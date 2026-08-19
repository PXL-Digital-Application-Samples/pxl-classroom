// PXL Classroom - lockdown-retry.test.mjs
//
// A finalize run can be retried (find-finalizable re-queues an assignment whose
// submissions were locked down but never preserved). Retrying must not move the
// recorded submission: a student's HEAD can advance after the deadline - late
// pushes land until the demotion propagates, and lecturers grant extensions -
// so re-snapshotting would silently replace the on-time submission with a later
// commit.
//
// Drives the real lockdown.mjs against a stub GitHub API over GITHUB_API_URL.

import { test } from "node:test";
import assert from "node:assert/strict";
// spawn, not spawnSync: the stub API server below runs in this process, so a
// synchronous child would block the event loop and deadlock against it.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const lockdownScript = join(here, "..", "lockdown", "lockdown.mjs");

const ON_TIME_SHA = "1".repeat(40);
const LATE_SHA = "9".repeat(40);

/** Stub GitHub API. `headSha` is what the student's branch currently points at. */
async function withStubApi(headSha, fn) {
  const server = createServer((req, res) => {
    const send = (code, body) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const url = req.url.split("?")[0];

    if (url === "/rate_limit") return send(200, { rate: { remaining: 5000 } });
    if (/^\/repos\/[^/]+\/[^/]+$/.test(url)) {
      return send(200, { id: 42, default_branch: "main" });
    }
    if (/\/commits\/main$/.test(url)) return send(200, { sha: headSha });
    if (/\/collaborators\/[^/]+\/permission$/.test(url)) return send(200, { permission: "read" });
    if (/\/collaborators\/[^/]+$/.test(url) && req.method === "PUT") {
      res.writeHead(204);
      return res.end();
    }
    return send(404, { message: "not stubbed: " + url });
  });

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

/** Control-repo fixture with one provisioned student. */
function makeControlDir(priorRecord = null) {
  const dir = mkdtempSync(join(tmpdir(), "pxl-lockdown-"));
  const id = "exam";

  mkdirSync(join(dir, "assignments"), { recursive: true });
  writeFileSync(
    join(dir, "assignments", `${id}.yml`),
    `state: published\ndeadline_at: "${new Date(Date.now() - 3600000).toISOString()}"\nsubmission_ref: refs/heads/main\n`,
  );

  mkdirSync(join(dir, "repositories", id), { recursive: true });
  writeFileSync(
    join(dir, "repositories", id, "alice.json"),
    JSON.stringify({ github_login: "alice", repo_name: "TestOrg/exam-alice", repo_id: 42 }),
  );

  if (priorRecord) {
    mkdirSync(join(dir, "lockdowns", id), { recursive: true });
    writeFileSync(join(dir, "lockdowns", id, "lockdown-record.json"), JSON.stringify(priorRecord));
  }
  return dir;
}

function runLockdown(dir, apiBase) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [lockdownScript], {
      env: {
        ...process.env,
        GITHUB_TOKEN: "stub-token",
        GITHUB_API_URL: apiBase,
        ORG: "TestOrg",
        ASSIGNMENT_ID: "exam",
        DATA_DIR: dir,
        GITHUB_OUTPUT: join(dir, "out.env"),
        GITHUB_STEP_SUMMARY: join(dir, "summary.md"),
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (status) => {
      const recordPath = join(dir, "lockdowns", "exam", "lockdown-record.json");
      resolve({
        status,
        stdout,
        stderr,
        record: existsSync(recordPath) ? JSON.parse(readFileSync(recordPath, "utf8")) : null,
      });
    });
  });
}

test("first lockdown snapshots the current HEAD and records attempt 1", async () => {
  await withStubApi(ON_TIME_SHA, async (api) => {
    const dir = makeControlDir();
    const res = await runLockdown(dir, api);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.record.results[0].snapshot_sha, ON_TIME_SHA);
    assert.equal(res.record.finalize_attempts, 1);
  });
});

test("retry freezes the original snapshot even after a late commit", async () => {
  // The whole point: the student pushed again after lockdown, and the retry
  // must still preserve the on-time SHA.
  const dir = makeControlDir();
  await withStubApi(ON_TIME_SHA, async (api) => {
    const first = await runLockdown(dir, api);
    assert.equal(first.record.results[0].snapshot_sha, ON_TIME_SHA);
  });

  await withStubApi(LATE_SHA, async (api) => {
    const retry = await runLockdown(dir, api);
    assert.equal(retry.status, 0, retry.stderr);
    assert.equal(
      retry.record.results[0].snapshot_sha,
      ON_TIME_SHA,
      "retry must NOT adopt the post-deadline commit",
    );
    assert.equal(retry.record.finalize_attempts, 2, "attempt counter must advance");
    assert.match(retry.stdout, /frozen/i);
  });
});

test("retry preserves the original lockdown timestamp", async () => {
  const dir = makeControlDir();
  let firstAt;
  await withStubApi(ON_TIME_SHA, async (api) => {
    firstAt = (await runLockdown(dir, api)).record.results[0].lockdown_at;
  });
  await withStubApi(LATE_SHA, async (api) => {
    const retry = await runLockdown(dir, api);
    assert.equal(retry.record.results[0].lockdown_at, firstAt, "lockdown instant is historical");
    assert.ok(retry.record.first_finalized_at, "first_finalized_at is carried forward");
  });
});

test("retry does not fabricate a second observation of the frozen snapshot", async () => {
  const dir = makeControlDir();
  const obsDir = join(dir, "observations", "exam", "alice");

  await withStubApi(ON_TIME_SHA, async (api) => await runLockdown(dir, api));
  const afterFirst = readdirSync(obsDir).length;

  await withStubApi(LATE_SHA, async (api) => await runLockdown(dir, api));
  assert.equal(readdirSync(obsDir).length, afterFirst, "no duplicate lockdown observation");
});

test("a student added after the first lockdown still gets a fresh snapshot", async () => {
  // Frozen means "already recorded", not "never snapshot anything again" - a
  // late-provisioned student must not be skipped by the retry.
  const dir = makeControlDir({
    schema_version: 1,
    assignment_id: "exam",
    finalize_attempts: 1,
    results: [{ github_login: "bob", repo_name: "TestOrg/exam-bob", snapshot_sha: "b".repeat(40) }],
  });

  await withStubApi(LATE_SHA, async (api) => {
    const res = await runLockdown(dir, api);
    assert.equal(res.status, 0, res.stderr);
    const alice = res.record.results.find((r) => r.github_login === "alice");
    assert.ok(alice, "alice must be locked down on the retry");
    assert.equal(alice.snapshot_sha, LATE_SHA, "a first-time snapshot uses current HEAD");
  });
});
