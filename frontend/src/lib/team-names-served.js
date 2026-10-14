// Do students see a renamed team under its new name? Worked out from facts each
// time it is shown (DESIGN.md §1.5): the team files as the control repo holds
// them against the teams file the student site serves for this invitation.
// A rename said only in a toast was gone the moment the toast was (review
// 2026-10-14, PG12).

import { publishedTeamName } from '../../../lib/public-text.mjs'

/**
 * @param {Array<object>} stored  team documents as the control repo holds them
 * @param {{ status: 'ok', teams: Array<object> } | { status: 'missing' | 'unreadable' }} served
 *   the student site's teams file: read, absent (404), or not readable
 * @returns {{ state: 'none' | 'current' | 'stale' | 'unreadable',
 *             stale: Array<{ slug: string, name: string, served: string | null }> }}
 *   `none`: no team here was renamed, so there is nothing to say
 */
export function renamedTeamsServed(stored, served) {
  const renamed = (stored || []).filter(
    (t) => t && !t.vacant && Array.isArray(t.renamed_from) && t.renamed_from.length > 0,
  )
  if (!renamed.length) return { state: 'none', stale: [] }
  if (served?.status === 'unreadable' || !served) return { state: 'unreadable', stale: [] }
  const teams = served.status === 'ok' && Array.isArray(served.teams) ? served.teams : []
  const bySlug = new Map(teams.map((t) => [t?.team_slug, t]))
  const stale = []
  for (const t of renamed) {
    const name = publishedTeamName(t)
    // Under its new slug, or still under one it had: a slug that changed with
    // the name is served under the old one until the pages are rebuilt.
    const now = bySlug.get(t.team_slug) || t.renamed_from.map((s) => bySlug.get(s)).find(Boolean) || null
    if (!now || now.team_slug !== t.team_slug || now.team_name !== name) {
      stale.push({ slug: t.team_slug, name, served: now?.team_name ?? null })
    }
  }
  return { state: stale.length ? 'stale' : 'current', stale }
}

/** One line for the lecturer, from the answer above. */
export function renamedTeamsLine(answer) {
  if (answer.state === 'current') return 'Students see every renamed team under its new name.'
  if (answer.state === 'unreadable') return 'Could not read the student page, so whether students see the new team names is unknown.'
  if (answer.state !== 'stale') return ''
  // What is known is that the page is behind, not that an update is running.
  const one = answer.stale[0]
  const was = one.served ? `, they see "${one.served}"` : ''
  const more = answer.stale.length > 1 ? ` (and ${answer.stale.length - 1} more renamed team${answer.stale.length === 2 ? '' : 's'})` : ''
  return `Students do not see "${one.name}" yet${was}${more}: the student pages have not been rebuilt since the rename.`
}
