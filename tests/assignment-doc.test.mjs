// lib/assignment-doc.mjs, executed rather than grepped.
//
// The module was extracted from AdminView so the SPA and the tests could share
// ONE implementation - "Never re-implement the thing under test in the test.
// Import it." The test that covers it, admin-lifecycle-ui.test.mjs, reads its
// SOURCE TEXT and asserts on markers in it. That catches a delegation being
// removed; it cannot catch the function returning the wrong value.
//
// The gap has already cost something. `utcToLocalInput` returns the literal
// string `NaN-NaN-NaNTNaN:NaN` for a date it cannot parse, and that is
// LOAD-BEARING: AdminView's fieldErrors decides a deadline is unreadable with
//
//     const unreadable = (v) => Boolean(v) && Number.isNaN(new Date(v).getTime())
//
// so the NaN string is what makes the error fire and Save stay disabled on an
// assignment whose YAML says `deadline_at: soon`. A "defensive" edit returning
// "" instead removed the error and left Save enabled, silently. Only the e2e
// suite noticed, several layers away from the cause.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  localToUtc,
  utcToLocalInput,
  preserveOrLocal,
} from "../lib/assignment-doc.mjs";

test("utcToLocalInput yields a value a datetime-local input accepts", () => {
  const local = utcToLocalInput("2026-10-31T22:00:00Z");
  assert.match(local, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "no seconds, no zone - the input's own format");
});

test("an empty instant is an empty box, not a date", () => {
  // An assignment with no deadline yet must render an EMPTY field. Anything
  // else puts a date in front of a lecturer that nothing stored.
  for (const empty of ["", null, undefined]) {
    assert.equal(utcToLocalInput(empty), "");
  }
});

test("an unparseable instant stays unparseable - the NaN is load-bearing", () => {
  // NOT "" and NOT a thrown error. AdminView tests the returned string with
  // `Number.isNaN(new Date(v).getTime())` to decide whether to disable Save, so
  // this value has to keep failing that parse. Returning "" reads as "no
  // deadline set", which is a different - and permitted - state.
  const out = utcToLocalInput("soon");
  assert.notEqual(out, "", "an empty string would read as 'no deadline', and Save would be enabled");
  assert.ok(
    Number.isNaN(new Date(out).getTime()),
    `AdminView must still be able to see this as unreadable, got "${out}"`,
  );
});

test("localToUtc and utcToLocalInput round-trip an instant in this machine's zone", () => {
  // A datetime-local value has no zone: it means whatever the browser's zone
  // says. The pair has to agree, or every save shifts the stored instant.
  const local = "2026-10-31T23:59";
  const utc = localToUtc(local);
  assert.equal(utcToLocalInput(utc), local);
});

test("preserveOrLocal keeps the stored instant when the visible value has not changed", () => {
  // The reason the pair exists. A lecturer in another zone opening an
  // assignment, changing the title and saving must not move its deadline: the
  // field renders in THEIR zone, so a blind round-trip through localToUtc
  // rewrites the instant for everyone.
  const stored = "2026-10-31T22:00:00.000Z";
  const shown = utcToLocalInput(stored);
  assert.equal(preserveOrLocal(shown, stored), stored, "untouched field must return the stored bytes");
});

test("preserveOrLocal converts when the value really did change", () => {
  const stored = "2026-10-31T22:00:00.000Z";
  const edited = utcToLocalInput(stored).replace(/T\d{2}:/, "T08:");
  const out = preserveOrLocal(edited, stored);
  assert.notEqual(out, stored, "an edited field must be converted, not preserved");
  assert.equal(out, localToUtc(edited));
});

test("preserveOrLocal with nothing stored is a plain conversion", () => {
  const local = "2026-09-01T09:00";
  assert.equal(preserveOrLocal(local, null), localToUtc(local));
  assert.equal(preserveOrLocal(local, ""), localToUtc(local));
});
