// Whether a save changed WHICH repository an assignment's students are
// created from, and whether anybody already holds a repository made from the
// old one.
//
// Changing the template reaches only students who accept afterwards. A
// repository that exists keeps what it was created with until a starter sync
// brings it across, and the lecturer who changed the template was never told
// that (LESSONS: "The fallback is the recipient's own first state").
//
// A RENAME IS NOT A CHANGE: GitHub keeps the repository id, and the pin
// (`repository_id`) says it is the same repository. A same name over a
// DIFFERENT id is a change - deleted and recreated, or a transfer that reused
// the name - which is exactly the case the pin exists to catch.

/** @param {{ owner?: string, repository?: string, repository_id?: number } | null | undefined} t */
function fullName(t) {
  return t?.owner && t?.repository ? `${t.owner}/${t.repository}`.toLowerCase() : ''
}

/**
 * @param {{ owner?: string, repository?: string, repository_id?: number } | null | undefined} before  the stored template, before the save
 * @param {{ owner?: string, repository?: string, repository_id?: number } | null | undefined} after   the template the save wrote
 */
export function templateChanged(before, after) {
  if (!fullName(before) || !fullName(after)) return false
  const ids = Number.isInteger(before.repository_id) && Number.isInteger(after.repository_id)
  if (ids) return before.repository_id !== after.repository_id
  return fullName(before) !== fullName(after)
}

/**
 * What to tell the lecturer after the save, or null for nothing.
 *
 * `repositoryCount` is how many repository records the assignment has: a
 * number, or null when they could not be read. Unreadable still tells - the
 * notice costs a glance, and staying silent is how this went unnoticed - but
 * says no number it does not have.
 *
 * @param {{ before: any, after: any, repositoryCount: number | null }} input
 * @returns {{ count: number | null, template: string } | null}
 */
export function templateChangeNotice({ before, after, repositoryCount }) {
  if (!templateChanged(before, after)) return null
  if (repositoryCount === 0) return null
  return {
    count: Number.isInteger(repositoryCount) ? repositoryCount : null,
    template: `${after.owner}/${after.repository}`,
  }
}
