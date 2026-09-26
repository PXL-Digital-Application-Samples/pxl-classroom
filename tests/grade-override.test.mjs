// A lecturer's decision about one student's grade, over the rules:
// lib/grade-override.mjs, and lib/grade-cohort.mjs honouring it.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CHOSEN_COMMIT, MANUAL_SCORE, decisionEntry, decisionProblem, gradeDecisionFor,
} from "../lib/grade-override.mjs";
import { gradeStudent, gradeCohort, rowFromOutcome } from "../lib/grade-cohort.mjs";
import { buildGradingSummary } from "../lib/grading-summary.mjs";
import { validateAgainst } from "../lib/validate.mjs";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const doc = (login, entries) => ({ schema_version: 1, assignment_id: "x", github_login: login, overrides: entries });
const commit = (sha, at = "2026-09-26T10:00:00Z", reason = "wifi dropped") =>
  decisionEntry({ type: CHOSEN_COMMIT, value: sha, reason, by: "tomcoolpxl", at });
const score = (earned, total, at = "2026-09-26T11:00:00Z") =>
  decisionEntry({ type: MANUAL_SCORE, value: earned === null ? null : { earned, total }, reason: "oral exam", by: "tomcoolpxl", at });

test("no decision is the rules", () => {
  assert.equal(gradeDecisionFor("kim", { overrides: [] }), null);
  assert.equal(gradeDecisionFor("kim", { overrides: [doc("kim", [{ type: "deadline_extension", value: "2026-10-01T00:00:00Z", reason: "r", overridden_by: "l", overridden_at: "2026-09-01T00:00:00Z" }])] }), null);
});

test("a chosen commit, then a score by hand: the score wins; removing it falls back to the commit, not the rules", () => {
  const withBoth = [doc("kim", [commit(SHA_A), score(15, 20)])];
  assert.equal(gradeDecisionFor("kim", { overrides: withBoth }).kind, "score");
  const scoreRemoved = [doc("kim", [commit(SHA_A), score(15, 20), score(null)])];
  assert.deepEqual(gradeDecisionFor("kim", { overrides: scoreRemoved }), {
    kind: "commit", sha: SHA_A, by: "tomcoolpxl", at: "2026-09-26T10:00:00Z", reason: "wifi dropped",
  });
});

test("the last entry of a type is in force; null returns them to the rules", () => {
  assert.equal(gradeDecisionFor("kim", { overrides: [doc("kim", [commit(SHA_A), commit(SHA_B)])] }).sha, SHA_B);
  assert.equal(gradeDecisionFor("kim", { overrides: [doc("kim", [commit(SHA_A), decisionEntry({ type: CHOSEN_COMMIT, value: null, reason: "back", by: "l" })])] }), null);
});

test("a malformed entry is skipped, never trusted - it cannot erase an earlier valid one", () => {
  const entries = [commit(SHA_A), { type: CHOSEN_COMMIT, value: "not-a-sha", reason: "x", overridden_by: "l", overridden_at: "2026-09-27T00:00:00Z" }];
  assert.equal(gradeDecisionFor("kim", { overrides: [doc("kim", entries)] }).sha, SHA_A);
  const badScore = [doc("kim", [{ type: MANUAL_SCORE, value: { earned: 25, total: 20 }, reason: "x", overridden_by: "l", overridden_at: "2026-09-27T00:00:00Z" }])];
  assert.equal(gradeDecisionFor("kim", { overrides: badScore }), null, "more than the total is not a score");
});

test("logins match whatever their case, and a Map (as the page holds them) works too", () => {
  const overrides = new Map([["Kim", doc("Kim", [commit(SHA_A)])]]);
  assert.equal(gradeDecisionFor("KIM", { overrides }).sha, SHA_A);
});

test("TEAM: a member with no decision takes the newest among teammates; their own revocation is not undone by a teammate's copy", () => {
  const overrides = [doc("ann", [commit(SHA_A, "2026-09-26T10:00:00Z")]), doc("ben", [commit(SHA_B, "2026-09-26T12:00:00Z")])];
  const team = { members: ["ann", "ben", "cas"] };
  assert.equal(gradeDecisionFor("cas", { overrides, team }).sha, SHA_B, "newest teammate's");
  assert.equal(gradeDecisionFor("ann", { overrides, team }).sha, SHA_A, "their own wins over a teammate's");
  const revoked = [...overrides, doc("cas", [commit(SHA_A), decisionEntry({ type: CHOSEN_COMMIT, value: null, reason: "r", by: "l" })])];
  assert.equal(gradeDecisionFor("cas", { overrides: revoked, team }), null);
});

test("what cannot be written, and why - the dialog and the handler ask the same function", () => {
  assert.match(decisionProblem({ type: CHOSEN_COMMIT, value: SHA_A, reason: " " }), /reason/);
  assert.match(decisionProblem({ type: CHOSEN_COMMIT, value: "abc123", reason: "r" }), /full commit id/);
  assert.match(decisionProblem({ type: MANUAL_SCORE, value: { earned: 21, total: 20 }, reason: "r" }), /more than the total/);
  assert.match(decisionProblem({ type: MANUAL_SCORE, value: { earned: 1, total: 0 }, reason: "r" }), /more than 0/);
  assert.match(decisionProblem({ type: MANUAL_SCORE, value: { earned: -1, total: 20 }, reason: "r" }), /negative/);
  assert.equal(decisionProblem({ type: MANUAL_SCORE, value: { earned: 20, total: 20 }, reason: "r" }), null);
  assert.equal(decisionProblem({ type: CHOSEN_COMMIT, value: null, reason: "back to the rules" }), null);
});

