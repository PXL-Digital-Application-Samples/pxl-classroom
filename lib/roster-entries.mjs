// PXL Classroom - what identifies a roster entry, and how two rosters differ.
//
// Pure and dependency-free - no fs, no fetch, no Node builtins - so the CLI,
// the SPA and workflow scripts all answer "is this the same student?" the same
// way. Imported by cli/src/commands/roster.mjs and re-exported by
// frontend/src/lib/csv.js.
//
// It is shared because the two copies had already forked. Both keyed the diff
// on `student_number` alone and both were written before a roster entry could
// exist without one; the CLI compared entries with a stable stringify while the
// SPA used JSON.stringify, which is key-order sensitive, so a roster whose YAML
// happened to serialise its keys in another order showed EVERY student as
// "updated" in the Admin Panel and as unchanged in the CLI. Same rule, two
// answers, no error either side.
//
// The identity rule itself is the load-bearing part. A promoted entry
// (lib/promote-roster.mjs) has no student_number - under roster_mode: open the
// system never learns one - so keying on it alone maps every promoted student
// onto the key `undefined`: fifty students collapse into one diff row, and the
// import that follows silently removes forty-nine of them.

// The identity rule is imported, not re-derived: `rosterIdentities` is what the
// acceptance gate matches on, and CLAUDE.md's rule is that every surface reading
// that data obeys it - a relaxed match applied on one side only is worse than
// no relaxation. lib/cohort.mjs pulls in nothing but lib/github-login.mjs, so
// this file stays as dependency-free as its header claims.
import { rosterIdentities } from "./cohort.mjs";

/** Where the roster lives in a control repo. One spelling, shared. */
export const ROSTER_PATH = "students/roster.yml";

/** Roster schema version this module reads and writes. */
export const ROSTER_SCHEMA_VERSION = 2;

/**
 * How an entry got onto the roster.
 *
 *   import   - came from a CSV (or was typed in). Carries an institutional
 *              identity: student_number + full_name are required.
 *   accepted - promoted from an acceptance record. All the system knows is a
 *              GitHub login, because roster_mode: open never asked for more.
 *
 * Absent means `import`: every entry written before promotion existed is one,
 * and the schema's required-field rule keys off exactly that.
 *
 * READ, not decorative. It was exported and imported by nobody while
 * `isPromotedEntry` compared against the literal `"accepted"` - a constant
 * describing a rule it did not enforce, which lib/group-config.mjs's header
 * calls a decoy. It is the enum `schemas/roster.schema.json` declares, and
 * tests/roster-entries.test.mjs asserts the two still agree, so changing one
 * without the other now fails rather than drifts.
 */
export const ROSTER_SOURCES = Object.freeze(["import", "accepted"]);

/** The source a promoted entry carries. */
export const PROMOTED_SOURCE = ROSTER_SOURCES[1];

function lower(s) {
  return String(s ?? "").trim().toLowerCase();
}

/**
 * The stable identity of a roster entry, or null when it has none.
 *
 * student_number wins when present: it is the institutional key, survives a
 * student changing their GitHub username, and is what a CSV re-import matches
 * on. A promoted entry has only a login, which is matched case-insensitively
 * because acceptance/accept.mjs's roster gate does
 * (`s.github_login?.toLowerCase() === login.toLowerCase()`) - `Alice` and
 * `alice` are one student to the thing that grants repositories, so they must
 * be one student here too.
 *
 * The `num:` / `login:` prefixes keep the two namespaces apart: a login that
 * happens to read like a student number must not collide with one.
 */
export function rosterKey(student) {
  if (!student || typeof student !== "object") return null;
  const number = String(student.student_number ?? "").trim();
  if (number) return `num:${number}`;
  const login = lower(student.github_login);
  if (login) return `login:${login}`;
  return null;
}

/** True when this entry was promoted from an acceptance rather than imported. */
export function isPromotedEntry(student) {
  return student?.source === PROMOTED_SOURCE;
}

/**
 * How an entry should be named in a diff, a prompt or a log line.
 *
 * A promoted entry has neither a student number nor a full name, so the
 * previous `${s.student_number}  ${s.full_name}` printed "undefined undefined"
 * for it - in the removal list of a CSV import, which is the one place a
 * lecturer is being asked to confirm a destructive change.
 */
