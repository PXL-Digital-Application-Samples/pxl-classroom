// PXL Classroom - where a deadline's lock is placed.
//
// Its own module because it is a DECISION about live assignments, and the two
// callers that must agree on it are a workflow and a test. Inside lockdown.mjs
// it was one expression nothing could import, so the only way to check it was
// to read it.
//
// ORGANIZATION SCOPE IS THE DEFAULT UNDER `block`, since 2026-09-09.
//
// The reason is the configuration lecturers actually want: "the deadline is
// final, and the student keeps their Actions, secrets and runners". That is
// exactly the case where the student is still admin of their own repository -
// and therefore exactly the case where they can open its Settings and delete
// the ruleset that stops them pushing. Measured: an organization ruleset
// answers 404 to that student on delete, on disable, and on removing it from
// their own repository, while leaving their admin, Actions and secrets intact.
//
// ABSENT MEANS ORGANIZATION SCOPE, AND THAT IS A DELIBERATE REINTERPRETATION OF
// EXISTING DOCUMENTS - the one place this codebase does that, against its own
// rule that absent and empty are different answers. It was chosen with the
// blast radius measured rather than assumed: on 2026-09-09 three published
// assignments used `late_policy: block` and none carried this field, one of them
// in a Team organization belonging to another lecturer, and that assignment
// will get the new mechanism at its deadline without its lecturer choosing it.
// `lockMethodNote` exists so the run log says which mechanism applied and why,
// because a change nobody asked for should at least be legible afterwards.
//
// `false` is preserved as an explicit opt-out and lib/assignment-doc.mjs
// carries it through a save, or the next unrelated edit would delete the only
// way back.

/**
 * Should this assignment's deadline be enforced by ONE organization ruleset
 * covering the cohort, rather than one ruleset per student repository?
 *
 * @param {object} assignment  the assignment document
 * @param {boolean} blockLate  `late_policy === "block"` - nothing is locked otherwise
 * @returns {boolean}
 */
export function usesOrgScope(assignment, blockLate) {
  if (!blockLate) return false;
  return assignment?.org_scoped_lock !== false;
}

/**
 * One sentence for the run log saying which lock was chosen and why it was.
 *
 * A default that reinterprets documents has to say so where somebody reading a
 * run can see it; "org-ruleset" on its own does not distinguish a lecturer's
 * choice from ours.
 */
export function lockScopeNote(assignment, blockLate) {
  if (!blockLate) return "late work counts, so nothing is locked";
  const stored = assignment?.org_scoped_lock;
  if (stored === false) return "repository scope - this assignment opts out of organization scope";
  if (stored === true) return "organization scope - set on the assignment";
  return "organization scope - the default under `does not count` (this assignment does not say)";
}
