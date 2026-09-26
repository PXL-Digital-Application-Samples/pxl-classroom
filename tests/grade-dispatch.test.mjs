// "Grade this commit now": lib/grade-dispatch.mjs, the workflows that carry
// the entry, and the decision that records the run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse, stringify } from "yaml";
import {
  GRADE_DISPATCH_INPUT, dispatchGrading, findGradingWorkflow, gradeRunTitle, hasGradeDispatch, readRunScore,
} from "../lib/grade-dispatch.mjs";
import { buildStarterWorkflow } from "../lib/starter-workflow.mjs";
import { buildAutogradingWorkflow } from "../provisioning/provision.mjs";
import { CHOSEN_COMMIT, decisionEntry, gradeDecisionFor } from "../lib/grade-override.mjs";
import { gradeStudent, rowFromOutcome } from "../lib/grade-cohort.mjs";
import { validateAgainst } from "../lib/validate.mjs";

const SHA = "c".repeat(40);
const TIP = "d".repeat(40);

// --- every workflow we ship carries the entry, and it does what it says -------

function expectEntry(name, doc) {
  const input = doc.on?.workflow_dispatch?.inputs?.[GRADE_DISPATCH_INPUT];
  assert.ok(input?.required === true && input.type === "string", `${name}: workflow_dispatch with a required ${GRADE_DISPATCH_INPUT}`);
  assert.match(doc["run-name"], new RegExp(`format\\('Grade \\{0\\} \\(PXL Classroom\\)', inputs\\.${GRADE_DISPATCH_INPUT}\\)`), `${name}: the run is titled with the commit`);
  const checkout = Object.values(doc.jobs).flatMap((j) => j.steps || []).find((s) => /actions\/checkout@/.test(s.uses || ""));
  assert.equal(checkout?.with?.ref, `\${{ inputs.${GRADE_DISPATCH_INPUT} || github.sha }}`, `${name}: checks out the chosen commit`);
  for (const job of Object.values(doc.jobs)) {
    if (typeof job.if === "string") assert.match(job.if, /^github\.event_name == 'workflow_dispatch' \|\| /, `${name}: a gate lets a dispatch through`);
  }
}

test("the starter workflow, gated and ungated, carries the entry", () => {
  expectEntry("starter (gated)", parse(buildStarterWorkflow({ handInMessage: "einde examen" })));
  expectEntry("starter", parse(buildStarterWorkflow()));
});

test("the workflow provisioning writes carries the entry, and a push cannot cancel a dispatch", () => {
  const doc = parse(buildAutogradingWorkflow({ id: "x", autograde: { enabled: true, tests: [{ id: "t1", type: "run", command: "true", points: 1 }] } }, "Org"));
  expectEntry("provisioning", doc);
  assert.match(doc.concurrency.group, /inputs\.grade_sha && github\.run_id \|\| 'push'/, "each dispatch is its own group");
});

test("both templates this repository ships carry the entry", () => {
  for (const p of ["templates/template-autograding-actions/.github/workflows/autograding.yml", "templates/template-cloud-autograding/.github/workflows/classroom.yml"]) {
    const text = readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
    assert.equal(hasGradeDispatch(text), true, p);
    expectEntry(p, parse(text));
  }
});

// --- finding, dispatching, reading ------------------------------------------------

const b64 = (s) => Buffer.from(s).toString("base64");
function fakeGitHub({ workflowText = buildStarterWorkflow(), dispatch = { status: 200, data: { workflow_run_id: 77 } }, run = {}, checkRuns = null } = {}) {
  const calls = [];
  const request = async (method, path, body) => {
    calls.push({ method, path, body });
    if (path.startsWith("/repos/Org/r/actions/workflows?")) return { ok: true, status: 200, data: { workflows: [{ id: 5, path: ".github/workflows/classroom.yml", state: "active" }] } };
    if (path.startsWith("/repos/Org/r/contents/.github/workflows/classroom.yml")) return { ok: true, status: 200, data: { content: b64(workflowText) } };
    if (method === "POST" && path.endsWith("/dispatches")) return { ok: dispatch.status < 300, ...dispatch };
    if (path === "/repos/Org/r/actions/runs/77") {
      return { ok: true, status: 200, data: { id: 77, event: "workflow_dispatch", status: "completed", display_title: gradeRunTitle(SHA), head_sha: TIP, check_suite_id: 9, html_url: "https://run/77", ...run } };
    }
    if (path.startsWith("/repos/Org/r/check-suites/9/check-runs")) {
      return { ok: true, status: 200, data: { check_runs: checkRuns ?? [{ id: 1, name: "run-autograding-tests", status: "completed", conclusion: "success", output: { title: "Points 7/10", annotations_count: 0 } }] } };
    }
    return { ok: false, status: 404, data: { message: "not stubbed" } };
  };
  return { request, calls };
}

