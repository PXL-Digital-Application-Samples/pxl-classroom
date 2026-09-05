import test from "node:test";
import assert from "node:assert/strict";

import { academicYearLabel } from "../lib/academic-year.mjs";
import { ACADEMIC_YEAR_START_MONTH } from "../lib/deployment.mjs";

const SEP = 9;

test("a date in the first half of the year takes the label that starts there", () => {
  assert.equal(academicYearLabel("2026-09-21T06:00:00Z", SEP), "2627");
  assert.equal(academicYearLabel("2026-12-31T23:59:59Z", SEP), "2627");
});

test("a date after New Year is still the same academic year", () => {
  // The whole reason the label is two years: January 2027 is 2627, not 2728.
  assert.equal(academicYearLabel("2027-01-01T00:00:00Z", SEP), "2627");
  assert.equal(academicYearLabel("2027-08-31T23:59:59Z", SEP), "2627");
});

test("the boundary is the first instant of the start month, not the last of the one before", () => {
  assert.equal(academicYearLabel("2026-08-31T23:59:59Z", SEP), "2526");
  assert.equal(academicYearLabel("2026-09-01T00:00:00Z", SEP), "2627");
});

test("the boundary is configuration, not September", () => {
  // A deployment whose year turns in August, or in January.
  assert.equal(academicYearLabel("2026-08-15T00:00:00Z", 8), "2627");
  assert.equal(academicYearLabel("2026-08-15T00:00:00Z", 1), "2627");
  assert.equal(academicYearLabel("2026-01-01T00:00:00Z", 1), "2627");
  assert.equal(academicYearLabel("2025-12-31T00:00:00Z", 1), "2526");
});

test("the label is read in UTC, so a browser's timezone cannot move it", () => {
  // An assignment opening at 00:30 UTC on 1 September is in the new year
  // wherever the lecturer is sitting. Local-time getters would put a browser
  // at UTC-2 in the previous one.
  assert.equal(academicYearLabel("2026-09-01T00:30:00Z", SEP), "2627");
  assert.equal(academicYearLabel("2026-08-31T22:30:00Z", SEP), "2526");
});

test("a century boundary keeps two digits each", () => {
  assert.equal(academicYearLabel("2099-09-01T00:00:00Z", SEP), "9900");
  assert.equal(academicYearLabel("2100-01-01T00:00:00Z", SEP), "9900");
});

test("a Date object works as well as a string", () => {
  assert.equal(academicYearLabel(new Date("2026-09-21T06:00:00Z"), SEP), "2627");
});

test("junk yields null rather than a wrong year", () => {
  assert.equal(academicYearLabel("not a date", SEP), null);
  assert.equal(academicYearLabel(null, SEP), null);
  assert.equal(academicYearLabel(undefined, SEP), null);
  assert.equal(academicYearLabel("2026-09-01T00:00:00Z", 0), null);
  assert.equal(academicYearLabel("2026-09-01T00:00:00Z", 13), null);
  assert.equal(academicYearLabel("2026-09-01T00:00:00Z", "September"), null);
  assert.equal(academicYearLabel("2026-09-01T00:00:00Z", undefined), null);
});

test("the deployment's configured month is a usable month", () => {
  // The suggestion is the only thing that reads it, and a broken value would
  // silently produce no suggestion rather than an error.
  assert.ok(Number.isInteger(ACADEMIC_YEAR_START_MONTH));
  assert.ok(ACADEMIC_YEAR_START_MONTH >= 1 && ACADEMIC_YEAR_START_MONTH <= 12);
  assert.equal(academicYearLabel("2026-09-21T06:00:00Z", ACADEMIC_YEAR_START_MONTH), "2627");
});
