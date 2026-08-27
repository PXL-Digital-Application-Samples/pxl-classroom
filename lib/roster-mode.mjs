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
 *   claim      - the student proves an institutional EMAIL ADDRESS, which must
 *                match a roster entry. Same roster, different key: it is
 *                "enforced, with a way in", for the ordinary case where a
 *                lecturer holds addresses and not GitHub usernames.
 *   open       - any GitHub account inside the window and under the cap.
 *                max_acceptances is MANDATORY here: with the roster gate gone
 *                it is the only remaining limit.
 *
 * `org_member` was a third mode: the login had to be an ACTIVE member of the
 * organization, which let a lecturer gate on a list of EMAIL ADDRESSES by
 * having GitHub do the binding (invite the addresses, then ask
 * /orgs/{org}/memberships/{login} who accepted). It is gone. It solved the
 * right problem - a lecturer holds addresses, not GitHub usernames - but it
 * solved it by making enrolment depend on org membership, and the claim flow
 * that replaces it binds the address directly without putting students in the
 * organization at all. It was never used on a cohort: every assignment ever
 * written in the twelve participating orgs is `enforced` (12) or `open` (10).
 *
 * Removing a value from this list is safe in a way that adding one is not,
 * because normalizeRosterMode fails CLOSED - a control repo still holding
 * `roster_mode: org_member` now reads as `enforced`, the most restrictive
 * mode, rather than admitting anyone.
 */
export const ROSTER_MODES = Object.freeze(["enforced", "claim", "open"]);

/** The default, and what anything unrecognised falls back to. */
export const DEFAULT_ROSTER_MODE = "enforced";

/**
 * The mode actually in force for an assignment.
 *
 * @param {unknown} value the raw `roster_mode` field, possibly absent or junk
 * @returns {"enforced"|"open"}
 */
export function normalizeRosterMode(value) {
  return ROSTER_MODES.includes(value) ? value : DEFAULT_ROSTER_MODE;
}

/** Does this mode require `max_acceptances`? Only `open` does, and it must. */
export function requiresAcceptanceCap(value) {
  return normalizeRosterMode(value) === "open";
}

/**
 * Is students/roster.yml the thing that decides who may accept?
 *
 * True for `enforced` AND `claim`: both refuse a student the roster does not
 * name, so under both an unreadable or empty roster means nobody can accept and
 * that is a failure rather than a degraded read.
 *
 * This is NOT the same question as rosterMatchesLogin below, and conflating
 * them is the bug this pair exists to prevent. Before `claim` there was exactly
 * one roster-gated mode, so a single `=== "enforced"` answered both - which is
 * why seven call sites spell it that way today. Adding a second roster-gated
 * mode splits the question in two, and each site wants one answer or the other.
 */
export function rosterGatesAcceptance(value) {
  const mode = normalizeRosterMode(value);
  return mode === "enforced" || mode === "claim";
}

/**
 * Is the student's GitHub LOGIN what gets looked up in the roster?
 *
 * True for `enforced` only. Under `claim` the key is the student's email
 * address, and `github_login` is precisely the column a claim assignment does
 * NOT expect the lecturer to have - that is the whole reason the mode exists.
 *
 * So anything that reports "you are not on the roster", counts how many roster
 * entries carry a `github_login`, or checks a student's own login against the
 * roster must ask THIS, not rosterGatesAcceptance. Asking the wrong one tells a
 * claim student they are missing from a roster that lists them by address, and
 * warns a lecturer about an empty column their cohort does not use.
 */
export function rosterMatchesLogin(value) {
  return normalizeRosterMode(value) === "enforced";
}
