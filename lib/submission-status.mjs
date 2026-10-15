// On time, late or no submission: ONE rule for the report and Refresh.
//
// The report (report/report.mjs) decided from its observations, and Refresh
// (lib/refresh-status.mjs) re-spelled the decision for the minute before the
// next rebuild - and spelled it differently: an on-time commit followed by a
// late one was "late" in the report and "on time" on screen until the rebuild
// put it back (review 2026-10-15, R6-14). Under `late_policy: report` late
// commits are part of the submission, so late activity after an on-time commit
// IS a late submission; under `block` a preserved snapshot settles it as on
// time, and the report says so before anything else.
//
// Isomorphic, no imports.

/**
 * @param {object} a
 * @param {boolean} [a.hadRepository]      a record or a preservation says a repository was given
 * @param {boolean} a.unstarted            still only what it was given (lib/starter-commit.mjs)
 * @param {string|null} [a.preservedOnTimeSha]  under `block`, the verified preserved snapshot
 * @param {boolean} [a.reconstructedNothing]   under `block`, the lock found nothing committed by the deadline
 * @param {string|null} a.lastOnTimeSha    the newest commit seen at or before the deadline
 * @param {boolean} a.hasLateActivity      a commit after the deadline that is not that one
 * @param {string|null} a.latestObservedSha
 * @param {boolean} a.hasDeadline          whether this student has a deadline at all
 * @returns {"no-submission"|"on-time"|"late"|"unknown"}
 */
export function classifySubmission({
  hadRepository = true, unstarted, preservedOnTimeSha = null, reconstructedNothing = false,
  lastOnTimeSha, hasLateActivity, latestObservedSha, hasDeadline,
}) {
  if (!hadRepository || unstarted) return "no-submission";
  if (preservedOnTimeSha) return "on-time";
  if (reconstructedNothing) return "no-submission";
  if (lastOnTimeSha) return hasLateActivity ? "late" : "on-time";
  if (latestObservedSha) return hasDeadline ? "late" : "unknown";
  return "no-submission";
}
