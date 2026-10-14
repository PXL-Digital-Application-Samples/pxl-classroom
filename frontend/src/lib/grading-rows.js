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
export const GRADING_STATUSES = Object.freeze(['scored', 'not-handed-in', 'late', 'no-result', 'running', 'not-read'])

/**
 * The filters the cards and the pills share. `needs-look` is `late` and
 * `no-result`; a run still going (`running`) is not a problem, so it has a
 * pill of its own and no place in that card.
 */
export const GRADING_FILTERS = Object.freeze(['', 'scored', 'needs-look', 'not-handed-in', 'running', 'not-read'])

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
  const counts = { students: rows.length, scored: 0, 'needs-look': 0, 'not-handed-in': 0, running: 0, 'not-read': 0 }
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
 * The median beside it (asked 2026-10-11): with most of a class at full marks
 * the average is pulled down by the few who are not, and the median says where
 * the middle student is.
 *
 * @returns {null | { count: number, fullMarks: number, average: number|null,
 *   median: number|null, total: number|null, averagePercent: number|null,
 *   medianPercent: number|null }}
 */
export function scoreStats(rows) {
  const scored = rows
    .map((r) => r.graded)
    .filter((g) => g && Number.isFinite(Number(g.earned_points)) && Number(g.total_points) > 0)
  if (scored.length === 0) return null
  const fullMarks = scored.filter((g) => Number(g.earned_points) >= Number(g.total_points)).length
  const totals = new Set(scored.map((g) => Number(g.total_points)))
  const oneDecimal = (n) => Math.round(n * 10) / 10
  if (totals.size === 1) {
    const points = scored.map((g) => Number(g.earned_points))
    const sum = points.reduce((acc, p) => acc + p, 0)
    return {
      count: scored.length, fullMarks,
      average: oneDecimal(sum / scored.length), median: oneDecimal(median(points)),
      total: [...totals][0], averagePercent: null, medianPercent: null,
    }
  }
  const shares = scored.map((g) => Number(g.earned_points) / Number(g.total_points))
  const pct = shares.reduce((acc, s) => acc + s, 0) / scored.length
  return {
    count: scored.length, fullMarks, average: null, median: null, total: null,
    averagePercent: Math.round(pct * 100), medianPercent: Math.round(median(shares) * 100),
  }
}

/** The middle value; with an even count, halfway between the two middle ones. */
function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * Scored rows whose result carries no points - a template's own workflow that
 * passes or fails with no score reporter, stored 0/0. `gradingCounts` counts
 * them as scored, `scoreStats` cannot average them, so the box says them apart
 * rather than "Nobody has a score yet" under a Scored card that says 20.
 */
export function resultsWithoutPoints(rows) {
  return rows.filter((r) => r.graded && !(Number(r.graded.total_points) > 0)).length
}

/**
 * Why a read of the whole cohort saved nothing: nobody had a score. Said by
 * kind, the way the box says it - "all checks missing or failed" over a cohort
 * whose runs were still going sent a lecturer looking for a fault.
 *
 * @param {Array<object>} failed  the read's failed rows
 */
export function nothingGradedMessage(failed = [], { failedReads = null } = {}) {
  // WHOSE READ FAILED is not "nobody has a score" (review 2026-10-14, P2-10):
  // a cohort the rate limit stopped read "Nobody has a score to read yet (20
  // with no result)", advice to wait for runs that had all finished. They are
  // `failedReads` (lib/grade-cohort.mjs gradeCohort), counted apart.
  const unread = (row) => Boolean(failedReads?.has?.(normalizeLogin(row?.login)))
  const notRead = failed.filter(unread).length
  const n = {}
  for (const f of failed) {
    if (unread(f)) continue
    n[failedKind(f)] = (n[failedKind(f)] || 0) + 1
  }
  const parts = [
    n.running && `${n.running} still being graded`,
    n['not-handed-in'] && `${n['not-handed-in']} not handed in`,
    n.late && `${n.late} handed in late`,
    n['no-result'] && `${n['no-result']} with no result`,
  ].filter(Boolean)
  const saved = 'Nothing was saved, so the scores on record stay.'
  if (notRead) {
    return `${notRead === 1 ? '1 student' : `${notRead} students`} could not be read${parts.length ? ` (and ${parts.join(', ')})` : ''}: read the scores again in a few minutes. ${saved}`
  }
  return `Nobody has a score to read yet${parts.length ? ` (${parts.join(', ')})` : ''}. ${saved}`
}

/** The sentence `scoreStats` makes, as the box under the cards says it. */
export function scoreStatsSentence(stats) {
  if (!stats) return ''
  const avg = stats.average != null ? `${stats.average} / ${stats.total}` : `${stats.averagePercent}%`
  const med = stats.average != null ? `${stats.median} / ${stats.total}` : `${stats.medianPercent}%`
  const who = stats.count === 1 ? '1 student' : `${stats.count} students`
  return `Over ${who}: average ${avg}, median ${med}, ${stats.fullMarks} at full marks.`
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
