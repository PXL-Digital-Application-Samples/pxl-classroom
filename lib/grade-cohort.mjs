// PXL Classroom - reading autograding scores back out of GitHub.
//
// ONE IMPLEMENTATION, because there are now three callers: the Admin Panel's
// re-grade, the per-student re-grade on a row, and the nightly finalize. It
// lived inside AssignmentDetailView.vue, where nothing could import it and no
// test could run it - so every refusal below was reasoned about once, in a
// component, and would have been reasoned about again in the workflow.
//
// ISOMORPHIC: `request(method, path, body)` is passed in, exactly as
// lib/submission-lock.mjs takes one, so the SPA drives it over `ghApi` and a
// script drives it over `lib/gh.mjs`. No `node:` imports - a static one here is
// a blank page that `npm run build` will not catch.
//
// WHAT THIS WILL NOT DO IS INVENT A SCORE. Every path that cannot establish one
// returns a NAMED student and a reason. A check run that did not run is not a
// zero; a read that failed is not a zero; a green check that is not the grading
// workflow is not full marks. Those three were all bugs, and the comments below
// say which.

import { pickAutogradeCheckRun, parseCheckRunScore } from "./check-run-score.mjs";
import { fetchCheckRunAnnotations } from "./check-run-annotations.mjs";
import { findMarkedCommit, listHandIns, selectHandIn } from "./submission-marker.mjs";
import { gradedRowFromCheckRun, gradedRowFromManualScore } from "./grading-summary.mjs";
import { decisionRecord, gradeDecisionFor } from "./grade-override.mjs";
import { handInLimitFor } from "./hand-in-allowance.mjs";
import { normalizeLogin } from "./github-login.mjs";

/**
 * Which commit a hand-in marker says to grade, with the cap applied.
 *
 * ONE DECISION for three graders - the Admin Panel, the nightly and
 * `pxl-classroom grade` - which is why the CLI no longer walks the commits
 * itself. Returns either `{ verdict: "found", commit }` or a refusal with a
 * reason, and in both cases the hand-in count when the assignment caps it: a
 * student refused because their graded hand-in has no run still used 3 of 2,
 * and that is worth saying.
 *
 * @param {(path: string) => Promise<{status: number, data: any}>} get
 * @param {{ row: import("./types.mjs").ReportStudent,
 *           marker: import("./submission-marker.mjs").SubmissionMarker,
 *           markerBranch?: string,
 *           overrides?: Map|Array|null, team?: {members?: string[]}|null }} opts
 * @returns {Promise<{ verdict: string, reason?: string,
 *           commit?: import("./submission-marker.mjs").HandIn, handIns: HandInCount|null }>}
 */
export async function resolveHandIn(get, { row, marker, markerBranch = "main", overrides = null, team = null }) {
  const repoFullName = row?.repo_name;
  const until = row?.effective_deadline_at || null;
  const { limit, base, extra } = handInLimitFor(marker, row?.github_login, { overrides, team });

  // Uncapped: the one question findMarkedCommit answers, spending what it
  // always did. Nothing below runs for an assignment without a cap.
  if (base == null) {
    const found = await findMarkedCommit(get, { repoFullName, branch: markerBranch, marker, until });
    if (!found.ok) {
      return {
        verdict: "lookup-failed",
        reason: `could not read this repository's commits to find the "${marker.value}" commit`,
        handIns: null,
      };
    }
    if (!found.complete) {
      return {
        verdict: "lookup-failed",
        reason: `could not finish looking for the "${marker.value}" commit - stopped after ${found.scanned} commits`,
        handIns: null,
      };
    }
    if (!found.commit) return { verdict: "no-commit", reason: noHandInReason(marker, found.lateCommit), handIns: null };
    return { verdict: "found", commit: found.commit, handIns: null };
  }

  const listed = await listHandIns(get, { repoFullName, branch: markerBranch, marker, withRuns: true });
  if (!listed.ok) {
    return {
      verdict: "lookup-failed",
      reason:
        listed.failedRead === "runs"
          ? `could not read this repository's Actions run history (HTTP ${listed.status}), which the hand-in limit counts from`
          : `could not read this repository's commits to find the "${marker.value}" commit`,
      handIns: null,
    };
  }
  if (!listed.complete) {
    // A count that stopped early is not a count, and grading the "last valid"
    // hand-in of a partial list could grade one the cap excludes.
    return {
      verdict: "lookup-failed",
      reason: `could not finish counting "${marker.value}" hand-ins - stopped after ${listed.scanned} commits`,
      handIns: null,
    };
  }

  const picked = selectHandIn(listed.handIns, { until, multiple: marker.multiple, limit });
  const handIns = {
    used: picked.used,
    allowed: picked.allowed,
    extra,
    graded_sha: picked.commit?.sha ?? null,
    graded_number: picked.number,
    ignored: picked.ignored,
  };
  if (!picked.commit) return { verdict: "no-commit", reason: noHandInReason(marker, picked.lateCommit), handIns };
  return { verdict: "found", commit: picked.commit, handIns };
}

