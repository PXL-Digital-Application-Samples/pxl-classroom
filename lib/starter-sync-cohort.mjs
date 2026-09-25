// PXL Classroom - the reads a per-student starter sync needs.
//
// lib/starter-sync.mjs decides; this reads. Transport-agnostic the way
// lib/submission-marker.mjs is: every function takes `get(path)` resolving
// `{ ok?, status, data, headers? }`, so the SPA's pre-flight, the workflow
// script and the CLI all read the same way and plan from the same inputs.
// Isomorphic: no `node:` imports (a static one here is a blank page).

import { diffTreePaths, planStarterSync, resolveSelection, startingPointFor } from "./starter-sync.mjs";

// planStarterSync is called here and nowhere else outside lib/starter-sync.mjs:
// the three surfaces go through planStudent (tests/sync-starter.test.mjs).

const PER_PAGE = 100;
const MAX_PAGES = 10;

const okStatus = (res) => res && res.status >= 200 && res.status < 300;

/** A header off a fetch `Headers`, a plain object, or nothing. */
function header(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get(name);
  return headers[name] ?? headers[name.toLowerCase()] ?? null;
}

/**
 * Every template commit on its default branch, newest first, with its tree.
 * `complete: false` when the walk hit its cap; the caller may still use what it
 * has - an unmatched first commit only falls back to the old behaviour.
 *
 * @returns {Promise<{ok: boolean, status: number, complete: boolean,
 *           commits: Array<{sha: string, treeSha: string, date: string|null}>}>}
 */
export async function listTemplateCommits(get, templateFullName) {
  const commits = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await get(`/repos/${templateFullName}/commits?per_page=${PER_PAGE}&page=${page}`);
    if (!okStatus(res)) return { ok: false, status: res?.status ?? 0, complete: false, commits };
    const rows = Array.isArray(res.data) ? res.data : [];
    for (const c of rows) {
      commits.push({
        sha: c.sha,
        treeSha: c?.commit?.tree?.sha ?? null,
        date: c?.commit?.committer?.date ?? c?.commit?.author?.date ?? null,
      });
    }
    if (rows.length < PER_PAGE) return { ok: true, status: 200, complete: true, commits };
  }
  return { ok: true, status: 200, complete: false, commits };
}

/**
 * The tree of a repository's FIRST commit on `branch`, or null.
 *
 * Two requests: one commit per page makes the `last` link's page number the
 * commit count, and that page is the oldest commit. A repository with a single
 * commit sends no `last` link, and the first page already is it.
 */
export async function rootTreeSha(get, repoFullName, branch = "main") {
  const first = await get(`/repos/${repoFullName}/commits?sha=${encodeURIComponent(branch)}&per_page=1`);
  if (!okStatus(first)) return null;
  const last = String(header(first.headers, "link") || "").match(/[?&]page=(\d+)>;\s*rel="last"/);
  let row = Array.isArray(first.data) ? first.data[0] : null;
  if (last) {
    const res = await get(`/repos/${repoFullName}/commits?sha=${encodeURIComponent(branch)}&per_page=1&page=${last[1]}`);
    if (!okStatus(res)) return null;
    row = Array.isArray(res.data) ? res.data[0] : null;
  }
  return row?.commit?.tree?.sha ?? null;
}

/**
 * `path -> blob sha` for one commit, cached per commit, throwing on a failed
 * or TRUNCATED read: a partial listing would make every unlisted path look
 * absent, which reads as "the student deleted it".
 */
export function treeReader(get) {
  const cache = new Map();
  return (repoFullName, ref) => {
    const key = `${repoFullName}@${ref}`;
    if (!cache.has(key)) {
      cache.set(
        key,
        (async () => {
          const res = await get(`/repos/${repoFullName}/git/trees/${encodeURIComponent(ref)}?recursive=1`);
          if (!okStatus(res)) throw new Error(`could not read the tree of ${repoFullName}@${String(ref).slice(0, 7)} (HTTP ${res?.status ?? 0})`);
          if (res.data?.truncated) throw new Error(`tree listing for ${repoFullName} was truncated - too many files to sync safely`);
          const map = new Map();
          for (const e of res.data?.tree || []) if (e.type === "blob") map.set(e.path, e.sha);
          return map;
        })(),
      );
      // A failed read is not cached: the next student may ask again.
      cache.get(key).catch(() => cache.delete(key));
    }
    return cache.get(key);
  };
}

