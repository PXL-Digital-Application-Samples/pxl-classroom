// WHICH MEMBER'S ROW SPEAKS FOR A TEAM'S REPOSITORY.
//
// A team row's submission status, commit count and preservation are the
// repository's, and every member working in that repository has the same
// observations. So any member whose row is ON the team's repository can speak
// for it - and a member whose row is not, cannot.
//
// Both report.mjs and the lecturer's live refresh took `memberStudents[0]`, the
// alphabetically first member. In a seeded team that is often somebody who has
// not accepted yet: no repository, no observations, so the team read
// "No submission" with no commits and no preservation while their teammates had
// pushed. And after a move it could be a member whose record still named
// another team's repository.
//
// Returns null when no member has a row on the repository - the same rule as
// every "pick ours out of the list" helper here: `|| rows[0]` would turn "nobody
// has provisioned yet" into somebody else's numbers.
//
// Pure and isomorphic: report.mjs and the SPA both import it.

import { normalizeLogin } from "./github-login.mjs";

/** `owner/name` or a bare `name`, compared on the name, case-insensitively. */
function repoKey(value) {
  if (typeof value !== "string") return "";
  const name = value.includes("/") ? value.slice(value.lastIndexOf("/") + 1) : value;
  return name.trim().toLowerCase();
}

/**
 * @param {{members?: unknown[], repo_name?: unknown}} team
 * @param {Array<{github_login?: unknown, repo_name?: unknown}>} students  report rows
 * @returns {any} the member row to read the repository's columns from, or null
 */
export function teamRepresentative(team, students) {
  const members = new Set((team?.members || []).map(normalizeLogin).filter(Boolean));
  const rows = (students || []).filter((s) => members.has(normalizeLogin(s?.github_login)));
  const teamRepo = repoKey(team?.repo_name);
  if (teamRepo) return rows.find((s) => repoKey(s?.repo_name) === teamRepo) ?? null;
  // No repository on the manifest yet (a lagging stamp): any member who has one.
  return rows.find((s) => repoKey(s?.repo_name)) ?? null;
}
