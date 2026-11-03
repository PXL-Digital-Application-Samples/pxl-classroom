// The countdown had two byte-identical copies (AssignmentView and
// GroupAcceptanceCard) before WS5 needed a third for the Admin Panel's cohort
// card. One implementation now, in frontend/src/lib/format.js - the same rule
// CLAUDE.md applies to lib/effective-deadline.mjs and lib/invite-token-format.mjs.
//
// The two audiences read the same number differently: a student is told the
// window "Closes in 6d 23h", a lecturer that the deadline is "6d 23h" away, so
// the module exposes the parts and the student-facing sentence separately
// rather than one string with a verb baked in.

import { test } from "node:test";
import assert from "node:assert/strict";

import { readFileSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { countdownParts, formatDeadlineCountdown, spanBetween as spanInDays } from "../frontend/src/lib/countdown.js";
import { repoFiles } from "./repo-files.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// --- one implementation, everywhere -----------------------------------------

test("nothing re-implements the countdown instead of importing it", () => {
  // Same guard tests/effective-deadline.test.mjs puts on the extension rule
  // and tests/rate-limit.test.mjs on the retry policy. Two copies of this
  // existed and drifted only because neither had changed yet; a third was
  // about to be written for the cohort card.
  const allowed = new Set([join(root, "frontend", "src", "lib", "countdown.js")]);
  const offenders = repoFiles({ exts: [".mjs", ".js", ".vue"] })
    .filter((p) => !allowed.has(p) && !p.startsWith(join(root, "tests")))
    // The tell is the string it builds - a bare `Math.floor(diffMs / 60000)`
    // shows up in unrelated duration code, but `${...}d ${...}h` is this.
    .filter((p) => /\$\{[^}]*\}d \$\{[^}]*\}h/.test(readFileSync(p, "utf8")))
    .map((p) => relative(root, p));

  assert.deepEqual(
    offenders,
    [],
    `these format a countdown themselves instead of using frontend/src/lib/countdown.js:\n  ${offenders.join("\n  ")}`
  );
});

const NOW = new Date("2026-08-24T12:00:00.000Z");
const at = (ms) => new Date(NOW.getTime() + ms);

const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;

test("the duration truncates to the two largest units that matter", () => {
  assert.equal(countdownParts(at(6 * DAY + 23 * HOUR), NOW).duration, "6d 23h");
  assert.equal(countdownParts(at(5 * HOUR + 12 * MIN), NOW).duration, "5h 12m");
  assert.equal(countdownParts(at(42 * MIN), NOW).duration, "42m");
  // Days win over hours even when the hours round to nothing.
  assert.equal(countdownParts(at(2 * DAY), NOW).duration, "2d 0h");
});

test("a deadline in the past is a duration too, and says it has passed", () => {
  const past = countdownParts(at(-3 * DAY - 4 * HOUR), NOW);
  assert.equal(past.passed, true);
  assert.equal(past.duration, "3d 4h", "the magnitude, not a negative number");

  const future = countdownParts(at(DAY), NOW);
  assert.equal(future.passed, false);
});

test("the exact instant counts as passed", () => {
  // `diffMs <= 0`. A deadline that is exactly now has closed - the student
  // view gates an Accept button on this, and "0m left" would offer it.
  assert.equal(countdownParts(NOW, NOW).passed, true);
});

test("nothing to count is null, not a zero", () => {
  assert.equal(countdownParts(null, NOW), null);
  assert.equal(countdownParts(undefined, NOW), null);
  assert.equal(countdownParts("", NOW), null);
  assert.equal(countdownParts("not a date", NOW), null, "an unparseable value is not 'now'");
  assert.equal(formatDeadlineCountdown(null, NOW), null);
});

test("ISO strings and Date objects are both accepted", () => {
  const iso = at(3 * DAY).toISOString();
  assert.equal(countdownParts(iso, NOW).duration, countdownParts(at(3 * DAY), NOW).duration);
});

