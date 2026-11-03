// The assignment header's state button (frontend/src/lib/state-actions.js).
//
// Every entry is a promise about what happens when it is clicked, so the
// rules here are DESIGN.md §1.5's: nothing on the menu may describe behaviour
// the system does not have.

import { test } from "node:test";
import assert from "node:assert/strict";
import { stateActions, everPublished } from "../frontend/src/lib/state-actions.js";

const STATES = ["draft", "published", "closed", "archived"];

test("reopening is never offered once the deadline has passed", () => {
  // Past it, every acceptance is refused as too late, and publishing an
  // assignment that was locked at its deadline is refused outright
  // (lib/finished-assignment.mjs). What is offered instead is the step that
  // makes reopening possible.
  for (const state of STATES) {
    const keys = stateActions({ state, deadlinePassed: true }).map((a) => a.key);
    assert.ok(!keys.includes("reopen"), `${state}: no Reopen past the deadline`);
  }
  for (const state of ["closed", "archived"]) {
    const keys = stateActions({ state, deadlinePassed: true }).map((a) => a.key);
    assert.ok(keys.includes("edit-deadline"), `${state}: offers to move the deadline instead`);
    assert.ok(stateActions({ state }).some((a) => a.key === "reopen"), `${state}: Reopen before the deadline`);
  }
});

