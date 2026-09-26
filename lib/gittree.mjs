// PXL Classroom - Git Data API commit primitive.
//
// Two retry policies for committing one or more files atomically to a branch:
//
//   commitWithRebase            - optimistic update; on non-fast-forward, re-reads
//                                 the parent ref and rebuilds the tree.
//   commitWithFreshRepoRetry    - tolerates 404 (repo metadata not propagated) and
//                                 409 (default branch not yet created) after a
//                                 freshly created repo, with longer backoff.
//
// Both are thin wrappers over the Git Data API (createBlob / createTree /
// createCommit / updateRef). A `changes` entry with `content === null` deletes
// the path via a tree entry with `sha: null` - supports atomic multi-file delete.
//
// HTTP plumbing is provided by the caller as a `request` function with the same
// shape as `Octokit.request`. A `{ token }` form is also accepted for plain-fetch
// callers (workflow scripts, frontend) - see the request adapter below.

import { retryDelayMs, backoffMs } from "./rate-limit.mjs";
import { GITHUB_API_VERSION } from "./github-api-version.mjs";

const NON_FF_RE = /Update is not a fast.?forward/i;
const REF_NOT_FOUND_RE = /Reference does not exist|Not Found/i;

class GittreeError extends Error {
  /**
   * @param {string} message
   * @param {object} [detail]
   * @param {number} [detail.status] the HTTP status, where there was one
   * @param {string} [detail.code] one of this module's own codes
   * @param {unknown} [detail.cause]
   */
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
    const rest = stripPathParams(params, pathTpl);
    const body = method === "GET" || method === "DELETE" ? undefined : JSON.stringify(rest);
    // What Octokit does with the parameters a GET has left over: the query.
    if (!body && Object.keys(rest).length) {
      url += "?" + new URLSearchParams(Object.entries(rest).map(([k, v]) => [k, String(v)])).toString();
    }
    const headers = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
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
      // Annotated at the assignment rather than declared in the constructor:
      // `this.response = undefined` there would put the property on EVERY error
      // this module throws, which is a runtime change made to satisfy a type.
      const err = /** @type {GittreeError & {response?: {status: number, headers: object, data: unknown}}} */ (
        new GittreeError(data?.message || `HTTP ${res.status}`, { status: res.status })
      );
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

// Isomorphic: the SPA imports this module too, and `Buffer` is Node-only.
function utf8Base64(str) {
  if (typeof Buffer !== "undefined") return Buffer.from(str, "utf8").toString("base64");
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function isBinaryContent(value) {
  return typeof Buffer !== "undefined" && Buffer.isBuffer(value);
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

// How long to wait before retrying `err`, or null when it is not retriable.
// The policy itself is in lib/rate-limit.mjs - shared with lib/gh.mjs, because
// having it here only was how gh.mjs kept the pre-fix version.
function rateLimitDelayMs(err, attempt, baseMs) {
  return retryDelayMs(
    {
      status: err?.status ?? 0,
      headers: err?.response?.headers ?? {},
      message: err?.response?.data?.message || err?.message || "",
    },
    attempt,
    { baseMs }
  );
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

// ONE REQUEST PER FILE WAS THE WHOLE COST OF A LARGE COMMIT. A starter sync
// writes the same 93 changed files into every student repository, and a blob
// POST each, one after another, is ~40s per student - so a cohort of 60 ran
// into the job's timeout after 30 and the rest were never synced. The Git Data
// API can write a text file's blob itself from a tree entry's `content`, so
// every text file goes in ONE tree request instead of one blob request each.
//
// `content` is a JSON string and GitHub's documentation says nothing about its
// encoding, so nothing here trusts it. The inlined files are written as a
// SEPARATE, small tree - no base_tree - read back recursively (it holds only
// those files, so it cannot come back truncated), and each blob sha GitHub
// wrote is compared against the git sha computed here from the original bytes.
// A file that matches is used by sha; a file that does not, or one that is not
// byte-exact UTF-8, or anything when SHA-1 is unavailable, is uploaded as a
// blob exactly as before. The throwaway tree is never referenced by a commit.
//
// Only for two or more files: for one, a blob is one request and the check
// would be two.
const INLINE_MIN_FILES = 2;
// Well inside GitHub's request-body limit, and a large file gains nothing from
// sharing a request with others.
const INLINE_MAX_FILE_BYTES = 512 * 1024;
const INLINE_MAX_TOTAL_BYTES = 8 * 1024 * 1024;

function toBytes(content) {
  if (typeof content === "string") return new TextEncoder().encode(content);
  return new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
}

/**
 * The file's text when its bytes are EXACTLY that text in UTF-8 - no NUL, no
 * invalid sequence, a BOM kept rather than eaten - or null. Exported for the
 * tests.
 */
export function inlineText(content) {
  const bytes = toBytes(content);
  if (bytes.length > INLINE_MAX_FILE_BYTES || bytes.includes(0)) return null;
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
  const back = new TextEncoder().encode(text);
  if (back.length !== bytes.length) return null;
  for (let i = 0; i < bytes.length; i++) if (back[i] !== bytes[i]) return null;
  return text;
}

/** The git blob sha of these bytes - `sha1("blob <n>\0" + bytes)` - or null without SHA-1. */
export async function gitBlobSha(content) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  const bytes = toBytes(content);
  const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const all = new Uint8Array(header.length + bytes.length);
  all.set(header, 0);
  all.set(bytes, header.length);
  const digest = new Uint8Array(await subtle.digest("SHA-1", all));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * path -> blob sha for every change that could be written through a tree
 * `content` and was verified. Anything absent from the map is uploaded as a
 * blob by the caller. Never throws for a verification failure - it just
 * verifies less.
 */
async function inlineBlobShas(request, { owner, repo, changes, signal, inline = true }) {
  const verified = new Map();
  if (!inline) return verified;
  const candidates = [];
  let total = 0;
  for (const c of changes) {
    if (c.content === null) continue;
    const text = inlineText(c.content);
    if (text === null) continue;
    const size = toBytes(c.content).length;
    if (total + size > INLINE_MAX_TOTAL_BYTES) continue;
    const expected = await gitBlobSha(c.content);
    if (!expected) return verified;
    total += size;
    candidates.push({ path: c.path, text, expected });
  }
  if (candidates.length < INLINE_MIN_FILES) return verified;

  // A failure here is a failed SHORTCUT, not a failed commit: every file then
  // goes up as a blob, which is what this module did before it had one. Only
  // an abort stops - the caller asked for that.
  let read;
  try {
    const scratch = await request("POST /repos/{owner}/{repo}/git/trees", {
      owner, repo,
      tree: candidates.map((c) => ({ path: c.path, mode: "100644", type: "blob", content: c.text })),
      request: { signal },
    });
    read = await request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", {
      owner, repo, tree_sha: scratch.data.sha, recursive: 1, request: { signal },
    });
  } catch (err) {
    if (err?.code === "ABORT" || signal?.aborted) throw err;
    // A rate limit or a 5xx goes back to the caller's retry, which WAITS.
    // Falling back here would answer a secondary rate limit with one blob
    // request per file, straight into the limit that refused one tree.
    // Marked, so the retry after the wait goes WITHOUT the shortcut: a scratch
    // tree that 5xxes because of its size would otherwise fail every attempt
    // of a commit that blobs finish.
    if (rateLimitDelayMs(err, 0, 0) !== null) {
      if (err && typeof err === "object") err.inlineShortcut = true;
      throw err;
    }
    return verified;
  }
  if (read.data?.truncated) return verified;
  const written = new Map();
  for (const e of read.data?.tree || []) if (e.type === "blob") written.set(e.path, e.sha);
  for (const c of candidates) {
    if (written.get(c.path) === c.expected) verified.set(c.path, c.expected);
  }
  return verified;
}

// Build tree entries from changes, uploading blobs for non-null content.
async function buildTreeEntries(request, { owner, repo, changes, signal, inline = true }) {
  const inlined = await inlineBlobShas(request, { owner, repo, changes, signal, inline });
  const entries = [];
  for (const change of changes) {
    if (change.content === null) {
      entries.push({ path: change.path, mode: "100644", type: "blob", sha: null });
    } else if (inlined.has(change.path)) {
      entries.push({ path: change.path, mode: change.mode ?? "100644", type: "blob", sha: inlined.get(change.path) });
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
async function attemptCommit(request, { owner, repo, branch, message, changes, baseTreeReuse, signal, inline = true }) {
  const { commitSha: parentSha, treeSha: parentTreeSha } = await readRefHead(request, {
    owner, repo, branch, signal,
  });
  const entries = await buildTreeEntries(request, { owner, repo, changes, signal, inline });

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
    if (c.content !== null && typeof c.content !== "string" && !isBinaryContent(c.content)) {
      throw new GittreeError(`change ${c.path}: content must be string | Buffer | null`);
    }
  }

  const request = buildRequest(opts);

  let lastErr;
  // Off for the rest of this commit once the shortcut itself hit a retriable
  // failure (inlineBlobShas).
  let inline = true;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (signal?.aborted) throw new GittreeError("aborted", { code: "ABORT" });
    try {
      const { commitSha } = await attemptCommit(request, {
        owner, repo, branch, message, changes, baseTreeReuse, signal, inline,
      });
      return { commitSha, ref: `refs/heads/${branch}`, attempts: attempt + 1 };
    } catch (err) {
      lastErr = err;
      if (err?.inlineShortcut) inline = false;
      if (isNonFastForward(err)) {
        await sleep(backoffMs(attempt, baseBackoffMs), signal);
        continue;
      }
      // 5xx / 429 / rate limits are retriable. A permission 403 ("Resource not
      // accessible by integration") carries neither a retry-after nor a
      // secondary-limit message, so it still fails fast.
      const delay = rateLimitDelayMs(err, attempt, baseBackoffMs);
      if (delay !== null) {
        await sleep(delay, signal);
        continue;
      }
      throw err;
    }
  }
  throw new GittreeError(`commitWithRebase exhausted ${maxAttempts} attempts`, { code: EXHAUSTED, cause: lastErr });
}

const EXHAUSTED = "EXHAUSTED";

/**
 * What a failed commit says to a lecturer.
 *
 * Running out of retries leaves NO status of its own (the last HTTP error is
 * the `cause`), and the Teams tab printed `HTTP ${res.status}` - so a lecturer
 * who saved while the dashboard update from their previous save was still
 * writing to the same repository read "HTTP 0". What happened: the branch kept
 * moving under the commit, and a multi-file commit is all or nothing, so
 * nothing was saved and trying again works.
 *
 * @param {unknown} e
 * @returns {string}
 */
export function commitFailureMessage(e) {
  const err = /** @type {{code?: string, status?: number, message?: string} | null | undefined} */ (e);
  if (err?.code === EXHAUSTED) {
    return "the course data was being changed by something else at the same moment, so nothing was saved. Wait a few seconds and try again";
  }
  if (err?.status) {
    return `HTTP ${err.status}${err.message && err.message !== `HTTP ${err.status}` ? ` (${err.message})` : ""}`;
  }
  return err?.message || "the commit failed";
}

export async function commitWithFreshRepoRetry(opts) {
  const {
    maxAttempts = 8, baseBackoffMs = 500, signal,
    classify404,
  } = opts;

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
