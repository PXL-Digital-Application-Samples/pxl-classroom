// PXL Classroom - the commit a student marked as their hand-in.
//
// Some template-owned grading workflows do not run on every push. The live one
// this module was written for gates its whole job on a literal:
//
//   if: github.event.head_commit.message == 'einde examen'
//
// so grading runs on the hand-in commit and on nothing else. The exam is a
// live AWS account, and the check has to be taken while the student's own
// sandbox session is still alive - it cannot be re-run afterwards from the
// archive, which is why the trigger is a commit and not the deadline.
//
// Read at score time, by the lecturer's browser and by the CLI, and by NOTHING
// on the nightly path: the collector reads one commit per student per night
// (`per_page=1`) and walking history there would spend Actions minutes and API
// calls on every student every night to answer a question only grading asks.
// The marker does not decide what is preserved, what is late, or what a
// submission IS - `lib/effective-deadline.mjs` and the collector still own
// that. It decides one thing: which commit's check run carries the score.
//
// Isomorphic on purpose - the SPA bundles it, the CLI imports it under plain
// Node; its one package is `yaml`, through lib/grade-dispatch.mjs, to read a
// workflow file a student dispatched - and transport-agnostic the way
// `lib/check-run-annotations.mjs` is: callers hand in a `request(path)`
// returning `{ status, data }`.

/**
 * What `readSubmissionMarker` returns: the assignment's marker, read.
 * @typedef {{ type: string, value: string, multiple: boolean, maxHandIns: number|null }} SubmissionMarker
 */

/**
 * One hand-in commit. `pushedAt` is when GitHub saw it pushed (server time):
 * its first run's creation (`pushedFrom: "run"`, a few seconds after the push)
 * or the push log's own record of the push (`pushedFrom: "log"`, the push
 * itself). `onBranch: false` is known only from the run history or the log.
 * @typedef {{ sha: string, message?: string, date: string|null,
 *             pushedAt?: string|null, pushedFrom?: "run"|"log"|null,
 *             onBranch?: boolean }} HandIn
 */

/**
 * One ignored hand-in, as `selectHandIn` names it and the grading summary
 * stores it.
 * @typedef {{ sha: string, date: string|null, pushed_at: string|null,
 *             on_branch: boolean, number: number|null, reason: "over-limit"|"late" }} IgnoredHandIn
 */

import { normalizeLogin } from "./github-login.mjs";
import { isAutogradeCheckRunName } from "./check-run-score.mjs";
import { decodeBase64, hasGradeDispatch, workflowCheckRunNames } from "./grade-dispatch.mjs";
import { isGradingWorkflow } from "./starter-workflow.mjs";

const PER_PAGE = 100;

// 300 commits back from the branch head. A student who buried their hand-in
// deeper than that has been reported as "not found in the last N commits"
// rather than as "no hand-in", which are different answers.
const MAX_PAGES = 3;

/**
 * The assignment's marker, or NULL when it does not declare one.
 *
 * Absent means every push grades - the ordinary GitHub Classroom workflow -
 * and that is the answer for every assignment written before this field
 * existed. It is not a fail-closed default because there is nothing to close:
 * with no marker the score is read at the commit the report already names,
 * exactly as it was.
 *
 * @returns {SubmissionMarker|null}
 */
export function readSubmissionMarker(assignment) {
  const marker = assignment?.submission_marker;
  if (!marker || typeof marker !== "object") return null;
  const value = String(marker.value ?? "").trim();
  if (!value) return null;
  const type = String(marker.type ?? "").trim();
  if (type !== "commit_message") return null;
  // May a student hand in again? ABSENT IS `true`, and that is the deliberate
  // direction rather than the fail-closed one. A student who hands in, spots a
  // mistake and hands in again has done the thing the exam asked; reading an
  // absent field as "only the first counts" would silently grade the version
  // they went back and fixed. `false` is a decision somebody has to make on
  // purpose, and the form always writes the field explicitly, so an absent one
  // only ever comes from hand-written YAML.
  const multiple = marker.multiple !== false;
  return { type, value, multiple, maxHandIns: multiple ? readMaxHandIns(marker.max_hand_ins) : null };
}

