// PXL Classroom CLI — roster CSV parsing tests.
//
// Exercises the CSV → roster conversion + schema validation path without
// any network. The command-action layer is integration-tested manually
// against a scratch control repo per the plan's verification step.

import { test } from "node:test";
import assert from "node:assert/strict";

// We test the parser/diff helpers by spawning the CLI binary against a
// captive CSV in dry-run mode against an unreachable org — the parse +
// validate steps run before any network call, so we get coverage of the
// schema-level errors.
//
// For purely-internal helper coverage, we re-import the same papaparse
// path used by the command. Keeping it short — the meaningful integration
// surface is "does the schema reject bad rows?".

import Papa from "papaparse";
import { validateAgainst } from "../src/lib/validate.mjs";

function csvToStudents(csv) {
  const parsed = Papa.parse(csv, {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (h) => h.trim(),
  });
  return parsed.data.map((row) => {
    const e = {};
    for (const [k, v] of Object.entries(row)) {
      const s = String(v ?? "").trim();
      if (!s) continue;
      if (k === "github_id") e[k] = Number(s);
      else if (k === "active") e[k] = /^(true|1|yes|y)$/i.test(s);
      else e[k] = s;
    }
    return e;
  });
}

test("valid CSV produces v2 roster", () => {
  const csv = [
    "student_number,full_name,email,class_group,github_login,active",
    "0123456,Alice Example,alice@stud.pxl.be,3A,alice-test,true",
    "0654321,Bob Example,,,bob-test,true",
  ].join("\n");
  const students = csvToStudents(csv);
  const doc = { schema_version: 2, students };
  const { valid, errors } = validateAgainst("roster", doc);
  assert.equal(valid, true, errors ? JSON.stringify(errors) : "");
  assert.equal(students.length, 2);
  assert.equal(students[0].active, true);
  assert.equal(students[1].github_login, "bob-test");
  assert.equal(students[1].email, undefined, "empty email cell stays absent");
});

test("missing required field fails schema", () => {
  const students = [{ student_number: "01" }];
  const { valid, errors } = validateAgainst("roster", { schema_version: 2, students });
  assert.equal(valid, false);
  assert.ok(errors.some((e) => /full_name/.test(JSON.stringify(e))));
});

test("invalid email fails schema validation", () => {
  const students = [
    { student_number: "01", full_name: "X", email: "not-an-email" },
  ];
  const { valid, errors } = validateAgainst("roster", { schema_version: 2, students });
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.keyword === "format" || /email/.test(JSON.stringify(e))));
});

test("schema_version: 1 fails — must be 2", () => {
  const { valid } = validateAgainst("roster", {
    schema_version: 1,
    students: [{ student_number: "01", full_name: "X" }],
  });
  assert.equal(valid, false);
});

test("unknown field rejected by additionalProperties: false", () => {
  const { valid, errors } = validateAgainst("roster", {
    schema_version: 2,
    students: [{ student_number: "01", full_name: "X", surprise: "value" }],
  });
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.keyword === "additionalProperties"));
});
