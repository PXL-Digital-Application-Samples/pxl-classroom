// Whether saving a published assignment also dispatches the publish workflow.
//
// The decision used to live inline in AdminView's click handler as
// `if (brokerExists.value === false)`, where nothing could run it. `brokerExists`
// has three states and that test read the third one - `null`, meaning nobody has
// looked yet - as "the broker is fine". The panel is in exactly that state from
// the moment it opens until verifyLiveInfrastructure() resolves, so a save
// inside that window dispatched nothing and reported nothing.
//
// Imported, not re-implemented: a test that restates `!== true` would pass
// against a component that had drifted away from it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { hasStudentCard } from "../lib/student-card.mjs";

import {
  deadlineReopens,
  saveReopens,
  needsBrokerDispatch,
  publishedSaveWorkflow,
  stillLockedCount,
  stillLockedMessage,
  writeReachesStudentPage,
} from "../frontend/src/lib/publish.js";

// R7-3 (review 2026-10-16): a later deadline does not reach a student the lock
// already holds, and the save says so, with the way to give them the time.
const SHA = "a".repeat(40);
const lockedRow = (login, extra = {}) => ({ github_login: login, repo_name: `O/exam-${login.toLowerCase()}`, snapshot_sha: SHA, lockdown_at: "2026-10-15T22:00:00Z", verified: true, lock_method: "org-ruleset", ...extra });

test("stillLockedCount: students a lock still holds, each once", () => {
  const record = { results: [
    lockedRow("Alice"),
    lockedRow("alice"),
    lockedRow("bob", { lock_method: "demotion" }),
    { github_login: "cleo", lock_method: null, reopened_at: "2026-10-16T10:00:00Z" },
    lockedRow("dan", { reopened_at: "2026-10-16T10:00:00Z" }),
    { github_login: "eve", lock_method: null, deferred_until: "2030-01-01T00:00:00Z", snapshot_sha: null },
    lockedRow("finn", { lock_method: "none" }),
    // Locked with nothing handed in is locked (lib/lock-rows.mjs).
    lockedRow("gil", { snapshot_sha: null, no_submission: true }),
  ] };
  assert.equal(stillLockedCount(record), 3, "alice (one login, two spellings), bob and gil");
  assert.equal(stillLockedCount(null), 0);
  assert.equal(stillLockedCount({}), 0);
});

// R7-35: a student reopened is let in at once, while their row says locked
// until a later pass - counted from the row alone, every save said they stayed.
test("stillLockedCount: a student with a reopen record is not counted, unless locked again since", () => {
  const record = { results: [lockedRow("alice"), lockedRow("bob"), lockedRow("cleo", { lockdown_at: "2026-10-16T12:00:00Z" }),
    lockedRow("dan", { repo_name: "O/grp-a" }), lockedRow("eve", { repo_name: "O/grp-a" })] };
  const reopens = [
    { github_login: "alice", repo_name: "O/exam-alice", unlocked_at: "2026-10-16T09:00:00Z" },
    { github_login: "cleo", repo_name: "O/exam-cleo", unlocked_at: "2026-10-16T09:00:00Z" },
    // A team's repository is reopened for every member by the one clicked.
    { github_login: "dan", repo_name: "O/grp-a", unlocked_at: "2026-10-16T09:00:00Z" },
  ];
  assert.equal(stillLockedCount(record, reopens), 2, "bob, and cleo who was locked again after her reopen");
});

test("stillLockedMessage says who stays locked and how to give them time, after the Saved toast rather than as a second one", () => {
  assert.match(stillLockedMessage(1), /^1 student stays locked/);
  assert.match(stillLockedMessage(3), /3 students stay locked.*Reopen those who need the time.*locked again at the new deadline/);
});

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("a broker positively found is the only reason to skip the dispatch", () => {
  assert.equal(needsBrokerDispatch(true), false);
});

test("a broker looked for and missing dispatches", () => {
  assert.equal(needsBrokerDispatch(false), true);
});

test("NOT YET LOOKED is not the same answer as fine", () => {
  // The regression. `null` is the panel's opening state, and reading it as
  // "fine" is what let a published assignment exist with no broker behind it.
  assert.equal(needsBrokerDispatch(null), true);
  assert.equal(needsBrokerDispatch(undefined), true);
});

test("nothing truthy-but-not-true counts as a sighting", () => {
  // Fails toward doing the work. A stray string or object is not evidence that
  // a broker exists, and treating it as such is the same class of mistake.
  assert.equal(needsBrokerDispatch("true"), true);
  assert.equal(needsBrokerDispatch(1), true);
  assert.equal(needsBrokerDispatch({}), true);
});

// PXL-2TIN-NetAdv-26-27, 2026-09-16. The broker existed, so saving the edit that
// ticked require_claim dispatched NOTHING: the hub enforced the new document and
// the student page kept the old card, which never asked for an address.
test("a save with the broker found still rebuilds the student page", () => {
  assert.equal(publishedSaveWorkflow(true), "regenerate-dashboard.yml");
});

