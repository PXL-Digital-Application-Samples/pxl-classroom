// PXL Classroom - CSV roster import helper for the SPA.
//
// Uses papaparse (same parser the CLI uses -> identical behavior). Returns a
// roster doc in the v2 schema shape, plus optional per-line parse errors.
// Schema validation is the caller's responsibility (validateAgainst('roster')).

import Papa from 'papaparse'

const KNOWN_COLUMNS = new Set([
  'student_number', 'full_name', 'email',
  'class_group', 'github_login', 'github_id', 'active',
  'team_slug', 'team_name',
])

function coerceCell(field, raw) {
  if (raw === undefined || raw === null) return undefined
  const v = String(raw).trim()
  if (v === '') return undefined
  if (field === 'github_id') {
    const n = Number(v)
    if (!Number.isInteger(n)) throw new Error(`github_id must be integer, got "${v}"`)
    return n
  }
  if (field === 'active') {
    if (/^(true|1|yes|y)$/i.test(v)) return true
    if (/^(false|0|no|n)$/i.test(v)) return false
    throw new Error(`active must be boolean-ish, got "${v}"`)
  }
  return v
}

export function csvToRoster(csvText) {
  const parsed = Papa.parse(csvText, {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: (h) => h.trim(),
  })

  if (parsed.errors.length) {
    const e = parsed.errors[0]
    throw new Error(`CSV parse error at row ${e.row}: ${e.message}`)
  }

  const headers = parsed.meta.fields ?? []
  const unknown = headers.filter((h) => !KNOWN_COLUMNS.has(h))
  if (unknown.length) {
    throw new Error(
      `Unknown column(s): ${unknown.join(', ')}. Known: ${[...KNOWN_COLUMNS].join(', ')}.`,
    )
  }
  for (const required of ['student_number', 'full_name']) {
    if (!headers.includes(required)) {
      throw new Error(`Required CSV column missing: ${required}`)
    }
  }

  const students = []
  const seen = new Set()
  for (let i = 0; i < parsed.data.length; i++) {
    const row = parsed.data[i]
    const lineNo = i + 2
    const entry = {}
    for (const field of KNOWN_COLUMNS) {
      try {
        const v = coerceCell(field, row[field])
        if (v !== undefined) entry[field] = v
      } catch (err) {
        throw new Error(`Line ${lineNo} (${field}): ${err.message}`)
      }
    }
    if (!entry.student_number) throw new Error(`Line ${lineNo}: student_number is required`)
    if (!entry.full_name) throw new Error(`Line ${lineNo}: full_name is required`)
    if (seen.has(entry.student_number)) {
      throw new Error(`Line ${lineNo}: duplicate student_number "${entry.student_number}"`)
    }
    seen.add(entry.student_number)
    students.push(entry)
  }

  return { schema_version: 2, students }
}

// Re-exported rather than re-implemented, the same way frontend/src/lib/deadline.js
// brings in lib/effective-deadline.mjs.
//
// The copy that used to live here had already forked from the CLI's in two
// ways, and both were silent. It compared entries with JSON.stringify, which is
// key-order sensitive, so a roster whose YAML happened to serialise its keys in
// another order showed EVERY student as "updated" in the Admin Panel while the
// CLI reported the same file unchanged. And both keyed the diff on
// student_number alone - which a promoted entry (source: "accepted") does not
// have, so every one of them mapped to the key `undefined`: fifty students
// collapsed into one diff row, and the import that followed would have silently
// removed forty-nine of them.
export { diffRosters, rosterKey, describeRosterEntry } from '../../../lib/roster-entries.mjs'