test("the entries validate against the override schema, revocations included", () => {
  const d = doc("kim", [commit(SHA_A), score(15, 20), score(null), decisionEntry({ type: CHOSEN_COMMIT, value: null, reason: "r", by: "l" })]);
  const v = validateAgainst("override", d);
  assert.equal(v.valid, true, JSON.stringify(v.errors));
  const bad = validateAgainst("override", doc("kim", [{ ...commit(SHA_A), value: "short" }]));
  assert.equal(bad.valid, false);
});

// --- the grading judge honours it ----------------------------------------------

/** A GitHub that has a grading run at SHA_A (7/10) and nothing anywhere else. */
function fakeGitHub(reads = []) {
  return async (method, path) => {
    reads.push(path);
    if (path.includes(`/commits/${SHA_A}/check-runs`)) {
      return { ok: true, status: 200, data: { check_runs: [{ name: "grading", status: "completed", conclusion: "success", html_url: "https://run/1", output: { title: "Points 7/10", annotations_count: 0 } }] } };
    }
    if (path.includes("/check-runs")) return { ok: true, status: 200, data: { check_runs: [] } };
    // Any rule-path read (commits, runs) would land here - the tests assert none happens.
    return { ok: true, status: 200, data: [] };
  };
}
const row = { github_login: "kim", repo_name: "Org/r-kim", latest_observed_sha: SHA_B, effective_deadline_at: "2026-09-01T00:00:00Z" };
const marker = { type: "commit_message", value: "hand in", multiple: true, maxHandIns: 2 };

test("A CHOSEN COMMIT skips the rules - deadline, cap, which hand-in - and reads that commit", async () => {
  const reads = [];
  const out = await gradeStudent(fakeGitHub(reads), { row, marker, overrides: [doc("kim", [commit(SHA_A)])] });
  assert.equal(out.verdict, "graded");
  assert.equal(out.sha, SHA_A);
  assert.deepEqual(reads, [`/repos/Org/r-kim/commits/${SHA_A}/check-runs`], "no hand-in listing, no run history - the rules were not consulted");
  const { graded } = rowFromOutcome("kim", out, 10);
  assert.equal(graded.earned_points, 7);
  assert.equal(graded.graded_sha, SHA_A);
  assert.deepEqual(graded.decided_by, { kind: "commit", by: "tomcoolpxl", at: "2026-09-26T10:00:00Z", reason: "wifi dropped" });
});

test("a chosen commit with NO grading result is a named refusal, never a zero", async () => {
  const out = await gradeStudent(fakeGitHub(), { row, marker, overrides: [doc("kim", [commit(SHA_B)])] });
  const { failed } = rowFromOutcome("kim", out, 10);
  assert.match(failed.reason, /the commit you chose \(bbbbbbb\) cannot be read: no CI run/);
});

test("A SCORE BY HAND reads nothing at all", async () => {
  const reads = [];
  const out = await gradeStudent(fakeGitHub(reads), { row, marker, overrides: [doc("kim", [score(15, 20)])] });
  assert.equal(out.verdict, "manual");
  assert.deepEqual(reads, []);
  const { graded } = rowFromOutcome("kim", out);
  assert.equal(graded.score_source, "manual");
  assert.equal(graded.earned_points, 15);
  assert.equal(graded.decided_by.kind, "score");
});

test("RE-GRADE ALL keeps every decision - the reason they are stored rather than applied once", async () => {
  const students = [row, { ...row, github_login: "lee", repo_name: "Org/r-lee" }];
  const res = await gradeCohort(fakeGitHub(), {
    students, overrides: [doc("kim", [commit(SHA_A)]), doc("lee", [score(12, 20)])], fallbackTotal: 10,
  });
  assert.equal(res.ok, true);
  const byLogin = Object.fromEntries(res.graded.map((g) => [g.login, g]));
  assert.equal(byLogin.kim.graded_sha, SHA_A);
  assert.equal(byLogin.lee.score_source, "manual");
  const summary = buildGradingSummary({ assignmentId: "x", gradedBy: "tomcoolpxl", runner: "github_actions", students: res.graded, failed: res.failed });
  const v = validateAgainst("grading-summary", summary);
  assert.equal(v.valid, true, JSON.stringify(v.errors));
});

test("without a decision nothing changes, except that the graded commit is now recorded", async () => {
  const out = await gradeStudent(fakeGitHub(), { row: { ...row, latest_observed_sha: SHA_A }, overrides: [] });
  const { graded } = rowFromOutcome("kim", out, 10);
  assert.equal(graded.graded_sha, SHA_A);
  assert.equal("decided_by" in graded, false);
});
