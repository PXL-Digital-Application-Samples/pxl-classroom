// What lockdown does with a change made AFTER the sentinel's stop and before
// the finalize acts (review 2026-10-16, R7-1 and R7-2). With the sentinel on,
// the finalize runs minutes after the deadline, so a deadline moved later or an
// extra-time student remembered in those minutes lands exactly here: the
// checkout the finalize took is older than both, and the stop the sentinel put
// on the cohort stayed on students whose deadline was still ahead.
//
// Driven over a stub GitHub that holds the CURRENT state (the moved deadline,
// the new extension, the stops) apart from the checkout's older copy.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";

const lockdownScript = join(dirname(fileURLToPath(import.meta.url)), "..", "lockdown", "lockdown.mjs");
const HEAD_SHA = "1".repeat(40);
const DEADLINE = new Date(Date.now() - 600_000).toISOString(); // ten minutes ago: the sentinel stopped
const LATER = new Date(Date.now() + 1800_000).toISOString(); // the deadline as moved, or an extension
const b64 = (s) => Buffer.from(s).toString("base64");

/**
 * `remote`: what the control repository holds now - `assignment` (YAML text)
 * and `overrides` ({ login: doc }). `orgIds`: the organization stop's ids (active),
 * or null for none. `repoLocked`: logins whose repository ruleset is on.
 * `demoted`: logins at read.
 */
