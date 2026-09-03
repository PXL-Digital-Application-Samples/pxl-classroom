// What the hub said about one acceptance, read off the student's own broker
// issue.
//
// This is the only channel between the two halves of the system that a student
// can actually read. The decision - rejected, or provisioned-and-invited - is
// made in the hub within a second and recorded in the private control repo,
// which they have no access to; the broker issue is public, they opened it
// themselves, and the page still holds its number.
//
// Both surfaces read it, so the parse lives here rather than twice. It was
// twice for about an hour, and the second copy would have been the one that
// never learned about `provisioned:` - group students would simply not have
// been told, and it would have looked exactly like the feature not existing.
//
// The counterpart writer is scripts/comment-acceptance-outcome.mjs, which owns
// what may cross onto a public repository at all.

/**
 * The machine-readable half of a hub comment.
 *
 * BOTH prefixes. This was `rejected[a-z:-]*` while `provisioned:invited` was
 * being added, and a marker that does not match is indistinguishable from a
 * marker that was never posted.
 */
export const OUTCOME_MARKER = /<!--\s*pxl-acceptance-outcome:((?:rejected|provisioned)[a-z:-]*)\s*-->/

/** The hub saw GitHub send an invitation - a 201 from the collaborator grant. */
export const INVITED = 'provisioned:invited'

/**
 * The category this acceptance ended in, or null if the hub has not said.
 *
 * A REJECTION OUTRANKS EVERYTHING, wherever it sits in the thread.
 *
 * The broker locks the acceptance issue once it has dispatched - but with
 * `|| true`, so the lock is best effort, and the repository is public. If the
 * last marker always won, a forged `provisioned:invited` posted underneath
 * somebody's rejection would replace "you were turned away, and here is why"
 * with an invitation link that 404s, and the real answer would sit two comments
 * above where nobody looks. The hub never posts both for one attempt, so making
 * the negative authoritative costs nothing legitimate.
 *
 * Among the rest, the LAST wins: a student who accepted, was refused, fixed the
 * problem and accepted again should see the latest answer.
 *
 * @param {Array<{body?: string}>|unknown} comments - as returned by the issue
 *   comments endpoint. Anything that is not an array yields null: unreadable is
 *   not evidence, and "the hub said nothing" must not be inferred from a failed
 *   read.
 * @returns {string|null}
 */
export function outcomeFromComments(comments) {
  if (!Array.isArray(comments)) return null
  const categories = comments
    .map((c) => OUTCOME_MARKER.exec(typeof c?.body === 'string' ? c.body : '')?.[1])
    .filter(Boolean)
  const rejection = categories.find((c) => c.startsWith('rejected'))
  if (rejection) return rejection
  return categories.length ? categories[categories.length - 1] : null
}

/** Did the hub tell us an invitation is waiting? */
export function announcesInvitation(category) {
  return category === INVITED
}

/** Is this the hub refusing the acceptance? */
export function isRejection(category) {
  return typeof category === 'string' && category.startsWith('rejected')
}
