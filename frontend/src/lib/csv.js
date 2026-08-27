// PXL Classroom - CSV roster import helper for the SPA.
//
// Uses papaparse (same parser the CLI uses -> identical behavior). Returns a
// roster doc in the v2 schema shape, plus optional per-line parse errors.
// Schema validation is the caller's responsibility (validateAgainst('roster')).

import Papa from 'papaparse'
import { rowsToRoster } from '../../../lib/roster-csv.mjs'

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

  // The rule itself lives in lib/roster-csv.mjs, shared with
  // `pxl-classroom roster import`. Papa.parse stays here so that module keeps
  // no dependency, and so both surfaces produce the identical document from
  // the identical file - these two files are where diffRosters forked.
  return rowsToRoster(parsed.data, parsed.meta.fields ?? [])
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
