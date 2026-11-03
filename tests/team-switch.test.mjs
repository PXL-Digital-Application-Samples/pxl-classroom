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

test("a switch is an acceptance, so the acceptance deadline closes it first", () => {
  // `accepts_until` (lib/acceptance-window.mjs): the hub refuses a switch
  // after it as it refuses any acceptance, so the card names that date.
  const CLOSES = "2026-10-13T20:00:00.000Z";
  const a = { ...open, accepts_until: CLOSES };
  assert.deepEqual(teamSwitchWindow({ canChooseAnother: true, assignment: a, now: at("2026-10-13T19:59:00Z") }), { can: true, until: CLOSES });
  assert.deepEqual(teamSwitchWindow({ canChooseAnother: true, assignment: a, now: at("2026-10-13T20:00:01Z") }), { can: false, until: CLOSES });
  // One after the deadline is never reached: the deadline is still the date.
  assert.equal(teamSwitchWindow({ canChooseAnother: true, assignment: { ...open, accepts_until: "2026-10-21T20:00:00.000Z" }, now: 0 }).until, DEADLINE);
  // And before the assignment opens, no switch either: the hub refuses one as
  // not-open, which the old rule did not know (review 2026-11-03).
  assert.equal(teamSwitchWindow({ canChooseAnother: true, assignment: { ...open, opens_at: "2026-10-01T00:00:00Z" }, now: at("2026-09-30T00:00:00Z") }).can, false);
});
