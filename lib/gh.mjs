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

import { retryDelayMs, DEFAULT_MAX_ATTEMPTS } from "./rate-limit.mjs";

const UA_BASE = "pxl-classroom";

function userAgent() {
  const action = process.env.GITHUB_ACTION || "unknown";
  return `${UA_BASE}/${action}`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function gh(method, path, body, opts = {}) {
  // Back-compat: callers passed a bare token as the 4th arg.
  const options = typeof opts === "string" ? { token: opts } : opts;
  const { token, apiBase, throwOnError = false } = options;
  const baseUrl = apiBase || process.env.GITHUB_API_URL || "https://api.github.com";
  const authToken = token || process.env.GITHUB_TOKEN;
  const url = path.startsWith("http") ? path : `${baseUrl}${path}`;

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${authToken}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": userAgent(),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const remaining = res.headers.get("x-ratelimit-remaining");

    // Body first, then decide. GitHub's SECONDARY rate limit announces itself in
    // the message - it answers 403 or 429, does not necessarily zero
    // x-ratelimit-remaining, and does not always send retry-after - so a
    // header-only test misses it and the call fails outright instead of backing
    // off. That is what a nightly finalize over a large cohort looks like.
    const text = await res.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch { data = { raw: text }; }
    }

    if (!res.ok && attempt < DEFAULT_MAX_ATTEMPTS - 1) {
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
