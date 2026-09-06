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
import { normalizeEmail } from "./normalize-email.mjs";
// The one judge of whether a row can be named. Isomorphic and dependency-free,
// like this module, so importing it costs the SPA nothing.
import { rosterIdentities } from "./cohort.mjs";

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
 * `student_number` USED TO BE HERE and is not any more. It was required so
 * every imported row would have a key, back when `rosterKey` knew only `num:`
 * and `login:` - but most institutions hand a lecturer addresses rather than
 * SIS numbers, so the requirement asked for a value they do not have. Worse,
 * it made the round trip this tab recommends impossible for a roster of
 * promoted rows: Export CSV writes them with an empty number, and the import
 * refused its own export on line 2.
 *
 * `github_login` is deliberately not here either: it is the optional column,
 * and the whole reason `roster_mode: claim` exists is that a lecturer is given
 * addresses rather than usernames.
 *
 * What a row still cannot be without is a NAME and some way to find it again,
 * which is checked per row rather than per column - a file may carry addresses
 * for some students and logins for others.
 */
export const REQUIRED_COLUMNS = Object.freeze(["full_name"]);

/** The columns that can key a row, in the order `rosterIdentities` prefers. */
export const IDENTITY_COLUMNS = Object.freeze(["student_number", "email", "github_login"]);

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
  const seenLogins = new Map();
  const seenEmails = new Map();

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

    if (!entry.full_name) throw new Error(`line ${lineNo}: full_name is required`);
    // ONE identity, not one particular identity. A row with none of the three
    // cannot be matched to a stored row, cannot be edited and cannot be
    // removed - `rosterKey` returns null for it - so it would import once and
    // then be unreachable. Naming all three tells a lecturer what would fix it.
    //
    // ASKS THE JUDGE, rather than testing the columns for truthiness. The
    // first version of this check was `IDENTITY_COLUMNS.some((f) => entry[f])`,
    // and `email: "garbage"` satisfied it - a non-empty cell in an identity
    // column - while `rosterIdentities` discards an address it cannot
    // normalise, so the row imported with NO key at all. That is precisely the
    // row this check exists to refuse, waved through by a check that asked a
    // different question from the one that decides.
    if (rosterIdentities(entry).length === 0) {
      throw new Error(
        `line ${lineNo}: a student needs a student_number, an email or a github_login - ` +
        `without one there is no way to find this row again.` +
        (entry.email ? ` "${entry.email}" is not a usable email address.` : ""),
      );
    }
    if (entry.student_number) {
      if (seenNumbers.has(entry.student_number)) {
        throw new Error(`line ${lineNo}: duplicate student_number "${entry.student_number}"`);
      }
      seenNumbers.add(entry.student_number);
    }
    // Same rule as the login below, for the same reason: an address keys a row
    // that has no number, so two rows sharing one are two students claiming to
    // be the same person. Normalised, because `rosterIdentities` compares them
    // normalised and a check on the raw string would miss `A@x.be` vs `a@x.be`.
    const email = normalizeEmail(entry.email);
    if (email) {
      if (seenEmails.has(email)) {
        throw new Error(
          `line ${lineNo}: email "${entry.email}" is already used on line ` +
          `${seenEmails.get(email)}. Two rows naming one address are two students ` +
          `claiming to be the same person; fix or remove one.`,
        );
      }
      seenEmails.set(email, lineNo);
    }
    // A login is an IDENTITY on the import path now: diffRosters matches an
    // incoming row against a stored one on either the number or the login, so
    // two rows sharing a login are two students claiming to be one person.
    // Only the first would match; the second would be written as a new row
    // holding a login that already belongs to somebody else - and the
    // acceptance gate, which matches on either identity too, would then find
    // two rows for one account.
    const login = String(entry.github_login ?? "").trim().toLowerCase();
    if (login) {
      // NAMES BOTH LINES. An import is all-or-nothing, so this refuses the
      // whole file - and "duplicate" without saying duplicate of WHAT sends a
      // lecturer scrolling a 200-row spreadsheet looking for the other one.
      if (seenLogins.has(login)) {
        throw new Error(
          `line ${lineNo}: github_login "${entry.github_login}" is already used on line ` +
          `${seenLogins.get(login)}. Two rows naming one GitHub account are two students ` +
          `claiming to be the same person; fix or remove one.`,
        );
      }
      seenLogins.set(login, lineNo);
    }
    students.push(entry);
  }

  return { schema_version: 2, students };
}
