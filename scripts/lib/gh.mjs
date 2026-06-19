const API_BASE = "https://api.github.com";
const RETRY_DELAYS_MS = [250, 500, 1000, 2000, 4000];

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function shouldRetry(status, headers) {
  if (status >= 500) return true;
  if (status === 429) return true;
  if (status === 403) {
    const remaining = headers.get("x-ratelimit-remaining");
    if (remaining === "0") return true;
    if (headers.get("retry-after")) return true;
  }
  return false;
}

function backoffMs(attempt, headers) {
  const retryAfter = headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (!Number.isNaN(seconds) && seconds > 0) return seconds * 1000;
  }
  const reset = headers.get("x-ratelimit-reset");
  if (reset) {
    const waitMs = Number(reset) * 1000 - Date.now();
    if (waitMs > 0 && waitMs < 60_000) return waitMs;
  }
  return RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
}

export async function gh(method, path, body, token) {
  if (typeof method !== "string" || typeof path !== "string") {
    throw new Error("gh(method, path, body, token) — method and path are required");
  }
  const url = path.startsWith("http") ? path : `${API_BASE}${path}`;
  let lastError;
  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.ok) {
      const text = await res.text();
      return { status: res.status, headers: res.headers, data: text ? JSON.parse(text) : null };
    }
    if (!shouldRetry(res.status, res.headers) || attempt === RETRY_DELAYS_MS.length - 1) {
      const text = await res.text();
      throw new Error(`${res.status} ${method} ${path}: ${text}`);
    }
    const wait = backoffMs(attempt, res.headers);
    lastError = `${res.status} ${method} ${path}`;
    console.error(`${lastError} — retrying in ${wait}ms (attempt ${attempt + 1})`);
    await sleep(wait);
  }
  throw new Error(`gh retry budget exhausted: ${lastError}`);
}

function parseNextLink(linkHeader) {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const m = part.match(/<([^>]+)>;\s*rel="next"/);
    if (m) return m[1];
  }
  return null;
}

export async function ghAll(path, token) {
  const out = [];
  let next = path;
  while (next) {
    const res = await gh("GET", next, null, token);
    if (!Array.isArray(res.data)) {
      throw new Error(`ghAll: expected array body at ${next}, got ${typeof res.data}`);
    }
    out.push(...res.data);
    next = parseNextLink(res.headers.get("link"));
  }
  return out;
}

export async function ghAllItems(path, itemsKey, token) {
  const out = [];
  let next = path;
  while (next) {
    const res = await gh("GET", next, null, token);
    const items = res.data?.[itemsKey];
    if (!Array.isArray(items)) {
      throw new Error(`ghAllItems: expected ${itemsKey} array at ${next}`);
    }
    out.push(...items);
    next = parseNextLink(res.headers.get("link"));
  }
  return out;
}