/**
 * The cap on hand-ins, or NULL for none.
 *
 * ABSENT IS UNLIMITED, which is every assignment written before the field
 * existed and the reading nobody has to opt out of. Only a whole number of at
 * least one caps anything: the schema refuses the rest, and a hand-written `0`
 * or `"5"` read as a cap would refuse every hand-in or grade a string. Read
 * only when `multiple` is on - with `multiple: false` exactly one hand-in
 * counts already, and a stored cap beside it is a value nothing may act on.
 */
export function readMaxHandIns(value) {
  return Number.isInteger(value) && value >= 1 ? value : null;
}

/**
 * `refs/heads/main` -> `main`, the branch the hand-in is looked for on.
 *
 * NOT the same decision as the collector's: `collect.mjs` can fall back to the
 * repository's own `default_branch` for a ref that is not `refs/heads/…`,
 * because it has just fetched the repository and this has not. Leaving the ref
 * as it stands makes an odd `submission_ref` fail visibly on the commits call
 * rather than silently reading a branch nobody named.
 */
export function submissionBranch(assignment) {
  const ref = assignment?.submission_ref || "refs/heads/main";
  return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
}

/**
 * Does this commit message hand the work in?
 *
 * THE WHOLE MESSAGE, compared the way the workflow's `==` compares it - and
 * GitHub's expression `==` IGNORES CASE for strings (docs.github.com,
 * "Evaluate expressions": "GitHub ignores case when comparing strings"). So
 * `Einde examen` is a hand-in the workflow graded, and a case-sensitive match
 * here called it "nothing handed in" (third review, 2026-09-26). It does NOT
 * trim: ` einde examen` is not what `==` matches, and a generous match names a
 * commit the workflow skipped. Only trailing line breaks are dropped, because
 * git stores one the push payload does not carry - disagreeing about that
 * would be an artefact of which API answered.
 */
export function messageMatchesMarker(message, marker) {
  if (!marker) return false;
  const bare = (s) => String(s ?? "").replace(/[\r\n]+$/, "").toLowerCase();
  return bare(message) === bare(marker.value);
}

/** The commit fields this cares about, out of a `/commits` row. */
function commitOf(row) {
  return {
    sha: row.sha,
    message: String(row?.commit?.message ?? "").trim(),
    // The COMMIT's own timestamp, which is what every deadline comparison in
    // this system uses - never when anything observed it (LESSONS.md).
    date: row?.commit?.committer?.date ?? row?.commit?.author?.date ?? null,
  };
}

/**
 * The commit the student handed in with, by the BRANCH ALONE, or NULL.
 *
 * NOT WHAT GRADING ASKS (review of v1.5.0). It judges lateness by each
 * commit's own date, which is whatever the student's machine said, so a
 * backdated hand-in pushed after the deadline reads as on time here. Every
 * grader goes through `resolveHandIn` (lib/grade-cohort.mjs): `listHandIns`
 * plus `selectHandIn`, timed by when GitHub saw the push. Kept as the
 * separately written walk `tests/hand-in-cap.test.mjs` checks `selectHandIn`
 * against on branch-only histories - a checker that does not share the
 * rule's logic.
 *
 * @param {(path: string) => Promise<{ status: number, data: any }>} request
 * @param {{ repoFullName: string, branch: string,
 *           marker: {value: string, multiple?: boolean},
 *           until?: string|null }} opts
 * @returns {Promise<{ ok: boolean, status: number,
 *           commit: HandIn|null,
 *           lateCommit: HandIn|null,
 *           complete: boolean, scanned: number }>}
 *
 * WHICH hand-in, when there is more than one, is the assignment's decision:
 *
 *   multiple: true   the LAST one on or before the deadline. A student who
 *                    hands in, spots a mistake and hands in again is graded on
 *                    the fix - which is what handing in again is for.
 *   multiple: false  the FIRST one. Once they have handed in, that is the
 *                    submission, and a later one does not replace it.
 *
 * THE DEADLINE BOUNDS BOTH. The walk reads the branch unfiltered and compares
 * each commit's own timestamp to `until` here, rather than handing `until` to
 * GitHub, so that a hand-in made *after* the deadline can be reported as such
 * instead of being invisible. `lateCommit` carries the newest of those, and it
 * is the difference between telling a lecturer "this student never handed in"
 * and "this student handed in 40 minutes late" - two different conversations.
 *
 * `ok: false` is a failed read and is NOT "there is no marked commit": the
 * caller must say it could not look, never that it looked and found nothing.
 * `complete: false` says the walk hit its cap, which is the same distinction
 * one level down.
 */