test("a repository whose grading workflow carries the entry is found and available; one without is found and not", async () => {
  assert.deepEqual(await findGradingWorkflow(fakeGitHub().request, { repo: "Org/r" }), { ok: true, workflowId: 5, path: ".github/workflows/classroom.yml", available: true });
  const old = "name: g\non: push\njobs:\n  grade:\n    steps:\n      - uses: classroom-resources/autograding-grading-reporter@v1\n";
  assert.equal((await findGradingWorkflow(fakeGitHub({ workflowText: old }).request, { repo: "Org/r" })).available, false);
});

test("dispatching sends the commit on main and returns the run GitHub names", async () => {
  const gh = fakeGitHub();
  assert.deepEqual(await dispatchGrading(gh.request, { repo: "Org/r", workflowId: 5, sha: SHA }), { ok: true, runId: 77 });
  const post = gh.calls.find((c) => c.method === "POST");
  assert.deepEqual(post.body, { ref: "main", inputs: { grade_sha: SHA }, return_run_details: true });
});

test("a workflow without the entry says what to do; a short sha never reaches GitHub", async () => {
  const gh = fakeGitHub({ dispatch: { status: 422, data: { message: "Workflow does not have 'workflow_dispatch' trigger" } } });
  const res = await dispatchGrading(gh.request, { repo: "Org/r", workflowId: 5, sha: SHA });
  assert.equal(res.ok, false);
  assert.match(res.reason, /sync the updated workflow file with Sync Starter Code/);
  const short = await dispatchGrading(gh.request, { repo: "Org/r", workflowId: 5, sha: "abc123" });
  assert.equal(short.ok, false);
  assert.equal(gh.calls.filter((c) => c.method === "POST").length, 1);
});

test("the run's own result is read - from its check suite, not the commit", async () => {
  const out = await readRunScore(fakeGitHub().request, { repoFullName: "Org/r", runId: 77, sha: SHA, fallbackTotal: 10 });
  assert.equal(out.verdict, "graded");
  assert.equal(out.parsed.earned, 7);
  assert.equal(out.run.html_url, "https://run/77", "the link is the dispatched run");
});

test("a run that does not name this commit, or was pushed, is NOT accepted as having graded it", async () => {
  const other = await readRunScore(fakeGitHub({ run: { display_title: gradeRunTitle("e".repeat(40)) } }).request, { repoFullName: "Org/r", runId: 77, sha: SHA });
  assert.equal(other.verdict, "no-run");
  const pushed = await readRunScore(fakeGitHub({ run: { event: "push" } }).request, { repoFullName: "Org/r", runId: 77, sha: SHA });
  assert.equal(pushed.verdict, "no-run");
});

test("a DELETED run is a named refusal for that student, never an API failure that blocks the cohort", async () => {
  // Review: a 404 on the recorded run made gradeCohort count an unnamed API
  // failure, so Re-grade all and the nightly refused for ever without saying who.
  const gone = async (_m, path) => {
    if (path.endsWith("/actions/runs/77")) return { ok: false, status: 404, data: { message: "Not Found" } };
    if (path === "/repos/Org/r") return { ok: true, status: 200, data: { full_name: "Org/r" } };
    return fakeGitHub().request(_m, path);
  };
  const out = await readRunScore(gone, { repoFullName: "Org/r", runId: 77, sha: SHA });
  assert.equal(out.verdict, "no-run");
  assert.match(out.reason, /no longer exists - grade that commit again, or go back to the rules/);
  // ...but a REPOSITORY that is gone (or outside this token) answers 404 for
  // the run too, and that is a failed read, never "the run no longer exists".
  const repoGone = async (_m, path) => (path.includes("/repos/Org/r") ? { ok: false, status: 404, data: { message: "Not Found" } } : fakeGitHub().request(_m, path));
  assert.equal((await readRunScore(repoGone, { repoFullName: "Org/r", runId: 77, sha: SHA })).verdict, "api-failed");

  const doc = { schema_version: 1, assignment_id: "x", github_login: "kim", overrides: [decisionEntry({ type: CHOSEN_COMMIT, value: SHA, reason: "r", by: "l", runId: 77 })] };
  const { gradeCohort } = await import("../lib/grade-cohort.mjs");
  const res = await gradeCohort(gone, { students: [{ github_login: "kim", repo_name: "Org/r" }], overrides: [doc], fallbackTotal: 10 });
  assert.equal(res.apiFailedCount, 0);
  assert.deepEqual(res.failed.map((f) => f.login), ["kim"]);
});

