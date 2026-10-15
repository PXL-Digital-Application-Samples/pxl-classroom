// lib/refresh-status.mjs - what Refresh says about one row before the next
// report rebuild (review 2026-10-14, G13c, TG-6).

import { test } from "node:test";
import assert from "node:assert/strict";
import { refreshStatus } from "../lib/refresh-status.mjs";

const DEADLINE = "2026-09-02T00:00:00Z";
const S = "c".repeat(40);
const read = (over = {}) => refreshStatus({ unstarted: false, sha: S, committedAt: "2026-09-01T12:00:00Z", deadline: DEADLINE, row: {}, ...over });

test("a commit made before the deadline is on time, whenever Refresh is pressed", () => {
  // Pressed two days after the deadline, about a commit from the day before.
  assert.deepEqual(read({ now: Date.parse("2026-09-04T00:00:00Z") }), { submission_status: "on-time", last_on_time_sha: S });
  assert.deepEqual(read({ committedAt: DEADLINE }), { submission_status: "on-time", last_on_time_sha: S }, "at the deadline is on time");
});

test("a commit made after it is late - and after an on-time one too, as the report says (R6-14)", () => {
  assert.deepEqual(read({ committedAt: "2026-09-02T00:00:01Z" }), { submission_status: "late", first_late_sha: S });
  // Refresh said "on time" here while the report, a minute later, said late:
  // under `report` late commits are part of the submission.
  assert.deepEqual(
    read({ committedAt: "2026-09-03T00:00:00Z", row: { submission_status: "on-time", last_on_time_sha: "a".repeat(40) } }),
    { submission_status: "late", first_late_sha: S },
  );
  // The first late commit on record is kept.
  assert.equal(read({ committedAt: "2026-09-03T00:00:00Z", row: { first_late_sha: "f".repeat(40) } }).first_late_sha, "f".repeat(40));
});

test("R6-14: Refresh and the report ask one function, and it says late for late activity after an on-time commit", async () => {
  // report.mjs and refreshStatus both call classifySubmission; the report's
  // own cases are in tests/report.test.mjs.
  const { classifySubmission } = await import("../lib/submission-status.mjs");
  const cases = [
    { lastOnTimeSha: "a", hasLateActivity: true, want: "late" },
    { lastOnTimeSha: "a", hasLateActivity: false, want: "on-time" },
    { lastOnTimeSha: null, hasLateActivity: true, want: "late" },
  ];
  for (const c of cases) {
    assert.equal(classifySubmission({ unstarted: false, latestObservedSha: "x", hasDeadline: true, ...c }), c.want, JSON.stringify(c));
  }
  // An on-time commit now, after a late one on record: late, as the report's
  // observations in that order give.
  assert.equal(read({ row: { first_late_sha: "f".repeat(40) } }).submission_status, "late");
});

test("nothing the student did is no submission; no deadline is unknown; an unreadable commit date falls back to now", () => {
  assert.deepEqual(read({ unstarted: true }), { submission_status: "no-submission" });
  assert.deepEqual(read({ deadline: null }), { submission_status: "unknown" });
  assert.equal(read({ committedAt: null, now: Date.parse("2026-09-01T00:00:00Z") }).submission_status, "on-time");
  assert.equal(read({ committedAt: "garbage", now: Date.parse("2026-09-05T00:00:00Z") }).submission_status, "late");
});
