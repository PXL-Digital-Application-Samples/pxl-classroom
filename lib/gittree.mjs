// PXL Classroom — Git Data API commit primitive.
//
// Two retry policies for committing one or more files atomically to a branch:
//
//   commitWithRebase            — optimistic update; on non-fast-forward, re-reads
//                                 the parent ref and rebuilds the tree.
//   commitWithFreshRepoRetry    — tolerates 404 (repo metadata not propagated) and
//                                 409 (default branch not yet created) after a
//                                 freshly created repo, with longer backoff.
//
// Both are thin wrappers over the Git Data API (createBlob / createTree /
// createCommit / updateRef). A `changes` entry with `content === null` deletes
// the path via a tree entry with `sha: null` — supports atomic multi-file delete.
//
// HTTP plumbing is provided by the caller as a `request` function with the same
// shape as `Octokit.request`. A `{ token }` form is also accepted for plain-fetch
// callers (workflow scripts, frontend) — see the request adapter below.

const NON_FF_RE = /Update is not a fast.?forward/i;
const REF_NOT_FOUND_RE = /Reference does not exist|Not Found/i;

class GittreeError extends Error {
  constructor(message, { status, code, cause } = {}) {
    super(message);
    this.name = "GittreeError";
    this.status = status;
    this.code = code;
    if (cause) this.cause = cause;
  }
}

// Build a request function from either an Octokit-style { request } or a plain
// { fetch, token, apiBase } pair. Always returns an async (route, params) => res
// shape where `res = { status, headers, data }`.
function buildRequest(opts) {
  if (typeof opts.request === "function") {
    return async (route, params) => {
      const r = await opts.request(route, params);
      return { status: r.status, headers: r.headers ?? {}, data: r.data };
    };
  }
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const token = opts.token;
  const apiBase = opts.apiBase ?? "https://api.github.com";
  const userAgent = opts.userAgent ?? "pxl-classroom-gittree";
  if (!fetchImpl) throw new GittreeError("no fetch available", { code: "ENOTFETCH" });

  return async (route, params = {}) => {
    const [method, pathTpl] = route.split(" ", 2);
    let url = apiBase + pathTpl.replace(/\{(\w+)\}/g, (_m, k) => {
      const v = params[k];
      if (v === undefined) throw new GittreeError(`missing path param: ${k}`);
      return encodeURIComponent(v);
    });
    const body = method === "GET" || method === "DELETE" ? undefined :
      JSON.stringify(stripPathParams(params, pathTpl));
    const headers = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": userAgent,
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body) headers["Content-Type"] = "application/json";

    const res = await fetchImpl(url, { method, headers, body, signal: params.request?.signal });
    const text = await res.text();
    let data = null;
    if (text) { try { data = JSON.parse(text); } catch { data = { raw: text }; } }
    const headerObj = {};
    res.headers.forEach((v, k) => { headerObj[k] = v; });
    if (!res.ok) {
      const err = new GittreeError(data?.message || `HTTP ${res.status}`, { status: res.status });
      err.response = { status: res.status, headers: headerObj, data };
      throw err;
    }
    return { status: res.status, headers: headerObj, data };
  };
}

function stripPathParams(params, pathTpl) {
  const tplKeys = new Set([...pathTpl.matchAll(/\{(\w+)\}/g)].map((m) => m[1]));
  const out = {};
  for (const [k, v] of Object.entries(params)) {
    if (!tplKeys.has(k) && k !== "request") out[k] = v;
  }
  return out;
}

function utf8Base64(str) {
  return Buffer.from(str, "utf8").toString("base64");
}

