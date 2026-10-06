// The students the Progress tab must list although the report has no row for
// them.
//
// A report row is keyed by GitHub username (the schema requires one), so a
// roster row that has none - an address-only student who has not accepted or
// confirmed yet - was simply absent: the testbed's teams-ux-demo showed 12
// students of a cohort of 14, and nothing said two were missing (2026-10-05).
//
// Who is admitted without a username is lib/cohort.mjs `cohortWithoutLogin`,
// the rule the Teams tab asks too. This module only turns those rows into
// display rows, and leaves out anyone the report already lists - by the
// username a confirmation bound to them, or by the address they confirmed.
// The report itself is not touched: everything that reads it (grading, the
// CSV export, the counts on the overview) is keyed by username.

import { cohortWithoutLogin } from '../../../lib/cohort.mjs'

const lower = (s) => String(s || '').trim().toLowerCase()

/**
 * @param {object} args
 * @param {object|null} args.assignment
 * @param {Array<object>} args.roster     every roster row, with or without a username
 * @param {Array<object>} args.students   the report's rows
 * @param {(row: object) => (string|null|undefined)} [args.loginFor]  the username
 *   a confirmation bound to an address-only row
 * @returns {Array<object>} display rows: `missing_from_report: true`, and
 *   `github_login: ''` where the student has no username at all
 */
export function studentsMissingFromReport({ assignment, roster, students, loginFor = null }) {
  const listed = new Set((students || []).map((s) => lower(s?.github_login)).filter(Boolean))
  const listedAddresses = new Set((students || []).map((s) => lower(s?.claimed_email)).filter(Boolean))
  const out = []
  for (const row of cohortWithoutLogin(assignment, roster)) {
    const bound = typeof loginFor === 'function' ? String(loginFor(row) || '').trim() : ''
    if (bound && listed.has(lower(bound))) continue
    if (row?.email && listedAddresses.has(lower(row.email))) continue
    out.push({
      github_login: bound,
      email: row?.email || null,
      full_name: row?.full_name || null,
      student_number: row?.student_number || null,
      class_group: row?.class_group || null,
      acceptance_state: 'not-accepted',
      submission_status: 'no-submission',
      missing_from_report: true,
    })
  }
  return out
}

/** A key for a row that may have no username. */
export function studentRowKey(s) {
  return s?.github_login || `no-login:${s?.email || s?.student_number || s?.full_name || ''}`
}
