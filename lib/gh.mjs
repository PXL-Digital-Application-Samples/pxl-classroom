// PXL Classroom — shared GitHub API helper.
//
// One canonical retry policy and one carrier for every script + action that
// does not already use Octokit. Replaces both the per-action gh() copies and
// the old scripts/lib/gh.mjs.
//
// Retry budget: [500, 1000, 2000, 4000, 8000, 16000] ms (~31.5s total).
// Honors Retry-After when present, then x-ratelimit-reset (if within 60s),
// otherwise the fixed delay table above.
//
// User-Agent is derived from the GITHUB_ACTION env var so logs name the caller.

const UA_BASE = "pxl-classroom";
const RETRY_DELAYS_MS = [500, 1000, 2000, 4000, 8000, 16000];

function userAgent() {
  const action = process.env.GITHUB_ACTION || "unknown";
  return `${UA_BASE}/${action}`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isRetriable(status, headers) {
  if (status >= 500) return true;
  if (status === 429) return true;
  if (status === 403) {
    if (headers.get("x-ratelimit-remaining") === "0") return true;
    if (headers.get("retry-after")) return true;
  }
  return false;
}

function backoffMs(attempt, headers) {
  const retryAfter = Number(headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1000;
  const reset = Number(headers.get("x-ratelimit-reset"));
  if (Number.isFinite(reset) && reset > 0) {
    const waitMs = reset * 1000 - Date.now();
    if (waitMs > 0 && waitMs < 60_000) return waitMs;
  }
  return RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
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

    if (isRetriable(res.status, res.headers) && attempt < RETRY_DELAYS_MS.length - 1) {
      await sleep(backoffMs(attempt, res.headers));
      continue;
    }

    const text = await res.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch { data = { raw: text }; }
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
