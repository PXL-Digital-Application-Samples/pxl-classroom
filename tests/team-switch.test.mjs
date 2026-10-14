// frontend/src/lib/team-switch.js - whether a student may still switch team,
// and until when: the hub's rule, by the assignment's deadline (TS-1, T4).

import { test } from "node:test";
import assert from "node:assert/strict";
import { teamSwitchWindow } from "../frontend/src/lib/team-switch.js";

const DEADLINE = "2026-10-20T20:00:00.000Z";
const at = (iso) => Date.parse(iso);
const open = { state: "published", deadline_at: DEADLINE };

test("before the assignment's deadline a self-service student may switch, until that deadline", () => {
  assert.deepEqual(teamSwitchWindow({ canChooseAnother: true, assignment: open, now: at("2026-10-20T19:59:00Z") }), { can: true, until: DEADLINE });
  assert.equal(teamSwitchWindow({ canChooseAnother: true, assignment: open, now: at(DEADLINE) }).can, true, "at the deadline itself, still");
});

test("after it, never - whatever extension the student has: the hub reads none for a switch", () => {
  assert.equal(teamSwitchWindow({ canChooseAnother: true, assignment: open, now: at("2026-10-20T20:00:01Z") }).can, false);
  // The `until` is the assignment's, never a later date the card might know.
  assert.equal(teamSwitchWindow({ canChooseAnother: true, assignment: open, now: 0 }).until, DEADLINE);
});

test("not self-service, not accepting, or no deadline", () => {
  assert.equal(teamSwitchWindow({ canChooseAnother: false, assignment: open, now: 0 }).can, false, "pre-assigned");
  assert.equal(teamSwitchWindow({ canChooseAnother: true, assignment: { ...open, state: "closed" }, now: 0 }).can, false, "stopped accepting");
  assert.deepEqual(teamSwitchWindow({ canChooseAnother: true, assignment: { state: "published" }, now: Date.now() }), { can: true, until: null }, "no deadline: open while accepting, and no date named");
  assert.equal(teamSwitchWindow({ canChooseAnother: true, assignment: null, now: 0 }).can, false);
});
