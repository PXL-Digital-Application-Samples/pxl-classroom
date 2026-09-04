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
  return { type, value };
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

/**
 * The newest commit on `branch` carrying the marker, at or before `until`.
 *
 * @param {(path: string) => Promise<{ status: number, data: any }>} request
 * @param {{ repoFullName: string, branch: string, marker: {value: string},
 *           until?: string|null }} opts
 * @returns {Promise<{ ok: boolean, status: number, commit: {sha: string,
 *           message: string, date: string|null}|null, complete: boolean,
 *           scanned: number }>}
 *
 * `ok: false` is a failed read and is NOT "there is no marked commit" - the
 * caller must say it could not look, never that it looked and found nothing.
 * `complete: false` says the walk hit its cap without finding one, which is
 * the same distinction one level down.
 *
 * `until` is the student's own effective deadline, so a hand-in pushed after it
 * cannot become the graded commit. GitHub filters `until` on the commit's own
 * timestamp, which is the field every other deadline comparison here uses.
 */
export async function findMarkedCommit(request, { repoFullName, branch, marker, until = null }) {
  let scanned = 0;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const query =
      `sha=${encodeURIComponent(branch)}&per_page=${PER_PAGE}&page=${page}` +
      (until ? `&until=${encodeURIComponent(until)}` : "");
    const res = await request(`/repos/${repoFullName}/commits?${query}`);

    if (!res || res.status < 200 || res.status >= 300) {
      return { ok: false, status: res?.status ?? 0, commit: null, complete: false, scanned };
    }

    const rows = Array.isArray(res.data) ? res.data : [];
    for (const row of rows) {
      scanned++;
      const message = row?.commit?.message ?? "";
      if (messageMatchesMarker(message, marker)) {
        return {
          ok: true,
          status: res.status,
          commit: {
            sha: row.sha,
            message: String(message).trim(),
            date: row?.commit?.committer?.date ?? row?.commit?.author?.date ?? null,
          },
          complete: true,
          scanned,
        };
      }
    }

    // A short page is the end of the branch: the walk saw everything there is,
    // and "no marked commit" is now a complete answer rather than a cap.
    if (rows.length < PER_PAGE) {
      return { ok: true, status: res.status, commit: null, complete: true, scanned };
    }
  }

  return { ok: true, status: 200, commit: null, complete: false, scanned };
}
