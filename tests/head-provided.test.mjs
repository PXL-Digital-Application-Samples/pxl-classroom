// R6-9 (review 2026-10-15): "No submission" is judged by what the head IS,
// not by how many commits there are. A student's squashed one-commit history is
// work; GitHub's copy plus provisioning's grading workflow, made before starts
// were recorded, is not. lib/untouched-repo.mjs `headIsProvided` decides, and
// the collector, Refresh, the report and lockdown ask it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { headIsProvided } from "../lib/untouched-repo.mjs";
import { unstartedRepo } from "../lib/starter-commit.mjs";
import { snapshotObservation } from "../lib/observation.mjs";
import { validateAgainst } from "../lib/validate.mjs";
import { FAILED_KINDS, NO_ON_TIME_SUBMISSION_REASON, NO_SUBMISSION_REASON, failedKind, gradeStudent, noSubmissionOutcome } from "../lib/grade-cohort.mjs";

const REPO = "Org/lab-ann";
const APP = "pxl-classroom-provisioner[bot]";
const sha = (c) => c.repeat(40);

// The measured shape of GitHub's generated first commit (lib/starter-sync-cohort.mjs).
const generated = (s = sha("a")) => ({
  sha: s, parents: [], author: { login: APP }, committer: { login: "web-flow" },
  commit: { verification: { verified: true } },
});
const appCommit = (s, parent) => ({
  sha: s, parents: [{ sha: parent }], author: { login: APP }, committer: { login: APP },
  commit: { verification: { verified: true } },
});
const studentCommit = (s, parents = []) => ({
  sha: s, parents: parents.map((p) => ({ sha: p })), author: { login: "ann" }, committer: { login: "ann" },
  commit: { verification: { verified: false } },
});

function getter(rows, { failOn = null } = {}) {
  const calls = [];
  const get = async (path) => {
    calls.push(path);
    const s = path.match(/\/commits\/([0-9a-f]{40})$/)?.[1];
    if (s && s === failOn) return { status: 502, data: null };
    const row = rows.find((r) => r.sha === s);
    return row ? { status: 200, data: row } : { status: 404, data: null };
  };
  return { get, calls };
}

test("GitHub's generated commit is what it was given, and nothing is read", async () => {
  const g = getter([]);
  assert.equal(await headIsProvided(g.get, REPO, generated(), { appLogin: APP }), true);
  assert.equal(g.calls.length, 0);
});

test("THE CASE: GitHub's copy plus provisioning's grading workflow is still what it was given", async () => {
  const root = generated();
  const g = getter([root]);
  assert.equal(await headIsProvided(g.get, REPO, appCommit(sha("b"), root.sha), { appLogin: APP }), true);
  // ...and a starter sync on top of that, too.
  const workflow = appCommit(sha("b"), root.sha);
  const g2 = getter([root, workflow]);
  assert.equal(await headIsProvided(g2.get, REPO, appCommit(sha("c"), workflow.sha), { appLogin: APP }), true);
});

test("THE CASE: a student's squashed one-commit history is work", async () => {
  assert.equal(await headIsProvided(getter([]).get, REPO, studentCommit(sha("d")), { appLogin: APP }), false);
  // A student's commit claiming the App's address is unverified: work.
  const forged = { ...studentCommit(sha("d")), author: { login: APP } };
  assert.equal(await headIsProvided(getter([]).get, REPO, forged, { appLogin: APP }), false);
});

test("anything a person made on the way is work, and github-actions is a person's workflow", async () => {
  const root = generated();
  const mine = studentCommit(sha("e"), [root.sha]);
  const g = getter([root, mine]);
  assert.equal(await headIsProvided(g.get, REPO, appCommit(sha("f"), mine.sha), { appLogin: APP }), false);
  const actions = { ...appCommit(sha("f"), root.sha), author: { login: "github-actions[bot]" } };
  assert.equal(await headIsProvided(getter([root]).get, REPO, actions, { appLogin: APP }), false);
});

test("the recorded start counts as given, with the App's commits on top of it", async () => {
  const start = studentCommit(sha("1"), [sha("0")]); // a full-history copy's head: the template's
  assert.equal(await headIsProvided(getter([]).get, REPO, start, { starterSha: start.sha, appLogin: APP }), true);
  assert.equal(await headIsProvided(getter([start]).get, REPO, appCommit(sha("2"), start.sha), { starterSha: start.sha, appLogin: APP }), true);
});

test("a read that failed on the way is not judged, and without the App's login only GitHub's commit is given", async () => {
  const root = generated();
  assert.equal(await headIsProvided(getter([root], { failOn: root.sha }).get, REPO, appCommit(sha("b"), root.sha), { appLogin: APP }), null);
  assert.equal(await headIsProvided(getter([root]).get, REPO, appCommit(sha("b"), root.sha), {}), false);
});

test("unstartedRepo takes the judgement where one was made, the old rule where none was", () => {
  assert.equal(unstartedRepo({ starterSha: null, latestSha: sha("d"), commitCount: 1, headProvided: false }), false, "squashed: work");
  assert.equal(unstartedRepo({ starterSha: null, latestSha: sha("b"), commitCount: 2, headProvided: true }), true, "copy + workflow: nothing");
  assert.equal(unstartedRepo({ starterSha: null, latestSha: sha("d"), commitCount: 1 }), true, "not judged: one commit");
  assert.equal(unstartedRepo({ starterSha: sha("1"), latestSha: sha("1"), commitCount: 9 }), true);
});

test("the observation carries the judgement only when one was made, and validates", async () => {
  const base = {
    assignmentId: "lab", login: "ann", repoId: 7, ref: "refs/heads/main",
    commit: { sha: sha("d"), commit: { message: "x", committer: { date: "2026-10-15T08:00:00Z" } } },
    commitCount: 1, observedAt: "2026-10-15T09:00:00Z", collectionType: "manual",
  };
  for (const headProvided of [true, false]) {
    const doc = snapshotObservation({ ...base, headProvided });
    assert.equal(doc.head_provided, headProvided);
    const { valid, errors } = await validateAgainst("observation", structuredClone(doc));
    assert.ok(valid, JSON.stringify(errors));
  }
  assert.equal("head_provided" in snapshotObservation(base), false, "absent, not false, when not judged");
});

test("late-only work is not called 'still as it was given'", async () => {
  assert.deepEqual(noSubmissionOutcome({ first_late_sha: null }), { kind: "not-handed-in", reason: NO_SUBMISSION_REASON });
  assert.deepEqual(noSubmissionOutcome({ first_late_sha: sha("9") }), { kind: "late", reason: NO_ON_TIME_SUBMISSION_REASON });
  assert.ok(FAILED_KINDS.includes("late"));
  // A row written by an older grader is read by its sentence.
  assert.equal(failedKind({ reason: NO_ON_TIME_SUBMISSION_REASON }), "late");
  const out = await gradeStudent(async () => { throw new Error("nothing is read"); }, {
    row: { github_login: "ann", repo_name: REPO, submission_status: "no-submission", first_late_sha: sha("9") },
  });
  assert.equal(out.verdict, "no-commit");
  assert.equal(out.kind, "late");
});
