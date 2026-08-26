// PXL Classroom - lockdown-phases.test.mjs
//
// lockdown.mjs used to run one loop per student: read the repo, read HEAD, write
// the observation, then demote. For a 200-student cohort that means student 1 is
// frozen at T+0s and student 200 minutes later, because the demotion is a write
// against an ~80/min secondary limit. Two consequences nobody would choose:
// students at the end of the list get extra time, and the snapshot is not a
// consistent cut - student 1's HEAD is read minutes before student 200's.
//
// The order is now STOP -> RECORD for the whole cohort. These tests assert that
// against the real script driven over a stub GitHub API that records the exact
// sequence of requests, so the property is checked rather than described.

import { test } from "node:test";
import assert from "node:assert/strict";
// spawn, not spawnSync: the stub API server runs in this process.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const lockdownScript = join(here, "..", "lockdown", "lockdown.mjs");

const HEAD_SHA = "1".repeat(40);
const PUSHED_AT = "2026-09-10T21:12:00Z";
const DEADLINE = new Date(Date.now() - 3600_000).toISOString();

/**
 * Stub GitHub API recording the request sequence.
 * `brokenRepos` 404s the repository object for those names, which is how a
 * failed phase 2 is simulated.
 */
async function withStubApi(fn, { brokenRepos = [] } = {}) {
  const calls = [];
  const server = createServer((req, res) => {
    const send = (code, body) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const url = req.url.split("?")[0];
    calls.push(`${req.method} ${url}`);

    if (url === "/rate_limit") return send(200, { rate: { remaining: 5000 } });
    const repoMatch = url.match(/^\/repos\/[^/]+\/([^/]+)$/);
    if (repoMatch) {
      if (brokenRepos.includes(repoMatch[1])) return send(404, { message: "Not Found" });
      return send(200, { id: 42, default_branch: "main", pushed_at: PUSHED_AT });
    }
    if (/\/commits\/main$/.test(url)) return send(200, { sha: HEAD_SHA });
    if (/\/collaborators\/[^/]+\/permission$/.test(url)) return send(200, { permission: "read" });
    if (/\/collaborators\/[^/]+$/.test(url) && req.method === "PUT") {
      res.writeHead(204);
      return res.end();
    }
    return send(404, { message: "not stubbed: " + url });
  });

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`, calls);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

/** Control repo with `logins.length` provisioned students. */
function makeControlDir(logins) {
  const dir = mkdtempSync(join(tmpdir(), "pxl-lockdown-phases-"));
  const id = "exam";
  mkdirSync(join(dir, "assignments"), { recursive: true });
  writeFileSync(
    join(dir, "assignments", `${id}.yml`),
    `state: published\ndeadline_at: "${DEADLINE}"\nsubmission_ref: refs/heads/main\n`,
  );
  mkdirSync(join(dir, "repositories", id), { recursive: true });
  for (const login of logins) {
    writeFileSync(
      join(dir, "repositories", id, `${login}.json`),
      JSON.stringify({ github_login: login, repo_name: `TestOrg/${id}-${login}`, repo_id: 42 }),
    );
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
      const outPath = join(dir, "out.env");
      resolve({
        status,
        stdout,
        stderr,
        record: existsSync(recordPath) ? JSON.parse(readFileSync(recordPath, "utf8")) : null,
        outputs: existsSync(outPath) ? readFileSync(outPath, "utf8") : "",
      });
    });
  });
}

const rowFor = (record, login) => record.results.find((r) => r.github_login === login);

test("every student is stopped before any student's HEAD is read", async () => {
  // The property the reordering exists for. With the old loop, alice's HEAD was
  // read before carol was demoted, so carol had extra time and the two SHAs came
  // from different instants.
  await withStubApi(async (api, calls) => {
    const dir = makeControlDir(["alice", "bob", "carol"]);
    const res = await runLockdown(dir, api);
    assert.equal(res.status, 0, res.stderr);

    const lastStop = calls.findLastIndex((c) => /^PUT .*\/collaborators\//.test(c));
    const firstRead = calls.findIndex((c) => /^GET .*\/commits\//.test(c));
    assert.ok(lastStop >= 0 && firstRead >= 0, `expected both phases to run: ${calls.join(", ")}`);
    assert.ok(
      lastStop < firstRead,
      `the last stop (index ${lastStop}) must precede the first HEAD read (index ${firstRead}):\n  ${calls.join("\n  ")}`,
    );
  });
});

test("the whole cohort is stopped before any repository is fetched", async () => {
  await withStubApi(async (api, calls) => {
    const dir = makeControlDir(["alice", "bob", "carol"]);
    await runLockdown(dir, api);
    const lastStop = calls.findLastIndex((c) => /^PUT .*\/collaborators\//.test(c));
    const firstRepoRead = calls.findIndex((c) => /^GET \/repos\/TestOrg\/exam-[^/]+$/.test(c));
    assert.ok(
      lastStop < firstRepoRead,
      `phase 2 must not begin until phase 1 is done:\n  ${calls.join("\n  ")}`,
    );
  });
});

test("the record says when the stop fired and what did it", async () => {
  await withStubApi(async (api) => {
    const dir = makeControlDir(["alice"]);
    const res = await runLockdown(dir, api);
    assert.equal(res.record.lock_method, "demotion");
    assert.ok(res.record.locked_at, "locked_at is when phase 1 actually fired");
    assert.ok(!Number.isNaN(Date.parse(res.record.locked_at)));
    assert.equal(rowFor(res.record, "alice").lock_method, "demotion");
    assert.match(res.outputs, /lock_method=demotion/);
  });
});

test("pushed_at is recorded from the repository object already fetched", async () => {
  // GitHub's own server-side timestamp. A student can set a commit date; they
  // cannot set this. It costs nothing - phase 2 fetches the repo anyway.
  await withStubApi(async (api, calls) => {
    const dir = makeControlDir(["alice"]);
    const res = await runLockdown(dir, api);
    assert.equal(rowFor(res.record, "alice").pushed_at, PUSHED_AT);
    assert.equal(
      calls.filter((c) => c === "GET /repos/TestOrg/exam-alice").length,
      1,
      "one repository fetch, not two",
    );
  });
});

test("a failed phase 2 leaves the cohort stopped and is safely re-runnable", async () => {
  // The repositories are frozen, so re-running produces the same answer. The
  // student whose repo could not be read produces no result row - preserve
  // iterates results, and a row it can never preserve would turn every
  // subsequent night amber for a repository that is simply gone.
  const dir = makeControlDir(["alice", "bob"]);
  await withStubApi(
    async (api, calls) => {
      const res = await runLockdown(dir, api);
      assert.ok(
        calls.includes("PUT /repos/TestOrg/exam-bob/collaborators/bob"),
        "bob is stopped even though his repo cannot be read",
      );
      assert.equal(rowFor(res.record, "bob"), undefined, "no result row for an unreadable repo");
      assert.equal(rowFor(res.record, "alice").snapshot_sha, HEAD_SHA);
      assert.equal(res.record.error_count, 1);
    },
    { brokenRepos: ["exam-bob"] },
  );

  // Second run, repo readable again: bob is recorded, alice stays frozen.
  await withStubApi(async (api) => {
    const retry = await runLockdown(dir, api);
    assert.equal(retry.status, 0, retry.stderr);
    assert.equal(rowFor(retry.record, "bob").snapshot_sha, HEAD_SHA);
    assert.equal(rowFor(retry.record, "alice").snapshot_sha, HEAD_SHA);
    assert.equal(retry.record.error_count, 0);
  });
});

// --- stop-only (what the deadline sentinel runs) -----------------------------

function runStopOnly(dir, apiBase) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [lockdownScript], {
      env: {
        ...process.env,
        GITHUB_TOKEN: "stub-token",
        GITHUB_API_URL: apiBase,
        ORG: "TestOrg",
        ASSIGNMENT_ID: "exam",
        DATA_DIR: dir,
        STOP_ONLY: "1",
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
        status, stdout, stderr,
        recordExists: existsSync(join(dir, "lockdowns", "exam", "lockdown-record.json")),
        outputs: existsSync(outPath) ? readFileSync(outPath, "utf8") : "",
      });
    });
  });
}

test("stop-only writes NO lockdown record - one with no results strands the assignment", async () => {
  // find-finalizable.mjs reads the record's existence as evidence a finalize
  // happened. A record with an empty `results` would make every student look
  // preserved and the assignment would never be finalized at all.
  await withStubApi(async (api, calls) => {
    const dir = makeControlDir(["alice", "bob"]);
    const res = await runStopOnly(dir, api);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.recordExists, false);
    assert.match(res.outputs, /outcome=stopped/);
    assert.ok(calls.some((c) => /^PUT .*\/collaborators\//.test(c)), "it did stop the cohort");
  });
});

test("stop-only records nothing and observes nothing", async () => {
  // The instant is its whole job; the finalize run does phases 2-4 unhurried,
  // against repositories that can no longer move.
  await withStubApi(async (api, calls) => {
    const dir = makeControlDir(["alice"]);
    await runStopOnly(dir, api);
    assert.deepEqual(calls.filter((c) => c.includes("/commits")), [], "no snapshot is taken");
    const obsDir = join(dir, "observations", "exam", "alice");
    assert.equal(existsSync(obsDir) ? readdirSync(obsDir).length : 0, 0);
  });
});

test("an empty cohort stops nothing and still writes a record", async () => {
  await withStubApi(async (api, calls) => {
    const dir = makeControlDir([]);
    const res = await runLockdown(dir, api);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.record.lock_method, "none", "nothing was stopped, and the record says so");
    assert.deepEqual(res.record.results, []);
    assert.deepEqual(calls.filter((c) => c.includes("/collaborators/")), []);
  });
});

// --- The sentinel already stopped them ---------------------------------------
//
// The sentinel fires at the deadline instant and deliberately writes NO lockdown
// record - one with empty results would strand the assignment forever. So the
// nightly hours later had no way to know writes had already stopped, and stamped
// `lockdown_at` with its own clock: for a 20:00 deadline the record claimed the
// cohort was frozen at 00:00 and `uncertainty_seconds` reported four hours where
// the sentinel had achieved seconds.
//
// That number is what a lecturer would cite in a dispute, and it was
// understating the system against them.

/** A fired sentinel timeline beside the record it explains. */
function writeSentinel(dir, { at, outcome = "fired", key = "k1" } = {}) {
  const d = join(dir, "lockdowns", "exam");
  mkdirSync(d, { recursive: true });
  writeFileSync(
    join(d, `sentinel-${key}.json`),
    JSON.stringify({ schema_version: 1, assignment_id: "exam", outcome, deadline_at: at, samples: [] }),
  );
}

test("a fired sentinel's instant becomes lockdown_at, not the nightly's clock", async () => {
  await withStubApi(async (api) => {
    const dir = makeControlDir(["alice"]);
    writeSentinel(dir, { at: DEADLINE });
    const res = await runLockdown(dir, api);
    assert.equal(res.status, 0, res.stderr);

    const row = res.record.results[0];
    assert.equal(row.lockdown_at, DEADLINE, "writes stopped at the deadline, and the record must say so");
    assert.equal(row.uncertainty_seconds, 0, "which is what makes the uncertainty honest");
    assert.equal(res.record.max_uncertainty_seconds, 0);
  });
});

test("a sentinel that gave up is not credited", async () => {
  // `gave-up:runtime` means it never reached the instant - the nightly really is
  // what stopped the cohort, and claiming otherwise would invent precision.
  await withStubApi(async (api) => {
    const dir = makeControlDir(["alice"]);
    writeSentinel(dir, { at: DEADLINE, outcome: "gave-up:runtime" });
    const res = await runLockdown(dir, api);
    assert.equal(res.status, 0, res.stderr);
    assert.notEqual(res.record.results[0].lockdown_at, DEADLINE);
    assert.ok(res.record.results[0].uncertainty_seconds > 0, "the nightly's delay is real and must show");
  });
});

test("no sentinel at all still stamps the nightly's own clock", async () => {
  await withStubApi(async (api) => {
    const dir = makeControlDir(["alice"]);
    const res = await runLockdown(dir, api);
    assert.equal(res.status, 0, res.stderr);
    assert.notEqual(res.record.results[0].lockdown_at, DEADLINE);
    assert.ok(res.record.results[0].uncertainty_seconds > 0);
  });
});

test("a student the sentinel DEFERRED is not backdated to its instant", async () => {
  // The discriminator is the student's own effective deadline. Someone whose
  // extension was still running when the sentinel fired was deferred then and is
  // only being stopped now - crediting the sentinel would claim they lost write
  // access hours before they actually did, against work the lecturer allowed.
  await withStubApi(async (api) => {
    const dir = makeControlDir(["alice"]);
    writeSentinel(dir, { at: DEADLINE });

    // An extension that ran out between the sentinel and this run.
    const granted = new Date(new Date(DEADLINE).getTime() + 1800_000).toISOString();
    mkdirSync(join(dir, "overrides", "exam"), { recursive: true });
    writeFileSync(
      join(dir, "overrides", "exam", "alice.json"),
      // The append-only shape override.schema.json requires. The flat
      // `deadline_at` form is dead - a fixture built that way is read as no
      // extension at all, which is the exact failure CLAUDE.md records.
      JSON.stringify({
        schema_version: 1,
        assignment_id: "exam",
        github_login: "alice",
        overrides: [
          {
            type: "deadline_extension",
            value: granted,
            reason: "medical extension",
            overridden_by: "admin-panel",
            overridden_at: DEADLINE,
          },
        ],
      }),
    );

    const res = await runLockdown(dir, api);
    assert.equal(res.status, 0, res.stderr);
    const row = res.record.results[0];
    assert.equal(row.github_login, "alice");
    assert.notEqual(row.lockdown_at, DEADLINE, "she could still push after the sentinel fired");
  });
});
