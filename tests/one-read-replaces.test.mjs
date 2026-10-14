// Reading ONE student again: what it may replace in the summary on record.
//
// 2026-10-14 review: `pxl-classroom grade --login alice` replaced alice's
// stored 18/20 with "checks: 502" - a read that failed - while the page's
// "Read score again" kept it and said so. One rule now
// (lib/grade-cohort.mjs `oneReadReplaces`, `mergeOneStudentRead`), and both
// surfaces are checked to ask it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FAILED_READ_VERDICTS, gradeCohort, keepStoredOnFailedReads, mergeOneStudentRead, oneReadReplaces, rowFromOutcome } from "../lib/grade-cohort.mjs";

const score = (login, earned = 18) => ({ login, earned_points: earned, total_points: 20 });
const reason = (login, kind, text = "x") => ({ login, kind, reason: text });

test("a score replaces; a failed read never does; a reason only after a decision or once a running row's run has ended", () => {
  assert.equal(oneReadReplaces({ hasScore: true, failedRead: false }), true);
  assert.equal(oneReadReplaces({ hasScore: false, failedRead: true, afterDecision: true }), false, "not even after a decision");
  assert.equal(oneReadReplaces({ hasScore: false, failedRead: false, newKind: "no-result" }), false, "it looked, no score: the earlier result stands");
  assert.equal(oneReadReplaces({ hasScore: false, failedRead: false, newKind: "no-result", afterDecision: true }), true);
  assert.equal(oneReadReplaces({ hasScore: false, failedRead: false, newKind: "no-result", stored: reason("a", "running") }), true, "the run ended");
  assert.equal(oneReadReplaces({ hasScore: false, failedRead: false, newKind: "running", stored: reason("a", "running") }), false, "still running is the same answer");
  assert.equal(oneReadReplaces({ hasScore: false, failedRead: false, newKind: "late", stored: reason("a", "no-result") }), false);
});

test("every failed-read verdict gradeStudent can return is one, and none of them is a summary row's kind", () => {
  assert.deepEqual([...FAILED_READ_VERDICTS].sort(), ["api-failed", "lookup-failed", "unreadable"]);
  for (const verdict of FAILED_READ_VERDICTS.filter((v) => v !== "api-failed")) {
    // What a row built from one would say, were it written - which is what
    // `grade --login` did.
    assert.equal(rowFromOutcome("a", { verdict, reason: "r" }).failed.kind, "no-result");
  }
});

test("--login: a failed read keeps the stored score, and everyone else's rows stand byte for byte", () => {
  const stored = { students: [score("Alice"), score("bob", 12)], failed: [reason("carol", "late")] };
  const merged = mergeOneStudentRead({
    stored, read: { graded: [], failed: [reason("alice", "no-result", "checks: 502")] },
    logins: ["alice"], failedReads: new Set(["alice"]),
  });
  assert.deepEqual(merged.unchanged, ["alice"]);
  assert.deepEqual(merged.students, [score("bob", 12), score("Alice")], "the stored row, matched case-blind");
  assert.deepEqual(merged.failed, [reason("carol", "late")]);
});

test("--login: a new score replaces the stored reason; a reason after an ended run replaces the running row", () => {
  const stored = { students: [score("bob", 12)], failed: [reason("alice", "running"), reason("dan", "running")] };
  const graded = mergeOneStudentRead({
    stored, read: { graded: [score("alice", 20)], failed: [] }, logins: ["alice"], failedReads: new Set(),
  });
  assert.deepEqual(graded.unchanged, []);
  assert.deepEqual(graded.students, [score("bob", 12), score("alice", 20)]);
  assert.deepEqual(graded.failed, [reason("dan", "running")]);

  const ended = mergeOneStudentRead({
    stored, read: { graded: [], failed: [reason("dan", "no-result", "ended without a score")] }, logins: ["dan"], failedReads: new Set(),
  });
  assert.deepEqual(ended.failed, [reason("alice", "running"), reason("dan", "no-result", "ended without a score")]);
});

