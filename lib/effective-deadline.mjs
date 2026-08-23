// PXL Classroom - the deadline that applies to one student.
//
// An assignment has a deadline. A student may have been granted an extension,
// recorded in `overrides/<assignment-id>/<login>.json` (append-only, ARCHITECTURE
// §5.2). Every part of the system that compares a moment in time against "the
// deadline" has to mean *this* deadline, or it acts against work a lecturer
// deliberately allowed.
//
// Before this module there was one implementation, inline in report/report.mjs,
// and it read a field no override document has carried since 2026-06-17:
//
//     override.deadline_at            <- the shape the first Admin Panel wrote
//     override.overrides[].value      <- the shape it has written since 9671afd
//
// So extensions did not work anywhere. `lockdown.mjs` and `find-finalizable.mjs`
// never opened `overrides/` at all, and `report.mjs` opened it and read a key
// that was not there. Granting seven extra days demoted the student to `pull` at
// the assignment's own deadline, then reported the work they were locked out of
// doing as on-time. The test covering it (report.test.mjs, "P0-7") built its
// fixture in the same dead shape, so it passed against a branch no production
// document could take.
//
// Both shapes are read here, because control repos provisioned before 2026-06-17
// can still hold the flat one. The array is the current writer and wins.
//
// Dependency-free and isomorphic on purpose: nothing here touches the
// filesystem, so the callers keep their own directory reads and the SPA can
// import it later without pulling in `node:fs`. Same split as
// lib/invite-token-format.mjs beside lib/invite-token.mjs.

export const DEADLINE_EXTENSION = "deadline_extension";

/** A Date, or null for absent/unparseable input. Never an Invalid Date. */
function toDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** GitHub logins are case-insensitive; override filenames are not. */
const norm = (login) => (typeof login === "string" ? login.toLowerCase() : "");

/**
 * Index override documents by login for lookup.
 * Accepts an array of documents or an already-built Map (returned as-is).
 */
export function indexOverrides(overrides) {
  if (overrides instanceof Map) return overrides;
  const index = new Map();
  for (const doc of overrides || []) {
    if (doc?.github_login) index.set(norm(doc.github_login), doc);
  }
  return index;
}

/**
 * The extension in force for one override document, or null.
 *
 * The list is append-only and the Admin Panel refuses an extension that is not
 * later than the student's current effective deadline, so the last entry is the
 * one in force - which is also what AdminView and AssignmentDetailView read
 * (`.filter(...).pop()`). A malformed entry is skipped rather than trusted, so a
 * hand-edited file cannot erase an earlier valid grant.
 *
 * @returns {{at: Date, reason: string|null, legacy: boolean}|null}
 */
export function extensionFrom(doc) {
  const entries = Array.isArray(doc?.overrides) ? doc.overrides : [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry?.type !== DEADLINE_EXTENSION) continue;
    const at = toDate(entry.value);
    if (!at) continue;
    return { at, reason: entry.reason ?? null, legacy: false };
  }

  // Pre-2026-06-17 flat shape. `override.schema.json` forbids it now
  // (additionalProperties: false), so no new document can be written this way,
  // but old control repos hold them and dropping it would silently un-extend
  // those students.
  const at = toDate(doc?.deadline_at);
  if (at) return { at, reason: doc.reason ?? null, legacy: true };

  return null;
}

/**
 * The deadline that applies to `login` on `assignment`.
 *
 * For a group assignment the whole team shares one repository, so the most
 * generous extension among its members applies to all of them - locking the
 * repo at anyone else's deadline would lock out the student who was granted the
 * time. Pass the team as `{ members: [...] }`.
 *
 * An extension only ever extends. The old inline version replaced the deadline
 * outright, so a document whose value fell before the assignment deadline would
 * have shortened it; that path was dead, the type is named `deadline_extension`,
 * and failing the other way locks a student out early - the exact bug this
 * module exists to fix.
 *
 * @param {{deadline_at?: string}} assignment
 * @param {string} login
 * @param {{overrides?: Map|Array, team?: {members?: string[]}}} [context]
 * @returns {{deadline: Date|null, base: Date|null, extended: boolean,
 *            reason: string|null, grantedTo: string|null}}
 */
export function effectiveDeadlineFor(assignment, login, { overrides, team } = {}) {
  const base = toDate(assignment?.deadline_at);
  const index = indexOverrides(overrides);

  const logins = new Set();
  if (login) logins.add(norm(login));
  for (const m of team?.members || []) if (m) logins.add(norm(m));

  let best = null;
  let grantedTo = null;
  for (const l of logins) {
    const ext = extensionFrom(index.get(l));
    if (!ext) continue;
    if (!best || ext.at > best.at) {
      best = ext;
      grantedTo = l;
    }
  }

  const extended = !!best && (!base || best.at > base);
  return {
    deadline: extended ? best.at : base,
    base,
    extended,
    reason: extended ? best.reason : null,
    grantedTo: extended ? grantedTo : null,
  };
}

/**
 * The latest instant any student on this assignment is still working towards.
 *
 * Teams are deliberately not consulted: propagating a team's most generous
 * extension to its members can only raise a member to a value already present
 * among the documents, so the maximum is the same either way. That keeps the
 * callers that only have `overrides/` - find-finalizable.mjs - from having to
 * load `teams/` as well.
 *
 * @returns {Date|null} null when nothing extends past the assignment deadline.
 */
export function latestEffectiveDeadline(assignment, overrides) {
  const base = toDate(assignment?.deadline_at);
  let latest = base;
  for (const doc of indexOverrides(overrides).values()) {
    const ext = extensionFrom(doc);
    if (!ext) continue;
    if (!latest || ext.at > latest) latest = ext.at;
  }
  return latest;
}
