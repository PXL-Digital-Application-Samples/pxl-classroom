// The Grading tab's rows, counts and average (frontend/src/lib/grading-rows.js),
// and why a student has no score (lib/grade-cohort.mjs `failedKind`).
//
// 2026-10-08: the tab listed only scored students and every other one as a red
// "20 grading failure(s)" at the bottom - an exam four days before its deadline,
// all twenty "no commit says ..., so nothing was handed in". A failed row now
// records what kind of "no score" it is, and a row written before that is read
// from the sentence this repository wrote for it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  FAILED_KINDS,
  NO_COMMIT_REASON,
  NO_REPOSITORY_REASON,
  failedKind,
  noHandInReason,
  rowFromOutcome,
} from "../lib/grade-cohort.mjs";
import { buildGradingSummary } from "../lib/grading-summary.mjs";
import { validateAgainst } from "../lib/validate.mjs";
import {
  GRADING_STATUSES,
  gradingCounts,
  gradingRows,
  inGradingFilter,
  pastDeadline,
  scoreStats,
  scoreStatsSentence,
} from "../frontend/src/lib/grading-rows.js";
import { GRADING_STATUS_LABELS, gradingStatusLabel } from "../frontend/src/lib/status-labels.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const marker = { value: "final submission", multiple: false };

test("the schema's kinds are the module's kinds", () => {
  const schema = JSON.parse(readFileSync(join(root, "schemas", "grading-summary.schema.json"), "utf8"));
  assert.deepEqual(schema.properties.failed.items.properties.kind.enum, [...FAILED_KINDS]);
});

test("a row that records its kind is read as it says", () => {
  for (const kind of FAILED_KINDS) assert.equal(failedKind({ login: "a", reason: "whatever", kind }), kind);
});

test("a row written before the kind existed is read from the sentence this module wrote", () => {
  // Derived from the builders, never a copy of their wording.
  assert.equal(failedKind({ reason: noHandInReason(marker, null) }), "not-handed-in");
  assert.equal(
    failedKind({ reason: noHandInReason(marker, { sha: "abcdef1234567", pushedAt: "2026-10-12T20:03:00Z" }) }),
    "late",
  );
  assert.equal(failedKind({ reason: noHandInReason(marker, { sha: "abcdef1234567", date: "2026-10-12T20:03:00Z" }) }), "late");
  assert.equal(failedKind({ reason: NO_REPOSITORY_REASON }), "not-handed-in");
  assert.equal(failedKind({ reason: NO_COMMIT_REASON }), "not-handed-in");
});

test("anything else is a score that could not be read - the answer that asks for a look", () => {
  assert.equal(failedKind({ reason: "no CI run at commit 4b68463" }), "no-result");
  assert.equal(failedKind({ reason: "read failed: timeout" }), "no-result");
  assert.equal(failedKind({ reason: "" }), "no-result");
  assert.equal(failedKind({ reason: "x", kind: "invented" }), "no-result");
  // A chosen commit that cannot be read quotes the rule's sentence INSIDE its
  // own: it is still the lecturer's decision failing, not "nothing handed in".
  assert.equal(failedKind({ reason: `the commit you chose (abc1234) cannot be read: ${noHandInReason(marker, null)}` }), "no-result");
});

test("rowFromOutcome stores the kind, and a chosen commit is always one to look at", () => {
  const notIn = rowFromOutcome("ann", { verdict: "no-commit", kind: "not-handed-in", reason: noHandInReason(marker, null) });
  assert.equal(notIn.failed.kind, "not-handed-in");
  const late = rowFromOutcome("bob", { verdict: "no-commit", kind: "late", reason: "late" });
  assert.equal(late.failed.kind, "late");
  const noRun = rowFromOutcome("cid", { verdict: "no-run", reason: "no CI run at commit 4b68463" });
  assert.equal(noRun.failed.kind, "no-result");
  const chosen = rowFromOutcome("dee", {
    verdict: "no-commit", kind: "not-handed-in", reason: "x", sha: "abcdef1",
    decision: { kind: "commit", sha: "abcdef1", by: "lect", at: "2026-10-08T10:00:00Z", reason: "asked" },
  });
  assert.equal(chosen.failed.kind, "no-result");
});

test("a summary with kinds validates against its schema", async () => {
  const doc = buildGradingSummary({
    assignmentId: "lab-1",
    gradedBy: "lect",
    runner: "github_actions",
    students: [{ login: "ann", earned_points: 20, total_points: 20, graded_at: "2026-10-08T07:26:25.902Z" }],
    failed: [
      { login: "bob", reason: noHandInReason(marker, null), kind: "not-handed-in" },
      { login: "cid", reason: "no CI run at commit 4b68463", kind: "no-result" },
    ],
  });
  const { valid, errors } = await validateAgainst("grading-summary", doc);
  assert.ok(valid, JSON.stringify(errors));
});

