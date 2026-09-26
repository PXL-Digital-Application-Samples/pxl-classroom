// "Grade this commit now": a lecturer starts the student repository's grading
// workflow for a commit they choose, with the tests on the student's main
// branch (2026-09-26).
//
// WHY A DISPATCH, AND WHAT IT CAN AND CANNOT DO. GitHub's re-run replays the
// original push (lib/grading-rerun.mjs): the tests as they were, only for a
// commit that was the head of its push, only within 30 days, and a hand-in gate
// skips again. A `workflow_dispatch` entry in the grading workflow has none of
// those limits - it runs the workflow file on the dispatched branch (the
// student's `main`) and checks out the commit named in `grade_sha`. So:
//
//   * tests written IN the workflow are the current ones (what the last starter
//     sync delivered to main); test FILES kept in the repository are the ones
//     at the chosen commit, because that is what is checked out. Said on the
//     button.
//   * the run belongs to main's tip, not to the chosen commit - GitHub attaches
//     a dispatched run to the ref it ran on - so "read the result at commit X"
//     does not find it. The chosen-commit decision therefore records the RUN
//     (`run_id` on the `submission_sha` override) and every grader reads that
//     run's result (`readRunScore`), never a result planted on the old commit.
//   * the run-name carries the commit, and a run whose title does not name the
//     chosen commit is not accepted as having graded it.
//
// The entry exists only in workflows PXL Classroom generates
// (lib/starter-workflow.mjs, provisioning's buildAutogradingWorkflow) and in
// the templates this repository ships; existing repositories get it through
// Sync Starter Code. A template's own workflow needs the same three lines.
//
// ISOMORPHIC: `request(method, path, body)` resolves `{ ok, status, data }`.

import { pickAutogradeCheckRun, parseCheckRunScore } from "./check-run-score.mjs";
import { fetchCheckRunAnnotations } from "./check-run-annotations.mjs";

/** The input's name - spelled once; the workflows, the page and the tests read it here. */
export const GRADE_DISPATCH_INPUT = "grade_sha";

/** The `workflow_dispatch` trigger to merge into a grading workflow's `on:`. */
export function gradeDispatchTrigger() {
  return {
    workflow_dispatch: {
      inputs: {
        [GRADE_DISPATCH_INPUT]: {
          description: "Commit to grade (started by a lecturer from PXL Classroom)",
          required: true,
          type: "string",
        },
      },
    },
  };
}

/**
 * The run's title. A dispatch names the commit it grades, which is what
 * `readRunScore` checks before trusting the run; a push keeps GitHub's own
 * title (the commit message).
 */
export const GRADE_RUN_NAME =
  `\${{ github.event_name == 'workflow_dispatch' && format('Grade {0} (PXL Classroom)', inputs.${GRADE_DISPATCH_INPUT}) || github.event.head_commit.message }}`;

/** The checkout that grades the chosen commit on a dispatch, and the pushed one otherwise. */
export function gradeCheckoutStep() {
  return {
    name: "Checkout code",
    uses: "actions/checkout@v7",
    // `with:`, never a script: the value is an input a person typed.
    with: { ref: `\${{ inputs.${GRADE_DISPATCH_INPUT} || github.sha }}` },
  };
}

/** A hand-in gate that still lets a lecturer's dispatch through. */
export function gateAllowingDispatch(gateExpr) {
  return `github.event_name == 'workflow_dispatch' || ${gateExpr}`;
}

/** Does this workflow file carry the entry? A text check, the same kind `isGradingWorkflow` is. */
export function hasGradeDispatch(text) {
  const t = String(text ?? "");
  return /\bworkflow_dispatch\b/.test(t) && new RegExp(`\\b${GRADE_DISPATCH_INPUT}\\b`).test(t);
}

/** The run title a dispatch for `sha` produces - what `readRunScore` checks. */
export const gradeRunTitle = (sha) => `Grade ${sha} (PXL Classroom)`;

/**
 * Find the repository's grading workflow and whether it can grade a chosen
 * commit. Never throws.
 *
 * @returns {Promise<{ ok: boolean, workflowId?: number, path?: string, available?: boolean, reason?: string }>}
 */
export async function findGradingWorkflow(request, { repo, branch = "main" }) {
  const list = await request("GET", `/repos/${repo}/actions/workflows?per_page=100`);
  if (!list?.ok) return { ok: false, reason: `could not list this repository's workflows (HTTP ${list?.status ?? 0})` };
  const workflows = (list.data?.workflows || []).filter((w) => w?.state === "active");
  for (const w of workflows) {
    const file = await request("GET", `/repos/${repo}/contents/${w.path}?ref=${encodeURIComponent(branch)}`);
    if (!file?.ok || !file.data?.content) continue;
    const text = decodeBase64(file.data.content);
    if (!/classroom-resources\/autograding-grading-reporter|autograd|grading/i.test(text)) continue;
    return { ok: true, workflowId: w.id, path: w.path, available: hasGradeDispatch(text) };
  }
  return { ok: true, available: false, reason: "no grading workflow was found in this repository" };
}

const decodeBase64 = (b64) => {
  const clean = String(b64).replace(/\s/g, "");
  if (typeof Buffer !== "undefined") return Buffer.from(clean, "base64").toString("utf8");
  return new TextDecoder().decode(Uint8Array.from(atob(clean), (c) => c.charCodeAt(0)));
};

/**
 * Start grading `sha` now. Resolves the run id GitHub names, or a reason.
 *
 * @returns {Promise<{ ok: boolean, runId?: number, status?: number, reason?: string }>}
 */
