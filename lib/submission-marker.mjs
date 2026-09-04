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
  return { type, value, multiple: marker.multiple !== false };
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
 *           commit: {sha, message, date}|null,
 *           lateCommit: {sha, message, date}|null,
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
