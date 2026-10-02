// Is this assignment FINISHED - so that publishing it again would reopen it?
//
// Publishing turns acceptance on: it sets the broker's INVITE_ENABLED to true and
// writes the broker App's private key back onto the broker, a public repository.
// The nightly's finalize turns both off when an assignment is done
// (scripts/close-acceptance.mjs), because a finished broker that still accepts
// boots a runner for every attempt and keeps a credential public for nothing.
// A re-publish undid that silently. Measured 2026-10-02 while re-publishing
// live brokers onto a new template: two of fourteen (`labo-api`,
// `finalize-drill`) were finished and closed, and re-publishing them would have
// reopened both.
//
// Finished means BOTH: the deadline has passed, and the deadline's lock has run
// (lockdowns/<id>/lockdown-record.json). A deadline in the past with no lock yet
// is an assignment the nightly has not finalized; publishing it changes nothing
// the finalize will not close again. A lecturer who means to reopen a finished
// assignment moves its deadline first, and then it is not finished.
//
// Pure, so the test runs it directly.

/**
 * Why publishing this assignment again must be refused, or null.
 *
 * @param {{deadlineAt?: unknown, lockRan: boolean, now?: Date, assignmentId?: string}} args
 * @returns {string|null}
 */
export function republishRefusal({ deadlineAt, lockRan, now = new Date(), assignmentId = "" }) {
  if (!lockRan) return null;
  if (typeof deadlineAt !== "string" || !deadlineAt) return null;
  const deadline = Date.parse(deadlineAt);
  if (!Number.isFinite(deadline) || deadline > now.getTime()) return null;
  return (
    `${assignmentId || "This assignment"} is finished: its deadline (${deadlineAt}) has passed and its submissions were locked. ` +
    `Publishing it again would turn acceptance back on and put the broker's key back on a public repository. ` +
    `To reopen it, move the deadline into the future first, then publish.`
  );
}
