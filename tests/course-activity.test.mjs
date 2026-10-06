// lib/course-activity.mjs: one assignment's activity in plain words.

import { test } from "node:test";
import assert from "node:assert/strict";
import { activitySummary } from "../lib/course-activity.mjs";

const now = new Date("2026-10-02T15:00:00Z");
const entry = (over = {}) => ({
  title: "Lab 3", state: "published", total_students: 42, accepted: 41, on_time: 0, late: 0, no_submission: 41,
  deadline_at: "2026-10-09T21:59:00Z", generated_at: "2026-10-02T02:00:00Z", ...over,
});

test("a running assignment says how many accepted and who was turned away", () => {
  const s = activitySummary({ entry: entry(), refused: 2, now });
  assert.deepEqual(s.phrases, ["41 of 42 accepted", "2 students turned away"]);
  assert.equal(s.checkedAt, "2026-10-02T02:00:00Z");
  assert.equal(s.attention, false);
});

test("after the deadline: locked or not, and who handed in", () => {
  const past = entry({ deadline_at: "2026-10-01T21:59:00Z", on_time: 38, late: 1, no_submission: 2, accepted: 41, total_students: 41 });
  assert.deepEqual(activitySummary({ entry: past, lock: { locked_count: 41, error_count: 0 }, now }).phrases, [
    "41 accepted", "locked at the deadline (41 repositories)", "38 on time, 1 late, 2 without a submission",
  ]);
  const notYet = activitySummary({ entry: past, now });
  assert.match(notYet.phrases[1], /not locked yet/);
  const failed = activitySummary({ entry: past, lock: { locked_count: 39, error_count: 2 }, now });
  assert.equal(failed.attention, true);
  assert.ok(failed.phrases.includes("2 repositories could not be locked"));
  // late_policy: report with lock-down off writes a record that locks nothing.
  const reportOnly = activitySummary({ entry: past, lock: { lock_method: "none", locked_count: 0, error_count: 0 }, now });
  assert.equal(reportOnly.phrases[1], "work collected at the deadline - this assignment does not lock");
  assert.ok(!reportOnly.phrases.some((p) => /locked at the deadline/.test(p)));
});

test("a draft and a missing report say so", () => {
  assert.deepEqual(activitySummary({ entry: entry({ state: "draft" }), now }).phrases, ["draft - students cannot accept yet"]);
  assert.deepEqual(activitySummary({ entry: null, now }).phrases, ["no report yet"]);
});

test("one is one", () => {
  assert.deepEqual(activitySummary({ entry: entry({ accepted: 1, total_students: 1 }), refused: 1, now }).phrases, ["1 accepted", "1 student turned away"]);
});