export async function findMarkedCommit(request, { repoFullName, branch, marker, until = null }) {
  const deadline = until ? new Date(until).getTime() : null;
  const bounded = Number.isFinite(deadline);
  let scanned = 0;
  let onTime = null;
  let late = null;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await request(
      `/repos/${repoFullName}/commits?sha=${encodeURIComponent(branch)}&per_page=${PER_PAGE}&page=${page}`,
    );

    if (!res || res.status < 200 || res.status >= 300) {
      return { ok: false, status: res?.status ?? 0, commit: null, lateCommit: null, complete: false, scanned };
    }

    const rows = Array.isArray(res.data) ? res.data : [];
    for (const row of rows) {
      scanned++;
      if (!messageMatchesMarker(row?.commit?.message, marker)) continue;

      const commit = commitOf(row);
      // A commit with no readable timestamp cannot be shown to be on time, and
      // guessing in the student's favour would let an unparseable date past the
      // deadline. It is late, and named as such.
      const at = commit.date ? new Date(commit.date).getTime() : NaN;
      if (bounded && !(Number.isFinite(at) && at <= deadline)) {
        // Newest first, so the first late one seen is the newest late one.
        if (!late) late = commit;
        continue;
      }

      // Newest first: the first on-time match is the LAST hand-in, and with
      // `multiple: false` the walk keeps going so the last one it sees is the
      // FIRST hand-in.
      onTime = commit;
      if (marker?.multiple !== false) {
        return { ok: true, status: res.status, commit: onTime, lateCommit: late, complete: true, scanned };
      }
    }

    // A short page is the end of the branch: the walk saw everything there is,
    // so whatever it holds now is a complete answer rather than a cap.
    if (rows.length < PER_PAGE) {
      return { ok: true, status: res.status, commit: onTime, lateCommit: late, complete: true, scanned };
    }
  }

  // Out of pages. Under `multiple: false` that means the oldest hand-in may be
  // deeper still, so what is held is not the answer - `complete: false` says so
  // and the caller reports a read it could not finish.
  return { ok: true, status: 200, commit: onTime, lateCommit: late, complete: false, scanned };
}

// -----------------------------------------------------------------------------
// A cap on hand-ins
// -----------------------------------------------------------------------------
//
// A CAP IS A COUNT, AND THE STUDENT CAN EDIT WHAT IT COUNTS. Until the deadline
// nothing stops a force-push - the lock ruleset that blocks one is `disabled`
// until the instant (lib/submission-lock.mjs) - so a student who erases hand-ins
// one to five from the branch makes the sixth read as the first. The branch
// alone is not a record of how often they handed in.
//
// GitHub's run history is the second witness: every push of a hand-in commit
// starts the grading workflow, and a run is not rewritten by a force-push. It
// can be DELETED by anyone with write access (docs.github.com, "Delete a
// workflow run"), and a student is usually admin of their own repository, so
// neither source is tamper-proof and nothing read after the fact can be. Taking
// the UNION means a student has to rewrite the branch AND delete the runs to
// get past the cap - two deliberate acts, where one was enough.
//
// Read for every assignment with a marker, capped or not (review of v1.5.0):
// without a cap there is no count, but lateness is still when GitHub saw the
// push, and only the runs and the push log know that. The student's own
// dispatches are read only under a cap, where they use a slot.

// Deeper than `findMarkedCommit`'s walk, because a count needs every hand-in
// rather than the newest one, and the walk cannot stop early. 1,000 is also the
// most the filtered runs endpoint will return.
const COUNT_MAX_PAGES = 10;

/**
 * Every hand-in this student made on the submission branch, oldest first.
 *
 * @param {(path: string) => Promise<{ status: number, data: any, headers?: any }>} request
 *   `headers` lets the push log page by its cursor; without them a full page is an incomplete count
 * @param {{ repoFullName: string, branch: string, marker: {value: string}, students?: string[]|null,
 *           withRuns?: boolean }} opts
 * @returns {Promise<{ ok: boolean, status: number, complete: boolean,
 *           failedRead: 'commits'|'runs'|'activity'|null, scanned: number,
 *           handIns: Array<{sha: string, message: string, date: string|null,
 *                           pushedAt: string|null, onBranch: boolean}> }>}
 *
 * `ok: false` names WHICH read failed, because "could not read the commits" and
 * "could not read the run history" send a lecturer to different places - and
 * neither is "no hand-in". `complete: false` is a walk that hit its cap: a
 * count that stopped early is not a count.
 */
