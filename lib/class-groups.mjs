// CLASS GROUPS ARE A PROPERTY OF A STUDENT, AND A FILTER. THEY GATE NOTHING.
//
// This file used to be the acceptance gate: an assignment named `class_groups`
// and every reader asked here whether a student was admitted. That was a rule
// the system re-evaluated at every acceptance, and it could only slice the
// roster along one axis - one group per student, no unions, so "3A plus these
// four" had no expression.
//
// The gate moved to `lib/cohort.mjs`, where an assignment stores the students a
// lecturer picked. What is left here is what the word was always supposed to
// mean: `class_group` is a column on a roster row, and these helpers let a
// picker offer the distinct values as filters. A file named for class groups
// should not decide acceptances once class groups decide nothing.
//
// A STUDENT IS IN AT MOST ONE GROUP, still - `class_group` is a scalar on the
// roster row. That is no longer a limitation on who an assignment can be for,
// because the cohort is chosen rather than derived: tick 3A, then tick four more
// people.
//
// Isomorphic and dependency-free: the SPA reads it through
// `frontend/src/lib/class-groups.js`.

/**
 * The comparable form of a class group.
 *
 * Lecturers type these into a CSV by hand, so "3A", "3a" and " 3A " are one
 * group and comparing them raw would split a section in two - the same mistake
 * `lib/github-login.mjs` exists to stop for logins. Comparison only; the roster
 * keeps whatever spelling the lecturer chose, and the UI shows that.
 *
 * @param {unknown} value
 * @returns {string} "" when there is no usable group
 */
export function normalizeClassGroup(value) {
  if (typeof value !== "string") return "";
  return value.trim().toLowerCase();
}

/**
 * The distinct class groups present on a roster, in the lecturer's own
 * spelling, sorted for a stable UI.
 *
 * Deduplicated on the NORMALIZED form but returned as typed, so "3A" and "3a"
 * offer one filter chip rather than two that mean the same thing. First
 * spelling seen wins - there is no basis for preferring another.
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
 * Is this student in this group? Used by the picker's filter, nothing else.
 *
 * `group` of "" means the ungrouped filter - the students who carry no
 * class_group at all. They used to be invisible in this control and refused by
 * the gate behind it; they are a filter of their own now, so a lecturer can see
 * them and tick them.
 *
 * @param {object|null|undefined} student
 * @param {string} group the lecturer's spelling, or "" for ungrouped
 * @returns {boolean}
 */
export function studentInClassGroup(student, group) {
  const theirs = normalizeClassGroup(student?.class_group);
  const wanted = normalizeClassGroup(group);
  if (!wanted) return theirs === "";
  return theirs === wanted;
}

/**
 * How many roster students sit in each group, plus the ungrouped.
 *
 * The picker's chips read "3A · 20", because a bare "3A" never answered the
 * question a lecturer is actually asking at that moment: how many people am I
 * about to admit. The ungrouped count is returned under "" and is deliberately
 * present even when it is zero, so the caller decides whether to show the chip
 * rather than inferring it from a missing key.
 *
 * @param {{students?: unknown}|Array|null|undefined} roster
 * @returns {Array<{group: string, count: number}>} groups sorted, ungrouped last
 */
export function classGroupCounts(roster) {
  const students = Array.isArray(roster) ? roster : roster?.students;
  const rows = Array.isArray(students) ? students : [];
  const counts = new Map();
  let ungrouped = 0;
  for (const s of rows) {
    const raw = typeof s?.class_group === "string" ? s.class_group.trim() : "";
    if (!normalizeClassGroup(raw)) {
      ungrouped += 1;
      continue;
    }
    const norm = normalizeClassGroup(raw);
    const existing = counts.get(norm);
    if (existing) existing.count += 1;
    else counts.set(norm, { group: raw, count: 1 });
  }
  const out = [...counts.values()].sort((a, b) => a.group.localeCompare(b.group));
  out.push({ group: "", count: ungrouped });
  return out;
}
