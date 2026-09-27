// PXL Classroom CLI - authed Octokit factory.
//
// Builds an Octokit with the cached OAuth token and a sensible user-agent.
// Use this for read-only and Contents-API calls; for multi-file commits use
// the gittree wrapper which threads through to lib/gittree.mjs.

import { Octokit } from "@octokit/rest";
import { retry } from "@octokit/plugin-retry";

const RetryOctokit = Octokit.plugin(retry);
import { requireToken } from "./auth.mjs";
import { GITHUB_API_VERSION } from "../../../lib/github-api-version.mjs";

const USER_AGENT = "pxl-classroom-cli/0.1.0";

/**
 * `fetch`: a stand-in transport, so a test can see what goes on the wire.
 * `retryBaseMs`: the retry plugin's delay unit (1000 by default), so a test of
 * a retried 5xx does not wait 1s + 4s + 9s.
 */
export function makeOctokit({ token, fetch, retryBaseMs } = {}) {
  const t = token ?? requireToken().access_token;
  const octokit = new RetryOctokit({
    auth: t,
    userAgent: USER_AGENT,
    // RETRIES ARE THE PLUGIN'S OPTION, NEVER `request.retries`. The plugin's
    // "failed" handler retries whenever the request carries `retries`, and
    // its never-retry list (400, 401, 403, 404, 410, 422, 451) is consulted
    // only on the path that sets it - so `request: { retries: 3 }` sent every
    // refused request four times (measured 2026-09-27: one 422 on
    // issues.create, four POSTs). Set here, a 4xx is asked once and a 5xx
    // is retried three times - for an idempotent method only (the hook below
    // sets `request.retries` to 0, never above it, for the others).
    retry: { retries: 3, ...(retryBaseMs != null ? { retryAfterBaseValue: retryBaseMs } : {}) },
    request: { ...(fetch ? { fetch } : {}) },
  });
  // THE SAME API VERSION AS EVERYTHING ELSE (lib/github-api-version.mjs). The
  // CLI sent none, so it got GitHub's default and warned on every issue it
  // created. Octokit has no default-headers option, so a hook sets it on
  // every request - including the retries the plugin makes.
  octokit.hook.before("request", (options) => {
    options.headers = { ...options.headers, "x-github-api-version": GITHUB_API_VERSION };
    // A 5xx IS NOT "NOTHING HAPPENED". GitHub can answer 502 to a POST it has
    // already acted on, so retrying one creates a second issue, a second pull
    // request, a second comment. Only a method whose repeat is the same
    // request is retried; the rest are asked once and the failure reported.
    // The plugin's supported per-request override (`@octokit/plugin-retry`
    // 8.x, error-request.js: `options.request.retries` wins over the plugin
    // option), set here because this hook runs outside the plugin's wrap and
    // so before it reads the options. 0 also stops the "failed" handler, which
    // retries on `request.retries` alone.
    if (!isIdempotent(options.method)) options.request = { ...options.request, retries: 0 };
  });
  return octokit;
}

// RFC 9110 §9.2.2: a repeat of these has the effect of one. PATCH is not in it.
const IDEMPOTENT = new Set(["GET", "HEAD", "PUT", "DELETE", "OPTIONS"]);

/** Is a retry of this method the same request? Unknown or absent is no. */
export function isIdempotent(method) {
  return IDEMPOTENT.has(String(method ?? "").toUpperCase());
}
