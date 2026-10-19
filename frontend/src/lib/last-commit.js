// WHAT A ROW'S "LAST COMMIT" IS, for every table that shows one.
//
// Lived inside AssignmentDetailView while the Progress table was the only one.
// The Teams table shows it too now, and a team's commit is its repository's:
// the same observations every member working in it has, read off the member
// whose row is on that repository (lib/team-representative.mjs, which the
// report uses for the team's other columns).

import { teamRepresentative } from '../../../lib/team-representative.mjs'

/** The newest commit the collector saw, else the last one before the deadline. */
export function latestSha(row) {
  return row?.latest_observed_sha || row?.last_on_time_sha || null
}

/** When that commit was made, as near as the row knows. */
export function commitTime(row) {
  return row?.commit_date || row?.latest_commit_date || row?.latest_observed_at || null
}

/** Its message, for the title; a repository with one commit is the starter's. */
export function commitMsg(row) {
  if (row?.commit_message) return row.commit_message
  if (row?.latest_commit_message) return row.latest_commit_message
  if (row?.commit_count === 1) return 'Initial commit'
  return null
}

/**
 * The fields the Last commit cell reads, for a team: the team's repository, and
 * the commit from the member row on that repository - SHA, time and message
 * from one row, so they cannot describe two different commits. A team row
 * carries no commit time of its own (report.mjs); with no member row on its
 * repository only its SHA is known - never another member's numbers.
 */
export function teamCommitRow(team, students) {
  const rep = teamRepresentative(team, students)
  return {
    repo_url: team?.repo_url || null,
    latest_observed_sha: (rep ? rep.latest_observed_sha : team?.latest_observed_sha) || null,
    last_on_time_sha: rep?.last_on_time_sha || null,
    commit_date: rep?.commit_date || null,
    latest_commit_date: rep?.latest_commit_date || null,
    latest_observed_at: rep?.latest_observed_at || null,
    commit_message: rep?.commit_message || null,
    latest_commit_message: rep?.latest_commit_message || null,
    commit_count: team?.commit_count ?? rep?.commit_count ?? null,
  }
}