function noHandInReason(marker, lateCommit) {
  // A late hand-in is a different fact from no hand-in, and the lecturer does
  // something different about each.
  return lateCommit
    ? `the only "${marker.value}" commit is after the deadline (${lateCommit.sha.slice(0, 7)}, ${lateCommit.date})`
    : `no commit says "${marker.value}", so nothing was handed in`;
}

/**
 * The members of the team `row` belongs to, from the rows of the same report.
 * Null for an individual row. Their allowances are pooled because they share
 * one repository and so one count (lib/hand-in-allowance.mjs).
 */
export function teamOf(row, students) {
  if (!row?.team_slug) return null;
  const members = (students || [])
    .filter((s) => s?.team_slug === row.team_slug && s.github_login)
    .map((s) => normalizeLogin(s.github_login));
  return { members };
}

/**
 * The commit a student's score should be read at, when no hand-in message
 * decides it.
 *
 * Preserved first: after a deadline that is THE submission, frozen and pushed
 * to the archive. The observed tip is the live answer before one exists.
 */
export function gradingCommitFor(row) {
  return (
    row?.preserved_sha ||
    row?.latest_observed_sha ||
    row?.last_on_time_sha ||
    row?.tagged_submission_sha ||
    null
  );
}

/**
 * The hand-in count under a cap, as `grading/<id>/summary.json` stores it.
 * @typedef {{ used: number, allowed: number|null, extra: number,
 *             graded_sha: string|null, graded_number: number|null,
 *             ignored: Array<import("./submission-marker.mjs").IgnoredHandIn> }} HandInCount
 */

/**
 * What reading one student comes to. `handIns` only under a hand-in cap.
 * @typedef {{ verdict: string, reason?: string, run?: object, parsed?: object, sha?: string,
 *             permissionDenied?: boolean, handIns?: HandInCount|null,
 *             decision?: ReturnType<typeof gradeDecisionFor> }} GradeOutcome
 */

/**
 * One commit's worth of reading. Returns a verdict; it never invents a score.
 *
 * @returns {Promise<GradeOutcome>}
 */
