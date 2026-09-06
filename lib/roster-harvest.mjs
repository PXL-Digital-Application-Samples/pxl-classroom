// PXL Classroom - what the reports already know about a login-only roster row.
//
// A roster row promoted from an acceptance carries a `github_login` and nothing
// else, and nothing fills it in afterwards: promotion skips rows it has already
// seen (planPromotion Rule 1, deliberately), and a claim is joined to a roster
// entry BY EMAIL - so a row with no email can never receive one. The lecturer
// was left reading "Not yet identified" six times with no route that did not
// start with typing.
//
// The reports know more than that. `collect.mjs` records the author of each
// student's latest commit, discards the provisioning bot and any
// `noreply.github.com` address, and falls back to the account's public GitHub
// profile - so `author_name` / `author_email` is already the best available
// guess, per assignment, gathered for free.
//
// TWO RULES, AND THEY ARE DIFFERENT RULES.
//
//   SHOWING. Show everything found, minus what repeats the login. The domain
//   check decides what gets WRITTEN, never what gets seen: an address whose
//   domain is a typo is still the string that tells a lecturer which student
//   this is - `rayane.waddah@student.pxl` names a person instantly, and hiding
//   it because `student.pxl` does not resolve would throw away the only useful
//   thing on that row.
//
//   WRITING. Only an address `domainAllowed()` accepts may be written into
//   `email`, because that field is the join key for claims
//   (planClaimPromotion does `byEmail.get(entry.email)`). A wrong address there
//   means a real claim never matches it, and under `roster_mode: claim` the
//   student is REJECTED at acceptance. A wrong address is worse than none.
//
// And a value is only ever PROPOSED. A git author email is whatever the student
// typed into `git config` - plausible is not proven.
//
// Isomorphic and dependency-free: the Roster tab reads it through
// `frontend/src/lib/roster-harvest.js`, and the domain check is passed in
// rather than imported so this module keeps no opinion about configuration.

const lower = (v) => String(v ?? "").trim().toLowerCase();

/**
 * Does this value tell a reader anything the login has not already told them?
 *
 * `IlkayDuranPXL@github.com` beside `@IlkayDuranPXL` is the login twice; so is
 * an `author_name` of `rayaneW` beside `@rayaneW`, which is what a student who
 * never set `git config user.name` produces. Rendering those fills the column
 * and adds nothing.
 *
 * Compared as written, lowercased, and NOT stripped of separators: a profile
 * name of `Lowie Serneels` beside `@LowieSerneelsPXL` is the same person spelled
 * readably, and that is worth showing.
 *
 * @param {string|null} value  a name, or the local part of an address
 * @param {string} login
 * @returns {boolean}
 */
export function addsInformation(value, login) {
  const v = lower(value);
  if (!v) return false;
  return v !== lower(login);
}

/** The part of an address before the `@`. */
export function emailLocalPart(email) {
  const s = String(email ?? "").trim();
  const at = s.lastIndexOf("@");
  return at > 0 ? s.slice(0, at) : s;
}

/**
 * Everything the reports know, per login, newest report first.
 *
 * `reports` is `[{ assignment_id, generated_at, students }]`. A student appears
 * in several, so the one with the most commits wins: an assignment they
 * actually worked in carries their real git identity, while one they accepted
 * and never touched carries only the profile fallback.
 *
 * @param {Array<object>} reports
 * @returns {Map<string, {login: string, name: string|null, email: string|null,
 *                        assignmentId: string|null, commitCount: number}>}
 */
export function harvestFromReports(reports) {
  const best = new Map();
  for (const report of Array.isArray(reports) ? reports : []) {
    const assignmentId = typeof report?.assignment_id === "string" ? report.assignment_id : null;
    for (const s of Array.isArray(report?.students) ? report.students : []) {
      const login = typeof s?.github_login === "string" ? s.github_login.trim() : "";
      if (!login) continue;
      const name = typeof s.author_name === "string" && s.author_name.trim() ? s.author_name.trim() : null;
      const email = typeof s.author_email === "string" && s.author_email.trim() ? s.author_email.trim() : null;
      if (!name && !email) continue;

      const commitCount = Number.isFinite(s.commit_count) ? s.commit_count : 0;
      const key = lower(login);
      const prev = best.get(key);
      // Strictly greater, so the first report wins a tie and the walk order is
      // what decides - not whichever happened to be read last.
      if (prev && prev.commitCount >= commitCount) continue;
      best.set(key, { login, name, email, assignmentId, commitCount });
    }
  }
  return best;
}

/**
 * What to show beside each roster row, and what may be written.
 *
 * A row is only considered for a field it does NOT already have: this fills
 * blanks and never overwrites, because a value a lecturer typed or imported
 * outranks one read off a commit.
 *
 * @param {object} args
 * @param {object|null} args.roster              parsed students/roster.yml
 * @param {Array<object>} args.reports
 * @param {(email: string) => boolean} [args.emailAllowed]  domainAllowed(), bound to the deployment's domains
 * @returns {{hints: Array<object>, fillable: Array<{login: string, email: string}>}}
 */
export function harvestPlan({ roster = null, reports = [], emailAllowed = () => false } = {}) {
  const found = harvestFromReports(reports);
  const hints = [];
  const fillable = [];

  for (const s of Array.isArray(roster?.students) ? roster.students : []) {
    const login = typeof s?.github_login === "string" ? s.github_login.trim() : "";
    if (!login) continue;
    const hit = found.get(lower(login));
    if (!hit) continue;

    // Blanks only. A name or address already on the row was put there by a
    // person or a CSV, and both outrank a git config field.
    const wantsName = !String(s.full_name ?? "").trim();
    const wantsEmail = !String(s.email ?? "").trim();
    if (!wantsName && !wantsEmail) continue;

    const name = wantsName && addsInformation(hit.name, login) ? hit.name : null;
    const email = wantsEmail && addsInformation(emailLocalPart(hit.email), login) ? hit.email : null;
    if (!name && !email) continue;

    const allowed = email ? Boolean(emailAllowed(email)) : false;
    hints.push({
      login,
      name,
      email,
      // Shown either way; this only says whether it may be written.
      emailAllowed: allowed,
      assignmentId: hit.assignmentId,
      commitCount: hit.commitCount,
    });
    if (email && allowed) fillable.push({ login, email });
  }

  return { hints, fillable };
}

/**
 * The roster with the fillable addresses written in.
 *
 * MERGE, NEVER REPLACE: the stored row is spread and one field is overridden,
 * so a `class_group`, a `team_slug` or anything else nobody listed here
 * survives (CLAUDE.md). Returns a new document; the caller validates it against
 * the schema before committing, as every other write here does.
 *
 * @param {object} roster
 * @param {Array<{login: string, email: string}>} fillable
 * @returns {object}
 */
export function applyHarvest(roster, fillable) {
  const byLogin = new Map((Array.isArray(fillable) ? fillable : []).map((f) => [lower(f.login), f.email]));
  if (byLogin.size === 0) return roster;
  return {
    ...roster,
    students: (Array.isArray(roster?.students) ? roster.students : []).map((s) => {
      const email = byLogin.get(lower(s?.github_login));
      // Guard the write on the field still being empty: the plan was built
      // against a roster read earlier, and the one being written may have
      // gained the address in between.
      if (!email || String(s?.email ?? "").trim()) return s;
      return { ...s, email };
    }),
  };
}