/**
 * One student's plan, from their own starting point to `head`.
 *
 * `root` is asked for only when no record answers - after one sync under this
 * scheme it never is, and the two requests it costs are spent once per
 * student, not once per sync.
 *
 * @param {object} p
 * @param {string} p.login
 * @param {string|null} [p.studentRepo]         `owner/name`, to read the student's first commit
 * @param {Map<string, string>} p.studentTree   the student's default branch
 * @param {(repo: string, ref: string) => Promise<Map<string, string>>} p.readTree  treeReader()
 * @param {() => Promise<string|null>} p.root   the student's first-commit tree, on demand
 * @param {string} p.templateFullName
 * @param {string} p.headSha                    the commit being synced
 * @param {Map<string, string>} p.headTree
 * @param {Array<{sha: string, treeSha: string, date: string}>} p.templateCommits
 * @param {Array<import("./types.mjs").SyncRecord>} p.records
 * @param {string|null} p.fallbackSha           the head commit's parent
 * @param {string[]} p.selected                 `["*", "!path", ...]` or an inclusion list
 * @returns {Promise<{from: string|null, source: string, paths: string[],
 *           plan: ReturnType<typeof planStarterSync>}>}
 */
export async function planStudent({
  login, studentRepo = null, studentTree, readTree, root, templateFullName, headSha, headTree, templateCommits, records,
  fallbackSha, selected,
}) {
  let rootSha;
  const rootOnce = async () => {
    if (rootSha === undefined) rootSha = await root();
    return rootSha;
  };
  let start = startingPointFor({ login, records, templateCommits, fallbackSha });
  if (start.source === "unknown") {
    start = startingPointFor({ login, records, templateCommits, fallbackSha, rootTreeSha: await rootOnce() });
  }

  // A SYNC NEVER MOVES A STUDENT BACKWARDS. Syncing to an older commit than
  // the one a student started from - `template_commit` naming lab 3 for a
  // student generated at lab 4 - would run their range the wrong way: every
  // file lab 4 added is in their start and not in the target, untouched, and
  // so a CLEAN DELETE. They already hold everything up to the target, so they
  // are sent nothing. Order comes from the template's listed history; where it
  // cannot be established, the range is not run at all and the student gets
  // the old behaviour, named as unknown.
  if (start.source !== "unknown" && start.sha !== headSha) {
    const at = new Map(templateCommits.map((c, i) => [c.sha, i]));
    const mine = at.get(start.sha);
    const target = at.get(headSha);
    if (mine === undefined || target === undefined) {
      start = { sha: fallbackSha, source: "unknown" };
    } else if (mine < target) {
      // Newest first: a smaller index is a LATER commit.
      const plan = planStarterSync({ headTree, baseTree: headTree, studentTree, paths: [] });
      return { from: start.sha, source: start.source, paths: [], plan };
    }
  }
  let fromTree = null;
  if (start.source !== "unknown" && start.sha) {
    try {
      fromTree = await readTree(templateFullName, start.sha);
    } catch {
      // A starting point the template no longer holds (history rewritten).
      start = { sha: fallbackSha, source: "unknown" };
    }
  }

  // THE STUDENT'S OWN FIRST COMMIT, when nothing in this template's history is
  // where they started - their repository was generated from a DIFFERENT
  // template (the assignment's template was changed after they accepted), or
  // the template's history was rewritten. Their first commit is exactly what
  // they were given, whichever template that was, so it is the right base:
  // files untouched since are replaced, edited ones become a pull request,
  // files the template has and they do not are added, and a file only the old
  // starter had and they never touched is removed.
  //
  // The single-commit fallback below this sent only what the NEWEST template
  // commit changed. On 2026-09-25 that left `.gitignore`, `.gitattributes` and
  // `infra/README.md` out of a PXL-Automation-II repository whose template had
  // been swapped - files from earlier commits of the new template, which the
  // student had never had.
  if (start.source === "unknown" && studentRepo) {
    const own = await rootOnce();
    if (own) {
      try {
        const firstTree = await readTree(studentRepo, own);
        const range = diffTreePaths(firstTree, headTree);
        const paths = resolveSelection(range, selected);
        const plan = planStarterSync({ headTree, baseTree: firstTree, studentTree, paths });
        return { from: null, source: "first-commit", paths, plan };
      } catch {
        /* unreadable: the last resort below */
      }
    }
  }

  // Last resort, named: the head commit's parent, what every sync did before
  // per-student ranges. Only when even the student's first commit is unknown.
  if (!fromTree) {
    start = { sha: fallbackSha, source: "unknown" };
    fromTree = fallbackSha ? await readTree(templateFullName, fallbackSha) : new Map();
  }
  const range = start.sha === headSha ? [] : diffTreePaths(fromTree, headTree);
  const paths = resolveSelection(range, selected);
  const plan = planStarterSync({ headTree, baseTree: fromTree, studentTree, paths });
  return { from: start.sha, source: start.source, paths, plan };
}