async function withApi(fn, { remote = {}, orgIds = null, repoLocked = [], demoted = [], repoMeta = {}, asOf = null } = {}) {
  const calls = [];
  const writes = [];
  let ids = orgIds ? [...orgIds] : null;
  let orgEnforcement = "active";
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const send = (code, body) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(body === undefined ? "" : JSON.stringify(body));
      };
      const url = req.url.split("?")[0];
      calls.push(`${req.method} ${url}`);
      const body = raw ? JSON.parse(raw) : null;
      if (req.method !== "GET") writes.push({ method: req.method, url, body });
      const control = "/repos/TestOrg/pxl-classroom-control/contents/";
      if (url === "/rate_limit") return send(200, { rate: { remaining: 5000 } });
      if (url === `${control}assignments/exam.yml` && remote.assignment) return send(200, { content: b64(remote.assignment) });
      if (url === `${control}assignments` && remote.listing) return send(200, remote.listing.map((name) => ({ name, type: "file" })));
      if (url === `${control}overrides/exam` && remote.overrides) {
        return send(200, Object.keys(remote.overrides).map((l) => ({ name: `${l}.json`, type: "file" })));
      }
      const ov = url.match(/\/contents\/overrides\/exam\/([^/]+)\.json$/);
      if (ov && remote.overrides?.[ov[1]]) return send(200, { content: b64(JSON.stringify(remote.overrides[ov[1]])) });
      if (url === `${control}lockdowns/exam/unlocked` && remote.unlocked) {
        return send(200, Object.keys(remote.unlocked).map((l) => ({ name: `${l}.json`, type: "file" })));
      }
      const un = url.match(/\/contents\/lockdowns\/exam\/unlocked\/([^/]+)\.json$/);
      if (un && remote.unlocked?.[un[1]]) return send(200, { content: b64(JSON.stringify(remote.unlocked[un[1]])) });
      if (url === "/orgs/TestOrg/rulesets" && req.method === "POST") {
        ids = body?.conditions?.repository_id?.repository_ids ?? [];
        orgEnforcement = body?.enforcement ?? "active";
        return send(201, { id: 7, name: body?.name, enforcement: orgEnforcement, conditions: { repository_id: { repository_ids: ids } } });
      }
      if (url === "/orgs/TestOrg/rulesets") return send(200, ids ? [{ id: 7, name: "pxl-classroom-deadline-exam" }] : []);
      if (url === "/orgs/TestOrg/rulesets/7" && req.method === "GET") {
        return send(200, { id: 7, name: "pxl-classroom-deadline-exam", enforcement: orgEnforcement,
          conditions: { repository_id: { repository_ids: ids }, ref_name: { include: ["refs/heads/main"], exclude: [] } } });
      }
      if (url === "/orgs/TestOrg/rulesets/7" && req.method === "PUT") {
        if (body?.conditions?.repository_id) ids = body.conditions.repository_id.repository_ids;
        if (body?.enforcement) orgEnforcement = body.enforcement;
        return send(200, { id: 7, enforcement: orgEnforcement, conditions: { repository_id: { repository_ids: ids } } });
      }
      const repoRulesets = url.match(/^\/repos\/TestOrg\/exam-([^/]+)\/rulesets$/);
      if (repoRulesets) {
        return send(200, repoLocked.includes(repoRulesets[1])
          ? [{ id: 9, name: "pxl-classroom-deadline", enforcement: "active", source_type: "Repository" }] : []);
      }
      if (/^\/repos\/TestOrg\/exam-[^/]+\/rulesets\/9$/.test(url) && req.method === "PUT") return send(200, { id: 9, enforcement: "disabled" });
      const perm = url.match(/\/collaborators\/([^/]+)\/permission$/);
      if (perm) return send(200, { permission: demoted.includes(perm[1]) ? "read" : "write", role_name: demoted.includes(perm[1]) ? "read" : "write" });
      if (/\/collaborators\/[^/]+$/.test(url) && req.method === "GET") { res.writeHead(204); return res.end(); }
      if (/\/collaborators\/[^/]+$/.test(url) && req.method === "PUT") { res.writeHead(204); return res.end(); }
      if (/^\/repos\/[^/]+\/[^/]+$/.test(url)) return send(200, { id: 42, default_branch: "main", ...repoMeta });
      // The newest commit as of a deadline (`?until=`), for a submission rebuilt.
      if (/\/commits$/.test(url) && asOf) return send(200, [asOf]);
      if (/\/commits\/main$/.test(url)) return send(200, { sha: HEAD_SHA });
      return send(404, { message: `not stubbed: ${url}` });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`, { calls, writes, ids: () => ids, enforcement: () => orgEnforcement });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

/** The finalize's checkout: the deadline as it was, no extension, alice's record, and the sentinel's fired stop. */
function checkout({ studentPermission = "push" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pxl-lockdown-late-"));
  mkdirSync(join(dir, "assignments"), { recursive: true });
  writeFileSync(join(dir, "assignments", "exam.yml"),
    `state: published\ndeadline_at: "${DEADLINE}"\nsubmission_ref: refs/heads/main\nlate_policy: block\nstudent_permission: ${studentPermission}\n`);
  mkdirSync(join(dir, "repositories", "exam"), { recursive: true });
  writeFileSync(join(dir, "repositories", "exam", "alice.json"), JSON.stringify({
    schema_version: 1, assignment_id: "exam", github_login: "alice", repo_name: "TestOrg/exam-alice", repo_id: 42,
    repo_url: "https://github.com/TestOrg/exam-alice",
  }));
  mkdirSync(join(dir, "lockdowns", "exam"), { recursive: true });
  writeFileSync(join(dir, "lockdowns", "exam", "sentinel-k1.json"), JSON.stringify({
    schema_version: 1, assignment_id: "exam", outcome: "fired", deadline_at: DEADLINE, stop: "done",
    samples: [{ observed_at: DEADLINE, pushed_at: { "exam-alice": DEADLINE } }],
  }));
  return dir;
}

function run(dir, api) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [lockdownScript], {
      env: { ...process.env, GITHUB_TOKEN: "stub", GITHUB_API_URL: api, ORG: "TestOrg", ASSIGNMENT_ID: "exam", DATA_DIR: dir,
        GITHUB_OUTPUT: join(dir, "out.env"), GITHUB_STEP_SUMMARY: join(dir, "summary.md"), PXL_APP_ID: "123" },
    });
    let log = "";
    child.stdout.on("data", (d) => (log += d));
    child.stderr.on("data", (d) => (log += d));
    child.on("error", reject);
    child.on("close", (status) => {
      const recordPath = join(dir, "lockdowns", "exam", "lockdown-record.json");
      resolve({ status, log, record: existsSync(recordPath) ? JSON.parse(readFileSync(recordPath, "utf8")) : null });
    });
  });
}

const extension = (value) => ({
  schema_version: 1, assignment_id: "exam", github_login: "alice",
  overrides: [{ type: "deadline_extension", value, reason: "extra time", overridden_by: "l", overridden_at: new Date().toISOString() }],
});
const row = (record, login) => record.results.find((r) => r.github_login === login);

test("R7-1: the deadline moved later on GitHub after the checkout - nobody is locked, everyone waits for it", async () => {
  await withApi(async (api, { writes }) => {
    const res = await run(checkout(), api);
    assert.equal(res.status, 0, res.log);
    const alice = row(res.record, "alice");
    assert.equal(alice.deferred_until, new Date(LATER).toISOString(), "deferred to the deadline in force");
    assert.equal(alice.snapshot_sha, null);
    assert.equal(writes.some((w) => /collaborators\/alice$/.test(w.url) && w.body?.permission === "pull"), false, "never demoted");
    assert.match(res.log, /deferred - the deadline is now .*still ahead/);
  }, { remote: { assignment: `state: published\ndeadline_at: "${LATER}"\nsubmission_ref: refs/heads/main\nlate_policy: block\n` } });
});

test("R7-1: ...and the sentinel's stop on them is let go: out of the organization ruleset, which goes off when empty", async () => {
  await withApi(async (api, state) => {
    const res = await run(checkout(), api);
    assert.equal(res.status, 0, res.log);
    assert.equal(state.enforcement(), "disabled", "the last id out switches the stop off");
    assert.match(res.log, /taken out of the organization's stop/);
  }, { remote: { assignment: `state: published\ndeadline_at: "${LATER}"\nsubmission_ref: refs/heads/main\nlate_policy: block\n` }, orgIds: [42] });
});

test("R7-2: an extension granted after the stop releases that student - organization stop, repository ruleset, demotion", async () => {
  await withApi(async (api, state) => {
    const res = await run(checkout(), api);
    assert.equal(res.status, 0, res.log);
    assert.equal(row(res.record, "alice").deferred_until, new Date(LATER).toISOString(), "the extension from GitHub, not the checkout");
    assert.deepEqual(state.ids(), [43], "out of the stop; the rest of the cohort stays in it");
    assert.ok(state.writes.some((w) => w.url === "/repos/TestOrg/exam-alice/rulesets/9" && w.body?.enforcement === "disabled"), "repository ruleset off");
    assert.ok(state.writes.some((w) => w.url === "/repos/TestOrg/exam-alice/collaborators/alice" && w.body?.permission === "push"), "the assignment's permission back");
  }, { remote: { overrides: { alice: extension(LATER) } }, orgIds: [42, 43], repoLocked: ["alice"], demoted: ["alice"] });
});

// R7-8: the delay figure is measured against the deadline a row was locked
// under, from the stop that held that student.
const assignmentYaml = (deadline) =>
  `state: published\ndeadline_at: "${deadline}"\nsubmission_ref: refs/heads/main\nlate_policy: block\nlock_down_enabled: false\n`;

test("R7-8: a deadline moved later and then passed is credited to the stop AT it, not the old instant's", async () => {
  const OLD = new Date(Date.now() - 7200_000).toISOString();
  const NEW = new Date(Date.now() - 600_000).toISOString();
  await withApi(async (api) => {
    const dir = checkout();
    writeFileSync(join(dir, "assignments", "exam.yml"), assignmentYaml(NEW));
    // The stop at the old instant (released when the deadline moved), and the
    // stop at the new one, each watching alice's repository.
    writeFileSync(join(dir, "lockdowns", "exam", "sentinel-k1.json"), JSON.stringify({
      schema_version: 1, assignment_id: "exam", outcome: "fired", deadline_at: OLD, stop: "done", samples: [{ observed_at: OLD, pushed_at: { "exam-alice": OLD } }] }));
    writeFileSync(join(dir, "lockdowns", "exam", "sentinel-k2.json"), JSON.stringify({
      schema_version: 1, assignment_id: "exam", outcome: "fired", deadline_at: NEW, stop: "done", samples: [{ observed_at: NEW, pushed_at: { "exam-alice": NEW } }] }));
    const res = await run(dir, api);
    assert.equal(res.status, 0, res.log);
    const alice = row(res.record, "alice");
    assert.equal(alice.lockdown_at, NEW, "the stop that held her");
    assert.equal(alice.uncertainty_seconds, 0);
    assert.equal(res.record.max_uncertainty_seconds, 0);
  }, { remote: { assignment: assignmentYaml(NEW) } });
});

test("R7-8: only the old instant's stop, under a deadline since moved: not credited, so never before the deadline", async () => {
  const OLD = new Date(Date.now() - 7200_000).toISOString();
  const NEW = new Date(Date.now() - 600_000).toISOString();
  await withApi(async (api) => {
    const dir = checkout();
    writeFileSync(join(dir, "assignments", "exam.yml"), assignmentYaml(NEW));
    writeFileSync(join(dir, "lockdowns", "exam", "sentinel-k1.json"), JSON.stringify({
      schema_version: 1, assignment_id: "exam", outcome: "fired", deadline_at: OLD, stop: "done", samples: [{ observed_at: OLD, pushed_at: { "exam-alice": OLD } }] }));
    const res = await run(dir, api);
    assert.equal(res.status, 0, res.log);
    const alice = row(res.record, "alice");
    assert.notEqual(alice.lockdown_at, OLD, "a stop for a deadline no longer in force is not her lock time");
    assert.ok(alice.uncertainty_seconds >= 590, `locked by this run, ten minutes after her deadline (${alice.uncertainty_seconds}s)`);
  }, { remote: { assignment: assignmentYaml(NEW) } });
});

test("R7-8: a row an earlier pass locked keeps its figure when the deadline moved later since - never negative", async () => {
  const LOCKED_AT = new Date(Date.now() - 3000_000).toISOString();
  const MOVED = new Date(Date.now() - 60_000).toISOString();
  await withApi(async (api) => {
    const dir = checkout();
    writeFileSync(join(dir, "assignments", "exam.yml"), assignmentYaml(MOVED));
    writeFileSync(join(dir, "lockdowns", "exam", "lockdown-record.json"), JSON.stringify({
      schema_version: 1, assignment_id: "exam", locked_at: LOCKED_AT, finalize_attempts: 1,
      results: [
        { github_login: "alice", repo_name: "TestOrg/exam-alice", repo_id: 42, snapshot_sha: HEAD_SHA, snapshot_ref: "refs/heads/main",
          lockdown_at: LOCKED_AT, lock_method: "org-ruleset", verified: true, uncertainty_seconds: 12 },
      ],
    }));
    const res = await run(dir, api);
    assert.equal(res.status, 0, res.log);
    const alice = row(res.record, "alice");
    assert.equal(alice.lockdown_at, LOCKED_AT, "history");
    assert.equal(alice.uncertainty_seconds, 12, "the figure the pass that locked her measured, not lock time minus the moved deadline");
  }, { remote: { assignment: assignmentYaml(MOVED) }, orgIds: [42] });
});

// R7-3: a reopen with time on it - the deadline in force after the reopen -
// ends at that time: deferred until it, then locked again with a fresh snapshot.
const OLD_SHA = "0".repeat(40);
const reopenRecord = (at) => ({ schema_version: 1, assignment_id: "exam", github_login: "alice", unlocked_at: at, unlocked_by: "lecturer", reason: "more time", snapshot_sha: OLD_SHA, lock_method: "org-ruleset" });
const reopenedRow = (at) => ({ github_login: "alice", repo_name: "TestOrg/exam-alice", repo_id: 42, snapshot_sha: OLD_SHA, snapshot_ref: "refs/heads/main",
  lockdown_at: null, lock_method: null, reopened_at: at, permission_after: null, verified: false, uncertainty_seconds: null });
function priorRecord(dir, rows) {
  writeFileSync(join(dir, "lockdowns", "exam", "lockdown-record.json"), JSON.stringify({ schema_version: 1, assignment_id: "exam", locked_at: DEADLINE, finalize_attempts: 1, results: rows }));
}

test("R7-3: reopened, and the deadline moved later: open until it, recorded as reopened and deferred to it", async () => {
  const REOPENED = new Date(Date.now() - 300_000).toISOString();
  await withApi(async (api, { writes }) => {
    const dir = checkout();
    priorRecord(dir, [reopenedRow(REOPENED)]);
    const res = await run(dir, api);
    assert.equal(res.status, 0, res.log);
    const alice = row(res.record, "alice");
    assert.equal(alice.deferred_until, new Date(LATER).toISOString(), "the queue comes back at their deadline");
    assert.equal(alice.reopened_at, REOPENED, "and the row still says a lecturer reopened it");
    assert.equal(alice.snapshot_sha, null);
    assert.equal(writes.some((w) => /rulesets|collaborators\/alice$/.test(w.url) && w.method !== "GET" && w.body?.permission === "pull"), false, "nothing locks them now");
    assert.match(res.log, /left open until .* locked again then/);
  }, { remote: { assignment: assignmentYaml(LATER), unlocked: { alice: reopenRecord(REOPENED) } } });
});

test("R7-3: at that deadline they are locked again with a FRESH snapshot, not the one the reopen carried", async () => {
  const REOPENED = new Date(Date.now() - 3600_000).toISOString();
  const MOVED = new Date(Date.now() - 600_000).toISOString(); // after the reopen, and passed
  await withApi(async (api) => {
    const dir = checkout();
    writeFileSync(join(dir, "assignments", "exam.yml"), assignmentYaml(MOVED));
    priorRecord(dir, [{ ...reopenedRow(REOPENED), snapshot_sha: null, deferred_until: MOVED, deferred_reason: "reopened by lecturer until their deadline" }]);
    const res = await run(dir, api);
    assert.equal(res.status, 0, res.log);
    const alice = row(res.record, "alice");
    assert.equal(alice.snapshot_sha, HEAD_SHA, "what they did since the reopen");
    assert.equal(alice.relocked_after, REOPENED);
    assert.ok(alice.lock_method, "locked");
    assert.equal(alice.reopened_at, undefined, "no longer open");
    assert.match(res.log, /locked again - reopened at/);
  }, { remote: { assignment: assignmentYaml(MOVED), unlocked: { alice: reopenRecord(REOPENED) } } });
});

test("R7-3: no pass in between - the reopened row's old snapshot is still not frozen over the new lock", async () => {
  const REOPENED = new Date(Date.now() - 3600_000).toISOString();
  const MOVED = new Date(Date.now() - 600_000).toISOString();
  await withApi(async (api) => {
    const dir = checkout();
    writeFileSync(join(dir, "assignments", "exam.yml"), assignmentYaml(MOVED));
    priorRecord(dir, [reopenedRow(REOPENED)]);
    const res = await run(dir, api);
    assert.equal(res.status, 0, res.log);
    assert.equal(row(res.record, "alice").snapshot_sha, HEAD_SHA);
  }, { remote: { assignment: assignmentYaml(MOVED), unlocked: { alice: reopenRecord(REOPENED) } } });
});

test("R7-3: once locked again, a later pass keeps that lock and its snapshot - no second re-lock", async () => {
  const REOPENED = new Date(Date.now() - 3600_000).toISOString();
  const MOVED = new Date(Date.now() - 1200_000).toISOString();
  const RELOCKED_AT = new Date(Date.now() - 1100_000).toISOString();
  const SECOND = "2".repeat(40);
  await withApi(async (api) => {
    const dir = checkout();
    writeFileSync(join(dir, "assignments", "exam.yml"), assignmentYaml(MOVED));
    priorRecord(dir, [{ github_login: "alice", repo_name: "TestOrg/exam-alice", repo_id: 42, snapshot_sha: SECOND, snapshot_ref: "refs/heads/main",
      lockdown_at: RELOCKED_AT, lock_method: "org-ruleset", verified: true, uncertainty_seconds: 100, relocked_after: REOPENED }]);
    const res = await run(dir, api);
    assert.equal(res.status, 0, res.log);
    const alice = row(res.record, "alice");
    assert.equal(alice.snapshot_sha, SECOND, "frozen, as any lock");
    assert.equal(alice.lockdown_at, RELOCKED_AT);
    assert.equal(alice.relocked_after, REOPENED, "carried");
  }, { remote: { assignment: assignmentYaml(MOVED), unlocked: { alice: reopenRecord(REOPENED) } }, orgIds: [42] });
});

test("R7-3: a reopen made after the deadline in force stays open, as it always has", async () => {
  const REOPENED = new Date(Date.now() - 60_000).toISOString(); // after the deadline ten minutes ago
  await withApi(async (api) => {
    const dir = checkout();
    priorRecord(dir, [reopenedRow(REOPENED)]);
    const res = await run(dir, api);
    assert.equal(res.status, 0, res.log);
    const alice = row(res.record, "alice");
    assert.equal(alice.lock_method, null);
    assert.equal(alice.reopened_at, REOPENED);
    assert.equal(alice.deferred_until, undefined);
    assert.match(res.log, /left open - reopened by/);
  }, { remote: { assignment: assignmentYaml(DEADLINE), unlocked: { alice: reopenRecord(REOPENED) } } });
});

test("R7-22: a student whose own stop failed is not given a LATER stop's HEAD as their submission", async () => {
  // Their stop at the deadline failed; an extension's sentinel stopped the
  // cohort ten minutes later. They pushed in between. The later stop is when
  // they were stopped, not the state at their deadline.
  const D = new Date(Date.now() - 1800_000).toISOString();
  const E = new Date(Date.now() - 600_000).toISOString();
  const ASOF = "3".repeat(40);
  await withApi(async (api) => {
    const dir = checkout();
    writeFileSync(join(dir, "assignments", "exam.yml"), assignmentYaml(D));
    writeFileSync(join(dir, "lockdowns", "exam", "sentinel-k1.json"), JSON.stringify({
      schema_version: 1, assignment_id: "exam", outcome: "fired", deadline_at: D, stop: "failed", samples: [{ observed_at: D, pushed_at: { "exam-alice": D } }] }));
    writeFileSync(join(dir, "lockdowns", "exam", "sentinel-k2.json"), JSON.stringify({
      schema_version: 1, assignment_id: "exam", outcome: "fired", deadline_at: E, stop: "done", samples: [{ observed_at: E, pushed_at: { "exam-alice": E } }] }));
    const res = await run(dir, api);
    assert.equal(res.status, 0, res.log);
    const alice = row(res.record, "alice");
    assert.equal(alice.snapshot_sha, ASOF, "rebuilt as of her deadline, not HEAD");
    assert.equal(alice.reconstructed, true);
    assert.equal(alice.lockdown_at, E, "stopped at the later stop, which is true");
  }, {
    remote: { assignment: assignmentYaml(D) },
    repoMeta: { pushed_at: new Date(Date.parse(E) - 60_000).toISOString(), created_at: new Date(Date.now() - 86400_000).toISOString() },
    asOf: { sha: ASOF, parents: [{ sha: "4".repeat(40) }], commit: { committer: { date: new Date(Date.parse(D) - 3600_000).toISOString() }, author: { name: "a" } } },
  });
});

test("R7-24: a student locked with nothing handed in is not deferred and released by a deadline moved later", async () => {
  const LATER_D = new Date(Date.now() + 3600_000).toISOString();
  await withApi(async (api, { writes }) => {
    const dir = checkout();
    priorRecord(dir, [{ github_login: "alice", repo_name: "TestOrg/exam-alice", repo_id: 42, snapshot_sha: null, snapshot_ref: "refs/heads/main",
      no_submission: true, verified: true, lockdown_at: DEADLINE, lock_method: "org-ruleset", uncertainty_seconds: 0 }]);
    const res = await run(dir, api);
    assert.equal(res.status, 0, res.log);
    const alice = row(res.record, "alice");
    assert.equal(alice.deferred_until, undefined, "her lock was taken; more time does not undo it");
    assert.equal(alice.lockdown_at, DEADLINE);
    assert.equal(writes.some((w) => w.method === "PUT" && /rulesets\/7$/.test(w.url) && !(w.body?.conditions?.repository_id?.repository_ids ?? [42]).includes(42)), false, "not taken out of the stop");
  }, { remote: { assignment: assignmentYaml(LATER_D) }, orgIds: [42] });
});

test("R7-24: a student locked again since the reopen, then given more time, stays locked", async () => {
  const REOPENED = new Date(Date.now() - 7200_000).toISOString();
  const RELOCKED_AT = new Date(Date.now() - 3600_000).toISOString();
  const LATER_D = new Date(Date.now() + 3600_000).toISOString();
  await withApi(async (api) => {
    const dir = checkout();
    priorRecord(dir, [{ github_login: "alice", repo_name: "TestOrg/exam-alice", repo_id: 42, snapshot_sha: "2".repeat(40), snapshot_ref: "refs/heads/main",
      lockdown_at: RELOCKED_AT, lock_method: "org-ruleset", verified: true, uncertainty_seconds: 5, relocked_after: REOPENED }]);
    const res = await run(dir, api);
    assert.equal(res.status, 0, res.log);
    const alice = row(res.record, "alice");
    assert.equal(alice.deferred_until, undefined, "a lock since the reopen is a lock like any other");
    assert.equal(alice.snapshot_sha, "2".repeat(40));
    assert.equal(alice.lockdown_at, RELOCKED_AT);
  }, { remote: { assignment: assignmentYaml(LATER_D), unlocked: { alice: reopenRecord(REOPENED) } }, orgIds: [42] });
});

test("R7-17: deleted while this ran - GitHub's listing no longer names it - nothing is locked and no record written", async () => {
  await withApi(async (api, { writes }) => {
    const dir = checkout();
    const res = await run(dir, api);
    assert.equal(res.status, 0, res.log);
    assert.match(res.log, /was deleted while this ran - nothing is locked/);
    assert.deepEqual(writes, [], "no ruleset made again, nobody demoted");
    assert.equal(res.record, null, "no record for an assignment nobody has");
  }, { remote: { listing: ["other.yml"] } });
});

test("a listing that still names it, with the file unreadable, is not a deletion: the checkout decides", async () => {
  await withApi(async (api) => {
    const res = await run(checkout(), api);
    assert.equal(res.status, 0, res.log);
    assert.doesNotMatch(res.log, /was deleted/);
    assert.ok(res.record, "locked from the checkout as before");
  }, { remote: { listing: ["exam.yml"] } });
});

test("without a fired sentinel a deferred student's repository is asked nothing, and nothing is written", async () => {
  await withApi(async (api, { calls, writes }) => {
    const dir = checkout();
    writeFileSync(join(dir, "lockdowns", "exam", "sentinel-k1.json"), JSON.stringify({ schema_version: 1, assignment_id: "exam", outcome: "gave-up:runtime", deadline_at: DEADLINE }));
    const res = await run(dir, api);
    assert.equal(res.status, 0, res.log);
    assert.deepEqual(calls.filter((c) => c.includes("exam-alice")), []);
    assert.deepEqual(writes, []);
  }, { remote: { overrides: { alice: extension(LATER) } } });
});