async function sleep(ms, signal) {
  if (signal?.aborted) throw new GittreeError("aborted", { code: "ABORT" });
  await new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = () => { clearTimeout(t); reject(new GittreeError("aborted", { code: "ABORT" })); };
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function backoffMs(attempt, baseMs) {
  const exp = Math.min(30_000, baseMs * 2 ** attempt);
  const jitter = Math.floor(Math.random() * (baseMs / 2));
  return exp + jitter;
}

// Resolve the latest commit + tree SHA on a ref.
async function readRefHead(request, { owner, repo, branch, signal }) {
  const ref = await request("GET /repos/{owner}/{repo}/git/ref/{ref}", {
    owner, repo, ref: `heads/${branch}`, request: { signal },
  });
  const commitSha = ref.data.object.sha;
  const commit = await request("GET /repos/{owner}/{repo}/git/commits/{commit_sha}", {
    owner, repo, commit_sha: commitSha, request: { signal },
  });
  return { commitSha, treeSha: commit.data.tree.sha };
}

// Build tree entries from changes, uploading blobs for non-null content.
async function buildTreeEntries(request, { owner, repo, changes, signal }) {
  const entries = [];
  for (const change of changes) {
    if (change.content === null) {
      entries.push({ path: change.path, mode: "100644", type: "blob", sha: null });
    } else {
      const blob = await request("POST /repos/{owner}/{repo}/git/blobs", {
        owner, repo,
        content: typeof change.content === "string" ? utf8Base64(change.content) : change.content.toString("base64"),
        encoding: "base64",
        request: { signal },
      });
      entries.push({
        path: change.path,
        mode: change.mode ?? "100644",
        type: "blob",
        sha: blob.data.sha,
      });
    }
  }
  return entries;
}

// One commit attempt. Returns { commitSha } on success or throws.
async function attemptCommit(request, { owner, repo, branch, message, changes, baseTreeReuse, signal }) {
  const { commitSha: parentSha, treeSha: parentTreeSha } = await readRefHead(request, {
    owner, repo, branch, signal,
  });
  const entries = await buildTreeEntries(request, { owner, repo, changes, signal });

  const tree = await request("POST /repos/{owner}/{repo}/git/trees", {
    owner, repo,
    base_tree: baseTreeReuse ? parentTreeSha : undefined,
    tree: entries,
    request: { signal },
  });

  const commit = await request("POST /repos/{owner}/{repo}/git/commits", {
    owner, repo,
    message,
    tree: tree.data.sha,
    parents: [parentSha],
    request: { signal },
  });

  await request("PATCH /repos/{owner}/{repo}/git/refs/{ref}", {
    owner, repo, ref: `heads/${branch}`,
    sha: commit.data.sha,
    force: false,
    request: { signal },
  });

  return { commitSha: commit.data.sha };
}

// Returns true if a 422 error indicates a non-fast-forward update.
function isNonFastForward(err) {
  if (err?.status !== 422) return false;
  const msg = err?.response?.data?.message || err?.message || "";
  return NON_FF_RE.test(msg);
}

// Returns true if a 404 indicates a freshly-created repo whose ref isn't visible yet.
// Lets callers extend with classify404(err) -> bool.
function isPropagationLag404(err, classify404) {
  if (err?.status !== 404) return false;
  if (typeof classify404 === "function") return classify404(err);
  const msg = err?.response?.data?.message || err?.message || "";
  return REF_NOT_FOUND_RE.test(msg);
}

export async function commitWithRebase(opts) {
  const {
    owner, repo, branch = "main", message, changes,
    baseTreeReuse = true,
    maxAttempts = 5, baseBackoffMs = 200, signal,
  } = opts;

  if (!owner || !repo || !message) throw new GittreeError("owner, repo, message required");
  if (!Array.isArray(changes) || changes.length === 0) throw new GittreeError("changes must be a non-empty array");
  for (const c of changes) {
    if (!c.path || typeof c.path !== "string") throw new GittreeError("each change requires a string path");
    if (c.content !== null && typeof c.content !== "string" && !Buffer.isBuffer(c.content)) {
      throw new GittreeError(`change ${c.path}: content must be string | Buffer | null`);
    }
  }

  const request = buildRequest(opts);

  let lastErr;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (signal?.aborted) throw new GittreeError("aborted", { code: "ABORT" });
    try {
      const { commitSha } = await attemptCommit(request, {
        owner, repo, branch, message, changes, baseTreeReuse, signal,
      });
      return { commitSha, ref: `refs/heads/${branch}`, attempts: attempt + 1 };
    } catch (err) {
      lastErr = err;
      if (isNonFastForward(err)) {
        await sleep(backoffMs(attempt, baseBackoffMs), signal);
        continue;
      }
      // 5xx / 429 / 403 rate-limit are also retriable
      const status = err?.status ?? 0;
      const rateLimited = status === 403 && err?.response?.headers?.["x-ratelimit-remaining"] === "0";
      if (status >= 500 || status === 429 || rateLimited) {
        const retryAfter = Number(err?.response?.headers?.["retry-after"]) || 0;
        await sleep(retryAfter * 1000 || backoffMs(attempt, baseBackoffMs), signal);
        continue;
      }
      throw err;
    }
  }
  throw new GittreeError(`commitWithRebase exhausted ${maxAttempts} attempts`, { cause: lastErr });
}

export async function commitWithFreshRepoRetry(opts) {
  const {
    owner, repo, branch = "main", message, changes,
    maxAttempts = 8, baseBackoffMs = 500, signal,
    classify404,
  } = opts;

  const request = buildRequest(opts);
  let lastErr;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (signal?.aborted) throw new GittreeError("aborted", { code: "ABORT" });
    try {
      // Inner attempt uses commitWithRebase's retry-on-non-FF logic.
      return await commitWithRebase({ ...opts, maxAttempts: 3, baseBackoffMs: 200 });
    } catch (err) {
      lastErr = err;
      const status = err?.status ?? err?.cause?.status ?? 0;
      if (
        isPropagationLag404(err, classify404) ||
        isPropagationLag404(err?.cause, classify404) ||
        status === 409
      ) {
        await sleep(backoffMs(attempt, baseBackoffMs), signal);
        continue;
      }
      throw err;
    }
  }
  throw new GittreeError(
    `commitWithFreshRepoRetry exhausted ${maxAttempts} attempts (last status ${lastErr?.status ?? "?"})`,
    { cause: lastErr },
  );
}

export { GittreeError };
