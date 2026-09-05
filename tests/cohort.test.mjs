// The gate that decides who may accept.
//
// It replaced a RULE with a LIST. `class_groups: ["3A"]` was re-evaluated at
// every acceptance against each student's own `class_group`, which meant the
// answer could change under a lecturer and could only ever slice one way. The
// assignment now stores the students that were picked.
//
// The test that matters most here is the identity one. A cohort names a roster
// row, a row can be named two ways, and the way it is named can change under a
// CSV import - so a gate that compared one canonical key would refuse a student
// it had admitted yesterday, with nothing on any screen to explain it.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  rosterIdentities,
  cohortIdentity,
  assignmentCohort,
  normalizeCohortEntry,
  restrictsCohort,
  assignmentAdmitsStudent,
  cohortStudents,
  danglingCohortEntries,
} from "../lib/cohort.mjs";

const ALICE = { student_number: "0123456", full_name: "Alice", github_login: "alice-dev", class_group: "3A" };
const BRAM = { student_number: "0123457", full_name: "Bram", github_login: "bram-p", class_group: "3A" };
const CARA = { student_number: "0123458", full_name: "Cara", class_group: "3B" };
/** Promoted from an acceptance: a login and nothing else. */
const ELLA = { github_login: "ella-dev", source: "accepted" };

const ROSTER = { students: [ALICE, BRAM, CARA, ELLA] };

test("an absent or empty cohort admits everyone", () => {
  // What every assignment written before this field means. Reading absence as
  // "nobody" would lock every existing cohort out of every existing assignment.
  for (const assignment of [{}, { cohort: [] }, { cohort: null }, null, undefined]) {
    assert.equal(assignmentAdmitsStudent(assignment, ALICE), true, JSON.stringify(assignment));
    assert.equal(assignmentAdmitsStudent(assignment, ELLA), true, "including a row with no number");
    assert.equal(restrictsCohort(assignment), false);
  }
});

test("a listed student is admitted and an unlisted one is not", () => {
  const a = { cohort: ["num:0123456", "login:ella-dev"] };
  assert.equal(assignmentAdmitsStudent(a, ALICE), true);
  assert.equal(assignmentAdmitsStudent(a, ELLA), true);
  assert.equal(assignmentAdmitsStudent(a, BRAM), false);
  assert.equal(assignmentAdmitsStudent(a, CARA), false);
  assert.equal(restrictsCohort(a), true);
});

test("a student with no class group is admitted when they are on the list", () => {
  // THE RULE THAT IS NOW OBSOLETE. Under class_groups an ungrouped student was
  // refused by any assignment naming groups - "I did not say" is not "any". A
  // list has no such ambiguity: Ella carries no class_group at all and is in.
  const a = { cohort: ["login:ella-dev"] };
  assert.equal(ELLA.class_group, undefined);
  assert.equal(assignmentAdmitsStudent(a, ELLA), true);
});

test("a row named by login stays admitted after it gains a student number", () => {
  // THE REASON rosterIdentities EXISTS, demonstrated rather than asserted about.
  //
  // Ella was promoted from an acceptance, so the cohort recorded `login:`. A
  // later CSV import gives her the student number the registrar has. Her
  // canonical rosterKey changes from login to number - and a gate comparing one
  // canonical key would refuse her, on an assignment she is deliberately in.
  const a = { cohort: ["login:ella-dev"] };
  const identified = { ...ELLA, student_number: "0123461", full_name: "Ella Maes" };

  assert.deepEqual(rosterIdentities(ELLA), ["login:ella-dev"]);
  assert.deepEqual(rosterIdentities(identified), ["num:0123461", "login:ella-dev"]);
  assert.equal(assignmentAdmitsStudent(a, identified), true, "the same person, still admitted");

  // And the other direction: recorded by number, then the login changes.
  const byNumber = { cohort: ["num:0123461"] };
  assert.equal(assignmentAdmitsStudent(byNumber, { ...identified, github_login: "ella-renamed" }), true);
});

test("logins compare case-insensitively, student numbers do not lose their zeroes", () => {
  const a = { cohort: ["login:Alice-Dev", "num:0123456"] };
  assert.equal(assignmentAdmitsStudent(a, { github_login: "ALICE-DEV" }), true);
  assert.equal(assignmentAdmitsStudent(a, { student_number: "0123456" }), true);
  // A leading zero is part of the number, not formatting.
  assert.equal(assignmentAdmitsStudent(a, { student_number: "123456" }), false);
});

test("an unprefixed cohort entry is refused rather than guessed at", () => {
  // A bare "0123456" could be a student number or a login, and picking one would
  // admit or refuse the wrong person. The schema requires the prefix.
  assert.equal(normalizeCohortEntry("0123456"), "");
  assert.equal(normalizeCohortEntry("alice-dev"), "");
  assert.equal(normalizeCohortEntry("  "), "");
  assert.equal(normalizeCohortEntry(42), "");
  assert.equal(assignmentCohort({ cohort: ["0123456"] }).size, 0);
});

test("cohortIdentity prefers the number, because a login can be renamed", () => {
  assert.equal(cohortIdentity(ALICE), "num:0123456");
  assert.equal(cohortIdentity(ELLA), "login:ella-dev");
  assert.equal(cohortIdentity({}), null);
  assert.equal(cohortIdentity(null), null);
});

test("cohortStudents narrows the roster, and returns all of it when nothing is named", () => {
  const a = { cohort: ["num:0123456", "num:0123458"] };
  assert.deepEqual(cohortStudents(a, ROSTER).map((s) => s.full_name), ["Alice", "Cara"]);
  assert.equal(cohortStudents({}, ROSTER).length, 4);
  assert.deepEqual(cohortStudents(a, null), []);
  // Accepts a bare array as well as a roster document.
  assert.equal(cohortStudents(a, ROSTER.students).length, 2);
});

test("a cohort entry matching nobody is reported, not silently dropped", () => {
  // A student removed from the roster leaves their identity in the assignment.
  // The cohort is a record, so it is not corrected - but a surface showing
  // "22 selected" over 20 rows has to be able to say why.
  const a = { cohort: ["num:0123456", "num:9999999", "login:ghost"] };
  assert.deepEqual(danglingCohortEntries(a, ROSTER), ["num:9999999", "login:ghost"]);
  assert.deepEqual(danglingCohortEntries({}, ROSTER), [], "nothing named, nothing dangling");
  assert.equal(cohortStudents(a, ROSTER).length, 1, "and the rows that do match still resolve");
});

test("duplicate and differently-spelled entries collapse", () => {
  const a = { cohort: ["login:Alice-Dev", "login:alice-dev", " num:0123456 ", "num:0123456"] };
  assert.equal(assignmentCohort(a).size, 2);
});

test("a malformed roster row is refused, never admitted by accident", () => {
  const a = { cohort: ["num:0123456"] };
  for (const row of [null, undefined, {}, { student_number: "" }, { github_login: null }, "alice"]) {
    assert.equal(assignmentAdmitsStudent(a, row), false, JSON.stringify(row));
  }
  assert.deepEqual(rosterIdentities("alice"), []);
});