export function describeRosterEntry(student) {
  if (!student || typeof student !== "object") return "(malformed entry)";
  const parts = [];
  const number = String(student.student_number ?? "").trim();
  const name = String(student.full_name ?? "").trim();
  if (number) parts.push(number);
  if (name) parts.push(name);
  const login = String(student.github_login ?? "").trim();
  if (login) parts.push(`@${login}`);
  if (parts.length === 0) return "(unidentified entry)";
  return parts.join("  ");
}

// Key-order-independent comparison. JSON.stringify is not: two entries holding
// the same fields in a different order compare unequal, which is how the SPA
// reported a whole unchanged roster as updated.
function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

export { stableStringify };

/**
 * Diff two roster documents by entry identity, and produce the document to
 * commit.
 *
 * MATCHED ON ANY IDENTITY A ROW CARRIES, not on one canonical key. `rosterKey`
 * prefers `num:` and falls back to `login:`, so a CSV row - which always has a
 * student_number, `rowsToRoster` requires one - keyed `num:0123456` could never
 * meet the promoted row for the same person keyed `login:alice`. The import
 * ADDED one and REMOVED the other: two rows for one student, and where the CSV
 * carried no `github_login` column, the login was simply gone - the one fact
 * the promoted row existed to hold. `rosterIdentities` is the same judge the
 * acceptance gate uses, which is the point: a relaxed match applied on one side
 * only is worse than no relaxation.
 *
 * MERGED, NEVER REPLACED. A matched entry is the stored one spread under the
 * incoming one, so the CSV wins for every column it carries and everything else
 * survives - the login, `source: accepted`, a class group set in the table. It
 * is safe because a CSV cannot express a deletion: `coerceCell` omits an empty
 * cell, so an absent column and a blank cell are the same thing and neither can
 * mean "clear this". Removing a whole student is what the `removed` list is for,
 * and both surfaces confirm it.
 *
 * `merged` IS THE DOCUMENT TO COMMIT. It is returned rather than left for each
 * caller to rebuild, because the previous shape - preview here, write your own
 * document there - is exactly how a diff and a write come to disagree.
 *
 * Entries with no identity at all cannot be matched against anything, so they
 * are reported separately as `unkeyed` rather than folded into added/removed -
 * a roster holding one is malformed, and saying so beats inventing a pairing.
 * Unkeyed incoming entries are still carried into `merged`: refusing to write
 * them would turn a malformed row into a silent deletion.
 */
export function diffRosters(current, next) {
  const unkeyed = { current: [], next: [] };

  // Every identity of every current entry, so either one can match. The entry
  // itself is the value, so two keys pointing at one row are one row.
  const byIdentity = new Map();
  const currentKeyed = [];
  for (const s of current?.students ?? []) {
    const ids = rosterIdentities(s);
    if (ids.length === 0) { unkeyed.current.push(s); continue; }
    currentKeyed.push(s);
    for (const id of ids) if (!byIdentity.has(id)) byIdentity.set(id, s);
  }

  const added = [];
  const updated = [];
  const students = [];
  // A current entry may be claimed once. Two incoming rows naming one student
  // would otherwise both merge into it and write it twice.
  const claimed = new Set();

  for (const entry of next?.students ?? []) {
    const ids = rosterIdentities(entry);
    if (ids.length === 0) { unkeyed.next.push(entry); students.push(entry); continue; }

    const prev = ids.map((id) => byIdentity.get(id)).find((e) => e && !claimed.has(e));
    if (!prev) {
      added.push(entry);
      students.push(entry);
      continue;
    }
    claimed.add(prev);
    const mergedEntry = { ...prev, ...entry };
    // `email_source` records where the address beside it came from - a claim,
    // or a commit. An import setting a DIFFERENT address makes that marker
    // describe a value the row no longer holds, and a stale provenance marker
    // is worse than none: it is confidently wrong. A person put this one here.
    if (entry.email && lower(entry.email) !== lower(prev.email)) delete mergedEntry.email_source;
    students.push(mergedEntry);
    if (stableStringify(prev) !== stableStringify(mergedEntry)) {
      updated.push({ before: prev, after: mergedEntry });
    }
  }

  const removed = currentKeyed.filter((s) => !claimed.has(s));

  return {
    added,
    updated,
    removed,
    unkeyed,
    // The document-level fields come from `next`: an import decides the schema
    // version it writes, and nothing else lives up there.
    merged: { ...(next ?? {}), students },
  };
}
