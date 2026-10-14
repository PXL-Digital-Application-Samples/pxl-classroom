// Renaming a team on the Teams tab - only while nobody in it has accepted.
//
// Asked 2026-10-12: teams copied from another assignment carried one wrong
// name, and the only way to fix it was to create the right team, move every
// member and delete the wrong one. Before anyone in a team accepts, nothing
// hangs on its name: no repository (it is named after the slug at the first
// acceptance, `repository_name_pattern` with `{team_slug}`), no acceptance
// record, no join code a student keeps. So the name AND the slug change in one
// commit - the manifest written under the new slug, the old file removed.
//
// After anyone accepted, the repository carries the old slug, and a new name
// on the page beside an old name on GitHub is the confusion this avoids: the
// rename is refused and says why (decided 2026-10-12).
//
// Isomorphic: the Teams tab calls it, and the test runs it.

import { teamPath } from "./control-layout.mjs";

/** The slug a team name makes - the same rule acceptance/accept.mjs applies to a typed name. */
export function teamSlug(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Why this team cannot be renamed now, or null when it can.
 *
 * @param {{ repo_name?: string|null, repo_id?: number|null, members?: string[] }} team  the stored manifest
 * @param {(login: string) => boolean} accepted  whether a member has accepted
 */
export function renameBlocker(team, accepted) {
  if (team?.repo_name || team?.repo_id) return "its repository already exists, under the current name";
  const joined = (team?.members || []).filter((m) => accepted(m));
  if (joined.length) {
    return `${joined.map((m) => `@${m}`).join(", ")} ${joined.length === 1 ? "has" : "have"} accepted, so its repository is named after the current name`;
  }
  return null;
}

/**
 * The commit a rename makes, or why it cannot.
 *
 * @param {object} a
 * @param {import("./types.mjs").Team} a.team  the stored manifest, read at the click
 * @param {string} a.newName
 * @param {string} a.assignmentId
 * @param {string[]} a.otherSlugs  every other team's slug in this assignment
 * @param {(login: string) => boolean} a.accepted
 * @returns {{ ok: true, slug: string, doc: object, changes: Array<{path: string, content: string|null}> }
 *   | { ok: false, reason: string }}
 */
export function planTeamRename({ team, newName, assignmentId, otherSlugs = [], accepted }) {
  const blocked = renameBlocker(team, accepted);
  if (blocked) return { ok: false, reason: blocked };
  const name = String(newName || "").trim().replace(/\s+/g, " ");
  if (!name) return { ok: false, reason: "the new name is empty" };
  if (name.length > 100) return { ok: false, reason: "the new name is longer than 100 characters" };
  const slug = teamSlug(name);
  if (!SLUG.test(slug)) return { ok: false, reason: "the new name needs at least one letter or digit, and at most 64 of them" };
  if (name === team.team_name && slug === team.team_slug) return { ok: false, reason: "that is already its name" };
  if (slug !== team.team_slug && otherSlugs.map((s) => String(s).toLowerCase()).includes(slug)) {
    return { ok: false, reason: `another team in this assignment is already called that (${slug})` };
  }
  // The slug it had, kept: a student page loaded before the rename still names
  // it, and acceptance takes it as this team for a member (review 2026-10-14) -
  // a pre-assigned student was refused as "not your team", a self-service one
  // made a new team under the old name, alone.
  const before = [...new Set([...(team.renamed_from || []), team.team_slug])].filter((s) => s !== slug).slice(-20);
  const doc = { ...team, team_slug: slug, team_name: name, ...(slug !== team.team_slug ? { renamed_from: before } : {}) };
  const json = JSON.stringify(doc, null, 2) + "\n";
  const changes = slug === team.team_slug
    ? [{ path: teamPath(assignmentId, slug), content: json }]
    : [{ path: teamPath(assignmentId, slug), content: json }, { path: teamPath(assignmentId, team.team_slug), content: null }];
  return { ok: true, slug, doc, changes };
}