test("a RATE-LIMIT 403 on the dispatch list is a failed read, never 'no permission' (review 2026-09-26)", async () => {
  // Read as no permission, it kept the dispatched run - newest - and the old
  // commit's score was written for the tip.
  const { withoutDispatchedRuns } = await import("../lib/grade-dispatch.mjs");
  const two = [{ id: 1, check_suite: { id: 5 } }, { id: 2, check_suite: { id: 6 } }];
  const secondary = async () => ({ ok: false, status: 403, data: { message: "You have exceeded a secondary rate limit." } });
  assert.deepEqual(await withoutDispatchedRuns(secondary, { repoFullName: "Org/r", sha: TIP, checkRuns: two }), { ok: false, status: 403 });
  const primary = async () => ({ ok: false, status: 403, data: { message: "API rate limit exceeded" }, headers: new Headers({ "x-ratelimit-remaining": "0" }) });
  assert.equal((await withoutDispatchedRuns(primary, { repoFullName: "Org/r", sha: TIP, checkRuns: two })).ok, false);
  const permission = async () => ({ ok: false, status: 403, data: { message: "Resource not accessible by integration" } });
  assert.equal((await withoutDispatchedRuns(permission, { repoFullName: "Org/r", sha: TIP, checkRuns: two })).ok, true);
});

test("the entry must GRADE on a dispatch: a blocking hand-in gate, or a checkout in another job, is not available", () => {
  const wf = (jobs) => stringify({
    "run-name": "${{ github.event_name == 'workflow_dispatch' && format('Grade {0} (PXL Classroom)', inputs.grade_sha) || github.event.head_commit.message }}",
    on: { push: null, workflow_dispatch: { inputs: { grade_sha: null } } },
    jobs,
  });
  const checkout = { uses: "actions/checkout@v7", with: { ref: "${{ inputs.grade_sha || github.sha }}" } };
  const reporter = { uses: "classroom-resources/autograding-grading-reporter@v1" };
  assert.equal(hasGradeDispatch(wf({ grade: { steps: [checkout, reporter] } })), true, "a bare `grade_sha:` input is declared");
  assert.equal(hasGradeDispatch(wf({ grade: { if: "github.event.head_commit.message == 'hand in'", steps: [checkout, reporter] } })), false, "the gate skips the dispatch");
  assert.equal(hasGradeDispatch(wf({ grade: { if: "github.event_name == 'workflow_dispatch' || github.event.head_commit.message == 'hand in'", steps: [checkout, reporter] } })), true);
  assert.equal(hasGradeDispatch(wf({ build: { steps: [checkout] }, grade: { steps: [{ uses: "actions/checkout@v7" }, reporter] } })), false, "the grading job checks out the tip");
});

test("an UNREADABLE student is named in the refusal", async () => {
  const { gradeCohort } = await import("../lib/grade-cohort.mjs");
  const down = async () => ({ ok: false, status: 502, data: null });
  const res = await gradeCohort(down, { students: [{ github_login: "kim", repo_name: "Org/r", latest_observed_sha: SHA }], fallbackTotal: 10 });
  assert.equal(res.refusal, "api-errors");
  assert.deepEqual(res.unreadable.map((u) => u.login), ["kim"]);
});

test("the entry is ALL THREE parts: a workflow with the input but no checkout or title is not offered", () => {
  const whole = buildStarterWorkflow();
  assert.equal(hasGradeDispatch(whole), true);
  assert.equal(hasGradeDispatch(whole.replace(/run-name:.*\n/, "")), false, "no title: readRunScore would refuse the run");
  assert.equal(hasGradeDispatch(whole.replace(/ref: .*\n/, "")), false, "no checkout of the input: it would grade the tip");
  assert.equal(hasGradeDispatch("on:\n  workflow_dispatch:\n    inputs:\n      grade_sha: {}\n"), false);
  assert.equal(hasGradeDispatch("not: [yaml"), false, "unparseable is not available");
});

