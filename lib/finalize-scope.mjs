// PXL Classroom - which assignments the deadline's machinery reaches.
//
// Published and closed assignments always: they are the ones a cohort is in.
// An archived or draft one only where students accepted (repository records)
// AND its deadline is from FINALIZE_ANY_STATE_FROM on. P2-25 (2026-10-14)
// widened the finalize to them, because an exam archived before its deadline
// was otherwise never locked or archived; it did so with no cutoff, so every
// archived assignment ever, in every org, with a past deadline and no lock
// record was queued - last year's courses locked out of the blue (review
// 2026-10-15, R6-4; last night's nightly finalized none, read from its run).
// And the report rebuild did not widen with it, so an assignment finalized
// that way kept its pre-lock report on Progress, Grading, the delete dialog
// and the retired copy. One rule now, for the finalize queue, the active count,
// the report rebuild and a delete's wait for a current report.
//
// Isomorphic: the hub's scripts and the Admin Panel import it; nothing here
// reads a file - the caller says whether repository records exist.

/** The first deadline an archived or draft assignment is finalized for. */
export const FINALIZE_ANY_STATE_FROM = "2026-10-14T00:00:00Z";

/** The states a cohort is in, whatever else is true. */
export const COHORT_STATES = Object.freeze(["published", "closed"]);

/**
 * @param {{state?: string, deadline_at?: string}|null|undefined} assignment
 * @param {{hasRepositories: boolean}} evidence  repository records exist for it
 */
export function inFinalizeScope(assignment, { hasRepositories }) {
  if (!assignment) return false;
  if (COHORT_STATES.includes(assignment.state)) return true;
  if (!hasRepositories) return false;
  const deadline = Date.parse(assignment.deadline_at ?? "");
  return Number.isFinite(deadline) && deadline >= Date.parse(FINALIZE_ANY_STATE_FROM);
}
