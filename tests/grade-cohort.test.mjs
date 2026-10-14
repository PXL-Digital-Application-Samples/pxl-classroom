// lib/grade-cohort.mjs - reading autograding scores back out of GitHub.
//
// This logic spent its life inside AssignmentDetailView.vue, where nothing
// could import it and no test could run it. Every refusal in it was reasoned
// about once, in a component, and the nightly would have had to reason about
// them again. These are the cases that reasoning is made of, driven over a fake
// transport that answers the way the live API was measured to.
//
// The fixture is the shape GitHub ACTUALLY returns for an Actions-created check
// run - `output.summary: null`, the score in the ANNOTATIONS - because a made-up
// one with the score in `output` is exactly what let a 15/20 be recorded as 0
// for as long as it was.
import { test } from "node:test";
import assert from "node:assert/strict";
import { failedKind, gradeCohort, gradeStudent, gradingCommitFor, keepStoredOnFailedReads, rowFromOutcome } from "../lib/grade-cohort.mjs";

const REPO = "Org/lab-1-ada";

const RUN = {
  id: 77,
  name: "run-autograding-tests",
  conclusion: "failure",
  html_url: "https://github.com/Org/repo/runs/71487050244",
  output: { title: null, summary: null, text: null, annotations_count: 4 },
};

const ANNOTATIONS = [
  { annotation_level: "warning", title: "", message: "Node.js 20 actions are deprecated.", path: ".github" },
  { annotation_level: "notice", title: "Autograding report", message: '{"totalPoints":12,"maxPoints":20}', path: ".github" },
  { annotation_level: "notice", title: "Autograding complete", message: "Points 12/20", path: ".github" },
];

/** A transport with per-path answers; anything unlisted is a 404. */
function transport(routes) {
  const calls = [];
  const request = async (method, path) => {
    calls.push(`${method} ${path}`);
    for (const [pattern, answer] of Object.entries(routes)) {
      if (path.startsWith(pattern)) {
        return typeof answer === "function" ? answer(path) : answer;
      }
    }
    return { ok: false, status: 404, data: {} };
  };
  return { request, calls };
}

const ok = (data) => ({ ok: true, status: 200, data });

const graded = (runs = [RUN], annotations = ANNOTATIONS) => ({
  [`/repos/${REPO}/commits/`]: ok({ check_runs: runs }),
  [`/repos/${REPO}/check-runs/77/annotations`]: ok(annotations),
});

const row = (over = {}) => ({
  github_login: "ada",
  repo_name: REPO,
  preserved_sha: "a".repeat(40),
  ...over,
});

test("the commit is the PRESERVED one where there is one", () => {
  // After a deadline that is THE submission - frozen, and pushed to an archive
  // the student cannot reach. Reading the live tip instead would grade whatever
  // they pushed afterwards.
  assert.equal(
    gradingCommitFor({ preserved_sha: "p".repeat(40), latest_observed_sha: "l".repeat(40) }),
    "p".repeat(40),
  );
  assert.equal(gradingCommitFor({ latest_observed_sha: "l".repeat(40) }), "l".repeat(40));
  assert.equal(gradingCommitFor({}), null);
});

test("a real Actions check run is read from its ANNOTATIONS", async () => {
  const t = transport(graded());
  const res = await gradeCohort(t.request, { students: [row()] });
  assert.equal(res.ok, true, res.refusal);
  assert.equal(res.graded.length, 1);
  assert.equal(res.graded[0].earned_points, 12);
  assert.equal(res.graded[0].total_points, 20);
});

test("NO AUTOGRADING RUN IS NOT FULL MARKS, even beside a green check of the student's own", async () => {
  // The picker used to fall back to the first check run of any kind, so a
  // student who deleted the autograding workflow and added a passing one was
  // awarded the total from `conclusion: success`.
  const t = transport({
    [`/repos/${REPO}/commits/`]: ok({
      check_runs: [{ id: 9, name: "my own tests", conclusion: "success", output: {} }],
    }),
  });
  const res = await gradeCohort(t.request, { students: [row()], fallbackTotal: 20 });
  assert.equal(res.ok, false);
  assert.equal(res.refusal, "nothing-graded");
  assert.equal(res.graded.length, 0);
  assert.match(res.failed[0].reason, /none of them grades/);
  assert.equal(res.failed[0].login, "ada");
});