export async function listHandIns(request, { repoFullName, branch, marker, withRuns = true, students = null }) {
  const fail = (failedRead, status, scanned) => ({
    ok: false, status, complete: false, failedRead, scanned, handIns: [],
  });

  // --- the branch, newest first as GitHub walks it --------------------------
  const onBranch = [];
  let scanned = 0;
  let branchComplete = false;
  for (let page = 1; page <= COUNT_MAX_PAGES; page++) {
    const res = await request(
      `/repos/${repoFullName}/commits?sha=${encodeURIComponent(branch)}&per_page=${PER_PAGE}&page=${page}`,
    );
    if (!res || res.status < 200 || res.status >= 300) return fail("commits", res?.status ?? 0, scanned);
    const rows = Array.isArray(res.data) ? res.data : [];
    for (const row of rows) {
      scanned++;
      if (messageMatchesMarker(row?.commit?.message, marker)) onBranch.push(commitOf(row));
    }
    if (rows.length < PER_PAGE) {
      branchComplete = true;
      break;
    }
  }
  if (!branchComplete) {
    return { ok: true, status: 200, complete: false, failedRead: null, scanned, handIns: [] };
  }

  // --- the run history --------------------------------------------------------
  // sha -> earliest time GitHub saw that commit pushed as a hand-in. SERVER
  // time, which a student cannot set, where a commit's own date is whatever
  // their machine said.
  const pushed = new Map();
  const runOnly = new Map();
  if (withRuns) {
    let runsComplete = false;
    for (let page = 1; page <= COUNT_MAX_PAGES; page++) {
      const res = await request(
        `/repos/${repoFullName}/actions/runs?event=push&branch=${encodeURIComponent(branch)}` +
          `&per_page=${PER_PAGE}&page=${page}`,
      );
      if (!res || res.status < 200 || res.status >= 300) return fail("runs", res?.status ?? 0, scanned);
      const runs = Array.isArray(res.data?.workflow_runs) ? res.data.workflow_runs : [];
      for (const run of runs) {
        // The run's own head commit, which is the one the workflow's
        // `head_commit.message ==` compared. Every workflow in the repository
        // starts a run on the same push, so a sha is kept once.
        const message = run?.head_commit?.message;
        if (!run?.head_sha || !messageMatchesMarker(message, marker)) continue;
        if (run.head_branch && run.head_branch !== branch) continue;
        const at = run.created_at || null;
        const prev = pushed.get(run.head_sha);
        if (at && (!prev || new Date(at) < new Date(prev))) pushed.set(run.head_sha, at);
        if (!runOnly.has(run.head_sha)) {
          runOnly.set(run.head_sha, {
            sha: run.head_sha,
            message: String(message).trim(),
            date: run?.head_commit?.timestamp ?? null,
          });
        }
      }
      if (runs.length < PER_PAGE) {
        runsComplete = true;
        break;
      }
    }
    if (!runsComplete) {
      return { ok: true, status: 200, complete: false, failedRead: null, scanned, handIns: [] };
    }
  }

  // --- the push log -------------------------------------------------------------
  // WHICH COMMITS WERE THE LAST OF A PUSH, from GitHub's repository activity
  // (`GET /repos/{o}/{r}/activity`, Metadata: read - every App token has it).
  // A push starts the workflow for its last commit only, so that is the set
  // of commits that ran. Asking the runs alone for it let a student hide a
  // hand-in by deleting its runs - which a repository admin can - and the
  // user refused that (2026-09-27); the activity log is not theirs to delete.
  // sha -> when GitHub recorded the push (server time).
  const heads = new Map();
  if (withRuns) {
    let cursor = null;
    let complete = false;
    for (let page = 1; page <= COUNT_MAX_PAGES; page++) {
      const res = await request(
        `/repos/${repoFullName}/activity?ref=${encodeURIComponent(`refs/heads/${branch}`)}&per_page=${PER_PAGE}` +
          (cursor ? `&after=${encodeURIComponent(cursor)}` : ""),
      );
      if (!res || res.status < 200 || res.status >= 300) return fail("activity", res?.status ?? 0, scanned);
      const rows = Array.isArray(res.data) ? res.data : [];
      for (const a of rows) {
        const sha = String(a?.after ?? "");
        if (!/^[0-9a-f]{40}$/.test(sha) || /^0+$/.test(sha)) continue; // a deletion ends on nothing
        const at = a?.timestamp || null;
        const prev = heads.get(sha);
        if (!prev || (at && new Date(at) < new Date(prev))) heads.set(sha, at);
      }
      if (rows.length < PER_PAGE) {
        complete = true;
        break;
      }
      // The log pages by cursor, named in the Link header's `next`. Without
      // headers a full page is a list that may go on: not complete.
      const link = typeof res.headers?.get === "function" ? res.headers.get("link") : res.headers?.link;
      const next = String(link || "").match(/<([^>]+)>;\s*rel="next"/)?.[1];
      cursor = next ? new URL(next, "https://api.github.com").searchParams.get("after") : null;
      if (!cursor) break;
    }
    if (!complete) return { ok: true, status: 200, complete: false, failedRead: null, scanned, handIns: [] };

    // A HAND-IN ERASED FROM THE BRANCH WHOSE RUNS WERE DELETED TOO: the log
    // still names its commit, and GitHub still answers for it - asked for its
    // message. Gone (404/422) is gone; any other failure is a failed read.
    const branchAll = new Set(onBranch.map((c) => c.sha));
    const unexplained = [...heads.keys()].filter((sha) => !branchAll.has(sha) && !runOnly.has(sha));
    if (unexplained.length > PER_PAGE) return { ok: true, status: 200, complete: false, failedRead: null, scanned, handIns: [] };
    for (const sha of unexplained) {
      const res = await request(`/repos/${repoFullName}/commits/${sha}`);
      if (res?.status === 404 || res?.status === 422) continue;
      if (!res || res.status < 200 || res.status >= 300) return fail("activity", res?.status ?? 0, scanned);
      const message = res.data?.commit?.message;
      if (!messageMatchesMarker(message, marker)) continue;
      runOnly.set(sha, { sha, message: String(message).trim(), date: res.data?.commit?.committer?.date ?? res.data?.commit?.author?.date ?? null });
    }
  }

  // --- grading runs the STUDENT started ---------------------------------------
  // The grading workflow's dispatch entry lets anyone with write access start
  // it (lib/grade-dispatch.mjs), and a student is usually admin of their own
  // repository - so under a cap they could have a commit graded as often as
  // they liked without spending a hand-in. Each one counts as a hand-in (the
  // user's decision, 2026-09-26): it USES a slot and is never the graded one.
  // Only runs a listed student triggered: a lecturer's or the App's dispatch
  // is a grading decision, not a hand-in.
  //
  // EVERY DISPATCH OF THE GRADING WORKFLOW, WHATEVER ITS TITLE (review of
  // v1.5.0). Only a dispatch whose input was a full commit was counted, while
  // the checkout takes any ref: measured 2026-09-27 on the testbed,
  // `grade_sha=main` is accepted, titled `Grade main (PXL Classroom)`, and
  // grades main's tip - graded and never counted. Which workflow is the
  // grading one is asked of the file the run EXECUTED (`run.path` at
  // `run.head_sha`), with the grader's own tests: a student's lint or deploy
  // workflow is not a hand-in.
  const who = new Set((students || []).map(normalizeLogin).filter(Boolean));
  const dispatched = [];
  if (withRuns && who.size) {
    let complete = false;
    // `path@sha` -> grades?, so one file is read once however often it ran.
    const judged = new Map();
    for (let page = 1; page <= COUNT_MAX_PAGES; page++) {
      const res = await request(
        `/repos/${repoFullName}/actions/runs?event=workflow_dispatch&per_page=${PER_PAGE}&page=${page}`,
      );
      if (!res || res.status < 200 || res.status >= 300) return fail("runs", res?.status ?? 0, scanned);
      const runs = Array.isArray(res.data?.workflow_runs) ? res.data.workflow_runs : [];
      for (const run of runs) {
        const actor = normalizeLogin(run?.triggering_actor?.login ?? run?.actor?.login);
        if (!who.has(actor)) continue;
        const judge = await ranGradingWorkflow(request, repoFullName, run, judged);
        if (!judge.ok) return fail("runs", judge.status, scanned);
        if (!judge.grades) continue;
        // The commit it graded: named in the title when the input was a full
        // commit. Otherwise it is whatever ref the student typed - usually
        // the branch it was dispatched on, whose tip then is the run's
        // `head_sha` (measured for `main`), or a short commit id, which is
        // not. BEST KNOWN, and enough: a dispatch only USES a slot, it is
        // never the graded one. (`ranGradingWorkflow` refused a run without a
        // full `head_sha`.)
        const titled = String(run?.display_title ?? "").match(/^Grade ([0-9a-f]{40}) \(PXL Classroom\)$/);
        const gradedSha = titled?.[1] ?? run.head_sha;
        dispatched.push({
          sha: gradedSha,
          message: String(run.display_title),
          date: run.created_at ?? null,
          pushedAt: run.created_at ?? null,
          pushedFrom: run.created_at ? "run" : null,
          onBranch: false,
          dispatched: true,
          run_id: run.id ?? null,
        });
      }
      if (runs.length < PER_PAGE) {
        complete = true;
        break;
      }
    }
    if (!complete) return { ok: true, status: 200, complete: false, failedRead: null, scanned, handIns: [] };
  }

  const branchShas = new Set(onBranch.map((c) => c.sha));
  // A HAND-IN IS A COMMIT THAT WAS THE LAST OF A PUSH (2026-09-27). GitHub
  // runs a push workflow for that commit only, so a hand-in message on an
  // earlier commit of the same push was never graded and uses no place. It is
  // known from the runs OR the push log, so deleting a hand-in's runs does not
  // hide it. Only when those were read (`withRuns`); without them the branch
  // is all there is.
  const ran = (c) => !withRuns || pushed.has(c.sha) || heads.has(c.sha);
  // WHERE the time came from travels with it: a run's creation is a push plus
  // GitHub's latency and gets the allowance (`handInTime`); the push log's
  // time IS the push and gets none.
  const pushTime = (sha) =>
    pushed.get(sha) ? { pushedAt: pushed.get(sha), pushedFrom: "run" }
      : heads.get(sha) ? { pushedAt: heads.get(sha), pushedFrom: "log" }
        : { pushedAt: null, pushedFrom: null };
  const handIns = orderHandIns(
    // Oldest first: GitHub walked newest first.
    [...onBranch].filter(ran).reverse().map((c) => ({ ...c, ...pushTime(c.sha), onBranch: true })),
    [
      ...[...runOnly.values()]
        .filter((c) => !branchShas.has(c.sha))
        .map((c) => ({ ...c, ...pushTime(c.sha), onBranch: false })),
      ...dispatched,
    ],
  );
  return { ok: true, status: 200, complete: true, failedRead: null, scanned, handIns };
}

