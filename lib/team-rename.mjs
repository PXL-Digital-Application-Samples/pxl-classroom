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

import { acceptancesDir, repositoriesDir, teamPath } from "./control-layout.mjs";
import { sameLogin } from "./github-login.mjs";

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
 * @param {(login: string) => string} [label]  how a member is named (the Teams tab: their address where known)
 */
export function renameBlocker(team, accepted, label = (m) => `@${m}`) {
  if (team?.repo_name || team?.repo_id) return "its repository already exists, under the current name";
  const joined = (team?.members || []).filter((m) => accepted(m));
  if (joined.length) {
    return `${joined.map(label).join(", ")} ${joined.length === 1 ? "has" : "have"} accepted, so its repository is named after the current name`;
  }
  return null;
}

/**
 * The members of `members` with a record among `fileNames` (the `.json` files
 * of `repositories/<id>/` and `acceptances/<id>/`, filed under the login as
 * GitHub spells it). ONE answer to "has a member accepted?", asked at the
 * click and again of the commit the rename lands on.
 *
 * @param {Array<{ name?: string, type?: string }>} entries  a directory listing
 * @param {string[]} members
 */
export function membersWithRecords(entries, members) {
  const names = (Array.isArray(entries) ? entries : [])
    .filter((f) => (f?.type === undefined || f.type === "file") && String(f?.name || "").endsWith(".json"))
    .map((f) => f.name.slice(0, -".json".length));
  return (members || []).filter((m) => names.some((n) => sameLogin(n, m)));
}

/**
 * Asked of the commit a rename is about to land on (`commitWithRebase`
 * `precondition`): the reason it may not, or null. What the rename was decided
 * from - the team file as read, no team at the new name, no member with a
 * record - must still hold there; a seeded member accepting in between left
 * their acceptance naming a manifest the rename deleted (review 2026-10-14).
 *
 * @param {object} a
 * @param {(path: string) => Promise<any>} a.get  the contents API at that commit: null for a 404, a throw for anything unreadable
 * @param {(b64: string) => string} a.decode
 * @param {string} a.assignmentId
 * @param {string} a.storedSlug
 * @param {string} a.storedText  the team file exactly as the rename read it
 * @param {string} a.newSlug
 * @param {string[]} a.members
 */
export async function renameRefusalAt({ get, decode, assignmentId, storedSlug, storedText, newSlug, members }) {
  const now = await get(teamPath(assignmentId, storedSlug));
  if (!now?.content || decode(now.content) !== storedText) return "the team was changed while you renamed it; open it again";
  if (newSlug !== storedSlug && (await get(teamPath(assignmentId, newSlug)))) return `a team called ${newSlug} was made meanwhile`;
  for (const dir of [repositoriesDir(assignmentId), acceptancesDir(assignmentId)]) {
    if (membersWithRecords(await get(dir), members).length) {
      return "a member accepted meanwhile, so its repository is named after the current name";
    }
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
 * @param {string[]} [a.reservedSlugs]  the slugs other teams had before THEIR rename (`renamed_from`)
 * @param {(login: string) => boolean} a.accepted
 * @param {(login: string) => string} [a.label]
 * @returns {{ ok: true, slug: string, doc: object, changes: Array<{path: string, content: string|null}> }
 *   | { ok: false, reason: string }}
 */
export function planTeamRename({ team, newName, assignmentId, otherSlugs = [], reservedSlugs = [], accepted, label }) {
  const blocked = renameBlocker(team, accepted, label);
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
  // A page loaded before another team's rename still sends its old slug, and
  // acceptance takes that as the renamed team for its members - so the old
  // name stays theirs (review 2026-10-14).
  if (reservedSlugs.map((s) => String(s).toLowerCase()).includes(slug)) {
    return { ok: false, reason: `another team in this assignment was called that until it was renamed (${slug})` };
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
