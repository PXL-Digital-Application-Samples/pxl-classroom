// PXL Classroom - shared GitHub API helper.
//
// One canonical retry policy and one carrier for every script + action that
// does not already use Octokit. Replaces both the per-action gh() copies and
// the old scripts/lib/gh.mjs.
//
// The retry policy is lib/rate-limit.mjs, shared with lib/gittree.mjs. Keeping a
// second copy here is how this file kept the pre-fix condition long after
// gittree learned that a SECONDARY rate limit answers 403 *or* 429 with neither
// x-ratelimit-remaining: 0 nor retry-after - and this is the carrier for
// provisioning, collection, lockdown, preservation, reporting, notification and
// usage, so a burst on a nightly finalize hit it hardest.
//
// Six attempts. A secondary limit sleeps at least 60s per GitHub's guidance, so
// the worst case is minutes - deliberately, because failing the leg loses the
// work and every job here has a 10-minute timeout to absorb it.
//
// User-Agent is derived from the GITHUB_ACTION env var so logs name the caller.

import { backoffMs, retryDelayMs, DEFAULT_MAX_ATTEMPTS, isIdempotent } from "./rate-limit.mjs";
import { GITHUB_API_VERSION } from "./github-api-version.mjs";

const UA_BASE = "pxl-classroom";

function userAgent() {
  const action = process.env.GITHUB_ACTION || "unknown";
  return `${UA_BASE}/${action}`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * How long one attempt may take, body included. GitHub's own gateway gives up
 * on a slow API call well inside this; a request still unanswered after a
 * minute is a connection that stalled, and Node's fetch would otherwise sit on
 * it for five minutes before failing - half of a job's ten.
 */
export const REQUEST_TIMEOUT_MS = 60_000;

/**
 * Attempts for a request that got no answer at all. Fewer than for a status
 * GitHub sent: each can cost the whole REQUEST_TIMEOUT_MS, so three is three
 * minutes against a GitHub that is not answering anyone.
 */
export const NO_ANSWER_ATTEMPTS = 3;

/**
 * `opts.repeatable`: the caller vouches that sending this request twice is the
 * same as sending it once, although its method is not idempotent - minting an
 * installation token, which hands out a fresh token each time and changes
 * nothing. Without it a 5xx or a dropped connection on that POST failed at
 * once, and the Pages deploy kept an organization's old pages over one 502
 * (review 2026-10-07). Never for a POST that creates something.
 */
export async function gh(method, path, body, opts = {}) {
  // Back-compat: callers passed a bare token as the 4th arg.
  const options = typeof opts === "string" ? { token: opts } : opts;
  const { token, apiBase, throwOnError = false, timeoutMs = REQUEST_TIMEOUT_MS, repeatable = false } = options;
  const safeToRepeat = repeatable || isIdempotent(method);
  const baseUrl = apiBase || process.env.GITHUB_API_URL || "https://api.github.com";
  const authToken = token || process.env.GITHUB_TOKEN;
  const url = path.startsWith("http") ? path : `${baseUrl}${path}`;

  let unanswered = 0;
  for (let attempt = 0; ; attempt++) {
    // A DROPPED CONNECTION, or one that stalled past the limit, is not an
    // answer. It was thrown straight out of here, failing whatever step met it
    // - during the 2026-10-06 GitHub incident as much as any 5xx. It is asked
    // again on the same terms as a 5xx: only where a repeat is the same request
    // (isIdempotent), because a POST that timed out may have been carried out.
    let res;
    let text;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${authToken}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": GITHUB_API_VERSION,
          "User-Agent": userAgent(),
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
      // Body first, then decide. GitHub's SECONDARY rate limit announces itself
      // in the message - it answers 403 or 429, does not necessarily zero
      // x-ratelimit-remaining, and does not always send retry-after - so a
      // header-only test misses it and the call fails outright instead of
      // backing off. That is what a nightly finalize over a large cohort looks
      // like. Read inside the same limit: a body can stall as well as a header.
      text = await res.text();
    } catch (error) {
      unanswered++;
      if (safeToRepeat && unanswered < NO_ANSWER_ATTEMPTS && attempt < DEFAULT_MAX_ATTEMPTS - 1) {
        console.warn(`[retry] ${method} ${path}: ${error?.name === "TimeoutError" ? `no answer in ${timeoutMs / 1000}s` : error?.message || error} - asking again`);
        await sleep(backoffMs(attempt));
        continue;
      }
      throw error;
    }

    const remaining = res.headers.get("x-ratelimit-remaining");
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch { data = { raw: text }; }
    }

    // A 5xx on a POST or PATCH is sent once: GitHub can answer 502 to a
    // request it already acted on, so a retry opens a second issue or comment
    // (isIdempotent). A rate-limit refusal is still retried whatever the method.
    const unsafeRetry = res.status >= 500 && !safeToRepeat;
    if (!res.ok && !unsafeRetry && attempt < DEFAULT_MAX_ATTEMPTS - 1) {
      const delay = retryDelayMs(
        { status: res.status, headers: res.headers, message: data?.message || text || "" },
        attempt
      );
      // null means not retriable - a permission 403 carries neither the headers
      // nor the wording, so it still fails fast rather than sleeping a minute
      // on its way to the same error.
      if (delay !== null) {
        await sleep(delay);
        continue;
      }
    }
    if (throwOnError && !res.ok) {
      throw new Error(`${res.status} ${method} ${path}: ${text}`);
    }
    return { status: res.status, ok: res.ok, headers: res.headers, data, remaining };
  }
}

function parseNextLink(linkHeader) {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const m = part.match(/<([^>]+)>;\s*rel="next"/);
    if (m) return m[1];
  }
  return null;
}

export async function ghAll(path, opts = {}) {
  const out = [];
  let next = path;
  while (next) {
    const res = await gh("GET", next, null, opts);
    if (!Array.isArray(res.data)) {
      throw new Error(`ghAll: expected array body at ${next}, got ${typeof res.data}`);
    }
    out.push(...res.data);
    next = parseNextLink(res.headers.get("link"));
  }
  return out;
}

export async function ghAllItems(path, itemsKey, opts = {}) {
  const out = [];
  let next = path;
  while (next) {
    const res = await gh("GET", next, null, opts);
    const items = res.data?.[itemsKey];
    if (!Array.isArray(items)) {
      throw new Error(`ghAllItems: expected ${itemsKey} array at ${next}`);
    }
    out.push(...items);
    next = parseNextLink(res.headers.get("link"));
  }
  return out;
}