test("a FOLDED run-name is still the entry - measured: yaml.stringify wraps it across lines", () => {
  // The live probe re-serialised the generated workflow and got
  //   run-name: ${{ ... format('Grade {0} (PXL
  //     Classroom)', inputs.grade_sha) || ... }}
  // which a text check reported as "cannot grade a chosen commit yet".
  const folded = stringify(parse(buildStarterWorkflow()), { lineWidth: 40 });
  assert.match(folded, /run-name: [^\n]*\n {2}\S/, "the fixture really is folded");
  assert.equal(hasGradeDispatch(folded), true);
});

test("findGradingWorkflow prefers the one with the entry, then the reporter - never a workflow that merely says 'grading'", async () => {
  const files = {
    "lint.yml": "name: lint\n# grading happens elsewhere\non: push\n",
    "classroom.yml": "name: g\non: push\njobs:\n  x:\n    steps:\n      - uses: classroom-resources/autograding-grading-reporter@v1\n",
  };
  const request = async (_m, path) => {
    if (path.includes("/actions/workflows?")) {
      return { ok: true, status: 200, data: { workflows: Object.keys(files).map((p, i) => ({ id: i + 1, path: `.github/workflows/${p}`, state: "active" })) } };
    }
    const name = Object.keys(files).find((p) => path.includes(`/contents/.github/workflows/${p}`));
    return name ? { ok: true, status: 200, data: { content: b64(files[name]) } } : { ok: false, status: 404 };
  };
  const found = await findGradingWorkflow(request, { repo: "Org/r" });
  assert.equal(found.path, ".github/workflows/classroom.yml");
  assert.equal(found.available, false);
  files["classroom.yml"] = buildStarterWorkflow();
  assert.equal((await findGradingWorkflow(request, { repo: "Org/r" })).available, true);
});

test("still going, or a failed read, is never a score", async () => {
  assert.equal((await readRunScore(fakeGitHub({ run: { status: "in_progress" } }).request, { repoFullName: "Org/r", runId: 77, sha: SHA })).verdict, "not-run");
  const cancelled = await readRunScore(fakeGitHub({ checkRuns: [{ id: 1, name: "grading", status: "completed", conclusion: "cancelled", output: {} }] }).request, { repoFullName: "Org/r", runId: 77, sha: SHA });
  assert.equal(cancelled.verdict, "not-run");
});

// --- the rules never read a dispatched run ----------------------------------------

test("THE MEASURED CASE: a run dispatched for an old commit is listed on the TIP, and the rules do not read it", async () => {
  // Live, 2026-09-26: the tip graded 0/10 by its push read 10/10 afterwards -
  // the old commit's result, newest first on the tip's check runs.
  const { readScoreAtCommit } = await import("../lib/grade-cohort.mjs");
  const reads = [];
  const request = async (_m, path) => {
    reads.push(path);
    if (path === `/repos/Org/r/commits/${TIP}/check-runs`) {
      return { ok: true, status: 200, data: { check_runs: [
        { id: 2, name: "run-autograding-tests", status: "completed", conclusion: "success", check_suite: { id: 98 }, output: { title: "Points 10/10", annotations_count: 0 } },
        { id: 1, name: "run-autograding-tests", status: "completed", conclusion: "failure", check_suite: { id: 97 }, output: { title: "Points 0/10", annotations_count: 0 } },
      ] } };
    }
    if (path.startsWith(`/repos/Org/r/actions/runs?head_sha=${TIP}&event=workflow_dispatch`)) {
      return { ok: true, status: 200, data: { workflow_runs: [{ id: 900, check_suite_id: 98 }] } };
    }
    return { ok: false, status: 404, data: null };
  };
  const out = await readScoreAtCommit(request, { repoFullName: "Org/r", sha: TIP, fallbackTotal: 10 });
  assert.equal(out.verdict, "graded");
  assert.equal(out.parsed.earned, 0, "the tip's own push result, not the dispatched one");
  assert.equal(out.run.id, 1);
});

