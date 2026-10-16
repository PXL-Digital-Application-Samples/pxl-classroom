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
// Isomorphic: lockdown, the finalize queue, acceptance and the SPA read the
// same rows. Its one import is isomorphic too.

import { LOCKING_METHODS } from "./repo-unlock.mjs";

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
 * Whether a lock holds this row: one a pass took (`lockTaken`), or one a
 * lecturer put back with Lock again on a row that had none taken - a student
 * reopened with time, deferred to it, then locked again before it: a locking
 * method, verified, and not reopened (review 2026-10-16, R7-30). The second
 * kind has no snapshot yet, and read as nothing taken it was deferred by the
 * next pass and taken out of the stop the lecturer had just put back. Neither
 * kind is ever deferred or released; the second is snapshotted at the next
 * pass, which is what the repository holds since the lecturer locked it.
 *
 * @param {{snapshot_sha?: string|null, snapshot_unread?: unknown, no_submission?: boolean, verified?: boolean, lock_method?: string|null, reopened_at?: string|null}|null|undefined} row
 */
export function lockHeld(row) {
  if (lockTaken(row)) return true;
  return LOCKING_METHODS.has(row?.lock_method ?? "") && row?.verified === true && !row?.reopened_at;
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
 * @param {{lockdown_at?: string|null, reopened_at?: string|null, relocked_after?: string|null, snapshot_sha?: string|null, snapshot_unread?: unknown, no_submission?: boolean, verified?: boolean}|null|undefined} row
 * @param {{unlocked_at?: string|null}|null|undefined} reopen
 */
export function lockedSinceReopen(row, reopen) {
  if (!lockTaken(row) || row?.reopened_at) return false;
  // Re-locked for THIS reopen, whatever its lock time: under "Nothing is
  // locked" that is null, and the queue owed the reopen every night (R7-42).
  if (row?.relocked_after && row.relocked_after === reopen?.unlocked_at) return true;
  return Date.parse(row?.lockdown_at ?? "") > Date.parse(reopen?.unlocked_at ?? "");
}
