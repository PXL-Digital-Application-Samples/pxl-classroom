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

import { parseCheckRunScore, unscoredRun } from "./check-run-score.mjs";
import { countedGradingRun, latestCheckRuns, rerunOnlyReason } from "./grading-attempt.mjs";
import { fetchCheckRunAnnotations } from "./check-run-annotations.mjs";
import { listHandIns, selectHandIn } from "./submission-marker.mjs";
import { gradedRowFromCheckRun, gradedRowFromManualScore } from "./grading-summary.mjs";
import { decisionRecord, gradeDecisionFor } from "./grade-override.mjs";
import { isRateLimited, readRunScore, withoutDispatchedRuns } from "./grade-dispatch.mjs";
import { handInLimitFor } from "./hand-in-allowance.mjs";
import { normalizeLogin, sameLogin } from "./github-login.mjs";

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
 * @returns {Promise<{ verdict: string, reason?: string, kind?: string, permissionDenied?: boolean,
 *           commit?: import("./submission-marker.mjs").HandIn, handIns: HandInCount|null }>}
 */
export async function resolveHandIn(get, { row, marker, markerBranch = "main", overrides = null, team = null }) {
  const repoFullName = row?.repo_name;
  const until = row?.effective_deadline_at || null;
  const { limit, base, extra } = handInLimitFor(marker, row?.github_login, { overrides, team });

  // EVERY ASSIGNMENT WITH A MARKER READS THE SAME LIST, CAPPED OR NOT (review
  // of v1.5.0). Lateness is when GitHub saw the push (`handInTime`), never the
  // commit's own date, which is whatever the student's machine said. The
  // uncapped path used to ask `findMarkedCommit`, which compares that date, so
  // a backdated hand-in pushed after the deadline was graded there while the
  // capped path and the Regrade dialog called it late. And under `multiple:
  // false` the FIRST hand-in is the submission, which a force-push can erase
  // from the branch (third review, 2026-09-26): the run history and the push
  // log are the witnesses there as well.
  //
  // The students whose own dispatches count as hand-ins: the team shares one
  // repository and one count. Only under a cap - without one a dispatch uses
  // no slot and is never graded, so it cannot change the answer, and reading
  // them would spend requests on nothing.
  const students = base == null ? null : team?.members?.length ? team.members : [row?.github_login].filter(Boolean);
  // What a full-history copy was given is not a hand-in (lib/starter-commit.mjs).
  const listed = await listHandIns(get, { repoFullName, branch: markerBranch, marker, withRuns: true, students, given: row?.starter_sha ?? null });
  if (!listed.ok) {
    // A failed read is not "no hand-in" and not "on time": the student is
    // refused by name and a lecturer sees which read to look at.
    return {
      verdict: "lookup-failed",
      // A 403 on the run history or the push log is the App's permission, not
      // this student, exactly as on the check runs: the cohort read refuses as
      // "permission" rather than saying "nobody has a score to read yet" over
      // every student (review 2026-10-14).
      // Never a rate limit, which GitHub also answers with 403 (GR9): that is
      // "try again", not "the App needs a permission".
      permissionDenied: (listed.status === 403 && !listed.rateLimited) || listed.status === 401,
      reason:
        listed.rateLimited
          ? `GitHub's rate limit stopped the read of this repository's hand-ins (HTTP ${listed.status}) - read the scores again in a few minutes`
          : listed.failedRead === "runs"
            ? `could not read this repository's Actions run history (HTTP ${listed.status}), which hand-ins are counted and timed from`
            : listed.failedRead === "activity"
              ? `could not read this repository's push history (HTTP ${listed.status}), which hand-ins are counted and timed from`
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
  // No cap, no count to report.
  if (base == null) {
    if (!picked.commit) return { verdict: "no-commit", kind: noHandInKind(picked.lateCommit), reason: noHandInReason(marker, picked.lateCommit), handIns: null };
    return { verdict: "found", commit: picked.commit, handIns: null };
  }
  const handIns = {
    used: picked.used,
    allowed: picked.allowed,
    extra,
    graded_sha: picked.commit?.sha ?? null,
    graded_number: picked.number,
    ignored: picked.ignored,
  };
  if (!picked.commit) return { verdict: "no-commit", kind: noHandInKind(picked.lateCommit), reason: noHandInReason(marker, picked.lateCommit), handIns };
  return { verdict: "found", commit: picked.commit, handIns };
}

/**
 * WHY A STUDENT HAS NO SCORE, as `grading/<id>/summary.json` stores it on a
 * failed row (`kind`). Three answers, because a lecturer does three different
 * things about them:
 *
 *  - `not-handed-in`: nothing to grade yet. Before the deadline that is every
 *    student who has not finished, and it is not a problem - the Grading tab
 *    showed twenty of them as a red "20 grading failure(s)" four days before
 *    an exam's deadline (2026-10-08).
 *  - `late`: handed in, only after the deadline.
 *  - `no-result`: handed in, and no score could be read - no grading run, a run
 *    that was cancelled, a read that failed. This is the one to look at.
 *  - `running`: handed in, and its grading run is still going (2026-10-12: a
 *    50-minute cloud exam run read "was never completed" 20 minutes in). Not a
 *    problem; the score is there to read once the run ends.
 *
 * Absent on a row written before 2026-10-08: `failedKind` reads those.
 */
export const FAILED_KINDS = Object.freeze(["not-handed-in", "late", "no-result", "running"]);

/** Two of the reasons a student has nothing to read, spelled once. */
export const NO_REPOSITORY_REASON = "no repository on record";
export const NO_COMMIT_REASON = "no commit on record to read a CI run from";
export const NO_SUBMISSION_REASON = "nothing handed in: the repository is still as it was given";
export const NO_ON_TIME_SUBMISSION_REASON = "nothing handed in by the deadline: the commits in the repository came after it";

/**
 * What a row the report calls No submission is, for the summary. "Still as it
 * was given" only where nothing came after the deadline either: under `block`
 * a repository whose only work came after it is No submission too, and was
 * told it held nothing (review 2026-10-15, R6-9).
 *
 * @param {{ first_late_sha?: string|null }} row
 * @returns {{ kind: "late"|"not-handed-in", reason: string }}
 */
export function noSubmissionOutcome(row) {
  return row?.first_late_sha
    ? { kind: "late", reason: NO_ON_TIME_SUBMISSION_REASON }
    : { kind: "not-handed-in", reason: NO_SUBMISSION_REASON };
}

function noHandInKind(lateCommit) {
  return lateCommit ? "late" : "not-handed-in";
}

/**
 * What a failed row says about the student, for a row of any age.
 *
 * A row that records its `kind` is read as it says. One written before the
 * field existed is read from its reason, against the sentences this module
 * writes (`noHandInReason`, the two constants above) - anything else is a
 * score that could not be read, which is the answer that asks for a look
 * rather than the one that hides a problem.
 *
 * @param {{ kind?: string, reason?: string }} row
 * @returns {"not-handed-in"|"late"|"no-result"|"running"}
 */
export function failedKind(row) {
  if (FAILED_KINDS.includes(row?.kind)) return /** @type {any} */ (row.kind);
  const reason = String(row?.reason || "");
  if (reason === NO_REPOSITORY_REASON || reason === NO_COMMIT_REASON || reason === NO_SUBMISSION_REASON) return "not-handed-in";
  if (/^no commit says ".*", so nothing was handed in$/.test(reason)) return "not-handed-in";
  if (/^the only ".*" commit is after the deadline \(/.test(reason) || reason === NO_ON_TIME_SUBMISSION_REASON) return "late";
  return "no-result";
}

/**
 * The verdicts that mean a READ failed: nothing was learned about the student,
 * so nothing about them may change. `gradeStudent` returns them; a transport
 * that throws is one too.
 */
export const FAILED_READ_VERDICTS = Object.freeze(["api-failed", "unreadable", "lookup-failed"]);

/**
 * Whether reading ONE student again replaces what the summary holds for them.
 * The page's "Read score again" and `pxl-classroom grade --login` both ask
 * this: the CLI replaced a stored 18/20 with a 502 while the page kept it
 * (review 2026-10-14), two rules for one action.
 *
 * A score replaces. A failed read never does. A reason replaces only where it
 * is a new answer: a lecturer's decision was just changed, or the row said
 * "being graded" and the run has ended since. Otherwise it looked, there was
 * no score, and the earlier result stands.
 *
 * @param {{ hasScore: boolean, failedRead: boolean, newKind?: string|null,
 *           stored?: { kind?: string, reason?: string }|null, afterDecision?: boolean }} a
 */
export function oneReadReplaces({ hasScore, failedRead, newKind = null, stored = null, afterDecision = false }) {
  if (hasScore) return true;
  if (failedRead) return false;
  if (afterDecision) return true;
  return Boolean(stored) && failedKind(stored) === "running" && Boolean(newKind) && newKind !== "running";
}

/**
 * The summary rows after reading the students in `logins` again, merged into
 * the summary on record: everyone else's rows stand as stored, and each of
 * these students' rows is replaced only where `oneReadReplaces` says so.
 * `pxl-classroom grade --login` writes this.
 *
 * @param {{ stored: { students?: any[], failed?: any[] }|null,
 *           read: { graded: any[], failed: any[] },
 *           logins: string[], failedReads: Set<string> }} a  failedReads holds normalised logins
 * @returns {{ students: any[], failed: any[], unchanged: string[] }}
 */
export function mergeOneStudentRead({ stored, read, logins, failedReads }) {
  const ours = (r) => logins.some((l) => sameLogin(l, r?.login));
  const students = (stored?.students || []).filter((r) => !ours(r));
  const failed = (stored?.failed || []).filter((r) => !ours(r));
  const unchanged = [];
  for (const login of logins) {
    const mine = (rows) => (rows || []).filter((r) => sameLogin(r?.login, login));
    const newGraded = mine(read.graded);
    const newFailed = mine(read.failed);
    const replaces = oneReadReplaces({
      hasScore: newGraded.length > 0,
      failedRead: failedReads.has(normalizeLogin(login)),
      newKind: newFailed[0]?.kind ?? null,
      stored: mine(stored?.failed)[0] ?? null,
    });
    if (replaces) {
      students.push(...newGraded);
      failed.push(...newFailed);
    } else {
      students.push(...mine(stored?.students));
      failed.push(...mine(stored?.failed));
      unchanged.push(login);
    }
  }
  return { students, failed, unchanged };
}

/**
 * A cohort read's rows, with every student whose READ failed kept as the
 * summary on record has them. A failed read learned nothing about the student
 * (`FAILED_READ_VERDICTS`), so nothing about them may change: as soon as one
 * other student was graded, a hand-in lookup that failed for this one wrote
 * "no result" over their stored 18/20 (review 2026-10-14, G4b). Where the
 * summary holds nothing for them, the failed row is kept, so the reason is
 * still named. Both cohort writers apply it: the page's Read all scores again
 * and the nightly.
 *
 * @param {{ stored: { students?: any[], failed?: any[] }|null,
 *           graded: any[], failed: any[], failedReads?: Set<string> }} a  failedReads holds normalised logins
 * @returns {{ graded: any[], failed: any[], kept: string[] }}
 */
export function keepStoredOnFailedReads({ stored, graded, failed, failedReads }) {
  if (!failedReads?.size || !stored) return { graded, failed, kept: [] };
  const read = (r) => !failedReads.has(normalizeLogin(r?.login));
  const outGraded = graded.filter(read);
  const outFailed = failed.filter(read);
  const kept = [];
  for (const login of failedReads) {
    const mine = (rows) => (rows || []).filter((r) => sameLogin(r?.login, login));
    const storedRows = [...mine(stored.students), ...mine(stored.failed)];
    if (storedRows.length) {
      outGraded.push(...mine(stored.students));
      outFailed.push(...mine(stored.failed));
      kept.push(login);
    } else {
      outFailed.push(...mine(failed));
    }
  }
  return { graded: outGraded, failed: outFailed, kept };
}

export function noHandInReason(marker, lateCommit) {
  // A late hand-in is a different fact from no hand-in, and the lecturer does
  // something different about each.
  // The time it is late BY: when GitHub saw it pushed, where that is known. A
  // backdated commit's own date is before the deadline and would contradict
  // the sentence it sits in.
  return lateCommit
    ? `the only "${marker.value}" commit is after the deadline (${lateCommit.sha.slice(0, 7)}, ${lateCommit.pushedAt ? `pushed ${lateCommit.pushedAt}` : lateCommit.date})`
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
 * What reading one student comes to. `handIns` only under a hand-in cap;
 * `handIn` (the graded hand-in itself) under any hand-in message.
 * @typedef {{ verdict: string, reason?: string, kind?: string, run?: object, parsed?: object, sha?: string,
 *             permissionDenied?: boolean, handIns?: HandInCount|null,
 *             handIn?: import("./submission-marker.mjs").HandIn|null,
 *             decision?: ReturnType<typeof gradeDecisionFor> }} GradeOutcome
 */

/**
 * One commit's worth of reading. Returns a verdict; it never invents a score.
 *
 * @returns {Promise<GradeOutcome>}
 */
export async function readScoreAtCommit(request, { repoFullName, sha, marker = null, fallbackTotal = 0, students = [] }) {
  const short = String(sha).slice(0, 7);
  // EVERY ATTEMPT, not only the newest: a re-run's result replaces the
  // commit's latest, and it is not always one that counts (lib/grading-attempt.mjs).
  const checksReq = await request("GET", `/repos/${repoFullName}/commits/${sha}/check-runs?filter=all&per_page=100`);
  // 422 "No commit found for SHA": the commit is gone from the repository - a
  // force-push dropped it and GitHub collected it, or a hand-in known only from
  // the run history. A fact about THIS student, named; an api-failed here
  // refused the whole cohort's summary over one rewritten branch (third
  // review, 2026-09-26).
  if (checksReq?.status === 422) {
    return { verdict: "no-run", reason: `commit ${short} no longer exists in this repository, so it has no result to read` };
  }
  // 404: is the REPOSITORY gone? Then it is a fact about this student, named,
  // as readRunScore names it (lib/grade-dispatch.mjs); an api-failed refused
  // the whole cohort's summary over one deleted repository - which a team
  // switch now makes (review 2026-10-14, GR8). Any other 404 is a failed read.
  if (checksReq?.status === 404) {
    const repo = await request("GET", `/repos/${repoFullName}`);
    if (repo?.status === 404) {
      // A FAILED READ, NOT AN ANSWER (review 2026-10-14, P2-2): GitHub says
      // the same 404 for a repository outside what this token may see ("Only
      // select repositories"), and as `no-run` it replaced a stored score with
      // "no longer exists". Named, the cohort not refused, the stored row kept.
      return {
        verdict: "unreadable",
        reason: `GitHub answers that the repository ${repoFullName} does not exist (deleted, or out of PXL Classroom's reach), so no result could be read`,
      };
    }
  }
  if (!checksReq?.ok) {
    // A 403 here is not transient, and "try again later" is advice that can
    // never come true: both check-run endpoints are gated by the App's Checks
    // permission, and a user-to-server token is capped by what the App
    // declares. Name it, or a lecturer retries for ever. UNLESS IT IS THE RATE
    // LIMIT, which GitHub also answers with 403 (review 2026-10-14, P2-5):
    // then "approve Checks" was advice for a permission nobody lacked.
    const limited = isRateLimited(checksReq);
    const denied = (checksReq?.status === 403 && !limited) || checksReq?.status === 401;
    return {
      verdict: "api-failed",
      permissionDenied: denied,
      reason: limited
        ? "GitHub's rate limit stopped the read - try again in a few minutes"
        : `checks API fetch failed - HTTP ${checksReq?.status}`,
    };
  }

  // Never a dispatched run's result: one dispatched for an OLDER commit is
  // listed on this one (lib/grade-dispatch.mjs, measured).
  const own = await withoutDispatchedRuns(request, { repoFullName, sha, checkRuns: checksReq.data?.check_runs });
  if (!own.ok) {
    // A 403 reaching here is the rate limit: withoutDispatchedRuns passes a
    // permission 403 through as "no runs to leave out" (P2-5).
    return {
      verdict: "api-failed",
      permissionDenied: own.status === 401,
      reason: own.status === 403
        ? "GitHub's rate limit stopped the read - try again in a few minutes"
        : `could not read which runs at commit ${short} a lecturer started - HTTP ${own.status}`,
    };
  }
  const checkRuns = own.checkRuns;
  if (checkRuns.length === 0) {
    return { verdict: "no-run", reason: `no CI run at commit ${short}` };
  }

  // The attempt a score may come from: the push's own, or one a lecturer
  // started again - never a student's re-run (R6-6, lib/grading-attempt.mjs).
  const counted = await countedGradingRun(request, { repoFullName, checkRuns, students });
  if (!counted.ok) {
    const limited = isRateLimited(counted.response);
    return {
      verdict: "api-failed",
      permissionDenied: (counted.status === 403 && !limited) || counted.status === 401,
      reason: limited
        ? "GitHub's rate limit stopped the read - try again in a few minutes"
        : `could not read who started the grading run at commit ${short} again - HTTP ${counted.status}`,
    };
  }
  const run = counted.run;
  if (!run && counted.ignored.length) {
    return { verdict: "no-run", reason: rerunOnlyReason(short, counted.ignored) };
  }
  // No autograding run at this commit is NOT a zero and NOT a pass. The picker
  // used to fall back to the first check run of any kind, so a student who
  // deleted the autograding workflow and added a green one of their own was
  // awarded the full total from `conclusion: success`.
  if (!run) {
    return {
      verdict: "no-run",
      reason:
        `no autograding run at commit ${short} - ${latestCheckRuns(checkRuns).length} other check run(s) ` +
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
    // Still running, or ended without a score - and which, in words
    // (lib/check-run-score.mjs `unscoredRun`, shared with the CLI).
    return unscoredRun({ short, status: run.status ?? null, conclusion: parsed.conclusion ?? null, marker });
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
    return { verdict: "no-commit", kind: "not-handed-in", reason: NO_REPOSITORY_REASON };
  }
  // Whose re-run of a grading run does not count (lib/grading-attempt.mjs).
  const students = [row?.github_login, ...(team?.members || [])].filter(Boolean);
  if (decision?.kind === "commit") {
    // The rules (deadline, cap, which hand-in) are the lecturer's to skip; the
    // run is not - a commit with no grading result is refused like any other,
    // named, never read as a zero.
    // Graded by a lecturer's "Grade this commit now": that RUN is the result
    // (it belongs to the branch tip, so nothing is attached to the commit).
    const outcome = decision.runId
      ? await readRunScore(request, { repoFullName, runId: decision.runId, sha: decision.sha, fallbackTotal, students })
      : await readScoreAtCommit(request, { repoFullName, sha: decision.sha, marker, fallbackTotal, students });
    return { ...outcome, sha: decision.sha, decision };
  }

  if (marker) {
    // Could not look is not "there is no hand-in", and a late hand-in is not
    // no hand-in either - resolveHandIn keeps the three apart.
    const found = await resolveHandIn((path) => request("GET", path), { row, marker, markerBranch, overrides, team });
    if (found.verdict !== "found") return found;
    const outcome = await readScoreAtCommit(request, { repoFullName, sha: found.commit.sha, marker, fallbackTotal, students });
    return { ...outcome, sha: found.commit.sha, handIns: found.handIns, handIn: found.commit };
  }

  // NOTHING HANDED IN IS NOT A SCORE (review 2026-10-14). A student still at
  // what they were given has a commit, and that commit can carry a grading
  // run - provisioning's own grading-workflow commit triggers one - so the
  // nightly recorded a score, sometimes points for the starter's passing
  // tests, for a repository nobody touched. The report decides "no
  // submission" (lib/starter-commit.mjs); a lecturer's decision above still wins.
  if (row?.submission_status === "no-submission") {
    return { verdict: "no-commit", ...noSubmissionOutcome(row) };
  }
  const sha = gradingCommitFor(row);
  // No commit on record is not an API failure. Without this the URL was built
  // with `undefined` in it, GitHub answered 404, and a student who simply has
  // not pushed yet was counted among "API errors".
  if (!sha) {
    return { verdict: "no-commit", kind: "not-handed-in", reason: NO_COMMIT_REASON };
  }
  return { ...(await readScoreAtCommit(request, { repoFullName, sha, marker, fallbackTotal, students })), sha };
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
        // A commit a lecturer chose that cannot be read is one to look at -
        // unless its run is simply still going.
        kind: outcome.kind === "running" ? "running" : decidedBy ? "no-result" : (outcome.kind || "no-result"),
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
      handIn: outcome.handIn ?? null,
    }),
  };
}

/**
 * Who the ARCHIVE-BASED grader (`pxl-classroom grade`) grades: every preserved
 * submission, and every student a lecturer set a score by hand for - who needs
 * no submission at all (an oral exam, no repository). Leaving them out wrote a
 * summary without them, and that summary replaces the whole file, so their
 * score was lost (review 2026-09-26).
 *
 * @param {Array<{github_login?: string, preservation_status?: string|null, preserved_sha?: string|null, team_slug?: string|null}>} students report rows
 * @param {Map|Array|null} overrides
 */
export function archiveGradeQueue(students, overrides) {
  const all = students || [];
  // A CHOSEN COMMIT too: the grader reads or refuses it by name, where leaving
  // the student out of the queue dropped them from the summary this run
  // replaces whole - their decided grade gone without a word (third review,
  // 2026-09-26).
  return all.filter((s) => s?.github_login && (
    (s.preservation_status === "preserved" && s.preserved_sha) ||
    ["score", "commit"].includes(gradeDecisionFor(s.github_login, { overrides, team: teamOf(s, all) })?.kind)
  ));
}

/**
 * Who a Re-grade all reads. A student with no repository is graded only by a
 * score set by hand - which reads nothing, and was otherwise dropped by the
 * next Re-grade all or the nightly after the lecturer entered it (an oral
 * exam, no repository). Exported so the page asks "is there anything to
 * grade?" with the same question: it said "nothing to grade" over a cohort of
 * scores by hand (third review, 2026-09-26).
 */
export function gradeQueue(students, overrides) {
  return (students || []).filter((s) => s?.github_login && (
    s?.repo_name || gradeDecisionFor(s.github_login, { overrides, team: teamOf(s, students) })?.kind === "score"
  ));
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
  const queue = gradeQueue(students, overrides);
  const graded = [];
  const failed = [];
  let permissionDenied = false;
  let apiFailedCount = 0;
  const unreadable = [];
  // Students a read failed for but whose row is still written (`unreadable`,
  // `lookup-failed`): `keepStoredOnFailedReads` keeps their stored row.
  const failedReads = new Set();
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
          // Named, so "try again later" says WHO - a read that keeps failing
          // for one student is otherwise a refusal nobody can act on.
          unreadable.push({ login: row.github_login, reason: outcome.reason || "read failed" });
        } else {
          if (FAILED_READ_VERDICTS.includes(outcome.verdict)) failedReads.add(normalizeLogin(row.github_login));
          const r = rowFromOutcome(row.github_login, outcome, fallbackTotal);
          if (r.graded) graded.push(r.graded);
          else failed.push(r.failed);
        }
      } catch (err) {
        // A transport that throws rather than resolving. Counted, never turned
        // into a zero for that student.
        apiFailedCount++;
        // In `unreadable` too: the page names only those, and a thrown read (a
        // browser fetch timeout) showed "could not be read for 1 student(s): ."
        unreadable.push({ login: row.github_login, reason: `read failed: ${err?.message || String(err)}` });
        failed.push({ login: row.github_login, reason: `read failed: ${err?.message || String(err)}`, kind: "no-result" });
      } finally {
        onProgress?.();
      }
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, queue.length || 1)) }, worker));

  if (permissionDenied) {
    return { ok: false, refusal: "permission", graded, failed, apiFailedCount, unreadable, failedReads };
  }
  if (apiFailedCount > 0) {
    return { ok: false, refusal: "api-errors", graded, failed, apiFailedCount, unreadable, failedReads };
  }
  // Writing a summary with nothing in it replaces whatever grades are already
  // on record with none of them, which is worse than not running.
  if (graded.length === 0) {
    return { ok: false, refusal: "nothing-graded", graded, failed, apiFailedCount, unreadable, failedReads };
  }
  return { ok: true, refusal: null, graded, failed, apiFailedCount, unreadable, failedReads };
}
