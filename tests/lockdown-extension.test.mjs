// PXL Classroom - lockdown-extension.test.mjs
//
// A lecturer grants a student seven extra days. Until this landed, lockdown.mjs
// never opened `overrides/`: the student was demoted to `pull` at the
// assignment's own deadline, and report.mjs then reported their extension as
// active and their work as on-time - work the system had prevented.
//
// So the assertions here are about what lockdown does NOT do to that student:
// no demotion, no snapshot, no observation, no API call at all. They are made
// against the real lockdown.mjs driven over a stub GitHub API, which records
// every request, so a "the code mentions overrides" pass is not possible.

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
const DEADLINE = new Date(Date.now() - 3600_000).toISOString();          // an hour ago
const RUNNING = new Date(Date.now() + 7 * 86400_000).toISOString();      // a week out
const EXPIRED = new Date(Date.now() - 1800_000).toISOString();           // half an hour ago

/** Stub GitHub API that logs every request it is asked to serve. */
async function withStubApi(fn) {
  const calls = [];
  const server = createServer((req, res) => {
    const send = (code, body) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const url = req.url.split("?")[0];
    calls.push(`${req.method} ${url}`);

    if (url === "/rate_limit") return send(200, { rate: { remaining: 5000 } });
    if (/^\/repos\/[^/]+\/[^/]+$/.test(url)) return send(200, { id: 42, default_branch: "main" });
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

/**
 * Control-repo fixture, in the shape PRODUCTION WRITES.
 *
 * This built ONE repository record per team, carrying `members` - a shape no
 * writer has ever produced. scripts/write-repository-record.mjs writes one file
 * per LOGIN (`repositories/<id>/<login>.json`) with `team_slug` and NO
 * membership, and the team lives in `teams/<id>/<slug>.json`. So the deferral
 * this file exists to test was verified against a fiction: in production
 * `members` collapsed to `[login]`, the team's extension never propagated, and
 * under `lock_method: ruleset` the team-mate WITHOUT an extension locked the
 * repository the extended student was still working in.
 *
 *   students:   [{ login, team_slug }]  - one record each, exactly as production
 *   teams:      [{ team_slug, members }] - teams/<id>/<slug>.json
 *   extensions: [{ login, value }]      - overrides/<id>/<login>.json
 */
function makeControlDir({ students, teams = [], extensions = [], assignmentType = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pxl-lockdown-ext-"));
  const id = "exam";

  mkdirSync(join(dir, "assignments"), { recursive: true });
  writeFileSync(
    join(dir, "assignments", `${id}.yml`),
    `state: published\ndeadline_at: "${DEADLINE}"\nsubmission_ref: refs/heads/main\n` +
      (assignmentType ? `assignment_type: ${assignmentType}\n` : ""),
  );

  mkdirSync(join(dir, "repositories", id), { recursive: true });
  for (const s of students) {
    writeFileSync(
      join(dir, "repositories", id, `${s.login}.json`),
      JSON.stringify({
        schema_version: 1,
        assignment_id: id,
        github_login: s.login,
        ...(s.team_slug ? { team_slug: s.team_slug } : {}),
        repo_name: `TestOrg/${id}-${s.team_slug || s.login}`,
        repo_id: 42,
        repo_url: `https://github.com/TestOrg/${id}-${s.team_slug || s.login}`,
      }),
    );
  }

  if (teams.length) {
    mkdirSync(join(dir, "teams", id), { recursive: true });
    for (const t of teams) {
      writeFileSync(
        join(dir, "teams", id, `${t.team_slug}.json`),
        JSON.stringify({
          schema_version: 1,
          assignment_id: id,
          team_slug: t.team_slug,
          team_name: t.team_name || t.team_slug,
          members: t.members,
          max_members: 4,
        }),
      );
    }
  }

  if (extensions.length) {
    mkdirSync(join(dir, "overrides", id), { recursive: true });
    for (const e of extensions) {
      writeFileSync(
        join(dir, "overrides", id, `${e.login}.json`),
        JSON.stringify({
          schema_version: 1,
          assignment_id: id,
          github_login: e.login,
          overrides: [
            {
              type: "deadline_extension",
              value: e.value,
              reason: e.reason ?? "medical extension",
              overridden_by: "admin-panel",
              overridden_at: new Date().toISOString(),
            },
          ],
        }),
      );
    }
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

test("a student with a running extension is not demoted", async () => {
  await withStubApi(async (api, calls) => {
    const dir = makeControlDir({
      students: [{ login: "alice" }, { login: "bob" }],
      extensions: [{ login: "alice", value: RUNNING }],
    });
    const res = await runLockdown(dir, api);
    assert.equal(res.status, 0, res.stderr);

    assert.ok(
      !calls.includes("PUT /repos/TestOrg/exam-alice/collaborators/alice"),
      "the extended student must not be demoted",
    );
    assert.ok(
      calls.includes("PUT /repos/TestOrg/exam-bob/collaborators/bob"),
      "everyone else is still locked at the deadline",
    );
  });
});

test("no API call is spent on a deferred student at all", async () => {
  // Not just the demotion: they are out of the target list before the first
  // read, so the repo is never even fetched.
  await withStubApi(async (api, calls) => {
    const dir = makeControlDir({
      students: [{ login: "alice" }],
      extensions: [{ login: "alice", value: RUNNING }],
    });
    await runLockdown(dir, api);
    assert.deepEqual(
      calls.filter((c) => c.includes("exam-alice")),
      [],
      `expected no requests against the deferred repo, saw: ${calls.join(", ")}`,
    );
  });
});

test("a deferred student is recorded with deferred_until and no snapshot", async () => {
  await withStubApi(async (api) => {
    const dir = makeControlDir({
      students: [{ login: "alice" }],
      extensions: [{ login: "alice", value: RUNNING, reason: "hospitalised" }],
    });
    const res = await runLockdown(dir, api);
    const alice = rowFor(res.record, "alice");

    assert.ok(alice, "the deferred student stays in the record");
    assert.equal(alice.snapshot_sha, null, "no submission was taken");
    assert.equal(alice.deferred_until, new Date(RUNNING).toISOString());
    assert.equal(alice.deferred_reason, "hospitalised");
    assert.equal(alice.lockdown_at, null);
    assert.equal(res.record.deferred_count, 1);
  });
});

test("a deferred student gets no lockdown observation", async () => {
  // An observation is a record of a fact. Nothing was observed.
  await withStubApi(async (api) => {
    const dir = makeControlDir({
      students: [{ login: "alice" }],
      extensions: [{ login: "alice", value: RUNNING }],
    });
    await runLockdown(dir, api);
    const obsDir = join(dir, "observations", "exam", "alice");
    assert.equal(
      existsSync(obsDir) ? readdirSync(obsDir).length : 0,
      0,
      "no observation may be fabricated for a student who was not locked",
    );
  });
});

test("a deferral is not an error - the run stays green", async () => {
  await withStubApi(async (api) => {
    const dir = makeControlDir({
      students: [{ login: "alice" }, { login: "bob" }],
      extensions: [{ login: "alice", value: RUNNING }],
    });
    const res = await runLockdown(dir, api);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.outputs, /outcome=locked/);
    assert.match(res.outputs, /error_count=0/);
    assert.match(res.outputs, /deferred_count=1/);
    assert.match(res.outputs, /locked_count=1/);
  });
});

test("an expired extension locks down normally", async () => {
  await withStubApi(async (api, calls) => {
    const dir = makeControlDir({
      students: [{ login: "alice" }],
      extensions: [{ login: "alice", value: EXPIRED }],
    });
    const res = await runLockdown(dir, api);
    const alice = rowFor(res.record, "alice");
    assert.equal(alice.snapshot_sha, HEAD_SHA, "the extension ran out; take the submission");
    assert.equal(alice.deferred_until, undefined);
    assert.ok(calls.includes("PUT /repos/TestOrg/exam-alice/collaborators/alice"));
  });
});

test("a still-deferred student is re-evaluated on a retry, not frozen out", async () => {
  // The deferral record has no snapshot_sha, so the freeze-on-retry rule must
  // not treat it as "already locked down" - the retry after the extension
  // expires is the whole point.
  const dir = makeControlDir({
    students: [{ login: "alice" }],
    extensions: [{ login: "alice", value: RUNNING }],
  });
  await withStubApi(async (api) => {
    const first = await runLockdown(dir, api);
    assert.equal(rowFor(first.record, "alice").snapshot_sha, null);
  });

  // The lecturer's extension is over: rewrite it into the past and run again.
  writeFileSync(
    join(dir, "overrides", "exam", "alice.json"),
    JSON.stringify({
      schema_version: 1,
      assignment_id: "exam",
      github_login: "alice",
      overrides: [
        {
          type: "deadline_extension",
          value: EXPIRED,
          reason: "medical extension",
          overridden_by: "admin-panel",
          overridden_at: new Date().toISOString(),
        },
      ],
    }),
  );

  await withStubApi(async (api) => {
    const retry = await runLockdown(dir, api);
    const alice = rowFor(retry.record, "alice");
    assert.equal(alice.snapshot_sha, HEAD_SHA, "now the submission is taken");
    assert.equal(alice.deferred_until, undefined, "the deferral is cleared");
  });
});

test("a team-mate's extension defers the whole team repository", async () => {
  // One repository, two students, ONE RECORD EACH - the shape provisioning
  // actually writes. dana has no extension of her own, so her record is the one
  // that used to become a target and lock the repository erin was granted more
  // time in. The team membership comes from teams/exam/team-a.json.
  await withStubApi(async (api, calls) => {
    const dir = makeControlDir({
      assignmentType: "group",
      students: [
        { login: "dana", team_slug: "team-a" },
        { login: "erin", team_slug: "team-a" },
      ],
      teams: [{ team_slug: "team-a", members: ["dana", "erin"] }],
      extensions: [{ login: "erin", value: RUNNING }],
    });
    const res = await runLockdown(dir, api);
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(
      calls.filter((c) => c.includes("exam-team-a")),
      [],
      "nothing may touch the shared repository while any member's extension runs",
    );
    for (const login of ["dana", "erin"]) {
      const row = rowFor(res.record, login);
      assert.ok(row, `${login} is in the record`);
      assert.equal(row.deferred_until, new Date(RUNNING).toISOString(), login);
    }
    assert.equal(res.record.deferred_count, 2);
  });
});

test("a team-mate WITHOUT the extension does not lock the shared repository", async () => {
  // The regression this pair exists for, stated from the other side: with the
  // team unknown, dana's record was a plain target and phase 1 ran against
  // exam-team-a - the same repository erin was still entitled to push to.
  await withStubApi(async (api, calls) => {
    const dir = makeControlDir({
      assignmentType: "group",
      students: [
        { login: "dana", team_slug: "team-a" },
        { login: "erin", team_slug: "team-a" },
      ],
      teams: [{ team_slug: "team-a", members: ["dana", "erin"] }],
      extensions: [{ login: "erin", value: RUNNING }],
    });
    await runLockdown(dir, api);
    const writes = calls.filter((c) => c.startsWith("PUT ") || c.startsWith("POST "));
    assert.deepEqual(writes, [], `no write may reach the repository: ${writes.join(", ")}`);
  });
});

test("an extension granted AFTER lockdown does not discard the recorded submission", async () => {
  // The freeze rule and the deferral rule meet here, and the freeze has to win.
  // alice was locked down and her submission recorded; a lecturer then grants
  // her an extension - too late, and RUNBOOK.md §3.3 says so. If the retry defers
  // her, her result row is rewritten with snapshot_sha: null and the on-time
  // submission disappears from the record, which is exactly what
  // freeze-on-retry exists to prevent.
  const dir = makeControlDir({ students: [{ login: "alice" }] });
  await withStubApi(async (api) => {
    const first = await runLockdown(dir, api);
    assert.equal(rowFor(first.record, "alice").snapshot_sha, HEAD_SHA);
  });

  mkdirSync(join(dir, "overrides", "exam"), { recursive: true });
  writeFileSync(
    join(dir, "overrides", "exam", "alice.json"),
    JSON.stringify({
      schema_version: 1,
      assignment_id: "exam",
      github_login: "alice",
      overrides: [{
        type: "deadline_extension", value: RUNNING, reason: "granted too late",
        overridden_by: "admin-panel", overridden_at: new Date().toISOString(),
      }],
    }),
  );

  await withStubApi(async (api) => {
    const retry = await runLockdown(dir, api);
    const alice = rowFor(retry.record, "alice");
    assert.equal(
      alice.snapshot_sha,
      HEAD_SHA,
      "the recorded submission must survive an extension granted after the fact",
    );
    assert.equal(alice.deferred_until, undefined, "and she is not deferred back into the future");
  });
});

test("no overrides at all changes nothing", async () => {
  await withStubApi(async (api, calls) => {
    const dir = makeControlDir({ students: [{ login: "alice" }] });
    const res = await runLockdown(dir, api);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(rowFor(res.record, "alice").snapshot_sha, HEAD_SHA);
    assert.equal(res.record.deferred_count, 0);
    assert.ok(calls.includes("PUT /repos/TestOrg/exam-alice/collaborators/alice"));
  });
});

test("a cohort splits: some locked, some deferred, in one run", async () => {
  await withStubApi(async (api, calls) => {
    const dir = makeControlDir({
      students: [{ login: "alice" }, { login: "bob" }, { login: "carol" }],
      extensions: [{ login: "alice", value: RUNNING }, { login: "carol", value: RUNNING }],
    });
    const res = await runLockdown(dir, api);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.record.deferred_count, 2);
    assert.equal(res.record.locked_count, 1);
    assert.equal(res.record.error_count, 0);
    assert.equal(rowFor(res.record, "bob").snapshot_sha, HEAD_SHA);
    for (const login of ["alice", "carol"]) {
      assert.equal(rowFor(res.record, login).snapshot_sha, null, login);
    }
    assert.deepEqual(
      calls.filter((c) => /^PUT .*\/collaborators\//.test(c)),
      ["PUT /repos/TestOrg/exam-bob/collaborators/bob"],
      "only the student whose time is up is touched",
    );
  });
});

test("an extension that expires exactly now does not defer", async () => {
  // The boundary is `>`: a deadline that has arrived has arrived. Deferring on
  // equality would push the student to the next nightly for no reason.
  await withStubApi(async (api) => {
    const dir = makeControlDir({
      students: [{ login: "alice" }],
      extensions: [{ login: "alice", value: new Date(Date.now() - 1000).toISOString() }],
    });
    const res = await runLockdown(dir, api);
    assert.equal(rowFor(res.record, "alice").snapshot_sha, HEAD_SHA);
    assert.equal(res.record.deferred_count, 0);
  });
});

test("a malformed extension value locks the student rather than stranding them", async () => {
  // Fails towards acting. A student left deferred on an unparseable date would
  // never be finalized at all, because nothing would ever say their time was up.
  await withStubApi(async (api) => {
    const dir = makeControlDir({
      students: [{ login: "alice" }],
      extensions: [{ login: "alice", value: "next tuesday" }],
    });
    const res = await runLockdown(dir, api);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(rowFor(res.record, "alice").snapshot_sha, HEAD_SHA);
    assert.equal(res.record.deferred_count, 0);
  });
});

test("an override for somebody who has no repository is simply not a target", async () => {
  await withStubApi(async (api) => {
    const dir = makeControlDir({
      students: [{ login: "alice" }],
      extensions: [{ login: "ghost", value: RUNNING }],
    });
    const res = await runLockdown(dir, api);
    assert.equal(res.record.deferred_count, 0);
    assert.equal(rowFor(res.record, "ghost"), undefined);
    assert.equal(rowFor(res.record, "alice").snapshot_sha, HEAD_SHA);
  });
});

test("every student deferred is a valid, green, empty-of-work run", async () => {
  // The whole cohort has more time. Nothing to lock, nothing to preserve, and
  // nothing has gone wrong - preserve reads this record and must not fail.
  await withStubApi(async (api, calls) => {
    const dir = makeControlDir({
      students: [{ login: "alice" }, { login: "bob" }],
      extensions: [{ login: "alice", value: RUNNING }, { login: "bob", value: RUNNING }],
    });
    const res = await runLockdown(dir, api);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.outputs, /outcome=locked/);
    assert.match(res.outputs, /locked_count=0/);
    assert.match(res.outputs, /error_count=0/);
    assert.equal(res.record.results.length, 2);
    assert.deepEqual(calls.filter((c) => c.includes("/repos/TestOrg/exam-")), []);
  });
});

test("the latest of several extensions decides the deferral", async () => {
  const dir = makeControlDir({ students: [{ login: "alice" }] });
  mkdirSync(join(dir, "overrides", "exam"), { recursive: true });
  writeFileSync(
    join(dir, "overrides", "exam", "alice.json"),
    JSON.stringify({
      schema_version: 1, assignment_id: "exam", github_login: "alice",
      overrides: [
        { type: "deadline_extension", value: EXPIRED, reason: "first", overridden_by: "a", overridden_at: EXPIRED },
        { type: "deadline_extension", value: RUNNING, reason: "second", overridden_by: "a", overridden_at: EXPIRED },
      ],
    }),
  );
  await withStubApi(async (api) => {
    const res = await runLockdown(dir, api);
    const alice = rowFor(res.record, "alice");
    assert.equal(alice.deferred_until, new Date(RUNNING).toISOString(), "the append-only history's last entry rules");
    assert.equal(alice.deferred_reason, "second");
  });
});

test("an unreadable override does not crash the run, and is reported", async () => {
  await withStubApi(async (api) => {
    const dir = makeControlDir({ students: [{ login: "alice" }] });
    mkdirSync(join(dir, "overrides", "exam"), { recursive: true });
    writeFileSync(join(dir, "overrides", "exam", "alice.json"), "{ not json");
    const res = await runLockdown(dir, api);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /\[FAIL\] override alice\.json/);
    assert.equal(rowFor(res.record, "alice").snapshot_sha, HEAD_SHA);
  });
});
