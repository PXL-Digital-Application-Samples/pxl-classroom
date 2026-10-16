// A broker owed a close and nothing else (review 2026-10-16, R7-4, R7-11).
//
// A publish switched a closed broker on again - the lecturer moved the
// deadline later - and nothing ever closed it again: the first close's record
// still said closed. A rule of times in the queue was tried and reverted
// within the hour (`4ee1236`), because a queued pass runs the WHOLE finalize
// and it reached every assignment ever moved after its lock. So the publish
// marks the broker, and the queue owes it a `close_only` entry, which the
// nightly's finalize leg runs as the broker close and its commit alone.
//
// The other broker nothing closed: an assignment archived or sent back to
// draft with nobody in it, which the finalize never reaches.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { main as markReopened } from "../scripts/mark-broker-reopened.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const queue = join(root, "scripts", "find-finalizable.mjs");
const iso = (ms) => new Date(Date.now() + ms).toISOString();
const HOUR = 3600_000;

/** A control checkout: one assignment, its lock record, its close record, its mark, and whether anyone accepted. */
function control({ yaml, lock = null, closed = null, reopened = null, students = false }) {
  const dir = mkdtempSync(join(tmpdir(), "pxl-close-only-"));
  mkdirSync(join(dir, "assignments"), { recursive: true });
  writeFileSync(join(dir, "assignments", "exam.yml"), yaml);
  mkdirSync(join(dir, "lockdowns", "exam"), { recursive: true });
  if (lock) writeFileSync(join(dir, "lockdowns", "exam", "lockdown-record.json"), JSON.stringify(lock));
  if (closed) writeFileSync(join(dir, "lockdowns", "exam", "broker-closed.json"), JSON.stringify(closed));
  if (reopened) writeFileSync(join(dir, "lockdowns", "exam", "broker-reopened.json"), JSON.stringify(reopened));
  if (students) {
    mkdirSync(join(dir, "repositories", "exam"), { recursive: true });
    writeFileSync(join(dir, "repositories", "exam", "alice.json"), JSON.stringify({ github_login: "alice", repo_name: "O/exam-alice" }));
  }
  return dir;
}

function scan(dir) {
  const res = spawnSync("node", [queue, dir, "O"], { encoding: "utf8", cwd: dir });
  return { list: JSON.parse(res.stdout.trim()), log: res.stderr, active: JSON.parse(readFileSync(join(dir, "active-O.json"), "utf8")).active };
}

const published = (deadline) => `state: published\ndeadline_at: "${deadline}"\ninvite_key: k\n`;
const finished = (lockedAt) => ({ schema_version: 1, assignment_id: "exam", locked_at: lockedAt, finalize_attempts: 1, results: [] });
const closedAt = (at, extra = {}) => ({ schema_version: 1, assignment_id: "exam", broker: "broker-exam", closed: true, key_removed: true, attempts: 0, at, ...extra });

test("R7-4: a broker switched on again after its close, once the deadline in force has passed: the close alone", () => {
  const dir = control({ yaml: published(iso(-HOUR)), lock: finished(iso(-30 * HOUR)), students: true,
    closed: closedAt(iso(-30 * HOUR)), reopened: { reopened_at: iso(-5 * HOUR), deadline_at: iso(-HOUR) } });
  const { list, log, active } = scan(dir);
  assert.deepEqual(list, [{ org: "O", assignment_id: "exam", close_only: true }]);
  assert.match(log, /queueing the broker close alone - broker-reopened/);
  assert.equal(active, 1, "the nightly stays on until it is done");
});

test("R7-4: ...not before the deadline in force, and not once a close since has done it", () => {
  const ahead = control({ yaml: published(iso(HOUR)), lock: finished(iso(-30 * HOUR)), students: true,
    closed: closedAt(iso(-30 * HOUR)), reopened: { reopened_at: iso(-5 * HOUR) } });
  assert.deepEqual(scan(ahead).list, [], "still accepting");
  const done = control({ yaml: published(iso(-HOUR)), lock: finished(iso(-30 * HOUR)), students: true,
    closed: closedAt(iso(-0.5 * HOUR)), reopened: { reopened_at: iso(-5 * HOUR) } });
  assert.deepEqual(scan(done).list, []);
});

test("R7-4: a close since the mark that did not finish is tried again, up to the ceiling", () => {
  const owed = control({ yaml: published(iso(-HOUR)), lock: finished(iso(-30 * HOUR)), students: true,
    closed: closedAt(iso(-0.5 * HOUR), { closed: false, key_removed: false, attempts: 1 }), reopened: { reopened_at: iso(-5 * HOUR) } });
  assert.deepEqual(scan(owed).list, [{ org: "O", assignment_id: "exam", close_only: true }]);
  const spent = control({ yaml: published(iso(-HOUR)), lock: finished(iso(-30 * HOUR)), students: true,
    closed: closedAt(iso(-0.5 * HOUR), { closed: true, key_removed: false, attempts: 3 }), reopened: { reopened_at: iso(-5 * HOUR) } });
  const res = scan(spent);
  assert.deepEqual(res.list, []);
  assert.match(res.log, /not retrying\. Close it by hand/);
});

