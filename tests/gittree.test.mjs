// PXL Classroom — gittree.test.mjs
//
// Drives lib/gittree.mjs against a mocked fetch that simulates the Git Data API.
// Covers: happy path, multi-file, delete-via-null, non-FF rebase retry,
// 404 propagation lag, 422 disambiguation, SIGINT abort.

import { test } from "node:test";
import assert from "node:assert/strict";
import { commitWithRebase, commitWithFreshRepoRetry, GittreeError } from "../lib/gittree.mjs";

// Tiny in-memory GitHub Git Data API fake.
// Records every call to `calls` and consults a per-test `scenario` that maps
// "METHOD PATH-TEMPLATE" → response (or response[]).
function makeMockFetch(scenario) {
  const calls = [];
  const cursors = Object.create(null);

  const fetchImpl = async (url, init) => {
    const method = init?.method ?? "GET";
    const path = url.replace("https://api.github.com", "");
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });

    // Match longest registered route prefix.
    const routes = Object.keys(scenario);
    let matched = null;
    for (const route of routes) {
      const [m, tpl] = route.split(" ", 2);
      if (m !== method) continue;
      const re = new RegExp("^" + tpl.replace(/\{[^}]+\}/g, "[^/]+") + "$");
      if (re.test(path)) { matched = route; break; }
    }
    if (!matched) {
      return mockResponse(404, { message: `Not Found (unmocked ${method} ${path})` });
    }

    let entry = scenario[matched];
    if (Array.isArray(entry)) {
      const idx = cursors[matched] ?? 0;
      entry = entry[Math.min(idx, entry.length - 1)];
      cursors[matched] = (cursors[matched] ?? 0) + 1;
    }
    if (typeof entry === "function") entry = entry({ body, calls });
    return mockResponse(entry.status, entry.body, entry.headers);
  };

  return { fetchImpl, calls, cursors };
}

function mockResponse(status, body, extraHeaders = {}) {
  const headers = new Map(Object.entries({ "content-type": "application/json", ...extraHeaders }));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (k) => headers.get(k.toLowerCase()) ?? null,
      forEach: (cb) => headers.forEach((v, k) => cb(v, k)),
    },
    text: async () => (body === undefined ? "" : JSON.stringify(body)),
  };
}

const refRes = (sha) => ({ status: 200, body: { object: { sha } } });
const commitRes = (sha, treeSha) => ({ status: 200, body: { sha, tree: { sha: treeSha } } });
const blobRes = (sha) => ({ status: 201, body: { sha } });
const treeRes = (sha) => ({ status: 201, body: { sha } });
const updateOk = (sha) => ({ status: 200, body: { object: { sha } } });

test("commitWithRebase: single-file happy path", async () => {
  const { fetchImpl, calls } = makeMockFetch({
    "GET /repos/{owner}/{repo}/git/ref/{ref}": refRes("parent-sha"),
    "GET /repos/{owner}/{repo}/git/commits/{commit_sha}": commitRes("parent-sha", "parent-tree-sha"),
    "POST /repos/{owner}/{repo}/git/blobs": blobRes("blob-1"),
    "POST /repos/{owner}/{repo}/git/trees": treeRes("new-tree-sha"),
    "POST /repos/{owner}/{repo}/git/commits": commitRes("new-commit-sha", "new-tree-sha"),
    "PATCH /repos/{owner}/{repo}/git/refs/{ref}": updateOk("new-commit-sha"),
  });

  const res = await commitWithRebase({
    fetch: fetchImpl, token: "t",
    owner: "o", repo: "r", branch: "main",
    message: "hi",
    changes: [{ path: "students/roster.yml", content: "schema_version: 2\n" }],
  });

  assert.equal(res.commitSha, "new-commit-sha");
  assert.equal(res.attempts, 1);
  const treeCall = calls.find((c) => c.path.endsWith("/git/trees"));
  assert.equal(treeCall.body.base_tree, "parent-tree-sha");
  assert.equal(treeCall.body.tree[0].path, "students/roster.yml");
  assert.equal(treeCall.body.tree[0].sha, "blob-1");
});