test("A SKIPPED RUN IS NOT A ZERO - it is a named student", async () => {
  // `conclusion: skipped` is what a job gated on a hand-in commit leaves at
  // every OTHER commit. The 0 this used to produce went into the table and the
  // CSV export as a measured grade.
  const t = transport({
    [`/repos/${REPO}/commits/`]: ok({
      check_runs: [{ ...RUN, conclusion: "skipped", output: { annotations_count: 0 } }],
    }),
  });
  const res = await gradeCohort(t.request, { students: [row()], fallbackTotal: 20 });
  assert.equal(res.ok, false);
  assert.equal(res.refusal, "nothing-graded");
  assert.match(res.failed[0].reason, /skipped|carries no score/);
});

test("A PERMISSION REFUSAL IS NOT RETRYABLE, and nothing is saved", async () => {
  // Both check-run endpoints are gated by the App's Checks permission, and a
  // user-to-server token is capped by what the App declares. "Try again later"
  // is advice that can never come true.
  const t = transport({ [`/repos/${REPO}/commits/`]: { ok: false, status: 403, data: {} } });
  const res = await gradeCohort(t.request, { students: [row()] });
  assert.equal(res.ok, false);
  assert.equal(res.refusal, "permission");
});

test("a transient API failure refuses the whole write rather than grading a subset", async () => {
  const t = transport({
    [`/repos/${REPO}/commits/`]: { ok: false, status: 500, data: {} },
    [`/repos/Org/lab-1-bo/commits/`]: ok({ check_runs: [RUN] }),
    [`/repos/Org/lab-1-bo/check-runs/77/annotations`]: ok(ANNOTATIONS),
  });
  const res = await gradeCohort(t.request, {
    students: [row(), row({ github_login: "bo", repo_name: "Org/lab-1-bo" })],
  });
  assert.equal(res.ok, false);
  assert.equal(res.refusal, "api-errors");
  assert.equal(res.graded.length, 1, "bo was read fine - and still must not be written alone");
});

