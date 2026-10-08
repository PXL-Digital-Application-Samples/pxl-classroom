// The Grading tab's rows, the counts on its cards, and the average in its box.
//
// The tab listed only the students who HAD a score, and every other student
// below the table as "N grading failure(s)", in red, behind a click. On
// 2026-10-08 that was twenty students of an exam four days before its deadline,
// every one of them "no commit says ... so nothing was handed in": not a failure
// of anything, and only discoverable by scrolling to the bottom. Every student
// is a row now, each with what grading says about them (lib/grade-cohort.mjs
// `failedKind`), and the counts that filter the table are worked out here,
// where a test can run them, rather than in the component.

import { failedKind } from './grade-cohort.js'
import { normalizeLogin } from '../../../lib/github-login.mjs'

/**
 * What grading says about one student. `scored`, the three reasons
 * `failedKind` gives for no score, and `not-read`: in no summary at all, which
 * is every student before the first read and one who accepted after the last.
 */
export const GRADING_STATUSES = Object.freeze(['scored', 'not-handed-in', 'late', 'no-result', 'not-read'])

/** The filters the cards and the pills share. `needs-look` is `late` and `no-result`. */
export const GRADING_FILTERS = Object.freeze(['', 'scored', 'needs-look', 'not-handed-in', 'not-read'])

/**
 * One row per student who has something to grade: a report row with a
 * repository (the students Read all scores again reads, `gradableCount`), and
 * anyone the summary names who is not among them - a score set by hand needs no
 * repository, and a score on record is shown rather than dropped.
 *
 * @param {{ students?: Array<object>, summary?: object|null }} input
 * @returns {Array<{ login: string, student: object|null, graded: object|null,
 *   failed: object|null, record: object, status: string, reason: string|null, handIns: object|null }>}
 */
export function gradingRows({ students = [], summary = null } = {}) {
  const graded = new Map()
  const failed = new Map()
  for (const r of summary?.students || []) if (r?.login) graded.set(normalizeLogin(r.login), r)
  for (const r of summary?.failed || []) if (r?.login) failed.set(normalizeLogin(r.login), r)

  const rows = []
  const seen = new Set()
  const add = (login, student) => {
    const key = normalizeLogin(login)
    if (!key || seen.has(key)) return
    seen.add(key)
    rows.push(rowFor(login, student, graded.get(key) || null, failed.get(key) || null))
  }
  for (const s of students || []) if (s?.github_login && s.repo_name) add(s.github_login, s)
  const byLogin = new Map((students || []).filter((s) => s?.github_login).map((s) => [normalizeLogin(s.github_login), s]))
  for (const r of [...graded.values(), ...failed.values()]) add(r.login, byLogin.get(normalizeLogin(r.login)) || null)
  return rows
}

// `record`: the summary's own row for this student (graded or failed), or just
// the login - what the page's commit and tooltip helpers read.
function rowFor(login, student, graded, failed) {
  if (graded) return { login, student, graded, failed: null, record: graded, status: 'scored', reason: null, handIns: graded.hand_ins || null }
  if (failed) {
    return {
      login, student, graded: null, failed, record: failed,
      status: failedKind(failed), reason: failed.reason || null, handIns: failed.hand_ins || null,
    }
  }
  return { login, student, graded: null, failed: null, record: { login }, status: 'not-read', reason: null, handIns: null }
}

/** Whether a row belongs under a filter (GRADING_FILTERS). */
export function inGradingFilter(row, filter) {
  if (!filter) return true
  if (filter === 'needs-look') return row.status === 'late' || row.status === 'no-result'
  return row.status === filter
}

/** The cards' and the pills' numbers, from the same rows the table shows. */
export function gradingCounts(rows) {
  const counts = { students: rows.length, scored: 0, 'needs-look': 0, 'not-handed-in': 0, 'not-read': 0 }
  for (const r of rows) {
    for (const f of GRADING_FILTERS) if (f && inGradingFilter(r, f)) counts[f]++
  }
  return counts
}

/**
 * The scores in one sentence's worth of numbers, or null with none to average.
 *
 * Points are averaged only when every score is out of the same total; across
 * different totals an average of points mixes scales, so it is a percentage.
 *
 * @returns {null | { count: number, fullMarks: number, average: number|null,
 *   total: number|null, averagePercent: number|null }}
 */
export function scoreStats(rows) {
  const scored = rows
    .map((r) => r.graded)
    .filter((g) => g && Number.isFinite(Number(g.earned_points)) && Number(g.total_points) > 0)
  if (scored.length === 0) return null
  const fullMarks = scored.filter((g) => Number(g.earned_points) >= Number(g.total_points)).length
  const totals = new Set(scored.map((g) => Number(g.total_points)))
  if (totals.size === 1) {
    const sum = scored.reduce((acc, g) => acc + Number(g.earned_points), 0)
    return { count: scored.length, fullMarks, average: Math.round((sum / scored.length) * 10) / 10, total: [...totals][0], averagePercent: null }
  }
  const pct = scored.reduce((acc, g) => acc + Number(g.earned_points) / Number(g.total_points), 0) / scored.length
  return { count: scored.length, fullMarks, average: null, total: null, averagePercent: Math.round(pct * 100) }
}

/** The sentence `scoreStats` makes, as the box under the cards says it. */
export function scoreStatsSentence(stats) {
  if (!stats) return ''
  const avg = stats.average != null ? `${stats.average} / ${stats.total}` : `${stats.averagePercent}%`
  const who = stats.count === 1 ? '1 student' : `${stats.count} students`
  return `Average ${avg} over ${who}, ${stats.fullMarks} at full marks.`
}

/**
 * Whether missing work is past its deadline - the line between grey and red
 * for "not handed in" and "no submission" (asked 2026-10-08): before the
 * deadline it is the ordinary state of a student who has not finished, after
 * it something nobody will hand in. An unknown deadline is not past.
 */
export function pastDeadline(deadline, now = Date.now()) {
  if (!deadline) return false
  const at = new Date(deadline).getTime()
  return Number.isFinite(at) && at < now
}
