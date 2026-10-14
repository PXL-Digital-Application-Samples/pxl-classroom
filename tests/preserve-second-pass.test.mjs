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
  return { srv, src, data, sha };
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