/**
 * Did this workflow run execute a GRADING workflow? Asked of the file it ran -
 * `run.path` at `run.head_sha`, which a later edit cannot change - with the
 * tests the rest of grading uses: GitHub Classroom's reporter
 * (`isGradingWorkflow`), PXL Classroom's dispatch entry (`hasGradeDispatch`),
 * or a job whose check run the grader would read a score from
 * (`isAutogradeCheckRunName`), which is a template that grades its own way.
 *
 * A file GitHub no longer has at that commit (404, 422: the commit was
 * force-pushed away and collected) cannot be shown NOT to grade, and the
 * student's own rewrite removed the evidence - it counts. Any other failure is
 * a failed read, never "not grading".
 *
 * @returns {Promise<{ ok: boolean, grades?: boolean, status?: number }>}  `status` when not ok
 */
async function ranGradingWorkflow(request, repoFullName, run, judged) {
  const path = String(run?.path ?? "").replace(/@.*$/, "");
  const sha = String(run?.head_sha ?? "");
  if (!path || !/^[0-9a-f]{40}$/.test(sha)) return { ok: false, status: 0 };
  const key = `${path}@${sha}`;
  if (judged.has(key)) return { ok: true, grades: judged.get(key) };
  const res = await request(`/repos/${repoFullName}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${sha}`);
  let grades;
  if (res?.status === 404 || res?.status === 422) grades = true;
  else if (!res || res.status < 200 || res.status >= 300 || typeof res.data?.content !== "string") return { ok: false, status: res?.status ?? 0 };
  else {
    const text = decodeBase64(res.data.content);
    grades = isGradingWorkflow(text) || hasGradeDispatch(text) || workflowCheckRunNames(text).some(isAutogradeCheckRunName);
  }
  judged.set(key, grades);
  return { ok: true, grades };
}

