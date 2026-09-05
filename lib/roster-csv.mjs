// PXL Classroom - turning CSV rows into a roster document.
//
// One rule, two importers: `pxl-classroom roster import` and the Admin Panel's
// Roster tab. They had a byte-for-byte copy of this each, in
// `cli/src/commands/roster.mjs` and `frontend/src/lib/csv.js` - the SAME TWO
// FILES where `diffRosters` had already forked and disagreed about key order,
// which showed every student as "updated" in one surface and unchanged in the
// other. That fork was closed by `lib/roster-entries.mjs`; this is the rest of
// the same pair.
//
// The copies had not yet diverged in behaviour - only in error-message casing -
// which is exactly when to merge them. A roster imported through the CLI and the
// same file imported through the SPA must produce the identical document, or the
// two surfaces disagree about who is on a course.
//
// PURE, and deliberately does not parse CSV. Papa.parse lives in each caller, so
// this module stays free of the dependency and the SPA imports it the way it
// imports `effective-deadline.mjs`. What is shared is the part that can drift:
// which columns exist, what a cell means, and which rows are refused.

import { stripFormulaGuard } from "./csv-cell.mjs";

/** Every column an import may carry. Anything else is refused, never ignored. */
export const KNOWN_COLUMNS = Object.freeze([
  "student_number",
  "full_name",
  "email",
  "class_group",
  "github_login",
  "github_id",
  "active",
  "team_slug",
  "team_name",
]);

/**
 * Columns a roster cannot be imported without.
 *
 * `github_login` is deliberately NOT here: it is the optional column, and the
 * whole reason `roster_mode: claim` exists is that a lecturer is given
 * addresses rather than usernames.
 */
export const REQUIRED_COLUMNS = Object.freeze(["student_number", "full_name"]);

/**
 * Coerce one cell into the value the schema expects.
 *
 * An empty cell is `undefined` rather than `""`, so an optional field stays
 * ABSENT in the document instead of being written as an empty string - the
 * roster schema distinguishes the two, and an empty `github_login` would look
 * like a linked student to anything counting them.
 */
export function coerceCell(field, raw) {
  if (raw === undefined || raw === null) return undefined;
  // WHAT THE EXPORTER WROTE IS WHAT THE IMPORTER READS. Export CSV prefixes an
  // apostrophe onto anything starting with = + - @ so a spreadsheet cannot
  // execute it, and this is the other half of that: without it, export -> edit
  // -> import silently changed the value, on the round trip the Roster tab now
  // tells lecturers to use. `stripFormulaGuard` inverts the exact rule and no
  // more, so a Flemish `'t Hooft` is not renamed on the way in.
  const v = String(stripFormulaGuard(raw)).trim();
  if (v === "") return undefined;

  if (field === "github_id") {
    const n = Number(v);
    if (!Number.isInteger(n)) throw new Error(`github_id must be an integer, got "${v}"`);
    return n;
  }

  if (field === "active") {
    if (/^(true|1|yes|y)$/i.test(v)) return true;
    if (/^(false|0|no|n)$/i.test(v)) return false;
    throw new Error(`active must be boolean-ish (true|false|1|0|yes|no), got "${v}"`);
  }

  return v;
}

/**
 * Build the roster document from already-parsed CSV rows.
 *
 * @param {object[]} rows    Papa.parse's `data`, header mode.
 * @param {string[]} headers Papa.parse's `meta.fields`, trimmed.
 * @param {{ filename?: string|null }} opts
 * @returns {{ schema_version: 2, students: object[] }}
 *
 * Throws on the first problem, naming the LINE as the lecturer sees it in their
 * spreadsheet (header is line 1, so the first data row is line 2). A roster
 * import replaces the file wholesale, so a half-applied one is worse than none.
 */
export function rowsToRoster(rows, headers, { filename = null } = {}) {
  const known = new Set(KNOWN_COLUMNS);
  const where = filename ? ` in ${filename}` : "";

  const unknown = (headers ?? []).filter((h) => !known.has(h));
  if (unknown.length) {
    throw new Error(
      `unknown column(s)${where}: ${unknown.join(", ")}. ` +
        `Known columns: ${KNOWN_COLUMNS.join(", ")}.`,
    );
  }

  for (const required of REQUIRED_COLUMNS) {
    if (!(headers ?? []).includes(required)) {
      throw new Error(`required CSV column missing: ${required}`);
    }
  }

  const students = [];
  const seenNumbers = new Set();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const lineNo = i + 2; // +1 for the header, +1 because humans count from 1
    const entry = {};

    for (const field of KNOWN_COLUMNS) {
      try {
        const v = coerceCell(field, row[field]);
        if (v !== undefined) entry[field] = v;
      } catch (err) {
        throw new Error(`line ${lineNo} (${field}): ${err.message}`);
      }
    }

    if (!entry.student_number) throw new Error(`line ${lineNo}: student_number is required`);
    if (!entry.full_name) throw new Error(`line ${lineNo}: full_name is required`);
    if (seenNumbers.has(entry.student_number)) {
      throw new Error(`line ${lineNo}: duplicate student_number "${entry.student_number}"`);
    }
    seenNumbers.add(entry.student_number);
    students.push(entry);
  }

  return { schema_version: 2, students };
}
