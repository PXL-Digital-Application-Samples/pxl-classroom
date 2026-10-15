// Whether a student's deadline snapshot is in the archive, for the report row
// (`preservation_status`) that Reopen, the preservation banner and the grader
// all read.
//
// WHETHER ONE IS REQUIRED comes from the lockdown row, never from the
// preservation file's absence (review 2026-10-14). preserve/preserve.mjs writes
// `preservation.json` only after a verified push, so a push that failed left no
// file and read "not-required" - and Reopen (lib/repo-unlock.mjs), which
// refuses only `pending` and `failed`, then reopened a repository whose deadline
// snapshot was in no archive. "Preservation is the gate" (LESSONS) had a hole
// the shape of a failure.
//
// Isomorphic, no imports: report.mjs calls it, and the test runs it.

/**
 * @param {object} a
 * @param {{ verified?: boolean } | null | undefined} a.preservation  the student's preservation.json
 * @param {{ snapshot_sha?: string|null, no_submission?: boolean, deferred_until?: string|null,
 *           reconstructed?: boolean, reopened_at?: string|null } | null | undefined} a.lockdownRow  their row of the lockdown record
 * @returns {"preserved"|"pending"|"failed"|"deferred"|"not-required"}
 */
export function preservationStatus({ preservation, lockdownRow }) {
  if (preservation?.verified) return "preserved";
  // A file that says it was not verified is a preservation that did not hold.
  if (preservation) return "failed";
  // Nothing locked yet: nothing is due to be preserved.
  if (!lockdownRow) return "not-required";
  // Locked with a snapshot that is not in the archive yet: the next pass
  // preserves it (or keeps failing, which the run's log and notice say).
  if (typeof lockdownRow.snapshot_sha === "string" && lockdownRow.snapshot_sha) return "pending";
  // STILL IN AN EXTENSION is owed a copy, later - not "not required"
  // (review 2026-10-15, R6-15): counted as nothing owed, the Progress strip
  // said all work was archived and the delete dialog that each submission was
  // kept, over students still working.
  if (lockdownRow.deferred_until) return "deferred";
  // No snapshot for a reason: nothing before the deadline under `block`, or a
  // reconstruction that found nothing.
  if (lockdownRow.no_submission || lockdownRow.reconstructed) return "not-required";
  // Reopened with nothing frozen (review 2026-10-14, P2-28): Reopen refuses a
  // `failed` or `pending` row, so this one owed nothing when it was reopened,
  // and the reopened row lockdown writes does not carry `no_submission`. Read
  // as failed it offered Try again over a student with nothing to archive -
  // the same row preserve.mjs already skips as no error (A15).
  if (lockdownRow.reopened_at) return "not-required";
  // Locked, and no snapshot was read: nothing can be preserved until lockdown
  // reads it again.
  return "failed";
}
