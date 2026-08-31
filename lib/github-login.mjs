// PXL Classroom - one spelling rule for a GitHub login.
//
// GitHub logins are CASE-INSENSITIVE: `Alice-PXL` and `alice-pxl` are one
// account, and GitHub will hand you either spelling depending on which surface
// you asked. A lecturer types one into a roster CSV; the acceptance dispatch
// carries the canonical one; the two need not match.
//
// Every gate in this system already knew that and spelled it by hand -
// `s.github_login?.toLowerCase() === login.toLowerCase()` in accept.mjs,
// `norm()` inside effective-deadline.mjs, `lower()` in seed-teams.mjs and
// roster-entries.mjs, `m.toLowerCase()` in report.mjs's team index. Five
// copies, and report.mjs's four OTHER indexes did not have one:
//
//     rosterByLogin    keyed "Alice-PXL"   (what the lecturer typed)
//     acceptanceByLogin keyed "alice-pxl"  (what GitHub dispatched)
//
// and `allLogins` was their union. One student became two rows - a phantom
// `not-accepted` row holding the name and student number, and the real
// acceptance row holding neither. `total_students` and `no_submission` both
// doubled, the dashboard inherited the inflated count, and the CSV export lost
// the identity of every student whose roster casing differed.
//
// So the rule lives here: a login is COMPARED and INDEXED lowercased, and
// DISPLAYED as whichever spelling the most authoritative source gave. The two
// are different jobs and conflating them is the bug above.
//
// Pure, dependency-free and isomorphic - no fs, no fetch, no Node builtins.

/**
 * The comparison/index key for a login. "" for anything that is not a string,
 * so callers get one falsy answer rather than three.
 */
export function normalizeLogin(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/** Are these two spellings the same GitHub account? Empty never matches. */
export function sameLogin(a, b) {
  const left = normalizeLogin(a);
  return left !== "" && left === normalizeLogin(b);
}

/**
 * Index records by login key, skipping records with no usable login.
 *
 * @param {Iterable<object>} records
 * @param {(record: object) => unknown} [pick] how to read the login off a record
 * @returns {Map<string, object>} keyed by normalizeLogin
 */
export function indexByLogin(records, pick = (r) => r?.github_login) {
  const index = new Map();
  for (const record of records || []) {
    const key = normalizeLogin(pick(record));
    if (key) index.set(key, record);
  }
  return index;
}

/**
 * Collect the spelling to SHOW for each login key.
 *
 * Sources are supplied most-authoritative first and the first non-empty
 * spelling for a key wins, so a login GitHub gave us beats one a lecturer
 * typed. Returns a Map keyed the same way indexByLogin keys.
 *
 * @param {...Iterable<unknown>} sources login spellings, best source first
 * @returns {Map<string, string>} key -> display spelling
 */
export function displayLogins(...sources) {
  const display = new Map();
  for (const source of sources) {
    for (const raw of source || []) {
      const key = normalizeLogin(raw);
      if (!key || display.has(key)) continue;
      display.set(key, typeof raw === "string" ? raw.trim() : key);
    }
  }
  return display;
}
