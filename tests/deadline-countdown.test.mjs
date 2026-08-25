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

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { countdownParts, formatDeadlineCountdown } from "../frontend/src/lib/countdown.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// --- one implementation, everywhere -----------------------------------------

test("nothing re-implements the countdown instead of importing it", () => {
  // Same guard tests/effective-deadline.test.mjs puts on the extension rule
  // and tests/rate-limit.test.mjs on the retry policy. Two copies of this
  // existed and drifted only because neither had changed yet; a third was
  // about to be written for the cohort card.
  const walk = (dir, out = []) => {
    for (const entry of readdirSync(dir)) {
      // `.claude` holds git worktrees - a full second checkout of this repo.
      // Walking into one finds a copy of every module and reports it as a fork,
      // so the suite goes red because a sibling checkout exists.
      if (entry === "node_modules" || entry === "dist" || entry === ".git" || entry === ".tools" || entry === ".claude") continue;
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.(mjs|js|vue)$/.test(entry)) out.push(p);
    }
    return out;
  };

  const allowed = new Set([join(root, "frontend", "src", "lib", "countdown.js")]);
  const offenders = walk(root)
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
