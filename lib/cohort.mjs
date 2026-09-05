// WHO AN ASSIGNMENT IS FOR.
//
// The cohort used to be DERIVED: an assignment named `class_groups: ["3A"]` and
// the gate re-evaluated that rule against each student's `class_group` at every
// acceptance. Nothing was ever written down, so the answer could change under a
// lecturer when the roster changed, and the rule could only ever slice along one
// axis - a resit for "3A plus these four" had no expression at all.
//
// Now it is CHOSEN. The assignment stores the students, picked from the org
// roster at creation; class groups stay on the roster as what a lecturer said
// they were, a filter for finding people, gating nothing.
//
// The fails-closed rule that used to live here is not relaxed, it is OBSOLETE.
// "A student with no class_group is refused" existed to resolve the ambiguity of
// a rule that had not been told about them. An explicit list has no such
// ambiguity: an ungrouped student is admitted when they are on it, and refused
// when they are not, and that is the whole of it.
//
// Isomorphic and dependency-free, like the module it replaces: the SPA reads it
// through `frontend/src/lib/cohort.js`, and it takes documents as parameters so
// a test can run it rather than describe it. The admin form and the acceptance
// gate must not be able to disagree about who is admitted.
import { normalizeLogin } from "./github-login.mjs";

/**
 * Every identity a roster row can be named by.
 *
 * NOT one canonical key, and that is the point. `rosterKey` in
 * lib/roster-entries.mjs answers "which single string identifies this row" for a
 * diff, preferring the student number and falling back to the login. A cohort
 * cannot use that: an entry promoted from an acceptance has only a login, and if
 * a later CSV import gives that same person a student number their canonical key
 * changes - so a cohort listing `login:ella-dev` would stop matching the row it
 * was chosen from, and the student would be refused with nothing on any screen
 * to explain it.
 *
 * Matching on ANY identity the row carries makes that impossible. The row is the
 * same person however it happens to be spelled today.
 *
 * @param {{student_number?: unknown, github_login?: unknown}|null|undefined} entry
 * @returns {string[]} in the order a cohort would prefer to record them
 */
export function rosterIdentities(entry) {
  if (!entry || typeof entry !== "object") return [];
  const out = [];
  const number = String(entry.student_number ?? "").trim();
  if (number) out.push(`num:${number}`);
  // Lowercased through lib/github-login.mjs, never a hand-written toLowerCase:
  // the spelling a lecturer types and the one GitHub dispatches are one account.
  const login = normalizeLogin(entry.github_login);
  if (login) out.push(`login:${login}`);
  return out;
}

/**
 * The identity a NEW cohort entry records for this roster row.
 *
 * The student number when there is one - it survives a GitHub rename, which a
 * login does not. `rosterIdentities` is what reads them back, and it accepts
 * either, so a row recorded one way and matched the other still resolves.
 *
 * @returns {string|null} null when the row can be named by nothing
 */
export function cohortIdentity(entry) {
  return rosterIdentities(entry)[0] ?? null;
}

/**
 * The cohort an assignment declares, normalized for comparison.
 *
 * An EMPTY result means every student on the roster. That is what an absent
 * field means and therefore what every assignment written before this existed
 * means - reading absence as "nobody" would lock every existing cohort out of
 * every existing assignment. It is also what an untouched picker means, which is
 * why the form has to say so on screen rather than leave a lecturer to discover
 * that unticking everything opened the assignment to the whole course.
 *
 * @param {{cohort?: unknown}|null|undefined} assignment
 * @returns {Set<string>}
 */
export function assignmentCohort(assignment) {
  const raw = assignment?.cohort;
  if (!Array.isArray(raw)) return new Set();
  const out = new Set();
  for (const entry of raw) {
    const norm = normalizeCohortEntry(entry);
    if (norm) out.add(norm);
  }
  return out;
}

/**
 * One stored cohort string, in comparable form.
 *
 * `num:` keeps its case (a student number is digits, but a hand-edited YAML may
 * carry anything and two spellings of one number would be two students).
 * `login:` is lowercased, because GitHub logins are case-insensitive.
 */
export function normalizeCohortEntry(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("login:")) {
    const login = normalizeLogin(trimmed.slice("login:".length));
    return login ? `login:${login}` : "";
  }
  if (trimmed.startsWith("num:")) {
    const num = trimmed.slice("num:".length).trim();
    return num ? `num:${num}` : "";
  }
  // An unprefixed value is not silently guessed at. A bare "0123456" could be a
  // student number or a login, and picking one would admit or refuse the wrong
  // person; the schema requires the prefix and the picker always writes it.
  return "";
}

/** Does this assignment narrow the roster at all? */
export function restrictsCohort(assignment) {
  return assignmentCohort(assignment).size > 0;
}

/**
 * May this roster entry accept this assignment?
 *
 * The single judge, called from the `enforced` gate, the `claim` gate and the
 * nightly report. Consulted only where the roster decides who may accept: under
 * `open` the roster is not the gate, so a cohort there would be a control that
 * decides nothing - the form does not offer one, and callers do not ask.
 *
 * @param {{cohort?: unknown}|null|undefined} assignment
 * @param {object|null|undefined} entry a roster row
 * @returns {boolean}
 */
export function assignmentAdmitsStudent(assignment, entry) {
  const cohort = assignmentCohort(assignment);
  if (cohort.size === 0) return true;
  return rosterIdentities(entry).some((id) => cohort.has(id));
}

/**
 * The roster rows this assignment is for, in roster order.
 *
 * What the report narrows its population with, and what the seed-teams checks
 * count against instead of the whole organization. Returns every row when the
 * assignment narrows nothing.
 *
 * @param {{cohort?: unknown}|null|undefined} assignment
 * @param {{students?: unknown}|Array|null|undefined} roster
 * @returns {object[]}
 */
export function cohortStudents(assignment, roster) {
  const students = Array.isArray(roster) ? roster : roster?.students;
  if (!Array.isArray(students)) return [];
  if (!restrictsCohort(assignment)) return [...students];
  return students.filter((s) => assignmentAdmitsStudent(assignment, s));
}

/**
 * Cohort entries that match no row on the roster.
 *
 * A student removed from the roster after the assignment was created leaves
 * their identity behind in it. That is not corrected automatically - the cohort
 * is a record of who the assignment was for - but a surface showing the cohort
 * has to be able to say "2 of these are no longer on the roster" rather than
 * quietly showing 20 where the document says 22.
 *
 * @returns {string[]} the unmatched entries, as stored
 */
export function danglingCohortEntries(assignment, roster) {
  const cohort = assignmentCohort(assignment);
  if (cohort.size === 0) return [];
  const students = Array.isArray(roster) ? roster : roster?.students;
  const known = new Set();
  for (const s of Array.isArray(students) ? students : []) {
    for (const id of rosterIdentities(s)) known.add(id);
  }
  return [...cohort].filter((id) => !known.has(id));
}
