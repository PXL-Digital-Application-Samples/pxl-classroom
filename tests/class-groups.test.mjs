// Which cohort may accept, executed rather than described.
//
// The org-wide roster could not separate two sections of one course: two
// groups, two different assignments, one gate. An assignment names its class
// groups now. This file holds the two properties that decide whether that is a
// gate or a suggestion - absence means EVERY group, and a restriction admits
// nobody it did not name.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  normalizeClassGroup,
  assignmentClassGroups,
  restrictsByClassGroup,
  assignmentAdmitsClassGroup,
  assignmentAdmitsStudent,
  rosterClassGroups,
  studentsExcludedByClassGroup,
} from "../lib/class-groups.mjs";

// --- absence is "everyone", and every existing assignment depends on it ------

test("an assignment that names no class group admits every group", () => {
  // The one place this rule is deliberately open. Every assignment written
  // before this field existed has no `class_groups`, and reading that as
  // "nobody" would lock every cohort out of every existing assignment.
  for (const a of [{}, null, undefined, { class_groups: [] }, { class_groups: null }]) {
    assert.equal(assignmentAdmitsClassGroup(a, "3A"), true, JSON.stringify(a));
    assert.equal(assignmentAdmitsClassGroup(a, ""), true, "including an ungrouped student");
    assert.equal(restrictsByClassGroup(a), false);
  }
});

// --- a restriction is a gate, not a hint ------------------------------------

test("a restricted assignment admits only the groups it named", () => {
  const a = { class_groups: ["3A"] };
  assert.equal(assignmentAdmitsClassGroup(a, "3A"), true);
  assert.equal(assignmentAdmitsClassGroup(a, "3B"), false);
});

test("an ungrouped student is NOT admitted to a restricted assignment", () => {
  // Fails closed. "I did not say" is not "any" - the alternative makes the
  // restriction advisory, which is the one thing a gate may never be.
  const a = { class_groups: ["3A"] };
  for (const missing of ["", "   ", null, undefined, 42, {}]) {
    assert.equal(
      assignmentAdmitsClassGroup(a, missing),
      false,
      `a student whose class_group is ${JSON.stringify(missing)} must not slip through`,
    );
  }
});

test("assignmentAdmitsStudent reads the entry's own class_group", () => {
  const a = { class_groups: ["3B"] };
  assert.equal(assignmentAdmitsStudent(a, { github_login: "alice", class_group: "3B" }), true);
  assert.equal(assignmentAdmitsStudent(a, { github_login: "bob", class_group: "3A" }), false);
  assert.equal(assignmentAdmitsStudent(a, { github_login: "carol" }), false, "no group, restricted assignment");
  assert.equal(assignmentAdmitsStudent(a, null), false);
});

// --- one group typed two ways is one group ----------------------------------

test("case and surrounding space do not split a section in two", () => {
  // Lecturers type these into a CSV by hand. Comparing raw would put "3a" and
  // "3A" in different sections - the mistake lib/github-login.mjs exists to
  // stop for logins.
  assert.equal(normalizeClassGroup("  3A "), "3a");
  const a = { class_groups: [" 3a "] };
  assert.equal(assignmentAdmitsClassGroup(a, "3A"), true);
  assert.equal(assignmentAdmitsClassGroup(a, "3a"), true);
});

test("the assignment's list is normalized and de-duplicated", () => {
  assert.deepEqual(assignmentClassGroups({ class_groups: ["3A", "3a", " 3A", "", null, "3B"] }), ["3a", "3b"]);
  assert.deepEqual(assignmentClassGroups({ class_groups: "3A" }), [], "a bare string is not a list");
});

// --- what the admin form needs to show ---------------------------------------

test("rosterClassGroups offers each group once, in the lecturer's own spelling", () => {
  const roster = {
    students: [
      { github_login: "a", class_group: "3B" },
      { github_login: "b", class_group: "3A" },
      { github_login: "c", class_group: "3a" },
      { github_login: "d" },
      { github_login: "e", class_group: "   " },
    ],
  };
  // De-duplicated on the normalized form, returned as TYPED - "3A" and "3a"
  // must not offer two choices that mean the same thing.
  assert.deepEqual(rosterClassGroups(roster), ["3A", "3B"]);
});

test("rosterClassGroups survives a roster that is absent or shaped oddly", () => {
  assert.deepEqual(rosterClassGroups(null), []);
  assert.deepEqual(rosterClassGroups({}), []);
  assert.deepEqual(rosterClassGroups({ students: "nope" }), []);
  assert.deepEqual(rosterClassGroups([{ class_group: "1C" }]), ["1C"], "a bare array is a roster too");
});

test("the form can name who a restriction would shut out", () => {
  // Being right at the gate is no use if the surprise arrives at the accept
  // button. This is what lets the form say so while it can still be changed.
  const roster = {
    students: [
      { github_login: "alice", class_group: "3A" },
      { github_login: "bob", class_group: "3B" },
      { github_login: "carol" },
    ],
  };
  const excluded = studentsExcludedByClassGroup({ class_groups: ["3A"] }, roster);
  assert.deepEqual(excluded.map((s) => s.github_login), ["bob", "carol"]);

  assert.deepEqual(
    studentsExcludedByClassGroup({}, roster),
    [],
    "an unrestricted assignment excludes nobody, so there is nothing to warn about",
  );
});