// PXL-2TIN-DevOps-2627/groepsindeling, 2026-10-16: the nightly had switched the
// broker off at the old deadline; moving the deadline found the broker
// repository there and only rebuilt the page, so every acceptance hung.
test("a save that moves a passed deadline into the future publishes, broker or not", () => {
  assert.equal(publishedSaveWorkflow(true, { reopens: true }), "publish-assignment.yml");
  assert.equal(publishedSaveWorkflow(true, { reopens: false }), "regenerate-dashboard.yml");
});

test("saveReopens (F5): decided from what GitHub holds at the click, never the tab's loaded copy", () => {
  const now = Date.parse("2026-10-16T10:00:00Z");
  const past = "2026-10-14T21:59:00.000Z";
  const future = "2026-10-16T21:59:00.000Z";
  // The stored deadline passed: reopens, lock or not.
  assert.equal(saveReopens({ storedDeadline: past, newDeadline: future, lockStatus: 404, now }), true);
  // Two saves in one tab: the first moved it into the past, the nightly locked
  // it, the second moves it out again. The STORED deadline (the past one) and
  // the lock both say so, whatever the tab loaded.
  assert.equal(saveReopens({ storedDeadline: past, newDeadline: future, lockStatus: 200, now }), true);
  // Stored in the future but a lock record exists: finished and switched off.
  assert.equal(saveReopens({ storedDeadline: future, newDeadline: "2026-10-17T21:59:00.000Z", lockStatus: 200, now }), true);
  // An unreadable lock record publishes: an open broker published again changes nothing.
  assert.equal(saveReopens({ storedDeadline: future, newDeadline: "2026-10-17T21:59:00.000Z", lockStatus: 502, now }), true);
  // Never finished and still ahead: an ordinary edit.
  assert.equal(saveReopens({ storedDeadline: future, newDeadline: "2026-10-17T21:59:00.000Z", lockStatus: 404, now }), false);
  // A deadline that ends up in the past reopens nothing.
  assert.equal(saveReopens({ storedDeadline: past, newDeadline: "2026-10-15T21:59:00.000Z", lockStatus: 200, now }), false);
});

test("deadlineReopens: from the past into the future, and nothing else", () => {
  const now = Date.parse("2026-10-16T10:00:00Z");
  const past = "2026-10-14T21:59:00.000Z";
  const future = "2026-10-16T21:59:00.000Z";
  assert.equal(deadlineReopens(past, future, now), true);
  assert.equal(deadlineReopens(past, "2026-10-15T21:59:00.000Z", now), false, "still in the past");
  assert.equal(deadlineReopens(future, "2026-10-20T21:59:00.000Z", now), false, "it never passed");
  assert.equal(deadlineReopens(past, past, now), false, "not moved");
  assert.equal(deadlineReopens("2026-10-16T10:00:00.000Z", future, now), true, "a deadline at this very instant has passed");
  for (const bad of ["", null, undefined, "garbage"]) {
    assert.equal(deadlineReopens(bad, future, now), false);
    assert.equal(deadlineReopens(past, bad, now), false);
  }
});

test("a save that publishes does not also regenerate - the publish does that itself", () => {
  for (const unknown of [false, null, undefined, "true"]) {
    assert.equal(publishedSaveWorkflow(unknown), "publish-assignment.yml");
  }
  const publish = readFileSync(join(ROOT, ".github", "workflows", "publish-assignment.yml"), "utf8");
  assert.match(
    publish,
    /workflows\/regenerate-dashboard\.yml\/dispatches/,
    "publish-assignment.yml no longer regenerates the student pages, so a save that publishes must",
  );
});

test("both answers name a workflow that exists", () => {
  for (const brokerExists of [true, false]) {
    const file = join(ROOT, ".github", "workflows", publishedSaveWorkflow(brokerExists));
    assert.ok(existsSync(file), `${file} does not exist - the dispatch would 404`);
  }
});

// The generator's own filter, read rather than restated. A state added to it
// and not here is a card students read that no lecturer write refreshes.
// Which states have a card: asked of the function the generator itself
// filters by (lib/student-card.mjs), and checked that it still does.
function cardStates() {
  const source = readFileSync(join(ROOT, "pages", "generate.mjs"), "utf8");
  assert.match(source, /if \(!hasStudentCard\(def\)\) continue;/, "pages/generate.mjs no longer filters cards by hasStudentCard");
  return ["draft", "published", "closed", "archived"].filter((state) => hasStudentCard({ state }));
}

test("a write reaches the student page whenever either side has a card", () => {
  const withCard = cardStates();
  assert.deepEqual([...withCard].sort(), ["closed", "published"]);
  const states = ["draft", "published", "closed", "archived"];
  for (const before of states) {
    for (const after of states) {
      assert.equal(
        writeReachesStudentPage(before, after),
        withCard.includes(before) || withCard.includes(after),
        `${before} -> ${after}`,
      );
    }
  }
});

test("draft to draft and archived to archived touch nothing a student reads", () => {
  assert.equal(writeReachesStudentPage("draft", "draft"), false);
  assert.equal(writeReachesStudentPage("archived", "draft"), false);
});
