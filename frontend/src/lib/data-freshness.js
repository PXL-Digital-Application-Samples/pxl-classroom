// When the commits on the Progress tab were read, and how - the info block
// beside Refresh (asked 2026-10-08; it was a footer under the table that a
// lecturer went looking for every time).
//
// The time that answers "do I need to Refresh?" is not when the report was
// rebuilt: that happens after every acceptance, while the commits in it can be
// a night old. It is when each student's repository was last READ
// (`latest_observed_at`), and the honest single answer is the OLDEST of those -
// "every repository here was read at or after this". Measured on the live
// orgs on 2026-10-10, every row carried the nightly's time, so in the ordinary
// case oldest and newest are one moment.

/**
 * @param {Array<object>} students  report rows
 * @returns {{ at: string|null, type: string|null, newest: string|null,
 *   read: number, unread: number }}
 *   `at` / `type`: the oldest read and how it was made (`latest_observation_type`);
 *   `read` / `unread`: students with a repository who were / were not read yet.
 */
export function commitsRead(students) {
  let oldest = null
  let newest = null
  let read = 0
  let unread = 0
  for (const s of students || []) {
    if (!s?.repo_name) continue
    const t = s.latest_observed_at ? new Date(s.latest_observed_at).getTime() : NaN
    if (!Number.isFinite(t)) {
      unread++
      continue
    }
    read++
    if (!oldest || t < oldest.t) oldest = { t, at: s.latest_observed_at, type: s.latest_observation_type ?? null }
    if (!newest || t > newest.t) newest = { t, at: s.latest_observed_at }
  }
  return { at: oldest?.at ?? null, type: oldest?.type ?? null, newest: newest?.at ?? null, read, unread }
}

/** Two reads closer than a minute are one read, as far as a person can tell. */
export function sameMoment(a, b) {
  if (!a || !b) return false
  return Math.abs(new Date(a).getTime() - new Date(b).getTime()) < 60_000
}

/**
 * When the scores on the Grading tab were read, for the info block beside
 * Read all scores again.
 *
 * NOT the summary's `generated_at` alone: reading ONE student's score again
 * rebuilds the whole summary with a new time and that lecturer's login, so the
 * summary's time can be one student's read over a cohort read days before.
 * Each scored row keeps its own `graded_at`; the oldest is "every score here
 * was read at or after this", as for the commits. `again` counts the rows read
 * later than that, and `uniform` says whether the summary's `graded_by` is
 * true of every row - only then may a surface say who read them.
 *
 * @param {{ generated_at?: string, graded_by?: string|null, students?: Array<{graded_at?: string}> }|null} summary
 * @returns {null | { at: string, again: number, latest: string|null, uniform: boolean }}
 */
export function scoresRead(summary) {
  if (!summary) return null
  let oldest = null
  let latest = null
  for (const row of summary.students || []) {
    const t = row?.graded_at ? new Date(row.graded_at).getTime() : NaN
    if (!Number.isFinite(t)) continue
    if (!oldest || t < oldest.t) oldest = { t, at: row.graded_at }
    if (!latest || t > latest.t) latest = { t, at: row.graded_at }
  }
  const at = oldest?.at || summary.generated_at || null
  if (!at) return null
  const base = new Date(at).getTime()
  const again = (summary.students || []).filter((row) => {
    const t = row?.graded_at ? new Date(row.graded_at).getTime() : NaN
    return Number.isFinite(t) && t - base >= 60_000
  }).length
  return { at, again, latest: again ? latest.at : null, uniform: again === 0 }
}
