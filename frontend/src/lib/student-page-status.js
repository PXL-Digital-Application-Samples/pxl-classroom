// Do students see what is saved? Worked out from facts every time it is asked,
// so it says the same after a refresh as right after a save.
//
// 2026-10-08: a lecturer changed a published assignment's deadline and pressed
// Save. A toast said "about two minutes" and vanished, and after that nothing
// on any page said whether students had the new deadline - and a refresh would
// not have told them either, because the only state was the toast. The facts
// were all there to read:
//
//   - the card the saved document makes (lib/student-card.mjs, the same
//     function the site generator uses);
//   - the card students are served, from the student site itself;
//   - when the assignment was last saved (its file's newest commit);
//   - the newest update of the student site since then (deploy-frontend.yml).
//
// Pure: those facts in, a status out. composables/useStudentPageStatus.js reads
// them.

import { cardDifferences } from '../../../lib/student-card.mjs'

/** Minutes after a save past which "not yet" is "stuck", unless an update is running. */
export const STUCK_MINUTES = 10

const NOT_STARTED = new Set(['queued', 'pending', 'waiting', 'requested'])

/**
 * @param {object} facts
 * @param {object|null} facts.saved     the card the saved document makes; null when it has none (draft, archived)
 * @param {{status: 'ok'|'missing'|'unreadable', card?: object}} facts.served
 * @param {number|null} facts.since     when the newest save (or a request to update) was made, ms
 * @param {object|null} facts.deploy    the newest student-site update created since then
 * @param {string|null} [facts.failure] starting the update failed, in this tab, with this reason
 * @param {number} [facts.now]
 * @returns {{state: 'none'|'unknown'|'current'|'updating'|'stuck'|'failed', differences: Array, missing: boolean,
 *            minutes: number, site: 'waiting'|'running'|'done'|'failed'|null, url: string|null, failure: string|null}}
 */
export function studentPageStatus({ saved, served, since, deploy, failure = null, now = Date.now() }) {
  const minutes = Number.isFinite(since) && since ? Math.max(0, Math.floor((now - since) / 60_000)) : 0
  const base = { differences: [], missing: false, minutes, site: null, url: deploy?.html_url || null, failure: null }
  if (!saved) return { ...base, state: 'none' }
  // Could not look is not "they see it" and not "they do not": nothing claimed.
  if (!served || served.status === 'unreadable') return { ...base, state: 'unknown' }
  const missing = served.status === 'missing'
  const differences = missing ? [] : cardDifferences(saved, served.card)
  if (!missing && differences.length === 0) return { ...base, state: 'current' }

  const site = !deploy ? null
    : NOT_STARTED.has(deploy.status) ? 'waiting'
    : deploy.status !== 'completed' ? 'running'
    : deploy.conclusion === 'success' ? 'done'
    : deploy.conclusion === 'cancelled' ? 'waiting'
    : 'failed'
  const behind = { ...base, differences, missing, site }
  if (failure) return { ...behind, state: 'failed', failure }
  if (site === 'waiting' || site === 'running') return { ...behind, state: 'updating' }
  if (!since || minutes < STUCK_MINUTES) return { ...behind, state: 'updating' }
  return { ...behind, state: 'stuck' }
}

/**
 * The steps of getting a save to students, for the list on the Settings tab:
 * Saved, the student site updated, students see it. Same shape as a publish's
 * (lib/publish-progress.js `publishSteps`).
 */
export function studentPageSteps(status) {
  if (!['updating', 'stuck', 'failed', 'current'].includes(status?.state)) return null
  if (status.state === 'current') {
    return [
      { key: 'saved', label: 'Saved', state: 'done', detail: '' },
      { key: 'site', label: 'Student site updated', state: 'done', detail: '' },
      { key: 'live', label: 'Students see it', state: 'done', detail: '' },
    ]
  }
  const siteDone = status.site === 'done'
  const site = status.state === 'failed' ? 'failed' : siteDone ? 'done' : 'active'
  return [
    { key: 'saved', label: 'Saved', state: 'done', detail: '' },
    { key: 'site', label: 'Student site updated', state: site, detail: '' },
    { key: 'live', label: 'Students see it', state: siteDone && status.state !== 'stuck' ? 'active' : 'todo', detail: '' },
  ]
}

/**
 * The one line for the assignment's header, on every tab - only while students
 * do not see what is saved. '' otherwise.
 *
 * @param {ReturnType<typeof studentPageStatus>} status
 */
export function studentPageLine(status) {
  const so = status.minutes >= 1 ? ` (${status.minutes} min so far; usually 3 to 4 minutes)` : ' (usually 3 to 4 minutes)'
  const what = status.missing
    ? 'The student page for this assignment is not on the site yet'
    : 'Students still see the version before your last save'
  switch (status.state) {
    case 'updating':
      return `${what}: updating the student site${so}.`
    case 'stuck':
      return `${what}, ${status.minutes} min after it was saved, and nothing is updating it now.`
    case 'failed':
      return `Saved, but starting the student page update failed: ${status.failure}.`
    default:
      return ''
  }
}

/** The bar's short version on the Settings tab, where Save was pressed. */
export function studentPageBarText(status) {
  if (status?.state === 'updating') return `Updating the student page, step 2 of 3${status.minutes >= 1 ? ` (${status.minutes} min so far)` : ''}.`
  if (status?.state === 'stuck') return 'Students do not see the saved version yet.'
  if (status?.state === 'failed') return 'Starting the student page update failed.'
  return ''
}