test("the student-facing sentence names the moment once it has passed", () => {
  // "3d ago" is not what a student who has just missed a hand-in needs to
  // read; the date is. Before the deadline it is the countdown.
  assert.equal(formatDeadlineCountdown(at(6 * DAY + 23 * HOUR), NOW), "Closes in 6d 23h");
  const passed = formatDeadlineCountdown(at(-2 * DAY), NOW);
  assert.match(passed, /^Deadline passed \(.+\)$/);
  assert.ok(!/ago/.test(passed), "a missed deadline is stated as a moment, not an elapsed time");
});

test("`now` is a parameter, so a ticking clock drives it", () => {
  // AssignmentView re-renders off a `now` ref every minute. A helper reaching
  // for Date.now() itself would make that ref decorative.
  const later = new Date(NOW.getTime() + 2 * HOUR);
  const deadline = at(3 * HOUR);
  assert.equal(countdownParts(deadline, NOW).duration, "3h 0m");
  assert.equal(countdownParts(deadline, later).duration, "1h 0m");
});

test("the span between two dates of the schedule, in a lecturer's units", () => {
  // Under the editor's Accept until and Deadline boxes (asked 2026-11-03):
  // whole days plainly, the remainder only where there is one.
  assert.equal(spanInDays(NOW, at(7 * DAY)), "7 days");
  assert.equal(spanInDays(NOW, at(DAY)), "1 day");
  assert.equal(spanInDays(NOW, at(7 * DAY + 6 * HOUR)), "7 days 6 hours");
  assert.equal(spanInDays(NOW, at(DAY + HOUR)), "1 day 1 hour");
  assert.equal(spanInDays(NOW, at(6 * HOUR)), "6 hours");
  assert.equal(spanInDays(NOW, at(HOUR + 30 * MIN)), "1 hour 30 minutes");
  assert.equal(spanInDays(NOW, at(45 * MIN)), "45 minutes");
  assert.equal(spanInDays(NOW, at(MIN)), "1 minute");
  // Seconds are not a unit: a box carries minutes, and the span truncates.
  assert.equal(spanInDays(NOW, at(7 * DAY + 59_000)), "7 days");
});

test("the span is nothing for a schedule that is wrong or unreadable", () => {
  assert.equal(spanInDays(NOW, NOW), null, "the same instant is no span");
  assert.equal(spanInDays(at(DAY), NOW), null, "a date before the open date is the field's error, not a span");
  assert.equal(spanInDays("", at(DAY)), null);
  assert.equal(spanInDays(NOW, ""), null);
  assert.equal(spanInDays(null, undefined), null);
  assert.equal(spanInDays("soon", at(DAY)), null);
  // Strings as a datetime-local box holds them, read alike at both ends.
  assert.equal(spanInDays("2026-11-09T09:00", "2026-11-16T09:00"), "7 days");
  assert.equal(spanInDays("2026-11-09T09:00", "2026-11-23T23:59"), "14 days 14 hours");
  assert.equal(spanInDays("2026-11-09T09:00:30", "2026-11-16T09:00:30.500"), "7 days", "seconds and milliseconds a box may carry");
});

test("two boxes are the clock on the wall, whatever summer time does between them (review 2026-11-03)", () => {
  // Europe ends summer time on 25 October 2026 and starts it on 28 March
  // 2027. Read as local time on a machine in Brussels, a week across either
  // change was "7 days 1 hour" or "6 days 23 hours". The boxes are compared
  // as the dates and times they show, on any machine, in any zone.
  assert.equal(spanInDays("2026-10-20T09:00", "2026-10-27T09:00"), "7 days");
  assert.equal(spanInDays("2027-03-25T09:00", "2027-04-01T09:00"), "7 days");
  assert.equal(spanInDays("2026-10-25T01:30", "2026-10-25T03:30"), "2 hours", "the hour that happens twice is not counted twice");
  // An instant is elapsed time: two ISO strings with a zone keep their meaning.
  assert.equal(spanInDays("2026-10-20T07:00:00Z", "2026-10-27T08:00:00Z"), "7 days 1 hour");
});
