// preserve/preserve.mjs on a second finalize pass - the real script, real git,
// against a directory of bare repositories standing in for github.com.
//
// 2026-10-14 review: every pass re-fetched and re-pushed every student inside
// the finalize's 10-minute job, rewrote `preserved_at` (so the day a snapshot
// was first archived was lost), and failed a student whose frozen commit had
// become unfetchable - a reopened student's force-push - although the archive
// already held it. A commit already in the archive at the student's ref is
// left alone now.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { archiveRepoName } from "../lib/archive-repo.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "..", "preserve", "preserve.mjs");
const ident = { GIT_AUTHOR_NAME: "S", GIT_AUTHOR_EMAIL: "s@x", GIT_COMMITTER_NAME: "S", GIT_COMMITTER_EMAIL: "s@x" };
const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...ident }, stdio: ["ignore", "pipe", "pipe"] }).trim();
const ARCHIVE = archiveRepoName("exam");

function world() {
  const srv = mkdtempSync(join(tmpdir(), "pxl-presrv-"));
  mkdirSync(join(srv, "TestOrg"));
  const src = join(srv, "TestOrg", "exam-alice.git");
  git(["init", "-q", "--bare", src], srv);
  git(["config", "uploadpack.allowReachableSHA1InWant", "true"], src);
  git(["init", "-q", "--bare", join(srv, "TestOrg", `${ARCHIVE}.git`)], srv);
  const work = join(srv, "work");
  git(["init", "-q", "-b", "main", work], srv);
  git(["commit", "-q", "--allow-empty", "-m", "one"], work);
  git(["commit", "-q", "--allow-empty", "-m", "two"], work);
  git(["push", "-q", src, "main"], work);
  const sha = git(["rev-parse", "HEAD"], work);
  const data = mkdtempSync(join(tmpdir(), "pxl-presdata-"));
  mkdirSync(join(data, "lockdowns", "exam"), { recursive: true });
  writeFileSync(join(data, "lockdowns", "exam", "lockdown-record.json"), JSON.stringify({
    schema_version: 1, assignment_id: "exam",
    results: [{ github_login: "alice", repo_name: "TestOrg/exam-alice", repo_id: 5, snapshot_sha: sha }],
  }));
  return { srv, src, data, sha, work };
}

/** A later snapshot in the lock record, as lockdown writes it after a re-lock (R7-3). */
function relock(w, sha) {
  writeFileSync(join(w.data, "lockdowns", "exam", "lockdown-record.json"), JSON.stringify({
    schema_version: 1, assignment_id: "exam",
    results: [{ github_login: "alice", repo_name: "TestOrg/exam-alice", repo_id: 5, snapshot_sha: sha, relocked_after: new Date().toISOString() }],
  }));
}

async function withApi(fn) {
  const server = createServer((req, res) => {
    const url = req.url.split("?")[0];
    res.writeHead(url === "/rate_limit" || url === `/repos/TestOrg/${ARCHIVE}` ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify(url === "/rate_limit" ? { rate: { remaining: 5000 } } : { id: 7 }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

function run(api, { srv, data }) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [script], {
      env: {
        ...process.env, GITHUB_TOKEN: "stub", GITHUB_API_URL: api, GITHUB_SERVER_URL: pathToFileURL(srv).href,
        ORG: "TestOrg", ASSIGNMENT_ID: "exam", DATA_DIR: data,
        GITHUB_OUTPUT: join(data, "out.env"), GITHUB_STEP_SUMMARY: join(data, "summary.md"),
      },
    });
    let log = "";
    child.stdout.on("data", (d) => (log += d));
    child.stderr.on("data", (d) => (log += d));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, log, out: existsSync(join(data, "out.env")) ? readFileSync(join(data, "out.env"), "utf8") : "" }));
  });
}

