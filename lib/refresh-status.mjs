// What a Refresh says about one student's row before the next report rebuild:
// whether the commit it just read is on time, late, or no submission at all.
//
// The report decides from observations (report/report.mjs); Refresh writes an
// observation too (lib/observation.mjs), so the rebuild a minute later agrees
// with this - it only has to say the same thing in the meantime. It judged by
// the moment Refresh was pressed once, which read a commit made before the
// deadline as late on any Refresh after it (review 2026-10-14). It is the
// commit's own time, as the report judges it; `observed_at` is when somebody
// looked (CLAUDE.md). Moved out of the page so it can be tested (TG-6).
//
// AND THE SAME RULE, NOT A SECOND SPELLING OF IT (review 2026-10-15, R6-14):
// this kept "on time" for an on-time commit followed by a late one, which the
// report calls late; both ask lib/submission-status.mjs now, with what each
// knows. Refresh never runs on a locked row, so a preserved snapshot does not
// come into it.

import { classifySubmission } from "./submission-status.mjs";

/**
 * @param {object} a
 * @param {boolean} a.unstarted        the branch holds only what it was given (lib/starter-commit.mjs `unstartedRepo`)
 * @param {string|null} a.sha          the commit just read
 * @param {string|null} a.committedAt  its committer date (or author date), as GitHub returns it
 * @param {string|null} a.deadline     this student's deadline (their extension, or the assignment's)
 * @param {{ submission_status?: string|null, last_on_time_sha?: string|null, first_late_sha?: string|null }} a.row  the row as it stands
 * @param {number} [a.now]             when Refresh ran: only for a commit whose date cannot be read
 * @returns {{ submission_status: string, last_on_time_sha?: string, first_late_sha?: string }} the fields to set
 */
export function refreshStatus({ unstarted, sha, committedAt, deadline, row = {}, now = Date.now() }) {
  if (unstarted) return { submission_status: "no-submission" };
  const due = Date.parse(deadline ?? "");
  if (!Number.isFinite(due)) return { submission_status: "unknown" };
  const at = Date.parse(committedAt ?? "");
  const onTime = (Number.isFinite(at) ? at : now) <= due;
  const lastOnTimeSha = onTime ? sha : row.last_on_time_sha || null;
  const firstLateSha = onTime ? row.first_late_sha || null : row.first_late_sha || sha;
  const submission_status = classifySubmission({
    unstarted: false,
    lastOnTimeSha,
    // The report's one boolean: a late commit that is not the on-time one.
    hasLateActivity: Boolean(firstLateSha) && firstLateSha !== lastOnTimeSha,
    latestObservedSha: sha,
    hasDeadline: true,
  });
  return onTime
    ? { submission_status, last_on_time_sha: sha }
    : { submission_status, first_late_sha: firstLateSha };
}
