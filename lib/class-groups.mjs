// WHICH COHORT MAY ACCEPT AN ASSIGNMENT.
//
// The roster is org-wide: one `students/roster.yml` per organization, and every
// assignment gated on it sees the same list. That breaks down the moment one
// course runs two sections in a year - two groups, two different assignments,
// one gate.
//
// Rather than a second roster, an assignment names the CLASS GROUPS it admits.
// `class_group` was already on every roster entry ("Optional class group or
// section the student belongs to"), already imported from CSV, already shown in
// the roster tab and already carried into reports - the field existed and
// nothing gated on it. This is that missing predicate, and nothing more.
//
// It is deliberately the same idea as GitHub Classroom's "classroom" - a roster
// belongs to a section, and an assignment inherits its section's roster - stored
// as a column instead of a folder, so a student exists once and there is no
// second file to keep in step.
//
// A STUDENT IS IN AT MOST ONE GROUP. That was a decision, not an oversight: it
// keeps `class_group` a scalar on the roster row. If a student ever needs two,
// this file is where that becomes a list - and every reader below goes through
// it, so it is one change rather than ten.
//
// Isomorphic and dependency-free: the SPA reads it through
// `frontend/src/lib/class-groups.js`, and it takes documents as parameters so a
// test can run it rather than describe it.

/**
 * The comparable form of a class group.
 *
 * Lecturers type these into a CSV by hand, so "3A", "3a" and " 3A " are one
 * group and comparing them raw would split a section in two - the same mistake
 * `lib/github-login.mjs` exists to stop for logins. Comparison only; the
 * roster keeps whatever spelling the lecturer chose, and the UI shows that.
 *
 * @param {unknown} value
 * @returns {string} "" when there is no usable group
 */
export function normalizeClassGroup(value) {
  if (typeof value !== "string") return "";
  return value.trim().toLowerCase();
}

/**
 * The groups an assignment admits, normalized.
 *
 * An EMPTY result means "every group", which is what an absent field means and
 * therefore what every assignment written before this existed means. That is
 * the one place this rule is deliberately open rather than closed: an
 * assignment that never named a cohort cannot be said to have excluded one, and
 * treating absence as "nobody" would lock every existing cohort out of every
 * existing assignment.
 *
 * @param {{class_groups?: unknown}|null|undefined} assignment
 * @returns {string[]}
 */
export function assignmentClassGroups(assignment) {
  const raw = assignment?.class_groups;
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  for (const entry of raw) {
    const norm = normalizeClassGroup(entry);
    if (norm) seen.add(norm);
  }
  return [...seen];
}

/** Does this assignment restrict acceptance to particular class groups? */
export function restrictsByClassGroup(assignment) {
  return assignmentClassGroups(assignment).length > 0;
}

/**
 * May a student in `classGroup` accept this assignment?
 *
 * FAILS CLOSED, and that is the whole point of the function. Once an assignment
 * names its cohorts, a student with no group is not admitted: "I did not say"
 * is not "any". The alternative - letting an ungrouped student through a
 * restricted assignment - would make the restriction advisory, which is the one
 * thing a gate may never be.
 *
 * The caller is expected to warn a lecturer BEFORE they save that some of their
 * roster has no group, because being right here is no use if the surprise
 * arrives at the accept button.
 *
 * @param {{class_groups?: unknown}|null|undefined} assignment
 * @param {unknown} classGroup the student's own `class_group`
 * @returns {boolean}
 */
export function assignmentAdmitsClassGroup(assignment, classGroup) {
  const allowed = assignmentClassGroups(assignment);
  if (allowed.length === 0) return true;
  const norm = normalizeClassGroup(classGroup);
  if (!norm) return false;
  return allowed.includes(norm);
}

/** Convenience for a roster entry rather than a bare value. */
export function assignmentAdmitsStudent(assignment, student) {
  return assignmentAdmitsClassGroup(assignment, student?.class_group);
}

/**
 * The distinct class groups present on a roster, in the lecturer's own
 * spelling, sorted for a stable UI.
 *
 * Deduplicated on the NORMALIZED form but returned as typed, so "3A" and "3a"
 * offer one choice rather than two that mean the same thing. First spelling
 * seen wins - there is no basis for preferring another.
 *
 * @param {{students?: unknown}|Array|null|undefined} roster
 * @returns {string[]}
 */
export function rosterClassGroups(roster) {
  const students = Array.isArray(roster) ? roster : roster?.students;
  if (!Array.isArray(students)) return [];
  const byNorm = new Map();
  for (const s of students) {
    const raw = typeof s?.class_group === "string" ? s.class_group.trim() : "";
    const norm = normalizeClassGroup(raw);
    if (norm && !byNorm.has(norm)) byNorm.set(norm, raw);
  }
  return [...byNorm.values()].sort((a, b) => a.localeCompare(b));
}

/**
 * Roster students who would be shut out by this assignment's cohorts.
 *
 * What the admin form needs in order to say "4 students have no class group and
 * will not be able to accept" while the lecturer can still do something about
 * it. Returns [] when the assignment restricts nothing.
 *
 * @returns {Array} the excluded entries, in roster order
 */
export function studentsExcludedByClassGroup(assignment, roster) {
  if (!restrictsByClassGroup(assignment)) return [];
  const students = Array.isArray(roster) ? roster : roster?.students;
  if (!Array.isArray(students)) return [];
  return students.filter((s) => !assignmentAdmitsStudent(assignment, s));
}