test("a second pass leaves a submission already in the archive alone: no fetch, no push, the first time kept", async () => {
  const w = world();
  await withApi(async (api) => {
    const first = await run(api, w);
    assert.equal(first.status, 0, first.log);
    assert.match(first.out, /preserved_count=1/);
    const presFile = join(w.data, "observations", "exam", "alice", "preservation.json");
    const before = JSON.parse(readFileSync(presFile, "utf8"));
    assert.equal(before.verified, true);
    assert.equal(git(["rev-parse", "refs/heads/preserved/exam/alice"], join(w.srv, "TestOrg", `${ARCHIVE}.git`)), w.sha);

    // The student was reopened and rewrote their branch: the frozen commit is
    // gone from their repository. The archive still holds it.
    rmSync(w.src, { recursive: true, force: true });
    await new Promise((r) => setTimeout(r, 20));
    const second = await run(api, w);
    assert.equal(second.status, 0, second.log);
    assert.match(second.out, /preserved_count=1/);
    assert.match(second.out, /error_count=0/);
    assert.match(second.log, /already in the archive/);
    assert.doesNotMatch(second.log, /\$ git fetch/, "nothing fetched");
    assert.doesNotMatch(second.log, /\$ git push/, "nothing pushed");
    assert.deepEqual(JSON.parse(readFileSync(presFile, "utf8")), before, "the record, preserved_at included, as it was");
  });
});

/** Two students, each with their own repository and a frozen snapshot. */
function world2() {
  const w = world();
  const bobSrc = join(w.srv, "TestOrg", "exam-bob.git");
  git(["init", "-q", "--bare", bobSrc], w.srv);
  git(["config", "uploadpack.allowReachableSHA1InWant", "true"], bobSrc);
  const work = join(w.srv, "work-bob");
  git(["init", "-q", "-b", "main", work], w.srv);
  git(["commit", "-q", "--allow-empty", "-m", "bob"], work);
  git(["push", "-q", bobSrc, "main"], work);
  const bobSha = git(["rev-parse", "HEAD"], work);
  writeFileSync(join(w.data, "lockdowns", "exam", "lockdown-record.json"), JSON.stringify({
    schema_version: 1, assignment_id: "exam",
    results: [
      { github_login: "alice", repo_name: "TestOrg/exam-alice", repo_id: 5, snapshot_sha: w.sha },
      { github_login: "bob", repo_name: "TestOrg/exam-bob", repo_id: 6, snapshot_sha: bobSha },
    ],
  }));
  return { ...w, bobSha };
}
const presOf = (w, login) => {
  const f = join(w.data, "observations", "exam", login, "preservation.json");
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null;
};

test("TL-5: the archive holding another commit at a student's ref fails that student, never overwrites it, and the others are preserved", async () => {
  const w = world2();
  // Something else sits at alice's archive ref already: not ours to replace.
  const other = join(w.srv, "work-other");
  git(["init", "-q", "-b", "main", other], w.srv);
  git(["commit", "-q", "--allow-empty", "-m", "unrelated"], other);
  const arc = join(w.srv, "TestOrg", `${ARCHIVE}.git`);
  git(["push", "-q", arc, "main:refs/heads/preserved/exam/alice"], other);
  const unrelated = git(["rev-parse", "HEAD"], other);
  await withApi(async (api) => {
    const res = await run(api, w);
    assert.match(res.out, /preserved_count=1/, res.log);
    assert.match(res.out, /error_count=1/);
    assert.equal(git(["rev-parse", "refs/heads/preserved/exam/alice"], arc), unrelated, "not overwritten");
    assert.equal(presOf(w, "alice"), null, "no record claims alice is preserved");
    assert.equal(presOf(w, "bob")?.verified, true);
    assert.equal(git(["rev-parse", "refs/heads/preserved/exam/bob"], arc), w.bobSha);
  });
});

test("TL-5: an archive that cannot be reached fails each student on their own, and the run finishes", async () => {
  const w = world2();
  rmSync(join(w.srv, "TestOrg", `${ARCHIVE}.git`), { recursive: true, force: true });
  await withApi(async (api) => {
    const res = await run(api, w);
    assert.match(res.out, /error_count=2/, res.log);
    assert.match(res.log, /preserve alice/);
    assert.match(res.log, /preserve bob/);
    assert.equal(presOf(w, "alice"), null);
    assert.equal(presOf(w, "bob"), null);
  });
});