test("a tip whose ONLY suite is a dispatched run reads nothing by the rules, not the old commit's score", async () => {
  // Review 2026-09-26: `[skip ci]` or a deleted push run leaves the tip with
  // one suite - the dispatched run's - which a "two suites or more" shortcut kept.
  const { readScoreAtCommit } = await import("../lib/grade-cohort.mjs");
  const request = async (_m, path) => {
    if (path === `/repos/Org/r/commits/${TIP}/check-runs`) {
      return { ok: true, status: 200, data: { check_runs: [
        { id: 2, name: "run-autograding-tests", status: "completed", conclusion: "success", check_suite: { id: 98 }, output: { title: "Points 10/10", annotations_count: 0 } },
      ] } };
    }
    if (path.includes("event=workflow_dispatch")) return { ok: true, status: 200, data: { workflow_runs: [{ id: 900, check_suite_id: 98 }] } };
    return { ok: false, status: 404, data: null };
  };
  const out = await readScoreAtCommit(request, { repoFullName: "Org/r", sha: TIP, fallbackTotal: 10 });
  assert.equal(out.verdict, "no-run");
});

test("the dispatch list: asked for any suite; only when ambiguous on the cheap path; a 403 keeps every run, a 500 is a failed read", async () => {
  const { withoutDispatchedRuns } = await import("../lib/grade-dispatch.mjs");
  let calls = 0;
  const answer = (status) => async () => { calls++; return { ok: false, status }; };
  const one = [{ id: 1, check_suite: { id: 5 } }, { id: 2, check_suite: { id: 5 } }];
  const two = [{ id: 1, check_suite: { id: 5 } }, { id: 2, check_suite: { id: 6 } }];
  const none = [{ id: 1 }];

  assert.deepEqual(await withoutDispatchedRuns(answer(500), { repoFullName: "Org/r", sha: TIP, checkRuns: none }), { ok: true, checkRuns: none }, "no suite ids: nothing to ask about");
  assert.equal(calls, 0);
  assert.deepEqual(await withoutDispatchedRuns(answer(500), { repoFullName: "Org/r", sha: TIP, checkRuns: one, onlyWhenAmbiguous: true }), { ok: true, checkRuns: one });
  assert.equal(calls, 0, "the Refresh column's shortcut costs no read on one suite");
  assert.deepEqual(await withoutDispatchedRuns(answer(500), { repoFullName: "Org/r", sha: TIP, checkRuns: one }), { ok: false, status: 500 });
  assert.equal(calls, 1, "grading asks even on one suite");
  // No Actions (read): the App's token cannot list runs, and a lecturer's
  // page token (capped by the App) cannot have dispatched one either.
  assert.deepEqual(await withoutDispatchedRuns(answer(403), { repoFullName: "Org/r", sha: TIP, checkRuns: two }), { ok: true, checkRuns: two });
});

// --- the decision records the run, and every grader reads it --------------------

test("a chosen commit graded by a dispatch records its run, validates, and is read from that run", async () => {
  const entry = decisionEntry({ type: CHOSEN_COMMIT, value: SHA, reason: "graded with the fixed tests", by: "l", runId: 77 });
  assert.equal(entry.run_id, 77);
  const doc = { schema_version: 1, assignment_id: "x", github_login: "kim", overrides: [entry] };
  assert.equal(validateAgainst("override", doc).valid, true);
  assert.equal(gradeDecisionFor("kim", { overrides: [doc] }).runId, 77);

  const reads = [];
  const gh = fakeGitHub();
  const request = async (m, p, b) => { reads.push(p); return gh.request(m, p, b); };
  const out = await gradeStudent(request, { row: { github_login: "kim", repo_name: "Org/r" }, overrides: [doc], fallbackTotal: 10 });
  assert.equal(out.verdict, "graded");
  assert.ok(reads.some((p) => p === "/repos/Org/r/actions/runs/77"), "read from the run");
  assert.ok(!reads.some((p) => p.includes(`/commits/${SHA}/check-runs`)), "not from the commit");
  const { graded } = rowFromOutcome("kim", out, 10);
  assert.equal(graded.graded_sha, SHA);
  assert.equal(graded.ci_run_url, "https://run/77");
});

test("going back to the rules drops the run with the choice", () => {
  const back = decisionEntry({ type: CHOSEN_COMMIT, value: null, reason: "r", by: "l", runId: 77 });
  assert.equal("run_id" in back, false);
});
