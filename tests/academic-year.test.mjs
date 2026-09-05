import test from "node:test";
import assert from "node:assert/strict";

import { academicYearLabel, withAcademicYear } from "../lib/academic-year.mjs";
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

// ------------------------------------------------------------ the prefixing

test("the year goes on the front", () => {
  assert.equal(withAcademicYear("lab-3", "2627"), "2627-lab-3");
});

test("reaching for it twice does not stack years", () => {
  // A lecturer refused once, who prefixes, is refused again for another
  // reason and prefixes again, must not end up with 2627-2526-lab-3.
  assert.equal(withAcademicYear("2526-lab-3", "2627"), "2627-lab-3");
  assert.equal(withAcademicYear("2627-lab-3", "2627"), "2627-lab-3");
});

test("a four-digit calendar year at the front is NOT a year label and stays", () => {
  // `2026-report` is somebody's assignment name. Stripping it would rename
  // their assignment behind their back. Only a consecutive pair counts.
  assert.equal(withAcademicYear("2026-report", "2627"), "2627-2026-report");
  assert.equal(withAcademicYear("1999-retro", "2627"), "2627-1999-retro");
});

test("a leading label with nothing after it is left alone", () => {
  // `2526-` is not `<year>-<id>`, it is an id. There is no id to keep.
  assert.equal(withAcademicYear("2526-", "2627"), "2627-2526-");
});

test("junk yields null rather than a broken name", () => {
  assert.equal(withAcademicYear("", "2627"), null);
  assert.equal(withAcademicYear("   ", "2627"), null);
  assert.equal(withAcademicYear(null, "2627"), null);
  assert.equal(withAcademicYear("lab-3", "26"), null);
  assert.equal(withAcademicYear("lab-3", "twenty"), null);
  assert.equal(withAcademicYear("lab-3", null), null);
});

test("the suggestion is a valid assignment slug", () => {
  // The form refuses anything that is not /^[a-z0-9][a-z0-9-]{0,99}$/, so a
  // recommendation it would then reject is worse than no recommendation.
  const slug = /^[a-z0-9][a-z0-9-]{0,99}$/;
  for (const id of ["lab-3", "linux-processes", "exam2026", "2526-lab-3"]) {
    assert.match(withAcademicYear(id, "2627"), slug, id);
  }
});
