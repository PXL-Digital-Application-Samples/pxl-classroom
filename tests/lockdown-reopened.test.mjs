// PXL Classroom - a repository a lecturer reopened is not re-locked.
//
// THE BUG THIS EXISTS FOR. A finalize run is not once: find-finalizable.mjs
// re-queues an assignment while preservation is incomplete, and AGAIN when a
// deferred extension expires. planTargets builds its list from every repository
// record, so a second pass locked the whole cohort - including a repository the
// lecturer had deliberately reopened (RUNBOOK §6.15).
//
// The trigger is two sections away in the same dialog: reopen Alice, grant Bob
// an extension, Bob's extension expires, the nightly re-locks Alice. Nothing
// said so, and `lockdowns/<id>/unlocked/alice.json` went on describing
// something that was no longer true.
//
// Driven against the real lockdown.mjs over a stub API that records every
// request, so "the code mentions unlocked/" cannot pass.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const lockdownScript = join(here, "..", "lockdown", "lockdown.mjs");

const HEAD_SHA = "1".repeat(40);
const DEADLINE = new Date(Date.now() - 3600_000).toISOString();

// The control repository as GitHub holds it NOW (lockdown reads `unlocked/`
// there since R6-3): by default the directory the test made, the same as the
// checkout; `remote` makes the two differ - an object of login -> record, or
// "error" for a read that fails.
let lastDir = null;
async function withStubApi(fn, { remote } = {}) {
  const calls = [];
  const server = createServer((req, res) => {
    const send = (code, body) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const url = req.url.split("?")[0];
    calls.push(`${req.method} ${url}`);

    const unlocked = url.match(/^\/repos\/TestOrg\/pxl-classroom-control\/contents\/lockdowns\/exam\/unlocked(?:\/([^/]+))?$/);
    if (unlocked) {
      if (remote === "error") return send(502, { message: "Bad Gateway" });
      const files = remote
        ? Object.fromEntries(Object.entries(remote).map(([login, rec]) => [`${login}.json`, JSON.stringify(rec)]))
        : (() => {
            const dir = join(lastDir, "lockdowns", "exam", "unlocked");
            if (!existsSync(dir)) return null;
            return Object.fromEntries(readdirSync(dir).map((f) => [f, readFileSync(join(dir, f), "utf8")]));
          })();
      if (!files || (!unlocked[1] && Object.keys(files).length === 0)) return send(404, { message: "Not Found" });
      if (!unlocked[1]) return send(200, Object.keys(files).map((name) => ({ name, type: "file" })));
      const name = decodeURIComponent(unlocked[1]);
      return name in files ? send(200, { name, content: Buffer.from(files[name]).toString("base64") }) : send(404, { message: "Not Found" });
    }
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
 * A control repo in the shape production writes: one repository record per
 * LOGIN, teams in their own manifests, and unlock records under
 * `lockdowns/<id>/unlocked/<login>.json` exactly as AssignmentDetailView commits
 * them.
 */
function makeControlDir({ students, teams = [], reopened = [], badReopened = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pxl-lockdown-reopened-"));
  lastDir = dir;
  const id = "exam";

  mkdirSync(join(dir, "assignments"), { recursive: true });
  writeFileSync(
    join(dir, "assignments", `${id}.yml`),
    `state: published\ndeadline_at: "${DEADLINE}"\nsubmission_ref: refs/heads/main\n`,
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
          schema_version: 1, assignment_id: id, team_slug: t.team_slug,
          team_name: t.team_slug, members: t.members, max_members: 4,
        }),
      );
    }
  }

  if (reopened.length || badReopened.length) {
    mkdirSync(join(dir, "lockdowns", id, "unlocked"), { recursive: true });
    for (const r of reopened) {
      writeFileSync(
        join(dir, "lockdowns", id, "unlocked", `${r.login}.json`),
        JSON.stringify({
          schema_version: 1,
          assignment_id: id,
          github_login: r.login,
          repo_name: `TestOrg/${id}-${r.login}`,
          unlocked_at: new Date().toISOString(),
          unlocked_by: r.by ?? "tomcoolpxl",
          reason: r.reason ?? "Appeal upheld",
          lock_method: "ruleset",
          snapshot_sha: HEAD_SHA,
        }),
      );
    }
    for (const login of badReopened) {
      writeFileSync(join(dir, "lockdowns", id, "unlocked", `${login}.json`), "{ not json");
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
      resolve({
        status, stdout, stderr,
        record: existsSync(recordPath) ? JSON.parse(readFileSync(recordPath, "utf8")) : null,
        outputs: existsSync(join(dir, "out.env")) ? readFileSync(join(dir, "out.env"), "utf8") : "",
      });
    });
  });
}