const ms = (iso) => {
  const t = iso ? new Date(iso).getTime() : NaN;
  return Number.isFinite(t) ? t : NaN;
};

/**
 * Oldest first, over both sources.
 *
 * Each hand-in is placed at the moment GitHub first saw it pushed, falling back
 * to the commit's own date only where no run records one. Commits that are
 * still on the branch additionally keep their BRANCH order - a later commit is
 * a descendant of an earlier one, and ancestry is the one ordering a forged
 * date cannot change - so a branch commit is never placed before the one it
 * was built on. A hand-in that survives only in the run history is slotted in
 * by the time its run started.
 *
 * Exported for the tests; `listHandIns` is the caller.
 */
export function orderHandIns(branchOldestFirst, runOnly) {
  let floor = -Infinity;
  const keyed = branchOldestFirst.map((c, i) => {
    const own = ms(c.pushedAt ?? c.date);
    // Never earlier than its ancestor. An unreadable time inherits the
    // ancestor's, which keeps it in branch order rather than sorting it to
    // either end of the list.
    const key = Number.isFinite(own) ? Math.max(own, floor) : floor;
    floor = key;
    return { c, key, rank: 0, i };
  });
  const loose = runOnly.map((c, i) => {
    const own = ms(c.pushedAt ?? c.date);
    // No time at all: last, rather than a guess that would let it take a
    // valid slot from a hand-in that has one.
    return { c, key: Number.isFinite(own) ? own : Infinity, rank: 1, i };
  });
  return [...keyed, ...loose]
    .sort((a, b) => a.key - b.key || a.rank - b.rank || a.i - b.i)
    .map((k) => k.c);
}

