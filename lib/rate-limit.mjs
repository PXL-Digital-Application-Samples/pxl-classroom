// PXL Classroom - one retry policy for GitHub's rate limits.
//
// This lived only in lib/gittree.mjs, where it was written to fix a real
// failure: a large multi-file commit (a hundred blobs in a burst - seeding a big
// cohort's teams) hit the SECONDARY limit and failed outright instead of backing
// off. lib/gh.mjs - which carries provisioning, collection, lockdown,
// preservation, reporting, notification, usage and the team-payload read - still
// had the pre-fix condition, so the same burst on a nightly finalize failed the
// same way. Two copies, one fixed.
//
// The rule GitHub actually documents:
//
//   - A secondary limit answers **403 or 429** with a message about a secondary
//     rate limit. It does NOT necessarily zero `x-ratelimit-remaining`, and it
//     does not always send `retry-after` - so keying the retry on either header
//     alone misses it.
//   - Honour `retry-after` when present.
//   - Otherwise, if `x-ratelimit-remaining` is 0, wait for `x-ratelimit-reset`.
//   - Otherwise wait at least a minute, then back off exponentially.
//   - A permission 403 carries neither the headers nor the wording, so it still
//     fails fast rather than sleeping for a minute on its way to the same error.
//
// https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
//
// Dependency-free and isomorphic: the SPA bundles gittree.mjs, which imports
// this.

// Internal: the wording GitHub uses when it declines to say which limit was
// hit. Read only by retryDelayMs below.
const SECONDARY_LIMIT_RE = /secondary rate limit|abuse detection/i;

// GitHub's documented floor when it declines to say how long to wait.
export const SECONDARY_MIN_WAIT_MS = 60_000;

export const DEFAULT_MAX_ATTEMPTS = 6;

// Headers arrive as a fetch `Headers` (has .get) from lib/gh.mjs and as a plain
// object from gittree.mjs's error shape. Read either, case-insensitively.
function header(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get(name);
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  return key ? headers[key] : null;
}

/** Exponential backoff with jitter, capped at 30s. Exported: gittree's non-rate
 * -limit retries (non-fast-forward, fresh-repo 404) use the same curve. */
export function backoffMs(attempt, baseMs = 500, random = Math.random) {
  const exp = Math.min(30_000, baseMs * 2 ** attempt);
  const jitter = Math.floor(random() * (baseMs / 2));
  return exp + jitter;
}

/**
 * How long to wait before retrying, or `null` when this response is not
 * retriable and the caller should surface it.
 *
 * @param {object} res              `{ status, headers, message }` - message is
 *                                  the API's error text, where the secondary
 *                                  limit announces itself.
 * @param {number} attempt          0-based.
 * @param {object} [opts]
 * @param {number} [opts.baseMs]    first backoff step; doubles per attempt.
 * @param {number} [opts.now]       injectable clock, for the reset calculation.
 * @param {Function} [opts.random]  injectable jitter, so tests are deterministic.
 */
export function retryDelayMs({ status = 0, headers = null, message = "" } = {}, attempt = 0, opts = {}) {
  const { baseMs = 500, now = Date.now(), random = Math.random } = opts;

  const retryAfter = Number(header(headers, "retry-after")) || 0;
  const remaining = header(headers, "x-ratelimit-remaining");
  const primaryLimited = status === 403 && remaining === "0";
  const secondaryLimited =
    (status === 403 || status === 429) && (retryAfter > 0 || SECONDARY_LIMIT_RE.test(String(message)));

  if (!(status >= 500 || status === 429 || primaryLimited || secondaryLimited)) return null;

  // Explicit instruction wins over every heuristic below.
  if (retryAfter > 0) return retryAfter * 1000;

  // A primary limit tells us exactly when it lifts. Trust it when it is soon;
  // an hour-away reset is not something to sleep through inside a job.
  if (primaryLimited) {
    const reset = Number(header(headers, "x-ratelimit-reset")) || 0;
    const waitMs = reset * 1000 - now;
    if (waitMs > 0 && waitMs < SECONDARY_MIN_WAIT_MS) return waitMs;
  }

  if (secondaryLimited) return Math.max(SECONDARY_MIN_WAIT_MS, backoffMs(attempt, baseMs, random));
  return backoffMs(attempt, baseMs, random);
}
