// What granting an extension does for one student, given what holds them now
// (review 2026-10-16, R7-16).
//
// The toasts said "their lock and grading use the new deadline anyway", which
// is true before the lock and false after it: a lock already taken is not
// undone by more time (RUNBOOK §3.3), and a lecturer who believed the toast
// left a student locked out of the time they had just been given.
//
//   open      nothing locked yet - not even a sentinel's stop that the lock
//             will not let go: the lock follows the new deadline.
//   locked    the deadline's lock holds them: only Reopen gives the time, and
//             a reopen with time on it ends at it (lockdown's planTargets).
//   reopened  a lecturer reopened them: they stay open until the new deadline,
//             and are locked again then.
//   unknown   the lock record or the reopen record could not be read (or was
//             still being read): said so, with what to do if they are locked.
//
// Locked is lockdown's own answer (lib/lock-rows.mjs, R7-24): a lock taken by
// a locking method, and a lock made SINCE a reopen is a lock like any other -
// called "reopened", a student locked again at the end of their reopen was
// told they would be let in by more time, which lockdown does not do.

import { lockTaken, lockedSinceReopen } from '../../../lib/lock-rows.mjs'
import { LOCKING_METHODS, lockdownRowFor } from '../../../lib/repo-unlock.mjs'

/**
 * @param {{ record?: object|null, login: string, reopen?: {unlocked_at?: string|null}|null, known?: boolean }} p
 *   `record` the lockdown record; `reopen` the reopen record, when one exists;
 *   `known` false when either could not be read, or not yet - then nothing
 *   above can be said, and "their lock follows it" read off a missing record
 *   was the sentence R7-16 removed
 * @returns {'open'|'locked'|'reopened'|'unknown'}
 */
export function extensionEffect({ record = null, login, reopen = null, known = true }) {
  if (!known) return 'unknown'
  const row = lockdownRowFor(record, login)
  if (reopen && !lockedSinceReopen(row, reopen)) return 'reopened'
  if (row && lockTaken(row) && LOCKING_METHODS.has(row.lock_method) && !row.reopened_at) return 'locked'
  return 'open'
}

/**
 * The toast, in the lecturer's words: what the extension does, then whether
 * the student's own page was told (`notTold` from the deadline variable write:
 * null told, `noRepoYet` not yet accepted, otherwise why not). `when` is the
 * new deadline as the page formats dates.
 */
export function extensionGrantedMessage({ login, when, effect, notTold = null, noRepoYet = false }) {
  const what = {
    open: `Extension granted to ${login} until ${when}; their lock and grading follow it.`,
    locked: `Extension granted to ${login}, but their repository was already locked at the deadline, and more time does not reopen it. Reopen them to let them push until ${when}; they are locked again then.`,
    reopened: `Extension granted to ${login}; their repository stays open and is locked again at ${when}.`,
    unknown: `Extension granted to ${login} until ${when}. Whether their repository is already locked could not be read: if it is, more time does not reopen it, and Reopen lets them push until then.`,
  }[effect]
  // Status moves on the nightly run or a Refresh, never at once (e2e 30).
  const progress = 'The Progress tab shows it after the next nightly run or a Refresh.'
  if (noRepoYet) return `${what} Their page shows it once they accept. ${progress}`
  if (notTold) return `${what} Their own page could not be told: ${notTold}. Open their actions to send it again.`
  return `${what} Their own page shows it. ${progress}`
}
