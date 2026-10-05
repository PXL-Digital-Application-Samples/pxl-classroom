// The assignment header's state button (frontend/src/lib/state-actions.js).
//
// Every entry is a promise about what happens when it is clicked, so the
// rules here are DESIGN.md §1.5's: nothing on the menu may describe behaviour
// the system does not have.

import { test } from "node:test";
import assert from "node:assert/strict";
import { stateActions } from "../frontend/src/lib/state-actions.js";

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
