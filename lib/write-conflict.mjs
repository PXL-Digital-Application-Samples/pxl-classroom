// PXL Classroom - what to do when a contents write is refused for a stale sha.
//
// GitHub's Contents API is eventually consistent. `commitFile` reads the file's
// sha and then PUTs with it, so a GET moments after a previous write can hand
// back the sha that write replaced - and the PUT is refused with GitHub's own
// wording, "is at 7575ba33... but expected f7a2cdb8...". Measured on
// PXL-Automation-II on 2026-09-06: press "Fill in 1 email", then edit a cell.
//
// THE OBVIOUS FIX IS DATA LOSS. Re-reading and retrying looks right and is not:
// if the sha the caller got was stale, the CONTENT it got was stale too, so the
// document it built is one commit behind. Writing that over the fresh sha
// silently drops whatever the caller never saw - in the measured case, the
// address the harvest had written a second earlier. The refusal was doing its
// job; retrying blind would have undone it.
//
// So the question is not "did the write fail" but "did anything actually
// change", and only the caller knows what it built from. This module is that
// one decision, kept out of `frontend/src/lib/api.js` because that file reaches
// deployment.yml through a Vite-only loader and cannot be imported by a test -
// and a decision that cannot be imported is a decision that gets re-implemented
// inside the test that checks it.

/** Retry the write: nothing moved, the sha we sent was simply out of date. */
export const RETRY = "retry";

/** Refuse: somebody wrote in between, and our document does not include it. */
export const REFUSE = "refuse";

/**
 * @param {object} args
 * @param {string|undefined} args.baseContent
 *   What the caller built its new document from. UNDEFINED means the caller
 *   has no baseline - a new file, or a document assembled from a form rather
 *   than edited from one that was read. There is nothing to compare, and
 *   refusing those would break writes that were never in danger, so they retry.
 * @param {string|null} args.freshContent
 *   The file as it reads now. Null when it could not be read or decoded.
 * @returns {typeof RETRY | typeof REFUSE}
 */
export function conflictAction({ baseContent, freshContent }) {
  if (baseContent === undefined) return RETRY;
  // An unreadable re-read is not evidence that nothing changed, and this is the
  // side where being wrong destroys work. Unreadable refuses.
  if (typeof freshContent !== "string") return REFUSE;
  return freshContent === baseContent ? RETRY : REFUSE;
}

/**
 * Is this response GitHub refusing a write because of the sha we sent?
 *
 * 409 is the documented answer; 422 is what older responses used and what some
 * proxies still return. Matched on STATUS rather than on the message, because
 * the message is the thing this whole change exists to stop showing people -
 * and a check that reads it would break the day GitHub rewords it.
 *
 * @param {{status?: number}} res
 */
export function isShaConflict(res) {
  return res?.status === 409 || res?.status === 422;
}