test("TL-5: a git server that never answers fails each student inside the step limit, not the job's", async () => {
  // A listener that accepts and says nothing: every git step stalls until
  // killed. With the limit at 1.5s the two students fail in seconds.
  const w = world2();
  const sockets = new Set();
  const stall = createServer(() => { /* never answers */ });
  stall.on("connection", (s) => sockets.add(s));
  await new Promise((r) => stall.listen(0, "127.0.0.1", r));
  const started = Date.now();
  try {
    await withApi(async (api) => {
      const res = await new Promise((resolve, reject) => {
        const child = spawn("node", [script], {
          env: {
            ...process.env, GITHUB_TOKEN: "stub", GITHUB_API_URL: api, GITHUB_SERVER_URL: `http://127.0.0.1:${stall.address().port}`,
            ORG: "TestOrg", ASSIGNMENT_ID: "exam", DATA_DIR: w.data, PXL_GIT_STEP_MS: "1500",
            GITHUB_OUTPUT: join(w.data, "out.env"), GITHUB_STEP_SUMMARY: join(w.data, "summary.md"),
          },
        });
        let log = "";
        child.stdout.on("data", (d) => (log += d));
        child.stderr.on("data", (d) => (log += d));
        child.on("error", reject);
        child.on("close", (status) => resolve({ status, log, out: existsSync(join(w.data, "out.env")) ? readFileSync(join(w.data, "out.env"), "utf8") : "" }));
      });
      assert.match(res.out, /error_count=2/, res.log);
      // Killed by the limit, not refused at once for some other reason.
      assert.equal((res.log.match(/ETIMEDOUT/g) || []).length, 2, res.log);
      assert.ok(Date.now() - started < 30_000, "both inside the step limit, not hung");
    });
  } finally {
    for (const s of sockets) s.destroy();
    await new Promise((r) => stall.close(r));
  }
});

test("R7-3: locked again on top of the first snapshot - the archive branch moves forward to it, the first still in its history", async () => {
  const w = world();
  await withApi(async (api) => {
    assert.equal((await run(api, w)).status, 0);
    git(["commit", "-q", "--allow-empty", "-m", "after the reopen"], w.work);
    git(["push", "-q", w.src, "main"], w.work);
    const later = git(["rev-parse", "HEAD"], w.work);
    relock(w, later);
    const res = await run(api, w);
    assert.equal(res.status, 0, res.log);
    assert.match(res.out, /preserved_count=1/, res.log);
    const archive = join(w.srv, "TestOrg", `${ARCHIVE}.git`);
    assert.equal(git(["rev-parse", "refs/heads/preserved/exam/alice"], archive), later);
    git(["merge-base", "--is-ancestor", w.sha, later], archive);
    const doc = JSON.parse(readFileSync(join(w.data, "observations", "exam", "alice", "preservation.json"), "utf8"));
    assert.deepEqual([doc.source_sha, doc.preserved_ref, doc.verified], [later, "refs/heads/preserved/exam/alice", true]);
  });
});

test("R7-3: locked again after a rewritten history - the first snapshot is kept, the second gets its own branch, nothing forced", async () => {
  const w = world();
  await withApi(async (api) => {
    assert.equal((await run(api, w)).status, 0);
    git(["checkout", "-q", "--orphan", "rewritten"], w.work);
    git(["commit", "-q", "--allow-empty", "-m", "a new history"], w.work);
    git(["push", "-q", "--force", w.src, "rewritten:main"], w.work);
    const later = git(["rev-parse", "HEAD"], w.work);
    relock(w, later);
    const res = await run(api, w);
    assert.equal(res.status, 0, res.log);
    const archive = join(w.srv, "TestOrg", `${ARCHIVE}.git`);
    assert.equal(git(["rev-parse", "refs/heads/preserved/exam/alice"], archive), w.sha, "the first snapshot is evidence, and stays");
    const branch = `refs/heads/preserved/exam/alice-${later.slice(0, 12)}`;
    assert.equal(git(["rev-parse", branch], archive), later);
    const doc = JSON.parse(readFileSync(join(w.data, "observations", "exam", "alice", "preservation.json"), "utf8"));
    assert.deepEqual([doc.source_sha, doc.preserved_ref], [later, branch], "the record names where the second one is");
    // And the pass after that finds it there: nothing fetched or pushed again.
    const again = await run(api, w);
    assert.equal(again.status, 0, again.log);
    assert.match(again.log, /already in the archive at/);
  });
});

