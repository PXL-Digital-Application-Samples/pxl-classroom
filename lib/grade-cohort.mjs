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
import { findMarkedCommit } from "./submission-marker.mjs";
import { gradedRowFromCheckRun } from "./grading-summary.mjs";

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
 * One commit's worth of reading. Returns a verdict; it never invents a score.
 *
 * @returns {Promise<{verdict: string, reason?: string, run?: object, parsed?: object, sha?: string, permissionDenied?: boolean}>}
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
 */
export async function gradeStudent(request, { row, marker = null, markerBranch = "main", fallbackTotal = 0 }) {
  const repoFullName = row?.repo_name;
  if (!repoFullName) {
    return { verdict: "no-commit", reason: "no repository on record" };
  }

  if (marker) {
    const found = await findMarkedCommit((path) => request("GET", path), {
      repoFullName,
      branch: markerBranch,
      marker,
      until: row.effective_deadline_at || null,
    });
    // Could not look. Not "there is no hand-in".
    if (!found.ok) {
      return {
        verdict: "lookup-failed",
        reason: `could not read this repository's commits to find the "${marker.value}" commit`,
      };
    }
    if (!found.complete) {
      return {
        verdict: "lookup-failed",
        reason: `could not finish looking for the "${marker.value}" commit - stopped after ${found.scanned} commits`,
      };
    }
    // A late hand-in is a different fact from no hand-in, and the lecturer does
    // something different about each.
    if (!found.commit) {
      return {
        verdict: "no-commit",
        reason: found.lateCommit
          ? `the only "${marker.value}" commit is after the deadline ` +
            `(${found.lateCommit.sha.slice(0, 7)}, ${found.lateCommit.date})`
          : `no commit says "${marker.value}", so nothing was handed in`,
      };
    }
    return readScoreAtCommit(request, { repoFullName, sha: found.commit.sha, marker, fallbackTotal });
  }

  const sha = gradingCommitFor(row);
  // No commit on record is not an API failure. Without this the URL was built
  // with `undefined` in it, GitHub answered 404, and a student who simply has
  // not pushed yet was counted among "API errors".
  if (!sha) {
    return { verdict: "no-commit", reason: "no commit on record to read a CI run from" };
  }
  return readScoreAtCommit(request, { repoFullName, sha, marker, fallbackTotal });
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
  { students, marker = null, markerBranch = "main", fallbackTotal = 0, concurrency = 6, onProgress = null },
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
        const outcome = await gradeStudent(request, { row, marker, markerBranch, fallbackTotal });
        if (outcome.permissionDenied) permissionDenied = true;
        if (outcome.verdict === "api-failed") {
          apiFailedCount++;
        } else if (outcome.verdict !== "graded") {
          failed.push({ login: row.github_login, reason: outcome.reason });
        } else {
          // Built by lib/grading-summary.mjs, not here: `pxl-classroom grade`
          // writes the same file and wrote a different row - no ci_status, no
          // ci_run_url, no score_source - because both spelled the shape out by
          // hand. One builder, every caller.
          graded.push(
            gradedRowFromCheckRun({
              login: row.github_login,
              parsed: outcome.parsed,
              run: outcome.run,
              fallbackTotal,
            }),
          );
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