export async function dispatchGrading(request, { repo, workflowId, sha, branch = "main" }) {
  if (!/^[0-9a-f]{40}$/.test(String(sha))) return { ok: false, reason: "not a full commit id" };
  const res = await request("POST", `/repos/${repo}/actions/workflows/${workflowId}/dispatches`, {
    ref: branch,
    inputs: { [GRADE_DISPATCH_INPUT]: sha },
    return_run_details: true,
  });
  if (res?.ok && Number.isInteger(res.data?.workflow_run_id)) return { ok: true, runId: res.data.workflow_run_id };
  if (res?.ok) return { ok: false, status: res.status, reason: "GitHub started the run but did not say which one, so its result could not be tied to this commit" };
  const msg = res?.data?.message || "";
  if (res?.status === 422 && /workflow_dispatch|Unexpected inputs/i.test(msg)) {
    return { ok: false, status: 422, reason: "this repository's grading workflow cannot grade a chosen commit yet - sync the updated workflow file with Sync Starter Code" };
  }
  return {
    ok: false,
    status: res?.status ?? 0,
    reason: res?.status === 403
      ? "GitHub refused to start the run (HTTP 403): the PXL Classroom app needs permission to run Actions in this organization, and you need admin access to this repository"
      : `GitHub refused to start the run (HTTP ${res?.status ?? 0}${msg ? `: ${msg}` : ""})`,
  };
}

/**
 * A commit's check runs WITHOUT those of dispatched runs - what "the result at
 * this commit" means to everything that grades by the rules.
 *
 * Measured 2026-09-26 (tests/live/grade-dispatch.mjs): a run dispatched to
 * grade an OLD commit belongs to the branch tip, so its check run is listed on
 * the tip's commit - newest first - and the tip, graded 0/10 by its push, read
 * 10/10: the old commit's result. The same holds for a student who dispatches
 * the workflow themselves. A dispatched run's score is read only through a
 * decision that names it (`readRunScore`).
 *
 * The extra read happens only when the check runs span more than one check
 * suite; a push run and its re-runs share one. A failed read is a failed read,
 * never "no dispatches".
 *
 * @returns {Promise<{ ok: boolean, checkRuns?: object[], status?: number }>}
 */
export async function withoutDispatchedRuns(request, { repoFullName, sha, checkRuns }) {
  const runs = Array.isArray(checkRuns) ? checkRuns : [];
  const suites = new Set(runs.map((c) => c?.check_suite?.id).filter((id) => id != null));
  if (suites.size < 2) return { ok: true, checkRuns: runs };
  const res = await request("GET", `/repos/${repoFullName}/actions/runs?head_sha=${sha}&event=workflow_dispatch&per_page=100`);
  if (!res?.ok) return { ok: false, status: res?.status ?? 0 };
  const dispatched = new Set((res.data?.workflow_runs || []).map((w) => w.check_suite_id));
  return { ok: true, checkRuns: runs.filter((c) => !dispatched.has(c?.check_suite?.id)) };
}

/**
 * The score one dispatched run produced for `sha` - the same verdicts as
 * `readScoreAtCommit` (lib/grade-cohort.mjs), read from that RUN's check runs
 * rather than from whatever is attached to a commit. Never a guessed score.
 *
 * @returns {Promise<{ verdict: string, reason?: string, run?: object, parsed?: object, sha?: string, permissionDenied?: boolean }>}
 */
export async function readRunScore(request, { repoFullName, runId, sha, fallbackTotal = 0 }) {
  const short = String(sha).slice(0, 7);
  const runRes = await request("GET", `/repos/${repoFullName}/actions/runs/${runId}`);
  if (!runRes?.ok) return { verdict: "api-failed", permissionDenied: runRes?.status === 403, reason: `could not read the grading run ${runId} (HTTP ${runRes?.status ?? 0})` };
  const wf = runRes.data;
  if (wf?.event !== "workflow_dispatch" || !String(wf?.display_title || wf?.name || "").includes(sha)) {
    return { verdict: "no-run", reason: `run ${runId} is not a grading run for commit ${short}` };
  }
  if (wf.status !== "completed") return { verdict: "not-run", reason: `the grading run for commit ${short} is still going` };
  const checks = await request("GET", `/repos/${repoFullName}/check-suites/${wf.check_suite_id}/check-runs?per_page=100`);
  if (!checks?.ok) return { verdict: "api-failed", permissionDenied: checks?.status === 403, reason: `could not read the grading run's checks (HTTP ${checks?.status ?? 0})` };
  const run = pickAutogradeCheckRun(checks.data?.check_runs || []);
  if (!run) return { verdict: "no-run", reason: `the run that graded commit ${short} has no grading check in it` };
  let annotations = [];
  let complete = true;
  if (run?.output?.annotations_count) {
    const res = await fetchCheckRunAnnotations((path) => request("GET", path), { repoFullName, checkRunId: run.id });
    annotations = res.annotations;
    complete = res.complete;
  }
  const parsed = parseCheckRunScore(run, annotations, fallbackTotal);
  if (!parsed.matched && !complete) return { verdict: "unreadable", reason: `could not read the score annotations of the run that graded ${short}` };
  if (!parsed.graded) return { verdict: "not-run", reason: `the run that graded commit ${short} was ${parsed.conclusion || "never completed"}, so it carries no score` };
  // The run the score came from, for the summary's link - the dispatched run,
  // not a check run on another commit.
  return { verdict: "graded", run: { ...run, html_url: wf.html_url || run.html_url }, parsed, sha };
}