test("commitWithRebase: multi-file with one delete (null content)", async () => {
  const { fetchImpl, calls } = makeMockFetch({
    "GET /repos/{owner}/{repo}/git/ref/{ref}": refRes("parent-sha"),
    "GET /repos/{owner}/{repo}/git/commits/{commit_sha}": commitRes("parent-sha", "parent-tree-sha"),
    "POST /repos/{owner}/{repo}/git/blobs": [blobRes("blob-a"), blobRes("blob-b")],
    "POST /repos/{owner}/{repo}/git/trees": treeRes("new-tree-sha"),
    "POST /repos/{owner}/{repo}/git/commits": commitRes("new-commit-sha", "new-tree-sha"),
    "PATCH /repos/{owner}/{repo}/git/refs/{ref}": updateOk("new-commit-sha"),
  });

  await commitWithRebase({
    fetch: fetchImpl, token: "t",
    owner: "o", repo: "r",
    message: "multi",
    changes: [
      { path: "a.txt", content: "alpha" },
      { path: "b.txt", content: "beta" },
      { path: "stale.txt", content: null },
    ],
  });

  const blobPosts = calls.filter((c) => c.path.endsWith("/git/blobs"));
  assert.equal(blobPosts.length, 2, "delete must not POST a blob");
  const treeCall = calls.find((c) => c.path.endsWith("/git/trees"));
  const stale = treeCall.body.tree.find((e) => e.path === "stale.txt");
  assert.equal(stale.sha, null, "null sha encodes delete");
});

test("commitWithRebase: non-FF triggers rebase retry, succeeds on second attempt", async () => {
  const { fetchImpl, calls } = makeMockFetch({
    "GET /repos/{owner}/{repo}/git/ref/{ref}": [refRes("parent-1"), refRes("parent-2")],
    "GET /repos/{owner}/{repo}/git/commits/{commit_sha}": [
      commitRes("parent-1", "tree-1"),
      commitRes("parent-2", "tree-2"),
    ],
    "POST /repos/{owner}/{repo}/git/blobs": [blobRes("blob-x"), blobRes("blob-x")],
    "POST /repos/{owner}/{repo}/git/trees": [treeRes("new-tree-1"), treeRes("new-tree-2")],
    "POST /repos/{owner}/{repo}/git/commits": [
      commitRes("commit-1", "new-tree-1"),
      commitRes("commit-2", "new-tree-2"),
    ],
    "PATCH /repos/{owner}/{repo}/git/refs/{ref}": [
      { status: 422, body: { message: "Update is not a fast forward" } },
      updateOk("commit-2"),
    ],
  });

  const res = await commitWithRebase({
    fetch: fetchImpl, token: "t",
    owner: "o", repo: "r",
    message: "rebase me",
    changes: [{ path: "x", content: "y" }],
    baseBackoffMs: 1,
  });

  assert.equal(res.commitSha, "commit-2");
  assert.equal(res.attempts, 2);
  const refReads = calls.filter((c) => c.path.includes("/git/ref/"));
  assert.equal(refReads.length, 2, "must re-read ref after non-FF");
});

test("commitWithRebase: real 422 (not non-FF) is thrown immediately", async () => {
  const { fetchImpl, calls } = makeMockFetch({
    "GET /repos/{owner}/{repo}/git/ref/{ref}": refRes("parent-sha"),
    "GET /repos/{owner}/{repo}/git/commits/{commit_sha}": commitRes("parent-sha", "parent-tree-sha"),
    "POST /repos/{owner}/{repo}/git/blobs": blobRes("blob-1"),
    "POST /repos/{owner}/{repo}/git/trees": treeRes("tree"),
    "POST /repos/{owner}/{repo}/git/commits": commitRes("c", "tree"),
    "PATCH /repos/{owner}/{repo}/git/refs/{ref}": {
      status: 422, body: { message: "Reference cannot be updated: malformed ref" },
    },
  });

  await assert.rejects(
    commitWithRebase({
      fetch: fetchImpl, token: "t",
      owner: "o", repo: "r", message: "m",
      changes: [{ path: "x", content: "y" }],
      baseBackoffMs: 1,
    }),
    (err) => {
      assert.ok(err instanceof GittreeError);
      assert.equal(err.status, 422);
      return true;
    },
  );

  // Exactly one update attempt (no retry on non-non-FF 422)
  const patches = calls.filter((c) => c.method === "PATCH");
  assert.equal(patches.length, 1);
});

