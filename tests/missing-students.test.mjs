// frontend/src/lib/missing-students.js and lib/cohort.mjs cohortWithoutLogin:
// the students the Progress tab lists although the report cannot.

import { test } from "node:test";
import assert from "node:assert/strict";
import { cohortWithoutLogin } from "../lib/cohort.mjs";
import { studentsMissingFromReport, studentRowKey } from "../frontend/src/lib/missing-students.js";

const roster = [
  { student_number: "1", full_name: "Ann", github_login: "ann", email: "ann@pxl.be" },
  { student_number: "2", full_name: "Kobe", email: "kobe@pxl.be" },
  { student_number: "3", full_name: "Lotte", email: "lotte@pxl.be", class_group: "B" },
  { student_number: "4", full_name: "Other Year", email: "old@pxl.be" },
];
const enforced = { roster_mode: "enforced", cohort: ["num:1", "num:2", "num:3"] };

test("cohortWithoutLogin: the admitted rows with no username, never another section's", () => {
  assert.deepEqual(cohortWithoutLogin(enforced, roster).map((r) => r.full_name), ["Kobe", "Lotte"]);
  assert.deepEqual(cohortWithoutLogin({ roster_mode: "claim" }, roster).map((r) => r.full_name), ["Kobe", "Lotte", "Other Year"]);
});

test("cohortWithoutLogin: under open enrolment nobody on the roster is missing from anything", () => {
  assert.deepEqual(cohortWithoutLogin({ roster_mode: "open" }, roster), []);
});

test("cohortWithoutLogin: a blank username is no username", () => {
  assert.equal(cohortWithoutLogin({ roster_mode: "enforced" }, [{ full_name: "X", github_login: "  " }]).length, 1);
});

test("the missing rows are display rows: not accepted, no submission, no username", () => {
  const rows = studentsMissingFromReport({ assignment: enforced, roster, students: [{ github_login: "ann" }] });
  assert.deepEqual(rows.map((r) => [r.full_name, r.email, r.github_login, r.acceptance_state, r.submission_status, r.missing_from_report]), [
    ["Kobe", "kobe@pxl.be", "", "not-accepted", "no-submission", true],
    ["Lotte", "lotte@pxl.be", "", "not-accepted", "no-submission", true],
  ]);
  assert.equal(rows[1].class_group, "B");
});

test("a student the report lists through a confirmation is not listed twice", () => {
  const loginFor = (row) => (row.email === "kobe@pxl.be" ? "Kobe-GH" : null);
  const rows = studentsMissingFromReport({
    assignment: enforced, roster, loginFor,
    students: [{ github_login: "ann" }, { github_login: "kobe-gh" }],
  });
  assert.deepEqual(rows.map((r) => r.full_name), ["Lotte"]);
});

test("a confirmed student the report does not list yet keeps their username", () => {
  const loginFor = (row) => (row.email === "kobe@pxl.be" ? "kobe-gh" : null);
  const rows = studentsMissingFromReport({ assignment: enforced, roster, loginFor, students: [] });
  assert.equal(rows[0].github_login, "kobe-gh");
});

test("an address the report already shows as confirmed is the same student", () => {
  const rows = studentsMissingFromReport({
    assignment: enforced, roster,
    students: [{ github_login: "someone", claimed_email: "LOTTE@pxl.be" }],
  });
  assert.deepEqual(rows.map((r) => r.full_name), ["Kobe"]);
});

test("rows without a username still have distinct keys", () => {
  const rows = studentsMissingFromReport({ assignment: enforced, roster, students: [] });
  const keys = rows.map(studentRowKey);
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(studentRowKey({ github_login: "ann" }), "ann");
});
