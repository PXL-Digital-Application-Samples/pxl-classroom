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
  resultsWithoutPoints,
  nothingGradedMessage,
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
  assert.deepEqual(counts, { students: 6, scored: 3, "needs-look": 1, "not-handed-in": 1, running: 0, "not-read": 1 });
  for (const f of ["scored", "needs-look", "not-handed-in", "running", "not-read"]) {
    assert.equal(rows.filter((r) => inGradingFilter(r, f)).length, counts[f], f);
  }
  assert.equal(rows.filter((r) => inGradingFilter(r, "")).length, rows.length);
  const late = gradingRows({ students: [{ github_login: "x", repo_name: "o/x" }], summary: { students: [], failed: [{ login: "x", reason: "r", kind: "late" }] } });
  assert.equal(gradingCounts(late)["needs-look"], 1, "a late hand-in needs a look");
});

test("the average: points over one total, a percentage over several", () => {
  const rows = gradingRows({ students: report, summary });
  const same = scoreStats(rows);
  assert.deepEqual(same, { count: 3, fullMarks: 1, average: 15.7, median: 15, total: 20, averagePercent: null, medianPercent: null });
  assert.equal(scoreStatsSentence(same), "Over 3 students: average 15.7 / 20, median 15 / 20, 1 at full marks.");
  // An even count: halfway between the two middle scores.
  const even = scoreStats(gradingRows({
    students: [],
    summary: { students: [10, 12, 20, 20].map((p, i) => ({ login: `s${i}`, earned_points: p, total_points: 20 })) },
  }));
  assert.equal(even.median, 16);
  const mixed = scoreStats(gradingRows({
    students: [],
    summary: { students: [{ login: "a", earned_points: 10, total_points: 10 }, { login: "b", earned_points: 5, total_points: 20 }] },
  }));
  assert.equal(mixed.average, null);
  assert.equal(mixed.averagePercent, 63);
  assert.equal(mixed.medianPercent, 63);
  assert.equal(scoreStatsSentence(mixed), "Over 2 students: average 63%, median 63%, 1 at full marks.");
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

test("a grading run still going is 'running', said as such - not 'was never completed', and not a problem", async () => {
  // 2026-10-12: a cloud exam's 50-minute grading run, read 20 minutes in,
  // showed "the grading run ... was never completed" under Needs a look. Its
  // status was in the same read all along.
  const { readScoreAtCommit } = await import("../lib/grade-cohort.mjs");
  const at = (status, conclusion = null) => async () => ({
    ok: true, status: 200, data: { check_runs: [{ name: "grading", status, conclusion, output: { annotations_count: 0 } }] },
  });
  const running = await readScoreAtCommit(at("in_progress"), { repoFullName: "Org/r", sha: "f61d20cabc" });
  assert.equal(running.kind, "running");
  assert.equal(running.reason, "the grading run at commit f61d20c is still running, so it has no score yet");
  const queued = await readScoreAtCommit(at("queued"), { repoFullName: "Org/r", sha: "f61d20cabc" });
  assert.match(queued.reason, /is still waiting to start/);
  const timedOut = await readScoreAtCommit(at("completed", "timed_out"), { repoFullName: "Org/r", sha: "f61d20cabc" });
  assert.equal(timedOut.kind, "no-result");
  assert.match(timedOut.reason, /timed out, so it carries no score/);

  // Stored as running - a chosen commit's still-going run too - and counted
  // apart from the problems.
  assert.equal(rowFromOutcome("rik", running).failed.kind, "running");
  const chosen = rowFromOutcome("rik", { ...running, sha: "f61d20c", decision: { kind: "commit", sha: "f61d20c", by: "l", at: "2026-10-12T00:00:00Z", reason: "r" } });
  assert.equal(chosen.failed.kind, "running");
  const rows = gradingRows({
    students: [{ github_login: "rik", repo_name: "o/rik" }],
    summary: { students: [], failed: [{ login: "rik", reason: running.reason, kind: "running" }] },
  });
  assert.equal(rows[0].status, "running");
  assert.deepEqual(gradingCounts(rows), { students: 1, scored: 0, "needs-look": 0, "not-handed-in": 0, running: 1, "not-read": 0 });
  assert.equal(gradingStatusLabel("running"), "Being graded");
});

test("the dispatched-run reader and the CLI say the same words", async () => {
  const { readRunScore } = await import("../lib/grade-dispatch.mjs");
  const stillGoing = await readRunScore(async (method, path) => (
    path.includes("/actions/runs/")
      ? { ok: true, status: 200, data: { id: 77, status: "in_progress", event: "workflow_dispatch", display_title: "Grade f61d20cabc" } }
      : { ok: false, status: 404 }
  ), { repoFullName: "Org/r", runId: 77, sha: "f61d20cabc" });
  assert.equal(stillGoing.kind, "running");
  // The CLI reads a commit's score through the hub's own reader (the one the
  // test above runs), so it has no wording of its own to drift (P2-5).
  const cli = readFileSync(join(root, "cli", "src", "commands", "grade.mjs"), "utf8");
  assert.match(cli, /readScoreAtCommit as readScoreShared[^}]*\} from "\.\.\/\.\.\/\.\.\/lib\/grade-cohort\.mjs"/, "the CLI reads a score through the shared reader");
  assert.doesNotMatch(cli, /parseCheckRunScore\(|unscoredRun\(/, "the CLI does not parse or word a run itself");
  assert.doesNotMatch(cli, /never completed/);
});

test("every grading status has a word, and 'not handed in' says 'yet' before the deadline", () => {
  for (const s of GRADING_STATUSES) assert.ok(GRADING_STATUS_LABELS[s], s);
  for (const k of FAILED_KINDS) assert.ok(GRADING_STATUS_LABELS[k], k);
  assert.equal(gradingStatusLabel("not-handed-in", { beforeDeadline: true }), "Not handed in yet");
  assert.equal(gradingStatusLabel("not-handed-in", { beforeDeadline: false }), "Not handed in");
  assert.equal(gradingStatusLabel("no-result"), "No score to read");
});

test("a result with no points is scored, averages to nothing, and is said apart (review 2026-10-14)", () => {
  // A template's own workflow that passes or fails with no reporter is stored 0/0:
  // the Scored card counted 20 over a box that said "Nobody has a score yet".
  const rows = [
    { graded: { earned_points: 0, total_points: 0 } },
    { graded: { earned_points: 0, total_points: 0 } },
    { graded: { earned_points: 8, total_points: 10 } },
    { graded: null },
  ];
  assert.equal(resultsWithoutPoints(rows), 2);
  assert.equal(scoreStats(rows).count, 1, "averaged over the one with points");
  assert.equal(resultsWithoutPoints([{ graded: { earned_points: 5, total_points: 10 } }]), 0);
});

test("a cohort read that saved nothing says why, by kind - never 'all checks missing or failed'", () => {
  const message = nothingGradedMessage([
    { login: "a", kind: "running", reason: "x" },
    { login: "b", kind: "running", reason: "x" },
    { login: "c", kind: "not-handed-in", reason: "no repository on record" },
  ]);
  assert.match(message, /2 still being graded, 1 not handed in/);
  assert.match(message, /Nothing was saved/);
  assert.doesNotMatch(message, /missing or failed/);
  assert.match(nothingGradedMessage([]), /^Nobody has a score to read yet\. Nothing was saved/);
});

test("P2-10: students whose read FAILED are said apart, with what to do - not 'nobody has a score yet'", () => {
  const failed = [
    { login: "A", kind: "no-result", reason: "GitHub's rate limit stopped the read of this repository's hand-ins" },
    { login: "b", kind: "no-result", reason: "GitHub's rate limit stopped the read" },
    { login: "c", kind: "running", reason: "x" },
  ];
  const message = nothingGradedMessage(failed, { failedReads: new Set(["a", "b"]) });
  assert.match(message, /^2 students could not be read \(and 1 still being graded\): read the scores again in a few minutes\./);
  assert.doesNotMatch(message, /Nobody has a score/);
  // Without failed reads, as before.
  assert.match(nothingGradedMessage(failed, { failedReads: new Set() }), /^Nobody has a score to read yet \(1 still being graded, 2 with no result\)/);
});
