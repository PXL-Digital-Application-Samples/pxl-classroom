// What a submission status MEANS, in words, for the row it sits on.
//
// THIS EXISTS BECAUSE THE LABEL ALONE COULD NOT BE CHECKED.
//
// `submission_status` is one word - `late`, `on-time`, `no-submission` - and a
// lecturer has no way to tell whether it is right. On a finished exam two
// students read `late` whose last commits were 6h50m and 54m BEFORE the
// deadline (PXL-Automation-II/2526-examen-aut2-ek2, 2026-09-02), and nothing on
// screen contradicted it. A tooltip reading "Last commit 6h 49m before the
// deadline" on a row labelled Late is the check that would have caught it the
// day it shipped rather than after an exam.
//
// It lives beside `countdown.js` and DELEGATES the duration to it. The first
// draft of this module formatted its own "6h 50m" and
// tests/deadline-countdown.test.mjs failed it immediately - that guard exists
// because the countdown had already been copied twice. One formatter.
//
// Dependency-free and parameterised for the same reason countdown.js is: so a
// test can run it rather than describe it.

import { countdownParts } from './countdown.js'

/**
 * The sentence behind a submission status.
 *
 * Returns "" when there is nothing truthful to say - no deadline, or no commit
 * observed - because an empty tooltip beats a confident one built from absent
 * data.
 *
 * `lateCommitCount` of `null` means NOT KNOWN (an assignment collected before
 * the field existed, or a count GitHub would not answer) and is deliberately
 * different from `0`, which means none. A report that could not count must not
 * say "No commits after the deadline" - unreadable is not evidence.
 *
 * @param {{deadline?: string|Date|null, latestCommitDate?: string|Date|null,
 *          lateCommitCount?: number|null}} row
 * @returns {string}
 */
export function describeSubmission({ deadline, latestCommitDate, lateCommitCount } = {}) {
  const parts = []

  // countdownParts(at, now) measures `at` from `now`, so passing the COMMIT as
  // `at` and the DEADLINE as `now` yields the distance between them - and its
  // `passed` flag (diff <= 0) then means the commit landed at or before the
  // deadline, which is exactly on-time.
  const span = deadline && latestCommitDate ? countdownParts(latestCommitDate, new Date(deadline)) : null
  if (span) {
    parts.push(
      span.passed
        ? `Last commit ${span.duration} before the deadline.`
        : `Last commit ${span.duration} after the deadline.`
    )
  }

  if (typeof lateCommitCount === 'number') {
    parts.push(
      lateCommitCount === 0
        ? 'No commits after the deadline.'
        : `${lateCommitCount} commit${lateCommitCount === 1 ? '' : 's'} after the deadline.`
    )
  }

  return parts.join(' ')
}
