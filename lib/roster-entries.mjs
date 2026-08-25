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
 */
export const ROSTER_SOURCES = ["import", "accepted"];

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
  return student?.source === "accepted";
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
 * Diff two roster documents by entry identity.
 *
 * Entries with no identity at all (no student_number, no github_login) cannot
 * be matched against anything, so they are reported separately as `unkeyed`
 * rather than folded into added/removed - a roster holding one is malformed,
 * and saying so beats inventing a pairing.
 */
export function diffRosters(current, next) {
  const currentMap = new Map();
  const nextMap = new Map();
  const unkeyed = { current: [], next: [] };

  for (const s of current?.students ?? []) {
    const key = rosterKey(s);
    if (key === null) unkeyed.current.push(s);
    else currentMap.set(key, s);
  }
  for (const s of next?.students ?? []) {
    const key = rosterKey(s);
    if (key === null) unkeyed.next.push(s);
    else nextMap.set(key, s);
  }

  const added = [];
  const updated = [];
  const removed = [];

  for (const [key, entry] of nextMap) {
    const prev = currentMap.get(key);
    if (!prev) added.push(entry);
    else if (stableStringify(prev) !== stableStringify(entry)) {
      updated.push({ before: prev, after: entry });
    }
  }
  for (const [key, entry] of currentMap) {
    if (!nextMap.has(key)) removed.push(entry);
  }

  return { added, updated, removed, unkeyed };
}