test("commitWithRebase: exhausts maxAttempts on persistent non-FF", async () => {
  const { fetchImpl } = makeMockFetch({
    "GET /repos/{owner}/{repo}/git/ref/{ref}": refRes("parent-sha"),
    "GET /repos/{owner}/{repo}/git/commits/{commit_sha}": commitRes("parent-sha", "parent-tree-sha"),
    "POST /repos/{owner}/{repo}/git/blobs": blobRes("blob"),
    "POST /repos/{owner}/{repo}/git/trees": treeRes("tree"),
    "POST /repos/{owner}/{repo}/git/commits": commitRes("commit", "tree"),
    "PATCH /repos/{owner}/{repo}/git/refs/{ref}": {
      status: 422, body: { message: "Update is not a fast forward" },
    },
  });

  await assert.rejects(
    commitWithRebase({
      fetch: fetchImpl, token: "t",
      owner: "o", repo: "r", message: "m",
      changes: [{ path: "x", content: "y" }],
      maxAttempts: 2, baseBackoffMs: 1,
    }),
    /exhausted 2 attempts/,
  );
});

test("commitWithRebase: aborted signal short-circuits", async () => {
  const { fetchImpl } = makeMockFetch({
    "GET /repos/{owner}/{repo}/git/ref/{ref}": refRes("parent-sha"),
    "GET /repos/{owner}/{repo}/git/commits/{commit_sha}": commitRes("parent-sha", "parent-tree-sha"),
    "POST /repos/{owner}/{repo}/git/blobs": blobRes("blob"),
    "POST /repos/{owner}/{repo}/git/trees": treeRes("tree"),
    "POST /repos/{owner}/{repo}/git/commits": commitRes("commit", "tree"),
    "PATCH /repos/{owner}/{repo}/git/refs/{ref}": {
      status: 422, body: { message: "Update is not a fast forward" },
    },
  });

  const ac = new AbortController();
  ac.abort();

  await assert.rejects(
    commitWithRebase({
      fetch: fetchImpl, token: "t",
      owner: "o", repo: "r", message: "m",
      changes: [{ path: "x", content: "y" }],
      signal: ac.signal,
    }),
    (err) => err.code === "ABORT",
  );
});

test("commitWithFreshRepoRetry: 404 on ref read retries then succeeds", async () => {
  let refCalls = 0;
  const fetchImpl = async (url, init) => {
    const method = init?.method ?? "GET";
    const path = url.replace("https://api.github.com", "");
    if (method === "GET" && path.includes("/git/ref/")) {
      refCalls++;
      if (refCalls < 3) {
        return mockResponse(404, { message: "Not Found" });
      }
      return mockResponse(200, { object: { sha: "parent" } });
    }
    if (method === "GET" && path.includes("/git/commits/")) {
      return mockResponse(200, { sha: "parent", tree: { sha: "parent-tree" } });
    }
    if (method === "POST" && path.endsWith("/git/blobs")) {
      return mockResponse(201, { sha: "blob" });
    }
    if (method === "POST" && path.endsWith("/git/trees")) {
      return mockResponse(201, { sha: "tree" });
    }
    if (method === "POST" && path.endsWith("/git/commits")) {
      return mockResponse(201, { sha: "commit", tree: { sha: "tree" } });
    }
    if (method === "PATCH" && path.includes("/git/refs/")) {
      return mockResponse(200, { object: { sha: "commit" } });
    }
    return mockResponse(404, { message: `unmocked ${method} ${path}` });
  };

  const res = await commitWithFreshRepoRetry({
    fetch: fetchImpl, token: "t",
    owner: "o", repo: "r",
    message: "first commit",
    changes: [{ path: "README.md", content: "# new\n" }],
    maxAttempts: 5, baseBackoffMs: 1,
  });

  assert.equal(res.commitSha, "commit");
  assert.equal(refCalls, 3);
});

test("commitWithRebase: rejects empty changes", async () => {
  await assert.rejects(
    commitWithRebase({
      fetch: async () => mockResponse(200, {}),
      token: "t", owner: "o", repo: "r", message: "m",
      changes: [],
    }),
    /non-empty array/,
  );
});