const demoted = (calls, login) => calls.includes(`PUT /repos/TestOrg/exam-${login}/collaborators/${login}`);

// ---------------------------------------------------------------------------

test("THE BUG: a reopened repository is NOT re-locked by a later pass", async () => {
  await withStubApi(async (api, calls) => {
    const dir = makeControlDir({
      students: [{ login: "alice" }, { login: "bob" }],
      reopened: [{ login: "alice", reason: "Appeal upheld by the examination board" }],
    });
    const res = await runLockdown(dir, api);
    assert.equal(res.status, 0, res.stderr);

    assert.ok(!demoted(calls, "alice"), "a repository a lecturer reopened must stay open");
    assert.ok(demoted(calls, "bob"), "everyone else is still locked");
  });
});

test("R6-3: the reopen records are read from GITHUB at the moment it plans, not from a checkout taken minutes before", async () => {
  // A Reopen clicked after the checkout: GitHub has the record, the checkout does not.
  const record = { schema_version: 1, assignment_id: "exam", github_login: "alice", repo_name: "TestOrg/exam-alice", unlocked_at: new Date().toISOString(), unlocked_by: "lect", reason: "appeal", lock_method: "ruleset", snapshot_sha: HEAD_SHA };
  await withStubApi(async (api, calls) => {
    const dir = makeControlDir({ students: [{ login: "alice" }, { login: "bob" }] });
    const res = await runLockdown(dir, api);
    assert.equal(res.status, 0, res.stderr);
    assert.ok(!demoted(calls, "alice"), "reopened after the checkout: still left open");
    assert.ok(demoted(calls, "bob"));
  }, { remote: { alice: record } });
  // A Lock again clicked after the checkout: the checkout still has the record, GitHub no longer does.
  await withStubApi(async (api, calls) => {
    const dir = makeControlDir({ students: [{ login: "alice" }, { login: "bob" }], reopened: [{ login: "alice" }] });
    const res = await runLockdown(dir, api);
    assert.equal(res.status, 0, res.stderr);
    assert.ok(demoted(calls, "alice"), "locked again after the checkout: locked, not undone");
  }, { remote: {} });
  // GitHub cannot be read: the checkout's records, as before - never "nobody reopened".
  await withStubApi(async (api, calls) => {
    const dir = makeControlDir({ students: [{ login: "alice" }, { login: "bob" }], reopened: [{ login: "alice" }] });
    const res = await runLockdown(dir, api);
    assert.equal(res.status, 0, res.stderr);
    assert.ok(!demoted(calls, "alice"));
    assert.match(res.stdout, /could not read the reopen records from GitHub - using the checkout's/);
  }, { remote: "error" });
});

test("…and it is touched not at all - no read, no permission call", async () => {
  // Same property a deferral has: excluded from the target list means excluded
  // from every phase, not merely from the write.
  await withStubApi(async (api, calls) => {
    const dir = makeControlDir({
      students: [{ login: "alice" }, { login: "bob" }],
      reopened: [{ login: "alice" }],
    });
    await runLockdown(dir, api);
    assert.ok(
      !calls.some((c) => c.includes("/exam-alice/")),
      `no call should name the reopened repository, got: ${calls.filter((c) => c.includes("alice")).join(", ")}`,
    );
  });
});

test("the run says so, and the record counts it", async () => {
  // A decision honoured silently is indistinguishable from one forgotten.
  await withStubApi(async (api) => {
    const dir = makeControlDir({
      students: [{ login: "alice" }, { login: "bob" }],
      reopened: [{ login: "alice", by: "tomcoolpxl", reason: "Appeal upheld" }],
    });
    const res = await runLockdown(dir, api);

    assert.match(res.stdout, /left open - reopened by tomcoolpxl \(Appeal upheld\)/);
    assert.equal(res.record.reopened_count, 1);
    assert.match(res.outputs, /reopened_count=1/);
  });
});

test("a GROUP repository reopened for one member stays open for the team", async () => {
  // One repository, one lock on it. Re-locking would shut out the whole team on
  // the strength of one member's record - and reopening it reopened it for all
  // of them in the first place.
  await withStubApi(async (api, calls) => {
    const dir = makeControlDir({
      students: [{ login: "alice", team_slug: "alpha" }, { login: "bob", team_slug: "alpha" }],
      teams: [{ team_slug: "alpha", members: ["alice", "bob"] }],
      reopened: [{ login: "alice" }],
    });
    const res = await runLockdown(dir, api);
    assert.equal(res.status, 0, res.stderr);
    assert.ok(
      !calls.some((c) => c.includes("/exam-alpha/")),
      "the team repository must not be re-locked for the member who was not named",
    );
    assert.equal(res.record.reopened_count, 2, "both member records are accounted for");
    // One row per member, not one per member per member (A15, review 2026-10-14).
    const rows = res.record.results.filter((r) => r.reopened_at !== undefined || r.lock_method === null);
    assert.deepEqual(rows.map((r) => r.github_login).sort(), ["alice", "bob"]);
  });
});

test("AN UNREADABLE RECORD COUNTS AS REOPENED - failing the other way re-locks a student", async () => {
  await withStubApi(async (api, calls) => {
    const dir = makeControlDir({
      students: [{ login: "alice" }, { login: "bob" }],
      badReopened: ["alice"],
    });
    const res = await runLockdown(dir, api);
    assert.equal(res.status, 0, res.stderr);
    assert.ok(!demoted(calls, "alice"), "a file we cannot parse is still a lecturer's decision");
    assert.match(res.stdout, /treating as reopened anyway/);
  });
});

test("no unlocked/ directory changes nothing", async () => {
  // The overwhelmingly common case: it must cost nothing and read as before.
  await withStubApi(async (api, calls) => {
    const dir = makeControlDir({ students: [{ login: "alice" }, { login: "bob" }] });
    const res = await runLockdown(dir, api);
    assert.equal(res.status, 0, res.stderr);
    assert.ok(demoted(calls, "alice"));
    assert.ok(demoted(calls, "bob"));
    assert.equal(res.record.reopened_count, 0);
  });
});

test("a stray file that is not a login is ignored", async () => {
  await withStubApi(async (api, calls) => {
    const dir = makeControlDir({ students: [{ login: "alice" }] });
    mkdirSync(join(dir, "lockdowns", "exam", "unlocked"), { recursive: true });
    writeFileSync(join(dir, "lockdowns", "exam", "unlocked", "README.md"), "not a record");
    const res = await runLockdown(dir, api);
    assert.equal(res.status, 0, res.stderr);
    assert.ok(demoted(calls, "alice"), "a non-JSON file must not reopen anybody");
  });
});

test("the login is matched case-insensitively, like every other login here", async () => {
  await withStubApi(async (api, calls) => {
    const dir = makeControlDir({
      students: [{ login: "Alice" }],
      reopened: [{ login: "Alice" }],
    });
    const res = await runLockdown(dir, api);
    assert.equal(res.status, 0, res.stderr);
    assert.ok(!calls.some((c) => c.includes("/collaborators/Alice")), "case must not decide this");
  });
});
