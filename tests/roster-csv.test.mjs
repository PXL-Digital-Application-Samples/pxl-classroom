// One CSV rule, two importers.
//
// `pxl-classroom roster import` and the Admin Panel's Roster tab each had a
// byte-for-byte copy of this, in cli/src/commands/roster.mjs and
// frontend/src/lib/csv.js - the SAME TWO FILES where `diffRosters` had already
// forked and disagreed about key order, showing every student as "updated" in
// one surface and unchanged in the other.
//
// The copies had not yet diverged in behaviour, only in error-message casing,
// which is exactly when to merge them: a roster imported through the CLI and
// the same file imported through the SPA must produce the identical document,
// or the two surfaces disagree about who is on a course. A roster import
// REPLACES the file wholesale, so that disagreement is not cosmetic.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  KNOWN_COLUMNS,
  REQUIRED_COLUMNS,
  coerceCell,
  rowsToRoster,
} from "../lib/roster-csv.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const HEADERS = ["student_number", "full_name", "email", "github_login"];
const rows = (...r) => r;

test("an empty cell is ABSENT, not an empty string", () => {
  // The roster schema distinguishes the two, and an empty github_login would
  // count as a linked student to anything counting them - which is what the
  // Admin Panel's "none has a GitHub username yet" warning reads.
  const doc = rowsToRoster(
    rows({ student_number: "1", full_name: "A", email: "", github_login: "   " }),
    HEADERS,
  );
  assert.deepEqual(doc.students[0], { student_number: "1", full_name: "A" });
  assert.ok(!("email" in doc.students[0]));
  assert.ok(!("github_login" in doc.students[0]));
});

test("github_id must be an integer and active must be boolean-ish", () => {
  assert.equal(coerceCell("github_id", " 42 "), 42);
  assert.throws(() => coerceCell("github_id", "4.5"), /must be an integer/);
  assert.throws(() => coerceCell("github_id", "abc"), /must be an integer/);

  for (const yes of ["true", "1", "YES", "y"]) assert.equal(coerceCell("active", yes), true);
  for (const no of ["false", "0", "No", "n"]) assert.equal(coerceCell("active", no), false);
  assert.throws(() => coerceCell("active", "maybe"), /boolean-ish/);
});

test("an unknown column is refused, never ignored", () => {
  // Ignoring it would silently drop data a lecturer put in the file on purpose.
  assert.throws(
    () => rowsToRoster(rows({ student_number: "1", full_name: "A" }), [...HEADERS, "nickname"]),
    /unknown column\(s\): nickname/,
  );
});

test("the filename appears only when the caller has one", () => {
  // The CLI reads a path and can name it; the SPA takes a paste and cannot.
  assert.throws(
    () => rowsToRoster(rows(), [...HEADERS, "x"], { filename: "roster.csv" }),
    /unknown column\(s\) in roster\.csv/,
  );
  assert.throws(() => rowsToRoster(rows(), [...HEADERS, "x"]), /unknown column\(s\): x/);
});

test("required columns and required values are both enforced, by line", () => {
  assert.throws(() => rowsToRoster(rows(), ["full_name"]), /required CSV column missing: student_number/);

  // Line numbers are what the lecturer sees in their spreadsheet: header is 1.
  assert.throws(
    () => rowsToRoster(rows({ student_number: "1", full_name: "" }), HEADERS),
    /line 2: full_name is required/,
  );
  assert.throws(
    () => rowsToRoster(
      rows({ student_number: "1", full_name: "A" }, { student_number: "", full_name: "B" }),
      HEADERS,
    ),
    /line 3: student_number is required/,
  );
});

test("a duplicate student_number is refused with the line that repeats it", () => {
  assert.throws(
    () => rowsToRoster(
      rows(
        { student_number: "1", full_name: "A" },
        { student_number: "2", full_name: "B" },
        { student_number: "1", full_name: "C" },
      ),
      HEADERS,
    ),
    /line 4: duplicate student_number "1"/,
  );
});

test("github_login is NOT required - it is the column claim exists to avoid needing", () => {
  assert.ok(!REQUIRED_COLUMNS.includes("github_login"));
  assert.ok(KNOWN_COLUMNS.includes("github_login"));
  const doc = rowsToRoster(
    rows({ student_number: "1", full_name: "A", email: "a@student.pxl.be" }),
    ["student_number", "full_name", "email"],
  );
  assert.equal(doc.students[0].email, "a@student.pxl.be");
});

test("neither importer parses CSV into a roster itself any more", () => {
  // The guard against re-forking, the same one tests/promote-roster.test.mjs
  // puts on diffRosters. Comments are stripped because both files now quote the
  // old arrangement while explaining why it changed.
  const strip = (s) =>
    s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  for (const rel of ["cli/src/commands/roster.mjs", "frontend/src/lib/csv.js"]) {
    const code = strip(readFileSync(join(root, rel), "utf8"));
    assert.ok(
      /rowsToRoster\s*\(/.test(code),
      `${rel} must build the roster through lib/roster-csv.mjs`,
    );
    assert.ok(
      !/function\s+coerceCell\s*\(/.test(code),
      `${rel} re-implements coerceCell - that is the fork this module closed`,
    );
    assert.ok(
      !/KNOWN_COLUMNS\s*=\s*new Set/.test(code),
      `${rel} declares its own column list - the two would drift apart`,
    );
  }
});