test("GR8: a deleted repository is a named student, never an API error that refuses everyone", async () => {
  // Review 2026-10-14: a 404 on check-runs was api-failed, so one repository a
  // team switch deleted kept the whole nightly summary from being written.
  const t = transport({
    // ada's repository is gone: everything under it 404s, the repository too.
    [`/repos/Org/lab-1-bo/commits/`]: ok({ check_runs: [RUN] }),
    [`/repos/Org/lab-1-bo/check-runs/77/annotations`]: ok(ANNOTATIONS),
  });
  const res = await gradeCohort(t.request, {
    students: [row(), row({ github_login: "bo", repo_name: "Org/lab-1-bo" })],
  });
  assert.equal(res.ok, true, res.refusal);
  assert.equal(res.graded.length, 1);
  assert.match(res.failed.find((f) => f.login === "ada").reason, /does not exist \(deleted, or out of PXL Classroom's reach\)/);
  // P2-2: a FAILED READ, so a score on record stays - GitHub answers the same
  // 404 for a repository outside what the token may see.
  assert.ok(res.failedReads.has("ada"), "ada's read failed");
  const stored = { students: [{ login: "ada", earned_points: 18, total_points: 20 }], failed: [] };
  const kept = keepStoredOnFailedReads({ stored, graded: res.graded, failed: res.failed, failedReads: res.failedReads });
  assert.deepEqual(kept.graded.find((s) => s.login === "ada"), stored.students[0], "18/20 stays");
  // A 404 on a repository that IS there stays a failed read.
  const there = transport({
    [`/repos/${REPO}/commits/`]: { ok: false, status: 404, data: {} },
    [`/repos/${REPO}`]: ok({ name: "lab-1-ada" }),
  });
  assert.equal((await gradeCohort(there.request, { students: [row()] })).refusal, "api-errors");
});

test("a student who has not pushed is named, never counted as an API error", async () => {
  // Without this the URL was built with `undefined` in it, GitHub answered 404,
  // and a student who simply has not started was reported as a broken read.
  const t = transport(graded());
  const res = await gradeCohort(t.request, {
    students: [row(), { github_login: "bo", repo_name: "Org/lab-1-bo" }],
  });
  assert.equal(res.ok, true, res.refusal);
  assert.equal(res.apiFailedCount, 0);
  const bo = res.failed.find((f) => f.login === "bo");
  assert.match(bo.reason, /no commit on record/);
});

// ---------------------------------------------------------------------------
// The hand-in commit.
// ---------------------------------------------------------------------------

const MARKER = { type: "commit_message", value: "hand-in", multiple: true };

/**
 * When GitHub saw each hand-in pushed - the push runs and the push log a
 * marker is timed from (lib/submission-marker.mjs `handInTime`).
 * `pushes`: [[sha, iso]].
 */
const pushed = (pushes = []) => ({
  [`/repos/${REPO}/actions/runs?`]: ok({
    workflow_runs: pushes.map(([sha, at], i) => ({ id: i + 1, head_sha: sha, head_branch: "main", event: "push", created_at: at, head_commit: { id: sha, message: MARKER.value } })),
  }),
  [`/repos/${REPO}/activity?`]: ok(pushes.map(([sha, at]) => ({ activity_type: "push", ref: "refs/heads/main", after: sha, timestamp: at }))),
});

test("WITH A MARKER THE HAND-IN COMMIT IS THE SUBMISSION, and the report's SHA is not consulted", async () => {
  // The report's commit used to be read FIRST and the hand-in used only as a
  // fallback - which graded a hand-in pushed after the deadline whenever it
  // happened to be the student's last commit, because the fallback carried the
  // deadline bound and the direct read never did.
  const HANDIN = "h".repeat(40);
  const t = transport({
    [`/repos/${REPO}/commits?`]: ok([
      { sha: HANDIN, commit: { message: "hand-in", committer: { date: "2026-09-09T10:00:00Z" } } },
    ]),
    [`/repos/${REPO}/commits/${HANDIN}/check-runs`]: ok({ check_runs: [RUN] }),
    [`/repos/${REPO}/check-runs/77/annotations`]: ok(ANNOTATIONS),
    ...pushed([[HANDIN, "2026-09-09T10:00:05Z"]]),
  });
  const res = await gradeCohort(t.request, {
    students: [row({ effective_deadline_at: "2026-09-10T22:00:00Z" })],
    marker: MARKER,
    markerBranch: "main",
  });
  assert.equal(res.ok, true, res.refusal || JSON.stringify(res.failed));
  assert.ok(
    t.calls.some((c) => c.includes(`${HANDIN}/check-runs`)),
    "the hand-in commit is what was read",
  );
  assert.ok(
    !t.calls.some((c) => c.includes(`${"a".repeat(40)}/check-runs`)),
    "and the preserved SHA was never consulted",
  );
});

test("no hand-in and a LATE hand-in are different sentences", async () => {
  const nothing = transport({ [`/repos/${REPO}/commits?`]: ok([]), ...pushed([]) });
  const res = await gradeCohort(nothing.request, {
    students: [row({ effective_deadline_at: "2026-09-10T22:00:00Z" })],
    marker: MARKER,
  });
  assert.match(res.failed[0].reason, /nothing was handed in/);
  // Committed on time by the student's clock, pushed a day late by GitHub's.
  const LATE = "l".repeat(40);
  const late = transport({
    [`/repos/${REPO}/commits?`]: ok([{ sha: LATE, commit: { message: "hand-in", committer: { date: "2026-09-10T20:00:00Z" } } }]),
    ...pushed([[LATE, "2026-09-11T20:00:00Z"]]),
  });
  const lateRes = await gradeCohort(late.request, {
    students: [row({ effective_deadline_at: "2026-09-10T22:00:00Z" })],
    marker: MARKER,
  });
  assert.match(lateRes.failed[0].reason, /after the deadline \(lllllll, pushed 2026-09-11T20:00:00Z\)/);
});

test("GR9: a rate-limited hand-in read is 'try again', not a missing permission", async () => {
  // Review 2026-10-14: any 403 was "the App needs Actions (read)".
  const limited = transport({
    [`/repos/${REPO}/commits?`]: { ok: false, status: 403, data: { message: "API rate limit exceeded for installation" }, headers: { "x-ratelimit-remaining": "0" } },
  });
  const res = await gradeCohort(limited.request, { students: [row()], marker: MARKER });
  assert.equal(res.ok, false);
  assert.notEqual(res.refusal, "permission");
  assert.match(res.failed[0].reason, /rate limit/);
  // A plain 403 is still the permission.
  const denied = transport({ [`/repos/${REPO}/commits?`]: { ok: false, status: 403, data: { message: "Resource not accessible by integration" } } });
  assert.equal((await gradeCohort(denied.request, { students: [row()], marker: MARKER })).refusal, "permission");
});

test("P2-5: a rate-limited CHECK-RUNS read is 'try again', never the Checks permission - and a plain 403 still is", async () => {
  // Review 2026-10-14: GR9 reached the hand-in reads only; the check runs
  // themselves said "approve Checks" over the rate limit.
  const limited = transport({
    [`/repos/${REPO}/commits/`]: { ok: false, status: 403, data: { message: "API rate limit exceeded for installation" }, headers: { "x-ratelimit-remaining": "0" } },
  });
  const res = await gradeCohort(limited.request, { students: [row()] });
  assert.equal(res.refusal, "api-errors");
  assert.match(res.unreadable[0].reason, /rate limit stopped the read - try again/);
  const denied = transport({ [`/repos/${REPO}/commits/`]: { ok: false, status: 403, data: { message: "Resource not accessible by integration" } } });
  assert.equal((await gradeCohort(denied.request, { students: [row()] })).refusal, "permission");
});

test("a commit lookup that FAILED is not 'there is no hand-in'", async () => {
  const t = transport({ [`/repos/${REPO}/commits?`]: { ok: false, status: 500, data: {} } });
  const res = await gradeCohort(t.request, { students: [row()], marker: MARKER });
  assert.equal(res.ok, false);
  assert.match(res.failed[0].reason, /could not read/);
  // TG-7 (G4b): and it is a FAILED READ, so a score on record is kept.
  assert.ok(res.failedReads.has("ada"));
});

test("TG-7 (G4a): a 403 on the run history or the push log is the App's permission - unless it is the rate limit", async () => {
  const HANDIN = "h".repeat(40);
  const commits = { [`/repos/${REPO}/commits?`]: ok([{ sha: HANDIN, commit: { message: "hand-in", committer: { date: "2026-09-09T10:00:00Z" } } }]) };
  // A cap, so the run history is read (the students' own dispatches count).
  const capped = { ...MARKER, multiple: true, max_hand_ins: 3 };
  const denied = { ok: false, status: 403, data: { message: "Resource not accessible by integration" } };
  const limited = { ok: false, status: 403, data: { message: "API rate limit exceeded" }, headers: { "x-ratelimit-remaining": "0" } };
  // A rate limit is no refusal of the cohort: that student is a failed read,
  // told to read again (P2-10), and their score on record stays.
  for (const [what, answer, refusal, reason] of [
    ["runs", denied, "permission", /Actions run history \(HTTP 403\)/],
    ["activity", denied, "permission", /push history \(HTTP 403\)/],
    ["activity", limited, "nothing-graded", /rate limit stopped the read of this repository's hand-ins/],
  ]) {
    const t = transport({
      ...commits,
      ...pushed([[HANDIN, "2026-09-09T10:00:05Z"]]),
      [`/repos/${REPO}/${what === "runs" ? "actions/runs?" : "activity?"}`]: answer,
    });
    const res = await gradeCohort(t.request, { students: [row({ effective_deadline_at: "2026-09-10T22:00:00Z" })], marker: capped });
    assert.equal(res.refusal, refusal, `${what}: ${JSON.stringify(res)}`);
    assert.match([...res.failed, ...(res.unreadable || [])][0].reason, reason, what);
    if (refusal === "nothing-graded") assert.ok(res.failedReads.has("ada"), "a failed read, kept on record");
  }
});

test("TG-7 (A13): a full-history copy's given commits that cannot be walked to the end are not 'nothing was given'", async () => {
  // What the copy was given is left out of the hand-ins; a walk of it that
  // never finishes cannot say which hand-ins are the student's.
  const GIVEN = "e".repeat(40);
  const t = transport({
    [`/repos/${REPO}/commits?`]: (path) => path.includes(`sha=${GIVEN}`)
      ? ok(Array.from({ length: 100 }, (_, i) => ({ sha: String(i).padStart(40, "0") })))
      : ok([{ sha: "h".repeat(40), commit: { message: "hand-in", committer: { date: "2026-09-09T10:00:00Z" } } }]),
    ...pushed([["h".repeat(40), "2026-09-09T10:00:05Z"]]),
  });
  const res = await gradeCohort(t.request, { students: [row({ starter_sha: GIVEN, effective_deadline_at: "2026-09-10T22:00:00Z" })], marker: MARKER });
  assert.equal(res.ok, false);
  assert.match(res.failed[0].reason, /could not finish counting "hand-in" hand-ins/);
  assert.ok(res.failedReads.has("ada"), "a failed read: the score on record stays");
});

test("TG-7 (GR8): a repository that cannot be read after a 404 on its check runs is a failed read, not a deleted repository", async () => {
  const t = transport({
    [`/repos/${REPO}/commits/`]: { ok: false, status: 404, data: {} },
    [`/repos/${REPO}`]: { ok: false, status: 500, data: {} },
  });
  const res = await gradeCohort(t.request, { students: [row()] });
  // Not a fact about the student: the whole write is refused, as for any
  // read that failed for a reason nobody can name.
  assert.equal(res.refusal, "api-errors");
  assert.doesNotMatch(JSON.stringify(res), /does not exist/);
});

// ---------------------------------------------------------------------------
// The refusals exist so a write can be refused whole.
// ---------------------------------------------------------------------------

test("an empty result NEVER reports ok - it would replace real grades with none", async () => {
  const t = transport({ [`/repos/${REPO}/commits/`]: ok({ check_runs: [] }) });
  const res = await gradeCohort(t.request, { students: [row()] });
  assert.equal(res.ok, false);
  assert.equal(res.refusal, "nothing-graded");
});

test("one student can be graded on their own, and the rest are not touched", async () => {
  // The per-row action. Same function, one row.
  const t = transport(graded());
  const res = await gradeStudent(t.request, { row: row() });
  assert.equal(res.verdict, "graded");
  assert.equal(res.parsed.earned, 12);
});

test("a student who handed in nothing gets no score - even where the starter's commit has a grading run", async () => {
  // Review 2026-10-14: provisioning's own grading-workflow commit triggers a
  // run, so the nightly scored repositories nobody touched - sometimes with
  // points for the starter's passing tests.
  const t = transport(graded());
  const res = await gradeStudent(t.request, { row: row({ submission_status: "no-submission" }) });
  assert.equal(res.verdict, "no-commit");
  assert.equal(res.kind, "not-handed-in");
  assert.deepEqual(t.calls, [], "nothing read");
  assert.equal(rowFromOutcome("ada", res).failed.kind, "not-handed-in");
  assert.equal(failedKind({ reason: res.reason }), "not-handed-in", "an older row without `kind` reads the same");
  // A lecturer's score by hand still wins.
  const manual = await gradeStudent(t.request, {
    row: row({ submission_status: "no-submission" }),
    overrides: [{
      schema_version: 1, assignment_id: "lab", github_login: "ada",
      overrides: [{ type: "manual_score", value: { earned: 5, total: 10 }, reason: "oral", overridden_by: "lect", overridden_at: "2026-10-14T09:00:00.000Z" }],
    }],
  });
  assert.equal(manual.verdict, "manual");
});