// A run is created a few seconds after the push that started it, so its time
// is a push at most this much earlier. Generous on purpose: the error it
// guards against is marking a student late for GitHub's own latency.
export const PUSH_TO_RUN_ALLOWANCE_MS = 120_000;

/**
 * When a hand-in was made, for the deadline: when GITHUB SAW IT PUSHED, where
 * a run records that, else the commit's own date. The commit date is whatever
 * the student's machine said, and a backdated one passed a deadline its push
 * missed (third review, 2026-09-26); the run's creation time is the server's.
 * Under a lock nothing can be pushed after the instant anyway - this is what
 * holds where there is none. A RUN's time is less `PUSH_TO_RUN_ALLOWANCE_MS`,
 * so a push at 16:59:59 whose run started at 17:00:03 is on time. The push
 * log's time is the push itself and is taken as it stands - subtracting the
 * allowance from it put a push two minutes late on time. A `pushedAt` with no
 * `pushedFrom` gets no allowance either: only a time known to be a run's has
 * GitHub's latency in it.
 */
export function handInTime(h) {
  const pushed = ms(h?.pushedAt);
  if (!Number.isFinite(pushed)) return ms(h?.date);
  return h?.pushedFrom === "run" ? pushed - PUSH_TO_RUN_ALLOWANCE_MS : pushed;
}

/**
 * The time a hand-in is SHOWN at, beside a verdict `handInTime` made: when
 * GitHub recorded the push wherever that is known, the commit's own date only
 * where it is not - and `kind` says which, so the words can. The commit's date
 * was shown everywhere, so a hand-in committed at 16:58 and pushed at 17:03
 * read "hand-in at 16:58 ... ignored: after the deadline" against 17:00.
 *
 * Takes either spelling of a hand-in: a live `HandIn` (`pushedAt`) or the
 * grading summary's record of one (`pushed_at`).
 *
 * `allowance`: the time is a run's, after `deadline`, and inside
 * `PUSH_TO_RUN_ALLOWANCE_MS` of it - so the rule counted it as on time, and a
 * sentence comparing the shown time with the deadline would say "after".
 *
 * @returns {{ at: string, kind: "pushed"|"committed", allowance: boolean }|null}
 */
export function handInShownTime(h, deadline = null) {
  const pushedAt = h?.pushedAt ?? h?.pushed_at ?? null;
  const pushedFrom = h?.pushedFrom ?? h?.pushed_from ?? null;
  if (Number.isFinite(ms(pushedAt))) {
    const due = deadline ? ms(deadline) : NaN;
    const allowance = Number.isFinite(due) && ms(pushedAt) > due && handInTime({ pushedAt, pushedFrom }) <= due;
    return { at: pushedAt, kind: "pushed", allowance };
  }
  const date = h?.date ?? null;
  return Number.isFinite(ms(date)) ? { at: date, kind: "committed", allowance: false } : null;
}

