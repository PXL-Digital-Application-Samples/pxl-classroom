// A cap on how long a page waits for one of its sections (2026-10-06).
//
// Every GitHub read already gives up after READ_TIMEOUT_MS (http.js), but a
// section can be several reads in a row - a walk over pages of members, of
// comments - and ten slow-but-answering reads are still most of two minutes
// behind a spinner. So a section also gets a deadline as a whole: past it the
// page stops waiting and says GitHub did not answer in time, and the late
// answer, when it comes, is dropped by the caller's own generation check.
//
// Not to be confused with deadline.js, which is an assignment's deadline.

/** What withDeadline resolves to when the deadline came first. */
export const TIMED_OUT = Symbol('timed out')

/** How long one section of a page waits, in all. */
export const SECTION_DEADLINE_MS = 25000

/**
 * @template T
 * @param {Promise<T>} promise
 * @param {number} [ms]
 * @returns {Promise<T | typeof TIMED_OUT>}
 */
export function withDeadline(promise, ms = SECTION_DEADLINE_MS) {
  let timer
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms)
  })
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer))
}
