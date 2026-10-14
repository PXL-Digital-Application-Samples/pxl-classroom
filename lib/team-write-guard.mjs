// What a Teams-tab write was decided from, asked again of the commit it lands
// on (`commitWithRebase` `precondition`, lib/gittree.mjs).
//
// A write that re-applies the same files to whatever the branch became is
// right for a write that does not care, and wrong for one decided from what it
// read (review 2026-10-14): "Undo copy" deleted a seeded team whose member had
// accepted since the page loaded, so their acceptance named a manifest that no
// longer existed; a member save or a move rewrote a team file a student's join
// or switch had just changed, and the student was listed in two teams.
//
// Isomorphic: the Teams tab calls these with a reader at the parent commit,
// and the test runs them over a map.

import { acceptancesDir, repositoriesDir, teamPath } from "./control-layout.mjs";
import { sameLogin } from "./github-login.mjs";
import { membersWithRecords } from "./team-rename.mjs";

/**
 * The first of `files` whose content at that commit is not the text it was
 * read as (null: it was absent, and must still be), or null when none.
 *
 * @param {object} a
 * @param {(path: string) => Promise<any>} a.get  contents API at that commit: null for a 404, a throw for anything else
 * @param {(b64: string) => string} a.decode
 * @param {Array<{ path: string, text: string|null }>} a.files
 */
export async function changedSinceRead({ get, decode, files }) {
  for (const { path, text } of files) {
    const now = await get(path);
    const nowText = now?.content ? decode(now.content) : null;
    if (nowText !== text) return path;
  }
  return null;
}

/**
 * Why "Undo copy" may not remove these teams at that commit, or null.
 * Each must still be the seeded team it was - there, seeded, no repository,
 * the same members - and no member may have a record of accepting.
 *
 * @param {object} a
 * @param {(path: string) => Promise<any>} a.get
 * @param {(b64: string) => string} a.decode
 * @param {string} a.assignmentId
 * @param {Array<{ team_slug: string, team_name?: string, members?: string[] }>} a.teams  the teams the page decided to remove
 */
export async function unseedRefusalAt({ get, decode, assignmentId, teams }) {
  for (const t of teams) {
    const now = await get(teamPath(assignmentId, t.team_slug));
    if (!now?.content) return `${t.team_name || t.team_slug} is no longer there`;
    let doc;
    try {
      doc = JSON.parse(decode(now.content));
    } catch {
      return `${t.team_name || t.team_slug} could not be read`;
    }
    const was = t.members || [];
    const is = doc?.members || [];
    const sameMembers = was.length === is.length && was.every((m) => is.some((n) => sameLogin(n, m)));
    if (!doc?.seeded_from || doc.repo_name || doc.repo_url || doc.repo_id || !sameMembers) {
      return `${t.team_name || t.team_slug} changed since this page loaded`;
    }
  }
  const members = teams.flatMap((t) => t.members || []);
  for (const dir of [repositoriesDir(assignmentId), acceptancesDir(assignmentId)]) {
    const joined = membersWithRecords(await get(dir), members);
    if (joined.length) return `${joined.join(", ")} accepted since this page loaded`;
  }
  return null;
}