/**
 * Which hand-in counts, and which do not - PURE, over `listHandIns`' list.
 *
 * @param {Array<HandIn>} handIns  oldest first
 * @param {{ until?: string|null, multiple?: boolean, limit?: number|null }} opts
 * @returns {{ commit: HandIn|null, number: number|null, lateCommit: HandIn|null,
 *             used: number, allowed: number|null, ignored: Array<IgnoredHandIn> }}
 *
 * THE RULE: take the hand-ins made on or before THIS student's deadline, in
 * order. The first `limit` of them are valid; the last valid one is graded
 * (the first, under `multiple: false`). Every other hand-in is returned in
 * `ignored`, named, with why - never dropped. A late one is ignored whether or
 * not the cap was reached, and it does not use up a slot: the cap is on
 * hand-ins that could have counted.
 *
 * `used` counts on-time hand-ins, so it can exceed `allowed` - "6 of 5" is the
 * fact a lecturer needs, and clamping it to 5 would hide the one that was
 * ignored.
 */
export function selectHandIn(handIns, { until = null, multiple = true, limit = null } = {}) {
  const deadline = until ? ms(until) : NaN;
  const bounded = Number.isFinite(deadline);
  const onTime = [];
  const late = [];
  for (const h of handIns || []) {
    const at = handInTime(h);
    // A commit with no readable timestamp cannot be shown to be on time - the
    // rule `findMarkedCommit` already applies.
    if (bounded && !(Number.isFinite(at) && at <= deadline)) late.push(h);
    else onTime.push(h);
  }

  const cap = readMaxHandIns(limit);
  const validCount = cap == null ? onTime.length : Math.min(cap, onTime.length);
  const valid = onTime.slice(0, validCount);
  // A grading run the student started USES a slot and is never the graded
  // hand-in: it named no hand-in message, it only bought them a grade.
  const gradable = valid.filter((h) => !h.dispatched);
  const graded = gradable.length ? (multiple === false ? gradable[0] : gradable[gradable.length - 1]) : null;

  const entry = (h, number, reason) => ({
    sha: h.sha,
    date: h.date ?? null,
    pushed_at: h.pushedAt ?? null,
    on_branch: h.onBranch !== false,
    number,
    reason,
  });
  const ignored = [
    // Inside the cap but not gradable: named, so "3 of 3 used" is explicable.
    ...valid.map((h, i) => (h.dispatched ? entry(h, i + 1, "self-dispatched") : null)).filter(Boolean),
    ...onTime.slice(validCount).map((h, i) => entry(h, validCount + i + 1, h.dispatched ? "self-dispatched" : "over-limit")),
    ...late.filter((h) => !h.dispatched).map((h) => entry(h, null, "late")),
  ];
  // With `multiple: false` the later on-time hand-ins inside the cap are not
  // graded either. They are VALID - they used a slot - so they are not listed
  // as ignored; `commit` says which one counts.

  return {
    commit: graded,
    number: graded ? valid.indexOf(graded) + 1 : null,
    // The newest late one, as `findMarkedCommit` reports it.
    lateCommit: late.filter((h) => !h.dispatched).at(-1) ?? null,
    used: onTime.length,
    allowed: cap,
    ignored,
  };
}

/**
 * One ignored hand-in, as a lecturer reads it. `formatTime` is the caller's:
 * the SPA shows local time, the CLI and the nightly log ISO.
 */
export function describeIgnoredHandIn(item, { allowed = null, formatTime = (iso) => iso } = {}) {
  // The time the verdict was made on (`handInShownTime`), and which time it is.
  const shown = handInShownTime(item);
  const short = String(item.sha || "").slice(0, 7);
  const where = item.on_branch === false ? " - no longer on the branch, still counted" : "";
  if (item.reason === "self-dispatched") {
    return `grading run the student started at ${shown ? formatTime(shown.at) : "an unknown time"} for ${short}: counted as hand-in ${item.number ?? "?"} of ${allowed ?? "?"}, never graded`;
  }
  const when = shown ? `${shown.kind} ${formatTime(shown.at)}` : "at an unknown time";
  if (item.reason === "late") {
    return `hand-in ${when} (${short}) ignored: after the deadline${where}`;
  }
  return `hand-in ${item.number} of ${allowed ?? "?"} ${when} (${short}) ignored: over the limit${where}`;
}
