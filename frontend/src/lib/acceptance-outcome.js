// What the hub said about one acceptance, read off the student's own broker
// issue.
//
// This is the only channel between the two halves of the system that a student
// can read. The decision is made in the hub within a second and recorded in the
// private control repository, which they have no access to; the broker issue is
// public, they opened it themselves, and the page still holds its number.
//
// LABELS, NOT COMMENTS, and the reasons are worth keeping because the comment
// version shipped first and was wrong three ways:
//
//   * A comment EMAILS the student. They authored the issue, so GitHub
//     subscribes them; a student reported "Re: Acceptance (processed) - Closed
//     #1 has been completed" arriving in their inbox, which is an email about
//     internal plumbing. Labels are metadata and are silent.
//   * A comment can be FORGED. Anyone may comment on a public issue, so the
//     reader needed a rule making a rejection outrank a success in case someone
//     posted one underneath it. Applying a label needs triage or write access,
//     which a student does not have - so the channel is trustworthy by
//     construction and that rule is gone.
//   * Commenting was returning 403 on a locked issue while labelling the same
//     issue returned 200.
//
// Both surfaces read it, so the parse lives here rather than twice. It was
// twice for about an hour, and the second copy would have been the one that
// never learned about a new outcome - group students simply not told, looking
// exactly like the feature not existing.

import { INVITED_LABEL, REJECTED_LABEL } from '../../../lib/acceptance-labels.mjs'

export { INVITED_LABEL, REJECTED_LABEL }

/**
 * The outcome an issue's labels carry, or null if the hub has not spoken.
 *
 * A REJECTION OUTRANKS A SUCCESS. Not for forgery any more - a student cannot
 * apply either - but because the two must never both be set and, if a bug ever
 * set them, "you were refused" is the answer that leaves a student asking their
 * lecturer rather than chasing a link that cannot work.
 *
 * @param {Array<{name?: string}|string>|unknown} labels - `issue.labels`, which
 *   GitHub returns as objects; strings are accepted so a test fixture can be
 *   written the obvious way. Anything that is not an array yields null:
 *   unreadable is not evidence, and "the hub said nothing" must not be inferred
 *   from a failed read.
 * @returns {string|null}
 */
export function outcomeFromLabels(labels) {
  if (!Array.isArray(labels)) return null
  const names = labels
    .map((l) => (typeof l === 'string' ? l : l?.name))
    .filter((n) => typeof n === 'string')
  if (names.includes(REJECTED_LABEL)) return REJECTED_LABEL
  if (names.includes(INVITED_LABEL)) return INVITED_LABEL
  return null
}

/** Did the hub tell us an invitation is waiting? */
export function announcesInvitation(outcome) {
  return outcome === INVITED_LABEL
}

/** Is this the hub refusing the acceptance? */
export function isRejection(outcome) {
  return outcome === REJECTED_LABEL
}
