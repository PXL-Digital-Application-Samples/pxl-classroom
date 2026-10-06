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

test("a finished JSON assignment is refused too, and a deadline that is not a date is no deadline", () => {
  // The workflow's own validation accepts `<id>.json`, and the nightly
  // finalizes those like any other - reading only `.yml` let one be reopened.
  const json = controlWith({
    "assignments/legacy.json": JSON.stringify({ state: "published", deadline_at: "2026-09-15T10:04:00Z" }),
    "lockdowns/legacy/lockdown-record.json": "{}",
  });
  const refused = run(json, "legacy");
  assert.equal(refused.status, 1, refused.stdout);
  assert.match(refused.stdout, /::error::legacy is finished/);

  const garbage = controlWith({
    "assignments/odd.yml": "state: published\ndeadline_at: not-a-date\n",
    "lockdowns/odd/lockdown-record.json": "{}",
  });
  const odd = run(garbage, "odd");
  assert.equal(odd.status, 0, odd.stderr);
});

test("publish-assignment.yml asks before anything writes", () => {
  const wf = parse(readFileSync(join(root, ".github", "workflows", "publish-assignment.yml"), "utf8"));
  const steps = wf.jobs.publish.steps.map((s) => s.name);
  const guard = steps.indexOf("Refuse to reopen a finished assignment");
  assert.ok(guard > 0, "the guard step is gone");
  for (const writer of ["Mint invitation token", "Create and configure broker repo", "Push broker workflow", "Update assignment state"]) {
    assert.ok(steps.indexOf(writer) > guard, `"${writer}" runs before the guard`);
  }
});

test("a refused publish puts back the state it found, never draft by default", () => {
  // "Record prior state" READS; it ran after the guard, so a refusal skipped
  // it, the revert read the empty output as "not published", and
  // `${PRIOR_STATE:-draft}` turned a finished exam into a draft. It has to run
  // before every step that can fail, and the revert has to need it.
  const wf = parse(readFileSync(join(root, ".github", "workflows", "publish-assignment.yml"), "utf8"));
  const steps = wf.jobs.publish.steps;
  const names = steps.map((s) => s.name);
  const prior = names.indexOf("Record prior state");
  const checkout = names.indexOf("Checkout control repo");
  assert.equal(prior, checkout + 1, "the prior state is read straight after the checkout");
  steps.slice(0, prior).forEach((s) => {
    // Everything before it is the bot guard, the hub checkout, the token and
    // the control checkout - nothing that can refuse a publish.
    const what = s.name || s.uses || "";
    assert.ok(
      ["Reject automated dispatch", "Mint App token for Org", "Checkout control repo"].includes(what) || what.startsWith("actions/checkout@"),
      `"${what}" can fail before the prior state is known`,
    );
  });
  const revert = steps.find((s) => s.name === "Revert to prior state on failure");
  assert.match(revert.if, /steps\.prior\.outcome == 'success'/);
  assert.doesNotMatch(revert.run, /PRIOR_STATE:-/, "an unknown prior state is not a default");
  // The editor writes `published` before dispatching, so it sends what it was.
  assert.ok(wf.on.workflow_dispatch.inputs.prior_state, "prior_state input");
  const admin = readFileSync(join(root, "frontend", "src", "views", "AdminView.vue"), "utf8");
  assert.match(admin, /prior_state:/, "the editor sends prior_state");
});
