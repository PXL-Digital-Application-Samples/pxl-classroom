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
import { gradeCohort, gradeStudent, gradingCommitFor } from "../lib/grade-cohort.mjs";

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
  const nothing = transport({ [`/repos/${REPO}/commits?`]: ok([]) });
  const res = await gradeCohort(nothing.request, {
    students: [row({ effective_deadline_at: "2026-09-10T22:00:00Z" })],
    marker: MARKER,
  });
  assert.match(res.failed[0].reason, /nothing was handed in/);
});

test("a commit lookup that FAILED is not 'there is no hand-in'", async () => {
  const t = transport({ [`/repos/${REPO}/commits?`]: { ok: false, status: 500, data: {} } });
  const res = await gradeCohort(t.request, { students: [row()], marker: MARKER });
  assert.equal(res.ok, false);
  assert.match(res.failed[0].reason, /could not read/);
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
