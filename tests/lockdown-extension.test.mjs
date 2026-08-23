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
 * Control-repo fixture.
 *   students: [{ login, members }]  - members makes it a team repository
 *   extensions: [{ login, value }]  - overrides/<id>/<login>.json
 */
function makeControlDir({ students, extensions = [], assignmentType = null } = {}) {
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
      join(dir, "repositories", id, `${s.team_slug || s.login}.json`),
      JSON.stringify({
        github_login: s.login,
        team_slug: s.team_slug,
        members: s.members,
        repo_name: `TestOrg/${id}-${s.team_slug || s.login}`,
        repo_id: 42,
      }),
    );
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
  // One repository, two students. Locking it at dana's deadline locks erin out
  // of time the lecturer granted her.
  await withStubApi(async (api, calls) => {
    const dir = makeControlDir({
      assignmentType: "group",
      students: [{ login: "dana", team_slug: "team-a", members: ["dana", "erin"] }],
      extensions: [{ login: "erin", value: RUNNING }],
    });
    const res = await runLockdown(dir, api);
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(calls.filter((c) => c.includes("exam-team-a")), []);
    for (const login of ["dana", "erin"]) {
      const row = rowFor(res.record, login);
      assert.ok(row, `${login} is in the record`);
      assert.equal(row.deferred_until, new Date(RUNNING).toISOString(), login);
    }
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
