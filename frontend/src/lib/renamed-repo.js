// Is this repository, under a name today's login does not make, the one this
// student had before renaming their account? (lib/login-rename.mjs)
//
// A student's token cannot read the control repository, so the page has to tell
// from what it can read, and it takes both of these:
//
//   * nobody holds the login the repository was named for. A classmate's they
//     were added to fits the pattern as well, and that login is a living account.
//   * they have an acceptance attempt of their own on this assignment's broker
//     that was not refused. GitHub lists an issue under its author's name today
//     (measured on PXL-Java-Essentials, 2026-10-30: the old login lists none), and
//     a student who never accepted has none, however many renamed classmates'
//     repositories they can reach. Without this they lost the Accept button.
//
// Anything less is null, and null is safe: the page offers Accept, and the hub
// decides from the record by account id and hands back what they have.
// Reads one page of what the student can reach already; asks more only when a
// repository fits, which for nearly every student is never.

import { REJECTED_LABEL } from '../../../lib/acceptance-labels.mjs'
import { brokerRepoName } from '../../../lib/broker-repo.mjs'
import { renamedOwnRepo, renamedRepoCandidates } from '../../../lib/repo-name.mjs'
import { ownAcceptanceIssue } from './broker-teams.js'

/**
 * @param {object} args
 * @param {(method: string, path: string) => Promise<{ok?: boolean, status?: number, data?: any}>} args.api
 * @param {Array<object>} args.repos what to look among
 * @param {string} args.org
 * @param {object} args.assignment needs `repository_name_pattern`
 * @param {string} args.assignmentId
 * @param {string} args.login who is signed in
 * @param {number|null} [args.excludeIssue] the attempt being waited on, which proves nothing
 * @returns {Promise<object|null>}
 */
export async function renamedRepoFor({ api, repos, org, assignment, assignmentId, login, excludeIssue = null }) {
  const who = { org, pattern: assignment?.repository_name_pattern, login }
  const candidates = renamedRepoCandidates(repos, who)
  if (candidates.length === 0) return null

  const gone = new Set()
  for (const name of [...new Set(candidates.map((c) => c.login))].slice(0, 10)) {
    const res = await api('GET', `/users/${encodeURIComponent(name)}`)
    if (res?.status === 404) gone.add(name.toLowerCase())
  }
  const repo = renamedOwnRepo(repos, who, gone)
  if (!repo) return null

  const broker = brokerRepoName({ assignment, assignmentId })
  if (!broker) return null
  const issues = await api('GET', `/repos/${org}/${broker}/issues?creator=${encodeURIComponent(login)}&state=all&per_page=30`)
  if (!issues?.ok || !Array.isArray(issues.data)) return null
  const earlier = issues.data.filter((i) =>
    i?.number !== excludeIssue && !(i?.labels || []).some((l) => l?.name === REJECTED_LABEL))
  return ownAcceptanceIssue(earlier, login) ? repo : null
}
