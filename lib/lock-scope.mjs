// PXL Classroom - where a deadline's lock is placed, and whether it takes
// access as well.
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
 * @param {import("./types.mjs").Assignment} assignment  the assignment document
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

// WHETHER THE DEADLINE ALSO TAKES ACCESS is a second question, and it is asked
// of every rung. `late_policy` decides what counts; `lock_down_enabled` decides
// what the student keeps (DESIGN.md §1.9), and all four combinations mean
// something.
//
// Phase 4 used to demote only when phase 1 had used a REPOSITORY ruleset - a
// condition written when that was the only ruleset there was. Organization scope
// became a rung and then the default, the condition still named the old rung by
// value, and `block` + `lock_down_enabled: true` silently stopped taking admin
// away. So the rule is written the other way round: demote unless phase 1
// already demoted, and a rung added later inherits what the lecturer asked for
// instead of dropping it.

/**
 * Does the deadline take the student's access away? `lock_down_enabled`.
 *
 * ABSENT MEANS TRUE: every assignment created before the field existed was
 * demoted at the deadline, and reading a missing field as "no" would stop
 * freezing live cohorts.
 *
 * @param {import("./types.mjs").Assignment} assignment
 * @returns {boolean}
 */
export function takesAccessAtDeadline(assignment) {
  return assignment?.lock_down_enabled ?? true;
}

/**
 * Should phase 4 demote this repository, given what phase 1 did to it?
 *
 * Per repository, because the ladder degrades per repository: a ruleset that
 * could not be applied has already fallen back to a demotion for that one, so
 * there is nothing left to take.
 *
 * @param {import("./types.mjs").Assignment} assignment
 * @param {string|undefined} stopMethod how phase 1 stopped THIS repository
 * @returns {boolean}
 */
export function demotesAfterStop(assignment, stopMethod) {
  return takesAccessAtDeadline(assignment) && stopMethod !== "demotion";
}
