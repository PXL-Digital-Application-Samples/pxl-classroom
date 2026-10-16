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
