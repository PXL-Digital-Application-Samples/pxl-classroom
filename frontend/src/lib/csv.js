// PXL Classroom — CSV roster import helper for the SPA.
//
// Uses papaparse (same parser the CLI uses → identical behavior). Returns a
// roster doc in the v2 schema shape, plus optional per-line parse errors.
// Schema validation is the caller's responsibility (validateAgainst('roster')).

import Papa from 'papaparse'

const KNOWN_COLUMNS = new Set([
  'student_number', 'full_name', 'email',
  'class_group', 'github_login', 'github_id', 'active',
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

export function diffRosters(current, next) {
  const currentMap = new Map((current?.students ?? []).map((s) => [s.student_number, s]))
  const nextMap = new Map(next.students.map((s) => [s.student_number, s]))

  const added = []
  const updated = []
  const removed = []

  for (const [num, entry] of nextMap) {
    const prev = currentMap.get(num)
    if (!prev) added.push(entry)
    else if (JSON.stringify(prev) !== JSON.stringify(entry)) {
      updated.push({ before: prev, after: entry })
    }
  }
  for (const [num, entry] of currentMap) {
    if (!nextMap.has(num)) removed.push(entry)
  }
  return { added, updated, removed }
}
