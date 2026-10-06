// The Teams tab's rows: who is in which team comes from the team FILES, and
// everything about the work comes from the report.
//
// The table used to trust `reports/<id>.json` for every team the report
// already listed, and read a team's file only for a team the report did not
// have yet. The report is DERIVED - regenerate-dashboard.yml rebuilds it from
// the files after every write, which takes the better part of a minute - so
// after "Save", a move or a delete the table showed the old members, an emptied
// team kept its member, and a deleted team kept its Delete button (testbed,
// 2026-10-04). CLAUDE.md: write the source, then derive; a screen that shows
// the source does not wait for the derivation.
//
// So a row's name, members and maximum come from the file, and its repository,
// commits, status, score and lock come from the report. A member added a moment
// ago is in the row at once and shows "not accepted yet" until the report knows
// them - which is true.
//
// UNREADABLE IS NOT EVIDENCE. A team whose file could not be read keeps its
// report row as it was; a report row is dropped only when the listing was read
// and holds no file for that team.

const slugKey = (s) => String(s || '').toLowerCase()

/**
 * @param {Array<object>} reportTeams  `report.teams` (possibly empty)
 * @param {{ listed: boolean, files: Array<{ slug: string, doc: object|null }> }} manifests
 *   `listed` - whether the team directory was read at all; `doc` is null for a
 *   file that could not be read or parsed.
 * @param {{ minTeamSize?: number }} [opts]
 * @returns {Array<object>} rows, sorted by slug
 */
export function teamRows(reportTeams, manifests, { minTeamSize = 0 } = {}) {
  const fromReport = new Map((reportTeams || []).map((t) => [slugKey(t.team_slug), t]))
  if (!manifests?.listed) return [...(reportTeams || [])]

  const rows = []
  for (const { slug, doc } of manifests.files || []) {
    const key = slugKey(doc?.team_slug || slug)
    const reported = fromReport.get(key)
    if (!doc) {
      // The file is there but could not be read: keep what the report says.
      if (reported) rows.push(reported)
      continue
    }
    const members = Array.isArray(doc.members) ? doc.members : []
    const under = minTeamSize > 0 && members.length < minTeamSize
    const otherWarnings = (reported?.warnings || []).filter((w) => w !== 'under-capacity')
    rows.push({
      submission_status: 'no-submission',
      commit_count: null,
      ...(reported || {}),
      team_slug: doc.team_slug || reported?.team_slug || slug,
      team_name: doc.team_name || reported?.team_name || doc.team_slug || slug,
      members,
      ...(Number.isInteger(doc.max_members) ? { max_members: doc.max_members } : {}),
      repo_name: doc.repo_name || reported?.repo_name || null,
      repo_url: doc.repo_url || reported?.repo_url || null,
      ...(doc.repo_id || reported?.repo_id ? { repo_id: doc.repo_id || reported?.repo_id } : {}),
      ...(doc.seeded_from ? { seeded_from: doc.seeded_from } : {}),
      // Only from the file: the report never carries it, and the Teams tab is
      // where a lecturer reads it out to a student who lost it.
      // Whatever is there, readable or not: the hub treats an unreadable one as
      // a lock (lib/team-join-code.mjs), so the tab must not show it as none.
      ...(Object.prototype.hasOwnProperty.call(doc, 'join_code') ? { join_code: String(doc.join_code ?? '') } : {}),
      under_capacity: under,
      warnings: under ? [...otherWarnings, 'under-capacity'] : otherWarnings,
    })
  }
  return rows.sort((a, b) => String(a.team_slug).localeCompare(String(b.team_slug)))
}