test("R7-4: other owed work queues the whole finalize, which closes the broker too - never both entries", () => {
  const dir = control({ yaml: published(iso(-HOUR)), students: true, reopened: { reopened_at: iso(-5 * HOUR) } });
  assert.deepEqual(scan(dir).list, [{ org: "O", assignment_id: "exam" }], "not finalized yet: the finalize does it all");
});

test("R7-11: an assignment archived or sent back to draft with nobody in it has its broker closed, alone", () => {
  for (const state of ["archived", "draft"]) {
    const dir = control({ yaml: `state: ${state}\ndeadline_at: "${iso(-HOUR)}"\ninvite_key: k\n` });
    const { list, log } = scan(dir);
    assert.deepEqual(list, [{ org: "O", assignment_id: "exam", close_only: true }], state);
    assert.match(log, new RegExp(`broker-not-closed \\(${state}, nobody accepted\\)`));
  }
});

test("R7-11: ...not one never published, not one already closed, and not last year's", () => {
  assert.deepEqual(scan(control({ yaml: `state: draft\ndeadline_at: "${iso(-HOUR)}"\n` })).list, [], "a draft that never went live has no broker");
  assert.deepEqual(scan(control({ yaml: `state: archived\ndeadline_at: "${iso(-HOUR)}"\ninvite_key: k\n`, closed: closedAt(iso(-0.5 * HOUR)) })).list, []);
  assert.deepEqual(scan(control({ yaml: `state: archived\ndeadline_at: "2026-06-01T10:00:00Z"\ninvite_key: k\n` })).list, [], "before FINALIZE_ANY_STATE_FROM: not swept");
  assert.deepEqual(scan(control({ yaml: `state: archived\ndeadline_at: "${iso(HOUR)}"\ninvite_key: k\n` })).list, [], "deadline ahead");
});

test("a deadline that does not parse queues nothing", () => {
  assert.deepEqual(scan(control({ yaml: `state: published\ndeadline_at: "soon"\ninvite_key: k\n`, students: true })).list, []);
});

test("mark-broker-reopened: written only where a close record is, with the deadline it was reopened to", async () => {
  const never = control({ yaml: published(iso(HOUR)) });
  assert.equal(await markReopened({ assignmentId: "exam", dataDir: never }), 0);
  assert.equal(existsSync(join(never, "lockdowns", "exam", "broker-reopened.json")), false);
  const deadline = iso(HOUR);
  const closed = control({ yaml: published(deadline), closed: closedAt(iso(-30 * HOUR)) });
  const now = new Date();
  assert.equal(await markReopened({ assignmentId: "exam", dataDir: closed, now }), 0);
  const mark = JSON.parse(readFileSync(join(closed, "lockdowns", "exam", "broker-reopened.json"), "utf8"));
  assert.equal(mark.reopened_at, now.toISOString());
  assert.equal(mark.deadline_at, deadline);
});

test("the nightly's finalize leg skips every step but the close and its commit for a close_only entry", () => {
  const wf = parse(readFileSync(join(root, ".github/workflows/daily-activity.yml"), "utf8"));
  const steps = wf.jobs.finalize.steps;
  const cond = (name) => String(steps.find((s) => s.name === name)?.if ?? "");
  for (const name of ["1. Collect", "2. Lockdown", "3. Preserve", "4. Report", "6a. Token for reading scores", "6. Read autograding scores"]) {
    assert.match(cond(name), /matrix\.assignment\.close_only != true/, name);
  }
  for (const name of ["5. Close acceptance on the broker", "Commit + push"]) {
    assert.doesNotMatch(cond(name), /close_only/, name);
  }
});

test("the publish marks the broker before the state commit, and the commit carries the mark", () => {
  const wf = parse(readFileSync(join(root, ".github/workflows/publish-assignment.yml"), "utf8"));
  const names = wf.jobs.publish.steps.map((s) => s.name);
  assert.equal(names.indexOf("Mark a closed broker as on again") + 1, names.indexOf("Update assignment state"));
  const update = wf.jobs.publish.steps.find((s) => s.name === "Update assignment state").run;
  assert.match(update, /MARK="lockdowns\/\$\{ASSIGNMENT_ID\}\/broker-reopened\.json"/);
  assert.match(update, /if \[ -f "control\/\$MARK" \]; then\s+git -C control add "\$MARK"\s+fi/);
});
