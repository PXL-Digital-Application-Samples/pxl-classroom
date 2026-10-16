// What a row of the lock record says about one student, asked one way
// everywhere (review 2026-10-16, R7-24).
//
// "Already locked" was spelled three ways: a snapshot alone (planTargets'
// deferral guard, the re-lock check), a snapshot, an unread snapshot or a
// verified no-submission (the lock time), and a locking method (the extension
// toast). So a student locked with nothing handed in was deferred and released
// by a later stop while the record still said locked, a re-locked row drifted
// every pass, and a re-locked student given more time was released again.
//
// Isomorphic, no imports: lockdown, the finalize queue, acceptance and the SPA
// read the same rows.

/**
 * Whether a pass already took this student's submission: a snapshot, a
 * snapshot it could not read (locked all the same), or nothing handed in,
 * verified. Its lock time and its delay figure are history from then on.
 *
 * @param {{snapshot_sha?: string|null, snapshot_unread?: unknown, no_submission?: boolean, verified?: boolean}|null|undefined} row
 */
export function lockTaken(row) {
  return Boolean(row?.snapshot_sha || row?.snapshot_unread || (row?.no_submission && row?.verified));
}

/**
 * The deadline a reopen ENDS at, or null (review 2026-10-16, R7-3): the
 * deadline in force for the reopened repository when it is later than the
 * reopen - the deadline moved later, or an extension granted. A reopen made
 * after the deadline in force has no end: it stays open until Lock again.
 *
 * @param {{unlocked_at?: string|null}|null|undefined} reopen the reopen record
 * @param {Date|null|undefined} deadline the deadline in force for that repository
 * @returns {Date|null}
 */
export function reopenEndsAt(reopen, deadline) {
  const at = Date.parse(reopen?.unlocked_at ?? "");
  if (!Number.isFinite(at) || !(deadline instanceof Date) || Number.isNaN(deadline.getTime())) return null;
  return deadline.getTime() > at ? deadline : null;
}

/**
 * Whether a lock made AFTER this reopen holds the row: the re-lock at the
 * reopen's end has happened, and from then on it is a lock like any other -
 * frozen, and not released by more time.
 *
 * @param {{lockdown_at?: string|null, reopened_at?: string|null, snapshot_sha?: string|null, snapshot_unread?: unknown, no_submission?: boolean, verified?: boolean}|null|undefined} row
 * @param {{unlocked_at?: string|null}|null|undefined} reopen
 */
export function lockedSinceReopen(row, reopen) {
  if (!lockTaken(row) || row?.reopened_at) return false;
  return Date.parse(row?.lockdown_at ?? "") > Date.parse(reopen?.unlocked_at ?? "");
}
