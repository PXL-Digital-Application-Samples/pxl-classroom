// What Refresh says when its save is refused.
//
// Refresh reads every student repository with the signed-in person's token and
// then commits what it read to the control repository with that same token. A
// GitHub App's user token can write only where the PERSON can write as well,
// so an account that may read a course's records but not change them gets the
// whole refresh on screen and then a 403 "Resource not accessible by
// integration" - which a lecturer read, in the middle of an exam, as PXL
// Classroom being broken (PXL-2TIN-CloudEssentials-2627, 2026-11-20).
//
// The 403 alone does not say that: a missing App permission answers the same
// words. So the read-only sentence is said only when GitHub, asked afterwards,
// answers that this account cannot push to the control repository. An answer
// that could not be read is not evidence (CLAUDE.md, "Unreadable is not
// evidence"): GitHub's own message is shown, as before.

/**
 * @param {{ status?: number, error?: string }} res  commitFiles' failure
 * @param {boolean|null} canPush  `permissions.push` on the control repository
 *   as GitHub answered it for this account afterwards; null when not read
 * @param {string} controlRepo  the control repository's name
 * @returns {{ readOnly: boolean, text: string }}
 */
export function refreshSaveRefusal(res, canPush, controlRepo) {
  if (res?.status === 403 && canPush === false) {
    return {
      readOnly: true,
      text:
        'Refreshed on screen, not saved: your GitHub account can read this course\'s records but not change them. ' +
        `An owner of the organization can give you write access to ${controlRepo}; until then the page shows the last saved status after a reload.`,
    }
  }
  return { readOnly: false, text: `Refreshed locally but save failed: ${res?.error || 'unknown error'}` }
}
