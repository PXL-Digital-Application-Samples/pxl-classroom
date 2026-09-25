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
// Dependency-free and isomorphic on purpose - the SPA bundles it, the CLI
// imports it under plain Node - and transport-agnostic the way
// `lib/check-run-annotations.mjs` is: callers hand in a `request(path)`
// returning `{ status, data }`.

/**
 * What `readSubmissionMarker` returns: the assignment's marker, read.
 * @typedef {{ type: string, value: string, multiple: boolean, maxHandIns: number|null }} SubmissionMarker
 */

/**
 * One hand-in commit. `pushedAt` is when GitHub started its first run for it
 * (server time); `onBranch: false` is known only from the run history.
 * @typedef {{ sha: string, message?: string, date: string|null,
 *             pushedAt?: string|null, onBranch?: boolean }} HandIn
 */

/**
 * One ignored hand-in, as `selectHandIn` names it and the grading summary
 * stores it.
 * @typedef {{ sha: string, date: string|null, pushed_at: string|null,
 *             on_branch: boolean, number: number|null, reason: "over-limit"|"late" }} IgnoredHandIn
 */

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
 * EXACT, on the whole message, and case-sensitive - because that is what the
 * workflow's `==` does, and this has to agree with it. Being more generous
 * here would name a commit the workflow never graded, and the caller would
 * report "no grading run" pointing at a commit that looks right to the
 * lecturer. Trimmed on both sides only: git stores a trailing newline that the
 * push payload does not carry, so `'einde examen\n'` and `'einde examen'` are
 * the same hand-in and disagreeing about it would be an artefact of which API
 * answered.
 */
export function messageMatchesMarker(message, marker) {
  if (!marker) return false;
  return String(message ?? "").trim() === String(marker.value ?? "").trim();
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
 * The commit the student handed in with, or NULL.
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
// Only read when a cap is set: an uncapped assignment asks the one question
// `findMarkedCommit` answers, and spends nothing more than it always did.

// Deeper than `findMarkedCommit`'s walk, because a count needs every hand-in
// rather than the newest one, and the walk cannot stop early. 1,000 is also the
// most the filtered runs endpoint will return.
const COUNT_MAX_PAGES = 10;

/**
 * Every hand-in this student made on the submission branch, oldest first.
 *
 * @param {(path: string) => Promise<{ status: number, data: any }>} request
 * @param {{ repoFullName: string, branch: string, marker: {value: string},
 *           withRuns?: boolean }} opts
 * @returns {Promise<{ ok: boolean, status: number, complete: boolean,
 *           failedRead: 'commits'|'runs'|null, scanned: number,
 *           handIns: Array<{sha: string, message: string, date: string|null,
 *                           pushedAt: string|null, onBranch: boolean}> }>}
 *
 * `ok: false` names WHICH read failed, because "could not read the commits" and
 * "could not read the run history" send a lecturer to different places - and
 * neither is "no hand-in". `complete: false` is a walk that hit its cap: a
 * count that stopped early is not a count.
 */
export async function listHandIns(request, { repoFullName, branch, marker, withRuns = true }) {
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

  const branchShas = new Set(onBranch.map((c) => c.sha));
  const handIns = orderHandIns(
    // Oldest first: GitHub walked newest first.
    [...onBranch].reverse().map((c) => ({ ...c, pushedAt: pushed.get(c.sha) ?? null, onBranch: true })),
    [...runOnly.values()]
      .filter((c) => !branchShas.has(c.sha))
      .map((c) => ({ ...c, pushedAt: pushed.get(c.sha) ?? null, onBranch: false })),
  );
  return { ok: true, status: 200, complete: true, failedRead: null, scanned, handIns };
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
    const at = ms(h.date);
    // A commit with no readable timestamp cannot be shown to be on time - the
    // rule `findMarkedCommit` already applies.
    if (bounded && !(Number.isFinite(at) && at <= deadline)) late.push(h);
    else onTime.push(h);
  }

  const cap = readMaxHandIns(limit);
  const validCount = cap == null ? onTime.length : Math.min(cap, onTime.length);
  const valid = onTime.slice(0, validCount);
  const graded = valid.length ? (multiple === false ? valid[0] : valid[valid.length - 1]) : null;

  const entry = (h, number, reason) => ({
    sha: h.sha,
    date: h.date ?? null,
    pushed_at: h.pushedAt ?? null,
    on_branch: h.onBranch !== false,
    number,
    reason,
  });
  const ignored = [
    ...onTime.slice(validCount).map((h, i) => entry(h, validCount + i + 1, "over-limit")),
    ...late.map((h) => entry(h, null, "late")),
  ];
  // With `multiple: false` the later on-time hand-ins inside the cap are not
  // graded either. They are VALID - they used a slot - so they are not listed
  // as ignored; `commit` says which one counts.

  return {
    commit: graded,
    number: graded ? valid.indexOf(graded) + 1 : null,
    // The newest late one, as `findMarkedCommit` reports it.
    lateCommit: late.length ? late[late.length - 1] : null,
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
  const when = item.date ? formatTime(item.date) : "an unknown time";
  const short = String(item.sha || "").slice(0, 7);
  const where = item.on_branch === false ? " - no longer on the branch, still counted" : "";
  if (item.reason === "late") {
    return `hand-in at ${when} (${short}) ignored: after the deadline${where}`;
  }
  return `hand-in ${item.number} of ${allowed ?? "?"} at ${when} (${short}) ignored: over the limit${where}`;
}
