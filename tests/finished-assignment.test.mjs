// Publishing a finished assignment again would reopen it (lib/finished-assignment.mjs).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { republishRefusal } from "../lib/finished-assignment.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const now = new Date("2026-10-02T13:00:00Z");

test("finished is a passed deadline AND a lock that has run", () => {
  assert.match(republishRefusal({ deadlineAt: "2026-09-15T10:04:00Z", lockRan: true, now, assignmentId: "labo-api" }), /labo-api is finished/);
  assert.equal(republishRefusal({ deadlineAt: "2026-09-15T10:04:00Z", lockRan: false, now }), null, "not finalized yet");
  assert.equal(republishRefusal({ deadlineAt: "2026-10-09T21:59:00Z", lockRan: true, now }), null, "a moved deadline reopens it");
  assert.equal(republishRefusal({ deadlineAt: null, lockRan: true, now }), null, "no deadline, nothing to be past");
  assert.equal(republishRefusal({ deadlineAt: "not a date", lockRan: true, now }), null);
});

function controlWith(files) {
  const dir = mkdtempSync(join(tmpdir(), "pxl-finished-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}
const run = (dir, id) =>
  spawnSync("node", [join(root, "scripts", "check-not-finished.mjs")], {
    encoding: "utf8",
    env: { ...process.env, DATA_DIR: dir, ASSIGNMENT_ID: id },
  });

test("the publish step refuses a finished assignment and lets an open one through", () => {
  const finished = controlWith({
    "assignments/labo-api.yml": "state: published\ndeadline_at: 2026-09-15T10:04:00Z\n",
    "lockdowns/labo-api/lockdown-record.json": "{}",
  });
  const refused = run(finished, "labo-api");
  assert.equal(refused.status, 1, refused.stdout);
  assert.match(refused.stdout, /::error::labo-api is finished/);

  const open = controlWith({ "assignments/groepsindeling.yml": "state: published\ndeadline_at: 2026-10-09T21:59:00Z\n" });
  assert.equal(run(open, "groepsindeling").status, 0);

  // YAML parses an unquoted timestamp to a Date; the script must cope.
  const unquoted = controlWith({
    "assignments/old.yml": "deadline_at: 2020-01-01T00:00:00Z\n",
    "lockdowns/old/lockdown-record.json": "{}",
  });
  assert.equal(run(unquoted, "old").status, 1);
});

test("publish-assignment.yml asks before anything writes", () => {
  const wf = parse(readFileSync(join(root, ".github", "workflows", "publish-assignment.yml"), "utf8"));
  const steps = wf.jobs.publish.steps.map((s) => s.name);
  const guard = steps.indexOf("Refuse to reopen a finished assignment");
  assert.ok(guard > 0, "the guard step is gone");
  for (const writer of ["Record prior state", "Mint invitation token", "Create and configure broker repo", "Push broker workflow", "Update assignment state"]) {
    assert.ok(steps.indexOf(writer) > guard, `"${writer}" runs before the guard`);
  }
});
