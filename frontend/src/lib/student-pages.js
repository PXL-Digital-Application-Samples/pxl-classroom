// Rebuild what students read after a lecturer changes something they read.
//
// Students never read the control repository. Their pages are built from it by
// regenerate-dashboard.yml, which runs nightly, after a successful acceptance
// and at the end of a publish - and at no other time. So every write a student
// is judged on has to ask for one, or the hub enforces the new document while
// the page shows the old one. That has cost lecturer-created teams that
// vanished, and a live assignment whose page never showed the address field
// the hub then refused its absence (lib/publish.js, publishedSaveWorkflow).
//
// One copy, because there were three and they had begun to word the same
// failure differently.

import { triggerWorkflow, explainDispatchFailure } from './api.js'
import { config } from './config.js'
import { toast } from './toast.js'

export const REGENERATE_WORKFLOW = 'regenerate-dashboard.yml'

/**
 * Dispatch the regeneration for one organization.
 *
 * `failure` is the sentence the toast opens with, naming what DID happen - the
 * write already landed, so "Saved, but ..." and not "Save failed".
 *
 * triggerWorkflow resolves `{ ok: false }` on a 403 or 404 rather than
 * throwing, so the result is read. Swallowing it reports success while students
 * still see the old page.
 *
 * @returns {Promise<boolean>} whether GitHub accepted the dispatch
 */
export async function republishStudentPages({ token, org, failure }) {
  const link = {
    href: `https://github.com/${config.hubOwner}/${config.hubRepo}/actions/workflows/${REGENERATE_WORKFLOW}`,
    text: 'Run it manually',
  }
  try {
    const res = await triggerWorkflow(token, config.hubOwner, config.hubRepo, REGENERATE_WORKFLOW, { org })
    if (res.ok) return true
    toast.error(explainDispatchFailure(res, failure), { link })
  } catch (e) {
    toast.error(`${failure}: ${e.message}`, { link })
  }
  return false
}
