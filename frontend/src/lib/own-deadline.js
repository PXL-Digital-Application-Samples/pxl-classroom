// The deadline that applies to the person reading their own student page, and
// whether this page knows it (lib/deadline-variable.mjs carries the decision).
//
// Two places can say it: the control repository's override file, which only
// staff can read and which carries the reason, and the student repository's
// variable, which the student can read while they can push. Both are asked, and
// the later date wins: the variable is a team repository's most generous
// member's, and the override file is only this login's.

import { ghApi, getRepoContent } from './api.js'
import { config } from './config.js'
import { overridePath } from '../../../lib/control-layout.mjs'
import { effectiveDeadlineFor } from '../../../lib/effective-deadline.mjs'
import { readDeadlineVariable } from '../../../lib/deadline-variable.mjs'

/**
 * The student card's badge for where their newest commit stands. `after-deadline`
 * is a commit after the deadline this page knows, where it could not read
 * whether the student was given a later one: never called late.
 *
 * @param {'on-time'|'late'|'after-deadline'|'no-submission'|string} status
 */
export function submissionBadge(status) {
  if (status === 'on-time') return 'Submitted on time'
  if (status === 'late') return 'Submitted late'
  if (status === 'after-deadline') return 'Submitted'
  return 'No commits pushed'
}

/** Its hover, which says why it does not say late. */
export const AFTER_DEADLINE_TITLE =
  'Pushed after the assignment deadline. If you were given more time, your own deadline applies, and this page could not read it.'

/**
 * @param {{ token: string, org: string, assignment: object, login: string, repoFullName: string }} args
 * @returns {Promise<{ extension: { value: string, reason: string|null } | null, known: boolean }>}
 *   `known` false: neither place could be read, so a commit after the
 *   assignment's deadline may still be inside this student's own (a locked,
 *   demoted student cannot read their variable - measured 2026-10-15).
 */
export async function readOwnDeadline({ token, org, assignment, login, repoFullName }) {
  const fromControl = async () => {
    try {
      const text = await getRepoContent(token, org, config.controlRepo, overridePath(assignment.id, login))
      if (!text) return { read: false, at: null, reason: null }
      const eff = effectiveDeadlineFor(assignment, login, { overrides: [JSON.parse(text)] })
      return { read: true, at: eff.extended ? eff.deadline : null, reason: eff.extended ? eff.reason : null }
    } catch {
      return { read: false, at: null, reason: null }
    }
  }
  const fromRepo = async () => {
    const repo = await ghApi(token, 'GET', `/repos/${repoFullName}`)
    const canPush = repo.ok ? repo.data?.permissions?.push === true : null
    return readDeadlineVariable((method, path) => ghApi(token, method, path), { repoFullName, canPush })
  }
  const [control, variable] = await Promise.all([fromControl(), fromRepo().catch(() => ({ state: 'unreadable', status: 0 }))])
  // ONLY EVER LATER than the assignment's deadline (lib/effective-deadline.mjs).
  // The variable is written when an extension is granted and nothing rewrites
  // it when the deadline moves: a date the deadline has since passed shortened
  // their deadline on screen (review 2026-10-15, R6-11). A student who can push
  // can also set it themselves, which changes this page and nothing else.
  const due = Date.parse(assignment?.deadline_at ?? '')
  const later = (d) => d && (!Number.isFinite(due) || d.getTime() > due)
  const candidates = [control.at, variable.state === 'set' ? variable.at : null].filter(later)
  const known = control.read || variable.state !== 'unreadable'
  if (!candidates.length) return { extension: null, known }
  const at = new Date(Math.max(...candidates.map((d) => d.getTime())))
  const reason = control.at && control.at.getTime() === at.getTime() ? control.reason : null
  return { extension: { value: at.toISOString(), reason }, known: true }
}
