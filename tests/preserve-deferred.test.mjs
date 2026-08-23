// PXL Classroom - preserve-deferred.test.mjs
//
// lockdown.mjs leaves a student with a running deadline extension alone, so
// their lockdown result carries `deferred_until` and no `snapshot_sha`. There is
// nothing to preserve yet and nothing has gone wrong.
//
// preserve.mjs counts a missing snapshot_sha as an error, which would turn the
// nightly amber for the whole cohort every night until the extension expires -
// for the system honouring a lecturer's decision. That is CLAUDE.md's "an empty
// population is not a failure" one level down.
//
// A missing snapshot with no deferral is still an error, and that is pinned here
// too, so the exemption cannot widen into "no submission is always fine".

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const preserveScript = join(here, "..", "preserve", "preserve.mjs");

/** Stub GitHub API: enough for the auth ping and the archive-repo probe. */
async function withStubApi(fn) {
  const server = createServer((req, res) => {
    const send = (code, body) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const url = req.url.split("?")[0];
    if (url === "/rate_limit") return send(200, { rate: { remaining: 5000 } });
    if (url === "/repos/TestOrg/pxl-classroom-archive") return send(200, { id: 7 });
    return send(404, { message: "not stubbed: " + url });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

/** Control-repo fixture holding just a lockdown record. */
function makeControlDir(results) {
  const dir = mkdtempSync(join(tmpdir(), "pxl-preserve-defer-"));
  mkdirSync(join(dir, "lockdowns", "exam"), { recursive: true });
  writeFileSync(
    join(dir, "lockdowns", "exam", "lockdown-record.json"),
    JSON.stringify({ schema_version: 1, assignment_id: "exam", results }),
  );
  return dir;
}

function runPreserve(dir, apiBase) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [preserveScript], {
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
      const outPath = join(dir, "out.env");
      resolve({
        status,
        stdout,
        stderr,
        outputs: existsSync(outPath) ? readFileSync(outPath, "utf8") : "",
      });
    });
  });
}

const deferred = {
  github_login: "bob",
  repo_name: "TestOrg/exam-bob",
  snapshot_sha: null,
  deferred_until: new Date(Date.now() + 7 * 86400_000).toISOString(),
};

test("a deferred student is not a preservation error", async () => {
  await withStubApi(async (api) => {
    const res = await runPreserve(makeControlDir([deferred]), api);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.outputs, /error_count=0/);
    assert.match(res.outputs, /outcome=preserved/);
    assert.match(res.stdout, /deferred/);
  });
});

test("a missing snapshot with no deferral is still an error", async () => {
  await withStubApi(async (api) => {
    const dir = makeControlDir([
      { github_login: "alice", repo_name: "TestOrg/exam-alice", snapshot_sha: null },
    ]);
    const res = await runPreserve(dir, api);
    assert.match(res.outputs, /error_count=1/, "a lockdown failure must still show up");
    assert.match(res.outputs, /outcome=fail:all-errors/);
  });
});

// --- no submission (UX_PLAN §3.2.6) ------------------------------------------
//
// Under `late_policy: block` a student who only pushed after the deadline has
// nothing to preserve. One slacker used to make the run `partial` and turn the
// nightly amber for the whole cohort - CLAUDE.md's "an empty population is not a
// failure" one level down: it covered zero records, not zero submissions.

const noSubmission = {
  github_login: "carol",
  repo_name: "TestOrg/exam-carol",
  snapshot_sha: null,
  no_submission: true,
};

test("a student with no submission before the deadline is not an error", async () => {
  await withStubApi(async (api) => {
    const res = await runPreserve(makeControlDir([noSubmission]), api);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.outputs, /error_count=0/);
    assert.match(res.outputs, /no_submission_count=1/);
    assert.match(res.outputs, /outcome=preserved/);
  });
});

test("one no-submission does not drag a whole cohort's run to partial", async () => {
  await withStubApi(async (api) => {
    const dir = makeControlDir([noSubmission, { ...noSubmission, github_login: "dave" }]);
    const res = await runPreserve(dir, api);
    assert.match(res.outputs, /outcome=preserved/);
    assert.match(res.outputs, /no_submission_count=2/);
  });
});
