// Arm the deadline sentinel when a change leaves an imminent instant to watch.
//
// The sentinel arms from a 4-hourly cron, and a cron cannot see a change made
// after it last fired. Publishing covers one of the moments that creates an
// instant it has already missed; a save covers another - an assignment whose
// deadline was next week, edited to this afternoon - and an extension granted
// with its end inside the window is the third (review 2026-10-16, R7-12): it
// was never watched at all.
//
// For every assignment that has been live (`everPublished`), not only a
// published one (R7-15): the sentinel watches a closed assignment, and an
// archived or draft one where students accepted - which find-armable decides
// from the records, so one dispatch too many is all asking it costs.
//
// DELIBERATELY SILENT, in both directions. A dispatch that fails changes
// nothing a lecturer must act on - the cron still arms anything more than four
// hours out, and the nightly still locks whatever the sentinel misses, so the
// deadline holds either way and only its precision is at stake. It is also
// entirely normal for this to fail: dispatching a hub workflow needs write
// access on the hub, which most lecturers do not have (OPEN-ITEMS 4).

import { deadlineIsImminent } from '../../../lib/sentinel-window.mjs'
import { everPublished } from '../../../lib/finalize-scope.mjs'
import { triggerWorkflow } from './api.js'
import { config } from './config.js'

/**
 * @param {{ token: string, org: string, doc: object|null, instant?: string|null }} p
 *   `instant` is what is about to need watching: the deadline by default, an
 *   extension's end where one was granted
 * @returns {Promise<boolean>} whether a dispatch was made and accepted
 */
export async function armSentinelIfImminent({ token, org, doc, instant = doc?.deadline_at ?? null }) {
  if (!everPublished(doc)) return false
  if (!deadlineIsImminent(instant)) return false
  // `.ok`, not try/catch: everything in lib/api.js RESOLVES `{ ok: false }`
  // rather than throwing, so a catch here would never run.
  const res = await triggerWorkflow(token, config.hubOwner, config.hubRepo, 'deadline-sentinel.yml', { org })
  if (!res?.ok) {
    console.warn(
      `Could not arm the deadline sentinel (HTTP ${res?.status}). The deadline still holds: ` +
        `the 4-hourly cron arms anything further out, and the nightly locks whatever it misses.`,
    )
    return false
  }
  return true
}
