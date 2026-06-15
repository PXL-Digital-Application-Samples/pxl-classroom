// PXL Classroom — shared GitHub API helper.
//
// Replaces the six near-identical gh() functions in the action scripts.
// One canonical retry policy:
//   - 4 retries on 5xx, 429, or 403-with-x-ratelimit-remaining=0
//   - Honors retry-after when present
//   - Exponential backoff (2^attempt seconds, capped at 30s) otherwise
//
// User-Agent is derived from the GITHUB_ACTION env var so logs name the caller.

const UA_BASE = "pxl-classroom";

function userAgent() {
  const action = process.env.GITHUB_ACTION || "unknown";
  return `${UA_BASE}/${action}`;
}

export async function gh(method, path, body, opts = {}) {
  const { retries = 4, token, apiBase } = opts;
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
    const retriable =
      res.status >= 500 ||
      res.status === 429 ||
      (res.status === 403 && remaining === "0");

    if (retriable && attempt < retries) {
      const retryAfter = Number(res.headers.get("retry-after")) || 0;
      const backoff = retryAfter * 1000 || Math.min(30000, 2 ** attempt * 1000);
      await new Promise((r) => setTimeout(r, backoff));
      continue;
    }

    const text = await res.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch { data = { raw: text }; }
    }
    return { status: res.status, ok: res.ok, data, remaining };
  }
}
