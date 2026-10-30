// The name a student's or a team's repository gets, from the assignment's
// `repository_name_pattern`.
//
// ONE SPELLING (review 2026-10-14): acceptance named the repository with its
// own function, while the team card, the Teams tab's rename preview and the
// student page each wrote the substitution again - with a different fallback
// for a missing pattern (`<id>-{team_slug}` where acceptance used the bare
// slug). The pattern is required, so the fallback is acceptance's, kept for a
// document that has none. Isomorphic: no imports.

/**
 * @param {string|null|undefined} pattern  `repository_name_pattern`
 * @param {{ teamSlug?: string|null, login?: string|null }} who
 *   the team's slug for a team repository, and the login of the student
 *   accepting or viewing (a team pattern may name `{github_login}` too, and
 *   every caller gives that student's). On a team assignment whose pattern
 *   names `{github_login}`, the repository is named after the member who
 *   accepts first, and a teammate's page works out a name from their own login
 *   that does not exist. The form allows it and it is rare, so it is accepted
 *   rather than refused.
 */
export function repositoryNameFor(pattern, { teamSlug = null, login = null } = {}) {
  const subject = teamSlug || login || "";
  if (!pattern) return subject;
  return String(pattern)
    .replace("{team_slug}", subject)
    .replace("{github_login}", login || subject);
}

/**
 * Repositories a student can reach that the pattern made for some OTHER login,
 * each with that login. For an individual assignment these are either a
 * classmate's they were added to or their own from before they renamed their
 * account; `renamedOwnRepo` tells which, once somebody has asked GitHub who those
 * logins are.
 *
 * Only `prefix{github_login}suffix`, in this organization. Not a name ending in
 * their own login: `lab-2-ann` is another assignment's repository of Ann's, not
 * `lab-{github_login}` for an account called `2-ann`.
 *
 * @param {Array<{name?: string, owner?: {login?: string}}>} repos
 * @param {{ org: string, pattern: string|null|undefined, login: string }} who
 * @returns {Array<{repo: object, login: string}>}
 */
export function renamedRepoCandidates(repos, { org, pattern, login }) {
  const parts = String(pattern ?? "").split("{github_login}");
  if (parts.length !== 2 || /[{}]/.test(parts[0] + parts[1])) return [];
  const [prefix, suffix] = parts.map((p) => p.toLowerCase());
  const today = repositoryNameFor(pattern, { login }).toLowerCase();
  const own = `-${String(login ?? "").toLowerCase()}`;
  const found = [];
  for (const repo of repos || []) {
    const original = String(repo?.name ?? "");
    const name = original.toLowerCase();
    if (String(repo?.owner?.login ?? "").toLowerCase() !== String(org ?? "").toLowerCase()) continue;
    if (name === today || name.length <= prefix.length + suffix.length) continue;
    if (!name.startsWith(prefix) || !name.endsWith(suffix)) continue;
    const carried = original.slice(prefix.length, original.length - suffix.length);
    if (carried.toLowerCase().endsWith(own)) continue;
    found.push({ repo, login: carried });
  }
  return found;
}

/**
 * The repository a student had before renaming their account. It keeps the name
 * it was given (lib/login-rename.mjs), so the name the pattern makes from today's
 * login does not exist, and a page that stopped there offered Accept over their
 * work.
 *
 * WHAT MAKES IT THEIRS IS THAT NOBODY HOLDS THE NAME IT WAS MADE FOR. A classmate's
 * repository they were added to fits the pattern just as well, and its login is a
 * living account. `goneLogins` is the lowercased logins GitHub answered 404 for.
 * Exactly one, or null: null is "not known", the caller offers Accept as usual, and
 * the hub decides from the record by account id. A name somebody has since
 * registered lands there too, which is the safe side.
 *
 * @param {Array<{name?: string, owner?: {login?: string}}>} repos
 * @param {{ org: string, pattern: string|null|undefined, login: string }} who
 * @param {Set<string>} [goneLogins]
 * @returns {object|null}
 */
export function renamedOwnRepo(repos, who, goneLogins = new Set()) {
  const fits = renamedRepoCandidates(repos, who).filter((c) => goneLogins.has(c.login.toLowerCase()));
  return fits.length === 1 ? fits[0].repo : null;
}
