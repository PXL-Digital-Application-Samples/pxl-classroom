import test from "node:test";
import assert from "node:assert/strict";

import { academicYearLabel, parseAcademicYearStart } from "../lib/academic-year.mjs";
import { ACADEMIC_YEAR_START } from "../lib/deployment.mjs";

const SEP15 = "09-15";

// --------------------------------------------------------------- the start

test("a start date parses to a month and a day", () => {
  assert.deepEqual(parseAcademicYearStart("09-15"), { month: 9, day: 15 });
  assert.deepEqual(parseAcademicYearStart("1-1"), { month: 1, day: 1 });
  assert.deepEqual(parseAcademicYearStart(" 09-15 "), { month: 9, day: 15 });
});

test("a start that is not a date yields null, never a default", () => {
  // A silent fallback to 1 September would be a boundary nobody configured,
  // and the refusal reads perfectly well with no year at all.
  for (const bad of ["", "9", "09", "09/15", "2026-09-15", "sept-15", null, undefined, 9, {}]) {
    assert.equal(parseAcademicYearStart(bad), null, JSON.stringify(bad));
  }
});

test("a day that does not exist in its month is refused", () => {
  // "02-31" is a boundary that is nothing. Two separate fields is how a
  // deployment gets there, which is why there is one.
  assert.equal(parseAcademicYearStart("02-30"), null);
  assert.equal(parseAcademicYearStart("04-31"), null);
  assert.equal(parseAcademicYearStart("13-01"), null);
  assert.equal(parseAcademicYearStart("00-01"), null);
  assert.equal(parseAcademicYearStart("09-00"), null);
  assert.equal(parseAcademicYearStart("09-32"), null);
});

test("29 February is allowed, because the boundary is a month and a day", () => {
  // It is compared against a (month, day), never resolved to a real date in a
  // real year - so in a non-leap year the year simply turns on 1 March.
  // Refusing it would reject a legal configuration to guard against nothing.
  assert.deepEqual(parseAcademicYearStart("02-29"), { month: 2, day: 29 });
  assert.equal(academicYearLabel("2027-02-28T00:00:00Z", "02-29"), "2627");
  assert.equal(academicYearLabel("2027-03-01T00:00:00Z", "02-29"), "2728");
});

// --------------------------------------------------------------- the label

test("THE DAY IS THE POINT: 14 September is last year, 15 September is this one", () => {
  // PXL teaches from the 15th, so an assignment opening on the 8th is the 2526
  // resit and not the 2627 course - and a resit is exactly the assignment most
  // likely to reuse a name and meet the collision refusal. A month-granular
  // boundary put the whole first fortnight in the wrong year.
  assert.equal(academicYearLabel("2026-09-08T09:00:00Z", SEP15), "2526");
  assert.equal(academicYearLabel("2026-09-14T23:59:59Z", SEP15), "2526");
  assert.equal(academicYearLabel("2026-09-15T00:00:00Z", SEP15), "2627");
  assert.equal(academicYearLabel("2026-09-21T06:00:00Z", SEP15), "2627");
});

test("a date after New Year is still the same academic year", () => {
  // The whole reason the label is two years: January 2027 is 2627, not 2728.
  assert.equal(academicYearLabel("2027-01-01T00:00:00Z", SEP15), "2627");
  assert.equal(academicYearLabel("2027-09-14T23:59:59Z", SEP15), "2627");
  assert.equal(academicYearLabel("2027-09-15T00:00:00Z", SEP15), "2728");
});

test("a month before the start month is always the previous year", () => {
  assert.equal(academicYearLabel("2026-06-01T00:00:00Z", SEP15), "2526");
  assert.equal(academicYearLabel("2026-08-31T23:59:59Z", SEP15), "2526");
});

test("the start is configuration, not September the fifteenth", () => {
  // A deployment whose year turns in August, or in January, or mid-month.
  assert.equal(academicYearLabel("2026-08-15T00:00:00Z", "08-01"), "2627");
  assert.equal(academicYearLabel("2026-07-31T00:00:00Z", "08-01"), "2526");
  assert.equal(academicYearLabel("2026-01-01T00:00:00Z", "01-01"), "2627");
  assert.equal(academicYearLabel("2025-12-31T00:00:00Z", "01-01"), "2526");
  assert.equal(academicYearLabel("2026-10-05T00:00:00Z", "10-06"), "2526");
  assert.equal(academicYearLabel("2026-10-06T00:00:00Z", "10-06"), "2627");
});

test("the label is read in UTC, the same instant opens_at stores", () => {
  // Pinned rather than argued: nothing real turns on the hours, since a
  // teaching year starts weeks from any date a lecturer picks.
  assert.equal(academicYearLabel("2026-09-15T00:30:00Z", SEP15), "2627");
  assert.equal(academicYearLabel("2026-09-14T22:30:00Z", SEP15), "2526");
});

test("a century boundary keeps two digits each", () => {
  assert.equal(academicYearLabel("2099-09-15T00:00:00Z", SEP15), "9900");
  assert.equal(academicYearLabel("2100-01-01T00:00:00Z", SEP15), "9900");
});

test("a Date object works as well as a string, and so does a parsed start", () => {
  assert.equal(academicYearLabel(new Date("2026-09-21T06:00:00Z"), SEP15), "2627");
  assert.equal(academicYearLabel("2026-09-21T06:00:00Z", { month: 9, day: 15 }), "2627");
});

test("junk yields null rather than a wrong year", () => {
  assert.equal(academicYearLabel("not a date", SEP15), null);
  assert.equal(academicYearLabel(null, SEP15), null);
  assert.equal(academicYearLabel(undefined, SEP15), null);
  assert.equal(academicYearLabel("", SEP15), null);
});

test("an unusable START yields null too - no year beats a wrong one", () => {
  assert.equal(academicYearLabel("2026-09-21T06:00:00Z", "02-30"), null);
  assert.equal(academicYearLabel("2026-09-21T06:00:00Z", "nonsense"), null);
  assert.equal(academicYearLabel("2026-09-21T06:00:00Z", null), null);
  assert.equal(academicYearLabel("2026-09-21T06:00:00Z", undefined), null);
  assert.equal(academicYearLabel("2026-09-21T06:00:00Z", 9), null);
  assert.equal(academicYearLabel("2026-09-21T06:00:00Z", { month: 2, day: 30 }), null);
  assert.equal(academicYearLabel("2026-09-21T06:00:00Z", {}), null);
});

test("THIS deployment starts on 15 September, and the value is usable", () => {
  // deployment.yml is the configuration and this is the check that it says
  // something this module can act on - the alternative is a refusal that
  // silently stops offering a year because of a typo nobody sees.
  assert.deepEqual(parseAcademicYearStart(ACADEMIC_YEAR_START), { month: 9, day: 15 });
  assert.equal(academicYearLabel("2026-09-14T00:00:00Z", ACADEMIC_YEAR_START), "2526");
  assert.equal(academicYearLabel("2026-09-15T00:00:00Z", ACADEMIC_YEAR_START), "2627");
});