// R7-43 (step-back review): the record named the second snapshot's branch, so
// a third was pushed onto the base and refused every pass until the ceiling.
test("R7-43: a third snapshot after another rewritten history gets a branch of its own too", async () => {
  const w = world();
  await withApi(async (api) => {
    assert.equal((await run(api, w)).status, 0);
    const archive = join(w.srv, "TestOrg", `${ARCHIVE}.git`);
    const rewrite = (name, msg) => {
      git(["checkout", "-q", "--orphan", name], w.work);
      git(["commit", "-q", "--allow-empty", "-m", msg], w.work);
      git(["push", "-q", "--force", w.src, `${name}:main`], w.work);
      return git(["rev-parse", "HEAD"], w.work);
    };
    const second = rewrite("second", "a new history");
    relock(w, second);
    assert.equal((await run(api, w)).status, 0);
    const third = rewrite("third", "and another");
    relock(w, third);
    const res = await run(api, w);
    assert.equal(res.status, 0, res.log);
    assert.match(res.out, /preserved_count=1/, res.log);
    assert.equal(git(["rev-parse", "refs/heads/preserved/exam/alice"], archive), w.sha, "the first, kept");
    assert.equal(git(["rev-parse", `refs/heads/preserved/exam/alice-${second.slice(0, 12)}`], archive), second, "the second, kept");
    const branch = `refs/heads/preserved/exam/alice-${third.slice(0, 12)}`;
    assert.equal(git(["rev-parse", branch], archive), third);
    const doc = JSON.parse(readFileSync(join(w.data, "observations", "exam", "alice", "preservation.json"), "utf8"));
    assert.deepEqual([doc.source_sha, doc.preserved_ref], [third, branch]);
  });
});

test("R7-43: a third snapshot on top of the first goes onto the student's branch", async () => {
  const w = world();
  await withApi(async (api) => {
    assert.equal((await run(api, w)).status, 0);
    const archive = join(w.srv, "TestOrg", `${ARCHIVE}.git`);
    git(["checkout", "-q", "--orphan", "second"], w.work);
    git(["commit", "-q", "--allow-empty", "-m", "a new history"], w.work);
    git(["push", "-q", "--force", w.src, "second:main"], w.work);
    const second = git(["rev-parse", "HEAD"], w.work);
    relock(w, second);
    assert.equal((await run(api, w)).status, 0);
    // Back on the first history, and on top of it.
    git(["checkout", "-q", "main"], w.work);
    git(["commit", "-q", "--allow-empty", "-m", "on top of the first"], w.work);
    git(["push", "-q", "--force", w.src, "main:main"], w.work);
    const third = git(["rev-parse", "HEAD"], w.work);
    relock(w, third);
    const res = await run(api, w);
    assert.equal(res.status, 0, res.log);
    assert.equal(git(["rev-parse", "refs/heads/preserved/exam/alice"], archive), third, "a fast-forward of the first");
  });
});

test("a record lost while the archive kept the commit is written again, from the archive's ref", async () => {
  const w = world();
  await withApi(async (api) => {
    assert.equal((await run(api, w)).status, 0);
    const presFile = join(w.data, "observations", "exam", "alice", "preservation.json");
    rmSync(presFile);
    const again = await run(api, w);
    assert.equal(again.status, 0, again.log);
    const doc = JSON.parse(readFileSync(presFile, "utf8"));
    assert.equal(doc.verified, true);
    assert.equal(doc.source_sha, w.sha);
  });
});
