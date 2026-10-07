// frontend/src/lib/login-tooltip.js: what hovering a student's login says on
// the Progress and Grading tabs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { commitHeadline, gradingLoginTitle, progressLoginTitle, relationToDeadline } from "../frontend/src/lib/login-tooltip.js";

const fmt = (iso) => `<${iso}>`;
const DEADLINE = "2026-10-12T20:00:00Z";

test("the first line of a commit message, never a paragraph", () => {
  assert.equal(commitHeadline("Fix the playbook\n\nLonger explanation here"), "Fix the playbook");
  assert.equal(commitHeadline("\n\n  Leading blank lines\nsecond"), "Leading blank lines");
  assert.equal(commitHeadline("x".repeat(100)).length, 72);
  assert.ok(commitHeadline("x".repeat(100)).endsWith("…"));
  for (const nothing of [null, undefined, "", 42]) assert.equal(commitHeadline(nothing), "");
});

test("a commit's place against the deadline, both ways, and nothing when either is unknown", () => {
  assert.equal(relationToDeadline("2026-10-12T17:57:00Z", DEADLINE), "2h 3m before the deadline");
  assert.equal(relationToDeadline("2026-10-13T21:00:00Z", DEADLINE), "1d 1h after the deadline");
  assert.equal(relationToDeadline(DEADLINE, DEADLINE), "exactly at the deadline");
  // Minutes round down: "0m" either side is where a lecturer reads closely.
  assert.equal(relationToDeadline("2026-10-12T19:59:30Z", DEADLINE), "less than a minute before the deadline");
  assert.equal(relationToDeadline("2026-10-12T20:00:30Z", DEADLINE), "less than a minute after the deadline");
  assert.equal(relationToDeadline("2026-10-12T19:59:00Z", DEADLINE), "1m before the deadline");
  assert.equal(relationToDeadline(null, DEADLINE), "");
  assert.equal(relationToDeadline("2026-10-12T17:57:00Z", null), "");
  assert.equal(relationToDeadline("2026-10-12T17:57:00Z", "not a date"), "");
});

test("Progress: who, the last commit with its own time and message, and the deadline sentence", () => {
  const title = progressLoginTitle({
    who: "ann.peeters@student.pxl.be - Ann Peeters (1TIN-A)",
    hasRepo: true,
    sha: "b2e04652e40e355df6840968fa1a10e4d4d53841",
    committedAt: "2026-10-04T16:24:00Z",
    message: "Add the inventory\n\ndetails",
    commitCount: 7,
    deadlineSentence: "Last commit 8d 3h before the deadline. No commits after the deadline.",
  }, fmt);
  assert.equal(title, [
    "ann.peeters@student.pxl.be - Ann Peeters (1TIN-A)",
    "Last commit b2e0465, <2026-10-04T16:24:00Z>: Add the inventory",
    "Last commit 8d 3h before the deadline. No commits after the deadline.",
  ].join("\n"));
});

test("Progress: the edges say what the row knows and no more", () => {
  // No repository yet (accepted, still being made; or not accepted).
  assert.equal(progressLoginTitle({ who: "Ann", hasRepo: false }, fmt), "Ann\nNo repository yet.");
  // A repository with no commits the collector saw: said only when it COUNTED none.
  assert.equal(progressLoginTitle({ who: null, hasRepo: true, sha: null, commitCount: 0 }, fmt), "No commits yet.");
  assert.equal(progressLoginTitle({ who: null, hasRepo: true, sha: null, commitCount: null }, fmt), null, "unknown is not none");
  // A commit whose own time is unknown: the SHA, never an observation time.
  assert.equal(progressLoginTitle({ hasRepo: true, sha: "abcdef1234", committedAt: null }, fmt), "Last commit abcdef1");
  // No message, no deadline sentence: just the commit.
  assert.equal(progressLoginTitle({ hasRepo: true, sha: "abcdef1234", committedAt: "2026-10-04T16:24:00Z" }, fmt), "Last commit abcdef1, <2026-10-04T16:24:00Z>");
});

test("Grading: the graded commit, its own time against this student's deadline, and which hand-in", () => {
  const title = gradingLoginTitle({
    who: "Ann Peeters",
    sha: "763bb0dc84ce074ad80b43373803b8cb58e0cbf2",
    committedAt: "2026-10-12T17:57:00Z",
    deadline: DEADLINE,
    handIns: { used: 3, allowed: 5, graded_number: 3 },
  }, fmt);
  assert.equal(title, [
    "Ann Peeters",
    "Graded commit 763bb0d, committed <2026-10-12T17:57:00Z> (2h 3m before the deadline)",
    "Hand-in 3 of the 5 allowed.",
  ].join("\n"));
  // It says when it was COMMITTED - never "on time": a hand-in is judged by
  // when GitHub recorded the push, which the summary does not store.
  assert.ok(!/on time/i.test(title));
});

