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
import { archiveRepoName } from "../lib/archive-repo.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const preserveScript = join(here, "..", "preserve", "preserve.mjs");

// The archive is per assignment. The stub answers that path and NOTHING else,
// so preserve.mjs asking for the wrong repository shows up as
// `fail:create-archive` rather than passing quietly: a stub that accepts any
// path tests nothing, which is what the e2e broker fixture taught.
const ARCHIVE_PATH = `/repos/TestOrg/${archiveRepoName("exam")}`;

/** Stub GitHub API: enough for the auth ping and the archive-repo probe. */
async function withStubApi(fn) {
  const seen = [];
  const server = createServer((req, res) => {
    const send = (code, body) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const url = req.url.split("?")[0];
    seen.push(url);
    if (url === "/rate_limit") return send(200, { rate: { remaining: 5000 } });
    if (url === ARCHIVE_PATH) return send(200, { id: 7 });
    return send(404, { message: "not stubbed: " + url });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`, seen);
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

// --- no submission (ARCHITECTURE §11.2.1.6) ------------------------------------------
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

// --- One malformed row must not fail the whole cohort ------------------------
//
// `rec.repo_name.split("/")` ran at the TOP of the loop, before every guard
// above. A row without a repo name threw a TypeError straight out into
// `fail:exception`, so nobody's submission was archived because one record was
// malformed - and preservation is the safety net the whole deadline flow rests
// on. collect.mjs already read the same field defensively, which is what made
// this an oversight rather than a decision.
//
// Latent rather than live: every row lockdown writes today carries repo_name.
// These pin the behaviour so it stays that way when the record shape next moves.

const good = {
  github_login: "alice",
  repo_name: "TestOrg/exam-alice",
  snapshot_sha: "a".repeat(40),
};

test("a row with no repo_name is ONE accounted error, not a dead loop", async () => {
  // The distinction under test is `fail:exception` - the loop threw and nothing
  // after that row ran - versus the ordinary per-row accounting. With nothing
  // actually pushed the outcome is still a failure (`fail:all-errors`, exit 1),
  // and that is correct: it just has to be a counted one, arrived at after every
  // other row was given its turn.
  await withStubApi(async (api) => {
    const dir = makeControlDir([{ github_login: "carol", snapshot_sha: "c".repeat(40) }, noSubmission]);
    const res = await runPreserve(dir, api);

    assert.doesNotMatch(res.outputs, /outcome=fail:exception/, `the loop died:\n${res.stdout}`);
    assert.match(res.outputs, /outcome=fail:all-errors/);
    assert.match(res.outputs, /error_count=1/);
    assert.match(res.stdout, /repo_name/, "and it must say what was wrong with the row");
    // The row BESIDE the bad one still got its turn - which is the whole point.
    assert.match(res.outputs, /no_submission_count=1/);
  });
});

test("a row with no github_login is an error too, not a crash", async () => {
  // login is how find-finalizable.mjs matches a pending submission, so a row
  // missing it is invisible to the retry logic - it has to be loud here or the
  // assignment looks finished with a submission unarchived.
  await withStubApi(async (api) => {
    const dir = makeControlDir([{ repo_name: "TestOrg/exam-x", snapshot_sha: "d".repeat(40) }]);
    const res = await runPreserve(dir, api);

    assert.equal(res.status, 1, "nothing preserved and one error is fail:all-errors");
    assert.doesNotMatch(res.outputs, /outcome=fail:exception/);
    assert.match(res.outputs, /error_count=1/);
    assert.match(res.stdout, /github_login/);
  });
});

test("the deferred and no-submission guards still run before the shape check", async () => {
  // Order matters: a deferred row legitimately has no snapshot, and asking it
  // for a repo name first would turn a lecturer's decision into an error.
  await withStubApi(async (api) => {
    const dir = makeControlDir([{ github_login: "bob", snapshot_sha: null, deferred_until: deferred.deferred_until }]);
    const res = await runPreserve(dir, api);
    assert.match(res.outputs, /error_count=0/);
    assert.match(res.outputs, /outcome=preserved/);
    assert.ok(good.snapshot_sha);
  });
});

test("preservation targets the assignment's own archive, not the org's", async () => {
  // The archive used to be one repository per org holding every cohort for
  // ever, which only grew and could not be retired without taking other
  // cohorts with it. Per assignment it dies with the cohort.
  await withStubApi(async (api, seen) => {
    const res = await runPreserve(makeControlDir([deferred]), api);
    assert.equal(res.status, 0, res.stderr);
    assert.ok(
      seen.includes(`/repos/TestOrg/${archiveRepoName("exam")}`),
      `expected a probe for the per-assignment archive, saw: ${seen.join(", ")}`,
    );
    assert.ok(
      !seen.includes("/repos/TestOrg/pxl-classroom-archive"),
      "must not touch the old per-org archive",
    );
  });
});

test("an assignment id with no usable archive name fails validation, not the push", async () => {
  // archiveRepoName returns null rather than throwing, so preserve.mjs has to
  // check it. Without that the name reaches the API as "undefined" and the run
  // dies somewhere less legible than validation.
  await withStubApi(async (api) => {
    const dir = makeControlDir([deferred]);
    const res = await new Promise((resolve, reject) => {
      const child = spawn("node", [preserveScript], {
        env: {
          ...process.env,
          GITHUB_TOKEN: "stub-token",
          GITHUB_API_URL: api,
          ORG: "TestOrg",
          ASSIGNMENT_ID: "---",
          DATA_DIR: dir,
          GITHUB_OUTPUT: join(dir, "bad.env"),
        },
      });
      let stdout = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.on("error", reject);
      child.on("close", (status) =>
        resolve({ status, stdout, outputs: existsSync(join(dir, "bad.env")) ? readFileSync(join(dir, "bad.env"), "utf8") : "" }),
      );
    });
    assert.equal(res.status, 1);
    assert.match(res.outputs, /outcome=fail:validation/);
  });
});
