// PXL Classroom - how close a deadline has to be to be worth watching.
//
// A repository ruleset has no time conditions, so stopping writes AT a
// deadline needs something running at that instant. `deadline-sentinel.yml`
// fires on a 4-hourly cron, arms a job for every deadline close enough to
// reach, and that job sleeps until the instant and locks.
//
// The window is 4.5h, and the number is forced from both sides: wider than the
// 4h cron interval, so every deadline gets a firing that can reach it, and
// narrower than the 6h GitHub job limit with margin. Cron drift therefore
// decides only whether a sentinel arms in time, never when it acts.
//
// WHY THIS IS NOT JUST A CONST IN find-armable.mjs. Arming happens on a cron,
// and a cron cannot see something that did not exist when it last fired. Two
// moments create a deadline the cron has already missed:
//
//   * publishing an assignment whose deadline is hours away - the classic
//     "the exam is at 10:00 and I set it up at 10:15";
//   * editing a live assignment to bring its deadline forward, from next week
//     to this afternoon.
//
// Both now arm the sentinel themselves, and both need to answer "is this
// deadline within the window?" - one in a workflow, one in the browser. The
// scripts/ module imports node:fs, which the SPA's bundle cannot, so the shared
// answer lives here.
//
// Pure, dependency-free and isomorphic - no fs, no fetch, no Node builtins.

/** 4.5 hours. See above for why it is not 4 and not 6. */
export const SENTINEL_ARM_WINDOW_MS = 4.5 * 3600_000;

/**
 * Is this deadline close enough that a sentinel armed now could reach it?
 *
 * FALSE for a deadline already past: the sentinel's job is to stop writes at
 * an instant, and an instant that has gone is the nightly's problem, not a
 * thing to arm for. False for anything unparseable, because a deadline nobody
 * can read is not evidence of an imminent one.
 *
 * @param {unknown} deadlineIso the assignment's `deadline_at`
 * @param {{now?: number, window?: number}} [opts]
 * @returns {boolean}
 */
export function deadlineIsImminent(deadlineIso, { now = Date.now(), window = SENTINEL_ARM_WINDOW_MS } = {}) {
  if (typeof deadlineIso !== 'string' || deadlineIso === '') return false;
  const at = new Date(deadlineIso).getTime();
  if (!Number.isFinite(at)) return false;
  return at > now && at - now <= window;
}
