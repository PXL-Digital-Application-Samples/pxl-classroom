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

import { acceptancesDir, repositoriesDir, teamPath, teamsDir } from "./control-layout.mjs";
import { sameLogin } from "./github-login.mjs";
import { membersWithRecords } from "./team-rename.mjs";

/**
 * A `get` for these guards: the contents API at the commit a precondition is
 * asked about, through `commitWithRebase`'s own `request`. Null for a 404; any
 * other failure throws, which refuses the write.
 *
 * @param {(route: string, params: object) => Promise<{ data: any }>} request
 * @param {string} parentSha
 * @param {string} owner
 * @param {string} repo
 */
export function contentsAt(request, parentSha, owner, repo) {
  return async (path) => {
    try {
      const r = await request(`GET /repos/{owner}/{repo}/contents/${String(path).split("/").map(encodeURIComponent).join("/")}`, { owner, repo, ref: parentSha });
      return r.data;
    } catch (e) {
      if (e?.status === 404) return null;
      throw e;
    }
  };
}

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
 * Why a seed (Copy teams, `pxl-classroom teams seed`) may not write its teams
 * at that commit, or null (review 2026-10-14, S4). The plan was made from what
 * was read, and the CLI's waits at a prompt for as long as the lecturer takes:
 * a student who created or joined one of those teams in between was
 * overwritten, and one who joined another team was listed in two.
 *
 * Every file it writes must still be absent, or still the kind `planSeed`
 * overwrites (nobody in it, no repository named); and no seeded student may be
 * in any other team file there.
 *
 * @param {object} a
 * @param {(path: string) => Promise<any>} a.get  contents API at that commit: null for a 404 (a directory reads as its listing)
 * @param {(b64: string) => string} a.decode
 * @param {string} a.assignmentId
 * @param {Array<{ team_slug: string, team_name?: string, members?: string[] }>} a.teams  the teams the seed writes
 */
export async function seedRefusalAt({ get, decode, assignmentId, teams }) {
  const read = async (path) => {
    const now = await get(path);
    if (!now?.content) return { absent: true };
    try {
      return { doc: JSON.parse(decode(now.content)) };
    } catch {
      return { unreadable: true };
    }
  };
  const planned = new Set(teams.map((t) => String(t.team_slug).toLowerCase()));
  for (const t of teams) {
    const r = await read(teamPath(assignmentId, t.team_slug));
    if (r.absent) continue;
    if (r.unreadable) return `${t.team_name || t.team_slug} could not be read`;
    const d = r.doc;
    if ((d?.members || []).length || d?.repo_name || d?.repo_id) {
      return `${t.team_name || t.team_slug} was made or joined since the plan was made`;
    }
  }
  const seeded = teams.flatMap((t) => t.members || []);
  const listing = await get(teamsDir(assignmentId));
  for (const entry of Array.isArray(listing) ? listing : []) {
    const name = String(entry?.name || "");
    if (!name.endsWith(".json") || planned.has(name.slice(0, -5).toLowerCase())) continue;
    const r = await read(teamPath(assignmentId, name.slice(0, -5)));
    if (r.unreadable) return `${name.slice(0, -5)} could not be read`;
    const inBoth = (r.doc?.members || []).filter((m) => seeded.some((s) => sameLogin(s, m)));
    if (inBoth.length) return `${inBoth.join(", ")} joined ${r.doc?.team_name || name.slice(0, -5)} since the plan was made`;
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
    // "Since the teams were read", not "since this page loaded": the CLI's
    // `teams unseed` asks this too, and has no page.
    if (!doc?.seeded_from || doc.repo_name || doc.repo_url || doc.repo_id || !sameMembers) {
      return `${t.team_name || t.team_slug} changed since the teams were read`;
    }
  }
  const members = teams.flatMap((t) => t.members || []);
  for (const dir of [repositoriesDir(assignmentId), acceptancesDir(assignmentId)]) {
    const joined = membersWithRecords(await get(dir), members);
    if (joined.length) return `${joined.join(", ")} accepted since the teams were read`;
  }
  return null;
}