test("--login with no summary on record and nothing new: nothing to write", () => {
  const merged = mergeOneStudentRead({
    stored: null, read: { graded: [], failed: [reason("alice", "no-result", "no CI run")] }, logins: ["alice"], failedReads: new Set(),
  });
  assert.deepEqual(merged, { students: [], failed: [], unchanged: ["alice"] });
});

// --- The whole cohort (review 2026-10-14, G4b) ------------------------------

test("a cohort read keeps the stored row of every student whose read failed", () => {
  const stored = { students: [score("Alice"), score("bob", 12)], failed: [reason("carol", "late")] };
  const out = keepStoredOnFailedReads({
    stored,
    graded: [score("bob", 15)],
    failed: [reason("alice", "no-result", "could not read the push log"), reason("carol", "no-result", "could not read"), reason("dan", "no-result", "could not read")],
    failedReads: new Set(["alice", "carol", "dan"]),
  });
  assert.deepEqual(out.graded, [score("bob", 15), score("Alice")], "the new score for bob, the stored one for alice");
  assert.deepEqual(out.failed, [reason("carol", "late"), reason("dan", "no-result", "could not read")], "carol as stored; dan had nothing stored, so the reason stands");
  assert.deepEqual(out.kept, ["alice", "carol"]);
  // Nothing stored, or nothing failed: the read as it is.
  const read = { graded: [score("bob")], failed: [reason("dan", "no-result")] };
  assert.deepEqual(keepStoredOnFailedReads({ stored: null, ...read, failedReads: new Set(["dan"]) }), { ...read, kept: [] });
  assert.deepEqual(keepStoredOnFailedReads({ stored, ...read, failedReads: new Set() }), { ...read, kept: [] });
});

test("gradeCohort names the students whose read failed but whose row it still wrote", async () => {
  // `unreadable`: the run is there, its annotations could not be read.
  const sha = "a".repeat(40);
  const request = async (method, path) => {
    if (/\/commits\/[0-9a-f]{40}\/check-runs/.test(path)) {
      return { ok: true, status: 200, data: { total_count: 1, check_runs: [{ id: 1, name: "run-autograding-tests", status: "completed", conclusion: "success", output: { annotations_count: 1 } }] } };
    }
    if (/\/check-runs\/1\/annotations/.test(path)) return { ok: false, status: 500, data: {} };
    return { ok: false, status: 404, data: {} };
  };
  const res = await gradeCohort(request, {
    students: [{ github_login: "alice", repo_name: "Org/r-alice", latest_observed_sha: sha, submission_status: "on-time" }],
  });
  assert.ok(res.failed.some((f) => f.login === "alice"), JSON.stringify(res));
  assert.deepEqual([...res.failedReads], ["alice"], JSON.stringify(res));
});

test("every cohort writer keeps stored rows on a failed read: the page, the nightly and the CLI", () => {
  const page = readFileSync(new URL("../frontend/src/views/AssignmentDetailView.vue", import.meta.url), "utf8");
  const nightly = readFileSync(new URL("../scripts/grade-at-deadline.mjs", import.meta.url), "utf8");
  const cli = readFileSync(new URL("../cli/src/commands/grade.mjs", import.meta.url), "utf8");
  for (const [name, src] of [["page", page], ["nightly", nightly], ["cli", cli]]) {
    assert.match(src, /keepStoredOnFailedReads\(\{/, name);
  }
  assert.doesNotMatch(page, /saveGradingSummary\(/, "the cohort read no longer overwrites the summary blind");
});

test("both surfaces ask the shared rule: the page's Read score again and the CLI's --login", () => {
  const page = readFileSync(new URL("../frontend/src/views/AssignmentDetailView.vue", import.meta.url), "utf8");
  const cli = readFileSync(new URL("../cli/src/commands/grade.mjs", import.meta.url), "utf8");
  assert.match(page, /oneReadReplaces\(\{/);
  assert.match(page, /FAILED_READ_VERDICTS\.includes\(outcome\.verdict\)/);
  assert.doesNotMatch(page, /\['api-failed', 'unreadable', 'lookup-failed'\]/, "no second spelling of the list");
  assert.match(cli, /mergeOneStudentRead\(\{/);
  assert.doesNotMatch(cli, /notThisRun/, "the replace-everything-for-them merge is gone");
});
