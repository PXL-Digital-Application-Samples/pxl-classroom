// Which assignments a signed-in student has, for the student home (HomeView):
// a repository of theirs, or a pending invitation to one, per published
// assignment. Its own module so the test runs the page's own matching - the
// test it had asserted a copy, which PG5 had already left behind (review
// 2026-10-14, P2-22).

import { invitationEvidence } from './invitation-evidence.js'
import { repositoryNameFor } from '../../../lib/repo-name.mjs'
import { renamedRepoFor } from './renamed-repo.js'
import { collidingRepoNames } from '../../../lib/assignment-collision.mjs'

/**
 * The time-left badge for a deadline.
 *
 * @returns {{ text: string, badgeClass: string }}
 */
export function timeRemaining(deadlineAt, now = new Date()) {
  if (!deadlineAt) return { text: '', badgeClass: 'badge-neutral' }
  const diffMs = new Date(deadlineAt) - now
  if (diffMs <= 0) return { text: 'Closed', badgeClass: 'badge-error' }
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMins / 60)
  const diffDays = Math.floor(diffHours / 24)
  const text = diffDays > 0 ? `${diffDays}d left` : diffHours > 0 ? `${diffHours}h left` : `${diffMins}m left`
  return { text, badgeClass: diffHours < 24 ? 'badge-warning' : 'badge-success' }
}

/**
 * Past the class deadline, THIS student's own one, where their repository
 * carries a later date (lib/deadline-variable.mjs; review 2026-10-15, R6-34):
 * the home called an assignment Closed over a running extension. Only a later
 * date read from their repository changes the badge; one that cannot be read
 * (a locked student cannot read theirs) leaves it as it was.
 *
 * @param {Array<object>} rows  matchStudentAssignments' rows, changed in place
 * @param {{ read: (repoFullName: string) => Promise<{state: string, at?: Date}>, now?: Date }} a
 */
export async function withOwnDeadlines(rows, { read, now = new Date() }) {
  for (const row of rows || []) {
    if (row.stateStatus !== 'provisioned' || !row.repoFullName) continue
    const due = Date.parse(row.deadline_at ?? '')
    if (!Number.isFinite(due) || due > now.getTime()) continue
    const own = await Promise.resolve(read(row.repoFullName)).catch(() => null)
    if (own?.state !== 'set' || !(own.at instanceof Date) || own.at.getTime() <= due) continue
    const left = timeRemaining(own.at.toISOString(), now)
    row.timeRemainingStr = left.text
    row.timeRemainingBadgeClass = left.badgeClass
  }
  return rows
}

/**
 * The repositories this student had before renaming their account, per assignment
 * (lib/renamed-repo.js), for `matchStudentAssignments`. Not on a pattern a more
 * specific assignment also makes.
 *
 * @param {Array<object>} allOrgAssignments
 * @param {{ api: Function, login: string, repos: Array<object> }} who
 * @returns {Promise<Map<string, object>>} keyed `<org>/<id>`
 */
export async function renamedReposFor(allOrgAssignments, { api, login, repos }) {
  const found = new Map()
  for (const a of allOrgAssignments) {
    const rivals = allOrgAssignments.filter((o) => o.org === a.org && o.id !== a.id)
    const theirs = (repos || []).filter((r) => collidingRepoNames(a.repository_name_pattern, [String(r.name || '')], rivals).length > 0)
    const repo = await renamedRepoFor({ api, repos: theirs, org: a.org, assignment: a, assignmentId: a.id, login })
    if (repo) found.set(`${a.org}/${a.id}`, repo)
  }
  return found
}

/**
 * The assignments this student has, in the order given.
 *
 * @param {Array<object>} allOrgAssignments  published assignments, each with `org`
 * @param {{ login: string, repos: Array<object>, invites: Array<object>, now?: Date, renamedRepos?: Map<string, object> }} who
 *   `repos`: the student's own repositories; `invites`: their pending repository
 *   invitations (only ever used to ADD a row - lib/invitation-evidence.js);
 *   `renamedRepos`: from `renamedReposFor`
 */
export function matchStudentAssignments(allOrgAssignments, { login, repos, invites, now = new Date(), renamedRepos = new Map() }) {
  const userLogin = String(login || '').toLowerCase()
  const matched = []
  for (const a of allOrgAssignments) {
    const expectedName = repositoryNameFor(a.repository_name_pattern, { login: userLogin }).toLowerCase()
    // A TEAM'S REPOSITORY IS NAMED AFTER THE TEAM, which this page does not
    // know. Asked for the one name a login makes (`grp-<login>`), a team
    // assignment never showed, and a student with only team work was told
    // they had accepted nothing (review 2026-10-14, PG5). So any name the
    // pattern makes, unless a more specific assignment in the org explains
    // it (lib/assignment-collision.mjs `collidingRepoNames`).
    const isTeam = String(a.repository_name_pattern || '').includes('{team_slug}')
    const rivals = isTeam ? allOrgAssignments.filter((o) => o.org === a.org && o.id !== a.id) : []
    const ours = (name) => isTeam
      ? collidingRepoNames(a.repository_name_pattern, [String(name || '')], rivals).length > 0
      : String(name || '').toLowerCase() === expectedName
    const inOrg = (owner) => String(owner || '').toLowerCase() === String(a.org || '').toLowerCase()
    const left = timeRemaining(a.deadline_at, now)
    const extra = { timeRemainingStr: left.text, timeRemainingBadgeClass: left.badgeClass }

    // A student who renamed their account keeps the repository, under the name
    // it was given.
    const existingRepo = (repos || []).find((r) => inOrg(r.owner?.login) && ours(r.name)) || renamedRepos.get(`${a.org}/${a.id}`)
    if (existingRepo) {
      matched.push({ ...a, repoUrl: existingRepo.html_url, repoFullName: existingRepo.full_name, stateStatus: 'provisioned', ...extra })
      continue
    }

    // A pending invitation, through the one judge every surface uses.
    const invitedName = isTeam
      ? ((invites || []).find((inv) => inOrg(inv?.repository?.owner?.login) && ours(inv?.repository?.name))?.repository?.name || '')
      : expectedName
    const { invitation } = invitationEvidence({ ok: true, data: invites || [] }, { org: a.org, repo: invitedName })
    if (invitation) {
      matched.push({ ...a, repoUrl: invitation.repository?.html_url, repoFullName: invitation.repository?.full_name, stateStatus: 'invited', ...extra })
    }
  }
  return matched
}