export async function readScoreAtCommit(request, { repoFullName, sha, marker = null, fallbackTotal = 0 }) {
  const short = String(sha).slice(0, 7);
  const checksReq = await request("GET", `/repos/${repoFullName}/commits/${sha}/check-runs`);
  if (!checksReq?.ok) {
    // A 403 here is not transient, and "try again later" is advice that can
    // never come true: both check-run endpoints are gated by the App's Checks
    // permission, and a user-to-server token is capped by what the App
    // declares. Name it, or a lecturer retries for ever.
    const denied = checksReq?.status === 403 || checksReq?.status === 401;
    return {
      verdict: "api-failed",
      permissionDenied: denied,
      reason: `checks API fetch failed - HTTP ${checksReq?.status}`,
    };
  }

  const checkRuns = checksReq.data?.check_runs || [];
  if (checkRuns.length === 0) {
    return { verdict: "no-run", reason: `no CI run at commit ${short}` };
  }

  const run = pickAutogradeCheckRun(checkRuns);
  // No autograding run at this commit is NOT a zero and NOT a pass. The picker
  // used to fall back to the first check run of any kind, so a student who
  // deleted the autograding workflow and added a green one of their own was
  // awarded the full total from `conclusion: success`.
  if (!run) {
    return {
      verdict: "no-run",
      reason:
        `no autograding run at commit ${short} - ${checkRuns.length} other check run(s) ` +
        `were found and none of them grades`,
    };
  }

  // The score is an ANNOTATION, not an output body: a check run created by
  // GitHub Actions has `output.summary === null` and carries `Points X/Y` plus
  // `{"totalPoints":…,"maxPoints":…}` as notices. This used to parse `output.*`
  // only, never match, and fall through to "green means full marks, anything
  // else means zero" - so a 15/20 was recorded as 0. Skipped when the run
  // declares no annotations, so the ordinary case costs no second request.
  let annotations = [];
  let annotationsComplete = true;
  if (run?.output?.annotations_count) {
    const res = await fetchCheckRunAnnotations((path) => request("GET", path), {
      repoFullName,
      checkRunId: run.id,
    });
    annotations = res.annotations;
    annotationsComplete = res.complete;
  }

  const parsed = parseCheckRunScore(run, annotations, fallbackTotal);

  // An incomplete annotation read that still had to guess from the conclusion
  // is not a grade, it is a failed read. Saying so beats writing a plausible
  // number nobody can tell apart from a real one.
  if (!parsed.matched && !annotationsComplete) {
    return { verdict: "unreadable", reason: `could not read the score annotations on the CI run at ${short}` };
  }

  // A run that was skipped, cancelled or is still going has no score in it -
  // and `conclusion: skipped` is what a job gated on a hand-in commit leaves
  // behind at every OTHER commit. Recording the 0 it used to produce was a
  // grade nobody measured, in the table and in the CSV export.
  if (!parsed.graded) {
    return {
      verdict: "not-run",
      reason: marker
        ? `the grading workflow was ${parsed.conclusion || "not run"} at commit ${short} - ` +
          `it only runs on a commit whose message is "${marker.value}"`
        : `the grading run at commit ${short} was ${parsed.conclusion || "never completed"}, so it carries no score`,
    };
  }

  return { verdict: "graded", run, parsed, sha };
}

/**
 * One student, marker handling included.
 *
 * WITH A MARKER, THE HAND-IN COMMIT IS THE SUBMISSION - the commit the report
 * names is not consulted at all. It used to be read first and the hand-in used
 * only as a fallback, which graded a hand-in pushed AFTER the deadline whenever
 * it happened to be the student's last commit: the fallback carried the
 * deadline bound and the direct read never did.
 *
 * @returns {Promise<GradeOutcome>}
 */
export async function gradeStudent(
  request,
  { row, marker = null, markerBranch = "main", fallbackTotal = 0, overrides = null, team = null },
) {
  const repoFullName = row?.repo_name;

  // A LECTURER'S DECISION FIRST (lib/grade-override.mjs), because every grader
  // reads through here - the page's Re-grade all, the nightly and the CLI - and
  // a choice any of them skipped would be reverted by it. A score by hand needs
  // no repository and reads nothing.
  const decision = gradeDecisionFor(row?.github_login, { overrides, team });
  if (decision?.kind === "score") {
    return { verdict: "manual", decision };
  }
  if (!repoFullName) {
    return { verdict: "no-commit", reason: "no repository on record" };
  }
  if (decision?.kind === "commit") {
    // The rules (deadline, cap, which hand-in) are the lecturer's to skip; the
    // run is not - a commit with no grading result is refused like any other,
    // named, never read as a zero.
    const outcome = await readScoreAtCommit(request, { repoFullName, sha: decision.sha, marker, fallbackTotal });
    return { ...outcome, sha: decision.sha, decision };
  }

  if (marker) {
    // Could not look is not "there is no hand-in", and a late hand-in is not
    // no hand-in either - resolveHandIn keeps the three apart.
    const found = await resolveHandIn((path) => request("GET", path), { row, marker, markerBranch, overrides, team });
    if (found.verdict !== "found") return found;
    const outcome = await readScoreAtCommit(request, { repoFullName, sha: found.commit.sha, marker, fallbackTotal });
    return { ...outcome, sha: found.commit.sha, handIns: found.handIns };
  }

  const sha = gradingCommitFor(row);
  // No commit on record is not an API failure. Without this the URL was built
  // with `undefined` in it, GitHub answered 404, and a student who simply has
  // not pushed yet was counted among "API errors".
  if (!sha) {
    return { verdict: "no-commit", reason: "no commit on record to read a CI run from" };
  }
  return { ...(await readScoreAtCommit(request, { repoFullName, sha, marker, fallbackTotal })), sha };
}