test("Grading: a hand-in is shown at its push, the time it was judged by", () => {
  const title = gradingLoginTitle({
    sha: "763bb0dc84",
    // The commit's own date is earlier; it is not what is shown.
    committedAt: null,
    pushedAt: "2026-10-12T17:57:00Z",
    pushedFrom: "log",
    deadline: DEADLINE,
    handIns: { used: 2, allowed: 3, graded_number: 2 },
  }, fmt);
  assert.equal(title, [
    "Graded commit 763bb0d, pushed <2026-10-12T17:57:00Z> (2h 3m before the deadline)",
    "Hand-in 2 of the 3 allowed.",
  ].join("\n"));
  // The push wins over a commit time, should a caller pass both.
  assert.match(gradingLoginTitle({ sha: "763bb0dc84", committedAt: "2026-10-01T00:00:00Z", pushedAt: "2026-10-12T17:57:00Z", deadline: DEADLINE }, fmt), /, pushed </);
});

test("Grading: a run started inside GitHub's margin is never called after the deadline", () => {
  // The rule counts a run that started up to two minutes after the deadline
  // as on time (GitHub's own delay). "45s after the deadline" alone would sit
  // beside a grade that counted it.
  const title = gradingLoginTitle({ sha: "763bb0dc84", pushedAt: "2026-10-12T20:00:45Z", pushedFrom: "run", deadline: DEADLINE }, fmt);
  assert.equal(title, "Graded commit 763bb0d, pushed <2026-10-12T20:00:45Z> (GitHub started its run 45s after the deadline, within the 2 minutes allowed for its own delay)");
  // The push log's time is the push: no margin applies.
  assert.match(gradingLoginTitle({ sha: "763bb0dc84", pushedAt: "2026-10-12T20:00:45Z", pushedFrom: "log", deadline: DEADLINE }, fmt), /\(less than a minute after the deadline\)$/);
  // Past the margin: plainly after (a lecturer's chosen commit, or a deadline moved earlier since).
  assert.match(gradingLoginTitle({ sha: "763bb0dc84", pushedAt: "2026-10-12T20:05:00Z", pushedFrom: "run", deadline: DEADLINE }, fmt), /\(5m after the deadline\)$/);
  // No deadline: the time alone.
  assert.equal(gradingLoginTitle({ sha: "763bb0dc84", pushedAt: "2026-10-12T20:00:45Z", pushedFrom: "run", deadline: null }, fmt), "Graded commit 763bb0d, pushed <2026-10-12T20:00:45Z>");
});

test("Grading: the edges", () => {
  // The graded commit is not the latest, so its own time is unknown: the SHA alone.
  assert.equal(gradingLoginTitle({ sha: "763bb0dc84", committedAt: null, deadline: DEADLINE }, fmt), "Graded commit 763bb0d");
  // A commit the lecturer chose.
  assert.match(gradingLoginTitle({ sha: "763bb0dc84", decidedBy: { kind: "commit", by: "tomcoolpxl" } }, fmt), /Chosen by @tomcoolpxl, not by the rules\./);
  // A score set by hand grades no commit, whatever SHA the row still carries.
  assert.equal(
    gradingLoginTitle({ who: "Ann", sha: "763bb0dc84", decidedBy: { kind: "score", by: "tomcoolpxl" } }, fmt),
    "Ann\nScore set by hand by @tomcoolpxl; no commit was graded.",
  );
  // Nothing graded at all.
  assert.equal(gradingLoginTitle({ sha: null }, fmt), "No graded commit recorded.");
  // No cap: no hand-in line. A cap with no graded hand-in: none either.
  assert.ok(!/Hand-in/.test(gradingLoginTitle({ sha: "763bb0dc84" }, fmt)));
  assert.ok(!/Hand-in/.test(gradingLoginTitle({ sha: "763bb0dc84", handIns: { used: 0, allowed: 2, graded_number: null } }, fmt)));
  // A commit after the deadline says so.
  assert.match(gradingLoginTitle({ sha: "763bb0dc84", committedAt: "2026-10-13T21:00:00Z", deadline: DEADLINE }, fmt), /\(1d 1h after the deadline\)/);
});