const report = [
  { github_login: "Ann", repo_name: "o/lab-ann", effective_deadline_at: "2026-10-12T20:00:00Z" },
  { github_login: "bob", repo_name: "o/lab-bob" },
  { github_login: "cid", repo_name: "o/lab-cid" },
  { github_login: "dee", repo_name: "o/lab-dee" },
  { github_login: "eve", repo_name: "o/lab-eve" }, // accepted after the last read
  { github_login: "fay", repo_name: null }, // no repository: nothing to grade
];
const summary = {
  students: [
    { login: "ann", earned_points: 20, total_points: 20 },
    { login: "bob", earned_points: 12, total_points: 20 },
    { login: "oral", earned_points: 15, total_points: 20, decided_by: { kind: "score" } }, // by hand, not in the report
  ],
  failed: [
    { login: "cid", reason: noHandInReason(marker, null) }, // legacy row, no kind
    { login: "dee", reason: "no CI run at commit 4b68463", kind: "no-result" },
  ],
};

test("every student with something to grade is a row, with what grading says", () => {
  const rows = gradingRows({ students: report, summary });
  const by = Object.fromEntries(rows.map((r) => [r.login.toLowerCase(), r]));
  assert.deepEqual(Object.keys(by).sort(), ["ann", "bob", "cid", "dee", "eve", "oral"]);
  assert.equal(by.ann.status, "scored");
  assert.equal(by.ann.student.github_login, "Ann", "joined across the login's case");
  assert.equal(by.ann.record, summary.students[0]);
  assert.equal(by.cid.status, "not-handed-in");
  assert.equal(by.dee.status, "no-result");
  assert.equal(by.dee.reason, "no CI run at commit 4b68463");
  assert.equal(by.eve.status, "not-read");
  assert.deepEqual(by.eve.record, { login: "eve" });
  assert.equal(by.oral.status, "scored");
  assert.equal(by.oral.student, null);
  for (const r of rows) assert.ok(GRADING_STATUSES.includes(r.status));
});

test("before any read, every student is 'not read yet' - never 'not handed in'", () => {
  const rows = gradingRows({ students: report, summary: null });
  assert.equal(rows.length, 5);
  assert.ok(rows.every((r) => r.status === "not-read"));
});

test("the counts are the filters, over the same rows", () => {
  const rows = gradingRows({ students: report, summary });
  const counts = gradingCounts(rows);
  assert.deepEqual(counts, { students: 6, scored: 3, "needs-look": 1, "not-handed-in": 1, "not-read": 1 });
  for (const f of ["scored", "needs-look", "not-handed-in", "not-read"]) {
    assert.equal(rows.filter((r) => inGradingFilter(r, f)).length, counts[f], f);
  }
  assert.equal(rows.filter((r) => inGradingFilter(r, "")).length, rows.length);
  const late = gradingRows({ students: [{ github_login: "x", repo_name: "o/x" }], summary: { students: [], failed: [{ login: "x", reason: "r", kind: "late" }] } });
  assert.equal(gradingCounts(late)["needs-look"], 1, "a late hand-in needs a look");
});

test("the average: points over one total, a percentage over several", () => {
  const rows = gradingRows({ students: report, summary });
  const same = scoreStats(rows);
  assert.deepEqual(same, { count: 3, fullMarks: 1, average: 15.7, total: 20, averagePercent: null });
  assert.equal(scoreStatsSentence(same), "Average 15.7 / 20 over 3 students, 1 at full marks.");
  const mixed = scoreStats(gradingRows({
    students: [],
    summary: { students: [{ login: "a", earned_points: 10, total_points: 10 }, { login: "b", earned_points: 5, total_points: 20 }] },
  }));
  assert.equal(mixed.average, null);
  assert.equal(mixed.averagePercent, 63);
  assert.equal(scoreStatsSentence(mixed), "Average 63% over 2 students, 1 at full marks.");
  assert.equal(scoreStats(gradingRows({ students: report, summary: null })), null);
  assert.equal(scoreStatsSentence(null), "");
});

test("missing work turns red only after its deadline, and an unknown deadline is not past", () => {
  const now = Date.parse("2026-10-08T10:00:00Z");
  assert.equal(pastDeadline("2026-10-12T20:00:00Z", now), false);
  assert.equal(pastDeadline("2026-10-01T20:00:00Z", now), true);
  assert.equal(pastDeadline(null, now), false);
  assert.equal(pastDeadline("not a date", now), false);
});

test("every grading status has a word, and 'not handed in' says 'yet' before the deadline", () => {
  for (const s of GRADING_STATUSES) assert.ok(GRADING_STATUS_LABELS[s], s);
  for (const k of FAILED_KINDS) assert.ok(GRADING_STATUS_LABELS[k], k);
  assert.equal(gradingStatusLabel("not-handed-in", { beforeDeadline: true }), "Not handed in yet");
  assert.equal(gradingStatusLabel("not-handed-in", { beforeDeadline: false }), "Not handed in");
  assert.equal(gradingStatusLabel("no-result"), "No score to read");
});
