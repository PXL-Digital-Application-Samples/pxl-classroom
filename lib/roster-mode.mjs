// PXL Classroom - who may accept an assignment.
//
// Pure and dependency-free - no fs, no fetch, no Node builtins - so the
// acceptance gate, the Pages generator, the Admin Panel and the roster planner
// all decide the same way.
//
// It is shared because the rule was written out by hand in five places as
// `roster_mode === "open" ? "open" : "enforced"`, and that spelling does two
// things at once: it normalises, and it silently COLLAPSES anything it does not
// recognise into `enforced`. That is the correct behaviour for garbage - the
// gate must fail closed - and the wrong behaviour for a value the system has
// since learned about. `AdminView.loadAssignmentIntoForm` used exactly that
// ternary, so opening an assignment in a mode the ternary predates rewrote it
// to `enforced` on load and saved the rewrite back: the same shape as buildDoc
// deleting invitation tokens, and just as silent.
//
// Fail-closed is not negotiable. `enforced` is the most restrictive mode, so an
// unrecognised value denies rather than admits - a typo like `Open` must never
// open a cohort to the internet. accept.mjs has always done this; the point of
// the module is that everything else does it identically.

/**
 * Every mode the system implements.
 *
 *   enforced   - the login must be in students/roster.yml (the default).
 *   open       - any GitHub account inside the window and under the cap.
 *                max_acceptances is MANDATORY here: with the roster gate gone
 *                it is the only remaining limit.
 *   org_member - the login must be an ACTIVE member of the organization.
 *                Membership is itself a real limit - somebody had to invite
 *                them - so a cap is allowed but not required.
 */
export const ROSTER_MODES = Object.freeze(["enforced", "open", "org_member"]);

/** The default, and what anything unrecognised falls back to. */
export const DEFAULT_ROSTER_MODE = "enforced";

/**
 * The mode actually in force for an assignment.
 *
 * @param {unknown} value the raw `roster_mode` field, possibly absent or junk
 * @returns {"enforced"|"open"|"org_member"}
 */
export function normalizeRosterMode(value) {
  return ROSTER_MODES.includes(value) ? value : DEFAULT_ROSTER_MODE;
}

/** Does this mode require `max_acceptances`? Only `open` does, and it must. */
export function requiresAcceptanceCap(value) {
  return normalizeRosterMode(value) === "open";
}