test("locking everyone out is offered only after the deadline, and does not claim to be final", () => {
  for (const state of STATES) {
    assert.ok(!stateActions({ state }).some((a) => a.key === "freeze"), `${state}: no lock before the deadline`);
  }
  const freeze = stateActions({ state: "closed", deadlinePassed: true }).find((a) => a.key === "freeze");
  assert.ok(freeze?.danger, "and it is marked destructive");
  // A student can be let back in from their row, so "cannot be undone" would
  // be a lie on the most consequential entry in the menu.
  assert.doesNotMatch(freeze.sub, /cannot be undone/i);
  // Not "every student's write access" (R7-34): false under "Nothing is
  // locked", and for every student deferred or reopened.
  assert.doesNotMatch(freeze.sub, /every student's write access/);
  assert.match(freeze.sub, /every student whose deadline has passed/);
});

test("delete is offered only where nobody can still be accepting", () => {
  // Deleting takes the broker away; a published assignment is stopped first.
  assert.ok(!stateActions({ state: "published" }).some((a) => /delete/.test(a.key)));
  assert.ok(stateActions({ state: "draft" }).some((a) => a.key === "delete-draft"));
  for (const state of ["closed", "archived"]) {
    assert.ok(stateActions({ state }).some((a) => a.key === "delete"), `${state} can be deleted`);
  }
});

test("destructive entries come last, so the menu separates them once", () => {
  for (const state of STATES) {
    for (const deadlinePassed of [false, true]) {
      const list = stateActions({ state, deadlinePassed });
      const firstDanger = list.findIndex((a) => a.danger);
      if (firstDanger < 0) continue;
      assert.ok(list.slice(firstDanger).every((a) => a.danger), `${state}${deadlinePassed ? " past deadline" : ""}: nothing safe after a destructive entry`);
    }
  }
});

test("an unknown state offers nothing rather than guessing", () => {
  assert.deepEqual(stateActions({ state: null }), []);
  assert.deepEqual(stateActions({ state: "something-new" }), []);
});

test("a draft that was published before is deleted in full, never as a bare file", () => {
  // Back to draft, then Delete draft, removed the YAML alone: the public
  // broker kept its key and acceptance, with nothing left to close it, under
  // a confirmation saying nobody could have accepted.
  const fresh = stateActions({ state: "draft", everPublished: false }).map((a) => a.key);
  assert.ok(fresh.includes("delete-draft") && !fresh.includes("delete"));
  const once = stateActions({ state: "draft", everPublished: true }).map((a) => a.key);
  assert.ok(once.includes("delete") && !once.includes("delete-draft"));

  assert.equal(everPublished({ state: "draft" }), false);
  assert.equal(everPublished({ state: "draft", invite_key: "" }), false, "an empty field is not an invitation");
  for (const f of ["invite_key", "invite_pubkey", "invite_nonce", "invite_token"]) {
    assert.equal(everPublished({ state: "draft", [f]: "x" }), true, f);
  }
  assert.equal(everPublished({ state: "closed" }), true);
  assert.equal(everPublished(null), false);
});

test("past the deadline each line says what it does now, and a lock that already ran is not offered again (live UI, 2026-10-15)", () => {
  const sub = (actions, key) => actions.find((a) => a.key === key)?.sub;
  const before = stateActions({ state: "published", deadlinePassed: false });
  assert.equal(sub(before, "close"), "Nobody new can accept; existing repositories are unaffected");
  assert.equal(sub(before, "draft"), "The invitation link stops working");
  const after = stateActions({ state: "published", deadlinePassed: true });
  assert.equal(sub(after, "close"), "Marks it closed. Nobody could accept after the deadline anyway; repositories are unaffected");
  assert.equal(sub(after, "draft"), "Takes it off the student pages");
  assert.ok(after.some((a) => a.key === "freeze"), "before the lock ran it is the way to run it now");
  for (const state of ["published", "closed"]) {
    const locked = stateActions({ state, deadlinePassed: true, lockRan: true }).map((a) => a.key);
    assert.ok(!locked.includes("freeze"), `${state}: it skips what was reopened and locked the rest, so it changes nothing`);
  }
});

test("past the acceptance deadline, Reopen says what it still does and moving the date is offered beside it", () => {
  // `accepts_until` passed while the deadline has not (lib/acceptance-window.mjs):
  // nobody new can accept, while a student who accepted can still send their
  // invitation again - which Reopen gives back to a closed assignment, so the
  // first version's "no Reopen" blocked exactly that (second review).
  for (const state of ["closed", "archived"]) {
    const list = stateActions({ state, acceptanceClosed: true });
    const reopen = list.find((a) => a.key === "reopen");
    assert.equal(reopen?.sub, "Students who accepted can send their invitation again. Nobody new can accept: the acceptance deadline has passed", `${state}: Reopen, in what it does now`);
    const move = list.find((a) => a.key === "edit-deadline");
    assert.equal(move?.label, "Move the acceptance deadline…", `${state}: and moving the date beside it`);
    assert.ok(list.indexOf(reopen) < list.indexOf(move));
  }
  // The deadline's own entry wins where both have passed, and Reopen goes.
  const both = stateActions({ state: "closed", deadlinePassed: true, acceptanceClosed: true });
  assert.equal(both.find((a) => a.key === "edit-deadline")?.label, "Move the deadline…");
  assert.ok(!both.some((a) => a.key === "reopen"));
  const sub = (actions, key) => actions.find((a) => a.key === key)?.sub;
  assert.equal(sub(stateActions({ state: "published", acceptanceClosed: true }), "close"), "Nobody new can accept already; this also stops students who accepted from sending their invitation again. Repositories are unaffected");
  // Nothing about the lock: that is the deadline's.
  assert.ok(!stateActions({ state: "published", acceptanceClosed: true }).some((a) => a.key === "freeze"));
});

test("Publish says what it does now: a draft past a date that closes acceptance lets nobody accept", () => {
  const sub = (args) => stateActions({ state: "draft", ...args }).find((a) => a.key === "publish")?.sub;
  assert.equal(sub({}), "Creates the invitation and lets students accept");
  assert.equal(sub({ acceptanceClosed: true }), "Creates the invitation. Nobody new can accept: the acceptance deadline has passed");
  assert.equal(sub({ deadlinePassed: true }), "Creates the invitation. Nobody can accept: the deadline has passed");
  assert.equal(sub({ deadlinePassed: true, acceptanceClosed: true }), "Creates the invitation. Nobody can accept: the deadline has passed");
});