/**
 * One outcome as the summary stores it: `{ graded }` or `{ failed }`. ONE
 * place, used by the cohort loop and by the page's single-student re-grade,
 * so a score by hand or a chosen commit is recorded identically by both.
 * (An `api-failed` outcome is the caller's to count; it is never a row.)
 */
export function rowFromOutcome(login, outcome, fallbackTotal = 0) {
  const decidedBy = decisionRecord(outcome.decision);
  if (outcome.verdict === "manual") {
    return { graded: gradedRowFromManualScore({ login, decision: outcome.decision }) };
  }
  if (outcome.verdict !== "graded") {
    // The count survives a refusal: "used 3 of 2, and the graded one has
    // no run" is two facts, and dropping the first hides the ignored ones.
    // A chosen commit with no result says so in its reason.
    return {
      failed: {
        login,
        reason: decidedBy ? `the commit you chose (${String(outcome.sha).slice(0, 7)}) cannot be read: ${outcome.reason}` : outcome.reason,
        ...(outcome.handIns ? { hand_ins: outcome.handIns } : {}),
      },
    };
  }
  // Built by lib/grading-summary.mjs, not here: `pxl-classroom grade`
  // writes the same file and wrote a different row - no ci_status, no
  // ci_run_url, no score_source - because both spelled the shape out by
  // hand. One builder, every caller.
  return {
    graded: gradedRowFromCheckRun({
      login,
      parsed: outcome.parsed,
      run: outcome.run,
      fallbackTotal,
      handIns: outcome.handIns,
      gradedSha: outcome.sha ?? null,
      decidedBy,
    }),
  };
}

/**
 * A whole cohort, or the one student named in `only`.
 *
 * Returns what happened; it decides nothing about saving. `ok` is false when
 * the result must NOT be written, and `reason` says which of the three refusals
 * it is - a permission the App does not hold, transient API failures, or a
 * summary that would replace real grades with none.
 */
export async function gradeCohort(
  request,
  {
    students, marker = null, markerBranch = "main", fallbackTotal = 0, concurrency = 6, onProgress = null,
    overrides = null,
  },
) {
  const queue = (students || []).filter((s) => s?.github_login && s?.repo_name);
  const graded = [];
  const failed = [];
  let permissionDenied = false;
  let apiFailedCount = 0;
  let cursor = 0;

  const worker = async () => {
    while (cursor < queue.length) {
      const row = queue[cursor++];
      try {
        const outcome = await gradeStudent(request, {
          row, marker, markerBranch, fallbackTotal, overrides, team: teamOf(row, students),
        });
        if (outcome.permissionDenied) permissionDenied = true;
        if (outcome.verdict === "api-failed") {
          apiFailedCount++;
        } else {
          const r = rowFromOutcome(row.github_login, outcome, fallbackTotal);
          if (r.graded) graded.push(r.graded);
          else failed.push(r.failed);
        }
      } catch (err) {
        // A transport that throws rather than resolving. Counted, never turned
        // into a zero for that student.
        apiFailedCount++;
        failed.push({ login: row.github_login, reason: `read failed: ${err?.message || String(err)}` });
      } finally {
        onProgress?.();
      }
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, queue.length || 1)) }, worker));

  if (permissionDenied) {
    return { ok: false, refusal: "permission", graded, failed, apiFailedCount };
  }
  if (apiFailedCount > 0) {
    return { ok: false, refusal: "api-errors", graded, failed, apiFailedCount };
  }
  // Writing a summary with nothing in it replaces whatever grades are already
  // on record with none of them, which is worse than not running.
  if (graded.length === 0) {
    return { ok: false, refusal: "nothing-graded", graded, failed, apiFailedCount };
  }
  return { ok: true, refusal: null, graded, failed, apiFailedCount };
}
