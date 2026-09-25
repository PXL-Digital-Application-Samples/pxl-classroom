// lib/gittree.mjs - text files written through ONE tree request instead of a
// blob request each.
//
// The starter sync writes the same changed files into every student repository.
// A blob POST per file, one after another, was ~40s per student for a 93-file
// update, so the job's timeout stopped a real cohort after 30 students.
//
// The expected blob shas here come from node:crypto - `sha1("blob <n>\0" +
// bytes)`, which is what `git hash-object` computes - and NOT from the
// module's own WebCrypto helper, so the check does not share the logic it
// checks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { commitWithRebase, inlineText, gitBlobSha } from "../lib/gittree.mjs";

// Spelled as a code point: a literal U+FEFF in the source is invisible, lint
// refuses it, and an editor may drop it.
const BOM = String.fromCharCode(0xfeff);

const gitSha = (bytes) => {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, "utf8");
  return createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${b.length}\0`), b])).digest("hex");
};

test("gitBlobSha is git's blob hash", async () => {
  // The two values `git hash-object` prints for these, from git itself.
  assert.equal(await gitBlobSha(""), "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
  assert.equal(await gitBlobSha("hello\n"), "ce013625030ba8dba906f756967f9e9ca394464a");
  const bytes = Buffer.from([0xef, 0xbb, 0xbf, 0x75, 0x73, 0x69, 0x6e, 0x67, 0x0d, 0x0a]);
  assert.equal(await gitBlobSha(bytes), gitSha(bytes));
});

test("inlineText takes only byte-exact UTF-8 text", () => {
  assert.equal(inlineText("plain"), "plain");
  assert.equal(inlineText(Buffer.from("héllo wörld ✓", "utf8")), "héllo wörld ✓");
  // .NET writes a BOM and CRLF. Both must survive exactly, or every file
  // changes under the student.
  const bom = Buffer.from(`${BOM}using System;\r\n`, "utf8");
  assert.equal(bom[0], 0xef, "the fixture really starts with a BOM");
  assert.equal(inlineText(bom), `${BOM}using System;\r\n`);
  assert.equal(Buffer.from(inlineText(bom), "utf8").equals(bom), true);
  // Binary: a NUL, an invalid sequence, a lone continuation byte.
  assert.equal(inlineText(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00])), null);
  assert.equal(inlineText(Buffer.from([0xff, 0xfe, 0x41])), null);
  assert.equal(inlineText(Buffer.from([0x80])), null);
  // Too large to share a request.
  assert.equal(inlineText("x".repeat(512 * 1024 + 1)), null);
});

// -----------------------------------------------------------------------------
// A mock Git Data API that WRITES the blobs a tree `content` asks for, so the
// read-back answers with real shas.
// -----------------------------------------------------------------------------

function fakeGit({ corrupt = new Set(), truncated = false, readStatus = 200, scratchStatus = [] } = {}) {
  const calls = [];
  const trees = new Map();
  let n = 0;
  // Statuses the SCRATCH tree POST (no base_tree) answers with, in turn.
  const scratchAnswers = [...scratchStatus];
  const res = (status, body) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null, forEach: () => {} },
    text: async () => JSON.stringify(body),
  });
  const fetchImpl = async (url, init) => {
    const method = init?.method ?? "GET";
    const path = url.replace("https://api.github.com", "");
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    if (method === "GET" && /\/git\/ref\//.test(path)) return res(200, { object: { sha: "parent" } });
    if (method === "GET" && /\/git\/commits\//.test(path)) return res(200, { sha: "parent", tree: { sha: "parent-tree" } });
    if (method === "POST" && path.endsWith("/git/blobs")) {
      return res(201, { sha: gitSha(Buffer.from(body.content, "base64")) });
    }
    if (method === "POST" && path.endsWith("/git/trees") && !body.base_tree && scratchAnswers.length) {
      const status = scratchAnswers.shift();
      return res(status, { message: status === 403 ? "You have exceeded a secondary rate limit." : "refused" });
    }
    if (method === "POST" && path.endsWith("/git/trees")) {
      const sha = `tree-${++n}`;
      trees.set(sha, body.tree.map((e) => ({
        path: e.path,
        type: "blob",
        // What GitHub would write - unless this path is set to come back wrong.
        sha: e.content !== undefined ? (corrupt.has(e.path) ? "0".repeat(40) : gitSha(e.content)) : e.sha,
      })));
      return res(201, { sha });
    }
    const m = path.match(/\/git\/trees\/([^?]+)\?recursive=1$/);
    if (method === "GET" && m) {
      if (readStatus !== 200) return res(readStatus, { message: "nope" });
      return res(200, { sha: m[1], truncated, tree: trees.get(m[1]) || [] });
    }
    if (method === "POST" && path.endsWith("/git/commits")) return res(201, { sha: "new-commit", tree: { sha: body.tree } });
    if (method === "PATCH") return res(200, { object: { sha: "new-commit" } });
    return res(404, { message: `unmocked ${method} ${path}` });
  };
  const finalTree = () => calls.filter((c) => c.method === "POST" && c.path.endsWith("/git/trees")).at(-1).body;
  return { fetchImpl, calls, finalTree };
}

const files = (count) =>
  Array.from({ length: count }, (_, i) => ({
    path: `Lab4/Src/File${i}.cs`,
    content: Buffer.from(`${BOM}namespace Lab4;\r\npublic class File${i} { }\r\n`, "utf8"),
  }));

const commit = (fake, changes) =>
  commitWithRebase({ fetch: fake.fetchImpl, token: "t", owner: "Org", repo: "r", message: "sync", changes });

test("93 TEXT FILES: one tree request, zero blob requests, every sha git's own", async () => {
  const fake = fakeGit();
  const changes = files(93);
  await commit(fake, changes);
  assert.equal(fake.calls.filter((c) => c.path.endsWith("/git/blobs")).length, 0);
  const entries = fake.finalTree().tree;
  assert.equal(entries.length, 93);
  for (const [i, c] of changes.entries()) {
    assert.equal(entries[i].sha, gitSha(c.content), c.path);
    assert.equal("content" in entries[i], false, "the commit's tree carries shas only");
  }
  // ref, commit, scratch tree, read-back, tree, commit, ref: 7, where it was 97.
  assert.equal(fake.calls.length, 7, fake.calls.map((c) => `${c.method} ${c.path}`).join("\n"));
});

test("a file GitHub wrote differently goes up as a blob, and only that one", async () => {
  const fake = fakeGit({ corrupt: new Set(["Lab4/Src/File3.cs"]) });
  const changes = files(5);
  await commit(fake, changes);
  const blobs = fake.calls.filter((c) => c.path.endsWith("/git/blobs"));
  assert.equal(blobs.length, 1);
  assert.equal(Buffer.from(blobs[0].body.content, "base64").equals(changes[3].content), true);
  for (const [i, c] of changes.entries()) assert.equal(fake.finalTree().tree[i].sha, gitSha(c.content));
});

test("binary files go up as blobs beside inlined text", async () => {
  const fake = fakeGit();
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
  const changes = [...files(3), { path: "logo.png", content: png }, { path: "gone.txt", content: null }];
  await commit(fake, changes);
  const blobs = fake.calls.filter((c) => c.path.endsWith("/git/blobs"));
  assert.equal(blobs.length, 1);
  const tree = fake.finalTree().tree;
  assert.equal(tree.find((e) => e.path === "logo.png").sha, gitSha(png));
  assert.equal(tree.find((e) => e.path === "gone.txt").sha, null, "a delete is still a null sha");
});

test("a truncated or unreadable read-back falls back to blobs for everything", async () => {
  for (const opts of [{ truncated: true }, { readStatus: 403 }]) {
    const fake = fakeGit(opts);
    const changes = files(4);
    await commit(fake, changes);
    assert.equal(fake.calls.filter((c) => c.path.endsWith("/git/blobs")).length, 4, JSON.stringify(opts));
    for (const [i, c] of changes.entries()) assert.equal(fake.finalTree().tree[i].sha, gitSha(c.content));
  }
});

test("a single file is a blob, as it always was", async () => {
  const fake = fakeGit();
  await commit(fake, [{ path: "a.txt", content: "alpha" }]);
  assert.equal(fake.calls.filter((c) => c.path.endsWith("/git/blobs")).length, 1);
  assert.equal(fake.calls.filter((c) => c.path.endsWith("/git/trees")).length, 1, "no scratch tree");
});

// -----------------------------------------------------------------------------
// Failure paths of the shortcut. None of them may fail a commit that blobs
// would have finished, and none may answer a rate limit with more requests.
// -----------------------------------------------------------------------------

const commitFast = (fake, changes) =>
  commitWithRebase({
    fetch: fake.fetchImpl, token: "t", owner: "Org", repo: "r", message: "sync", changes, baseBackoffMs: 1,
  });

test("a scratch tree GitHub REFUSES (422) falls back to blobs at once, in the same attempt", async () => {
  const fake = fakeGit({ scratchStatus: [422] });
  const changes = files(4);
  const res = await commitFast(fake, changes);
  assert.equal(res.attempts, 1);
  assert.equal(fake.calls.filter((c) => c.path.endsWith("/git/blobs")).length, 4);
  for (const [i, c] of changes.entries()) assert.equal(fake.finalTree().tree[i].sha, gitSha(c.content));
});

test("a 5xx on the scratch tree WAITS for the retry, and the retry goes without the shortcut", async () => {
  // Falling back inside the failed attempt would fire a blob per file at a
  // server that just failed one request; retrying the shortcut would fail a
  // commit whose scratch tree is too big for GitHub every time.
  const fake = fakeGit({ scratchStatus: [502, 502, 502] });
  const changes = files(4);
  const res = await commitFast(fake, changes);
  assert.equal(res.attempts, 2);
  const scratchPosts = fake.calls.filter((c) => c.method === "POST" && c.path.endsWith("/git/trees") && !c.body.base_tree);
  assert.equal(scratchPosts.length, 1, "the shortcut was tried once, not on every attempt");
  const firstBlob = fake.calls.findIndex((c) => c.path.endsWith("/git/blobs"));
  const secondRef = fake.calls.findIndex((c, i) => i > 0 && c.method === "GET" && /\/git\/ref\//.test(c.path) && i > fake.calls.indexOf(scratchPosts[0]));
  assert.ok(firstBlob > secondRef, "no blob was sent in the attempt the 5xx failed");
  assert.equal(fake.calls.filter((c) => c.path.endsWith("/git/blobs")).length, 4);
});

test("the same path twice is refused by GitHub, and that is the old behaviour, not a new failure", async () => {
  const fake = fakeGit({ scratchStatus: [422] });
  const dup = [{ path: "a.txt", content: "one" }, { path: "a.txt", content: "two" }];
  await commitFast(fake, dup);
  assert.equal(fake.calls.filter((c) => c.path.endsWith("/git/blobs")).length, 2);
});

test("an executable file keeps its mode; an empty file is inlined", async () => {
  const fake = fakeGit();
  await commitFast(fake, [
    { path: "run.sh", content: "#!/bin/sh\necho hi\n", mode: "100755" },
    { path: "Data/.gitkeep", content: Buffer.alloc(0) },
  ]);
  assert.equal(fake.calls.filter((c) => c.path.endsWith("/git/blobs")).length, 0);
  const [sh, keep] = fake.finalTree().tree;
  assert.equal(sh.mode, "100755");
  assert.equal(keep.sha, "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391", "git's empty blob");
});

test("without SHA-1 (an insecure browser context) nothing is inlined unverified", async () => {
  const desc = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true, writable: true });
  try {
    assert.equal(await gitBlobSha("x"), null);
    const fake = fakeGit();
    await commitFast(fake, files(3));
    assert.equal(fake.calls.filter((c) => c.path.endsWith("/git/blobs")).length, 3);
    assert.equal(fake.calls.filter((c) => c.path.endsWith("/git/trees")).length, 1, "no scratch tree at all");
  } finally {
    Object.defineProperty(globalThis, "crypto", desc);
  }
});

test("large files go up as blobs and the rest still share one request", async () => {
  const fake = fakeGit();
  const big = { path: "big.txt", content: "y".repeat(600 * 1024) };
  await commitFast(fake, [...files(3), big]);
  const blobs = fake.calls.filter((c) => c.path.endsWith("/git/blobs"));
  assert.equal(blobs.length, 1);
  assert.equal(fake.finalTree().tree.at(-1).sha, gitSha(big.content));
});

test("an abort during the shortcut stops the commit rather than falling back", async () => {
  const controller = new AbortController();
  const fake = fakeGit();
  const inner = fake.fetchImpl;
  const aborting = async (url, init) => {
    if (init?.method === "POST" && String(url).endsWith("/git/trees")) {
      controller.abort();
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    }
    return inner(url, init);
  };
  await assert.rejects(
    commitWithRebase({ fetch: aborting, token: "t", owner: "Org", repo: "r", message: "m", changes: files(3), signal: controller.signal }),
  );
  assert.equal(fake.calls.filter((c) => c.path.endsWith("/git/blobs")).length, 0, "nothing was uploaded after the abort");
});

test("the fetch adapter sends a GET's leftover parameters as the query", async () => {
  const fake = fakeGit();
  await commitFast(fake, files(2));
  assert.ok(fake.calls.some((c) => c.method === "GET" && /\/git\/trees\/tree-1\?recursive=1$/.test(c.path)));
  // and never percent-encodes one into a path segment
  assert.equal(fake.calls.some((c) => c.path.includes("%3F")), false);
});

test("string content is inlined the same way as a Buffer", async () => {
  const fake = fakeGit();
  await commit(fake, [{ path: "a.md", content: "# ä\n" }, { path: "b.md", content: "ö\r\n" }]);
  assert.equal(fake.calls.filter((c) => c.path.endsWith("/git/blobs")).length, 0);
  assert.deepEqual(fake.finalTree().tree.map((e) => e.sha), [gitSha("# ä\n"), gitSha("ö\r\n")]);
});
