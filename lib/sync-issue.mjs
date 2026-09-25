// Who a starter sync's tracking issue is ASSIGNED to.
//
// The issue is how a student learns a pull request is waiting, or that their
// main moved. Unassigned, GitHub emails only people who WATCH the repository:
// 2026-09-25 a lecturer who had accepted their own assignment got nothing,
// because an org owner already had access and was never "given" the
// repository, which is what turns watching on. Being assigned is a
// participating notification and is emailed regardless of watching.
//
// Nobody types an address or an account: every repository record already
// names the student who accepted it, and a group repository has one record
// per member, all naming the same repository - so the assignees are every
// login whose record points at this repository.

import { normalizeLogin } from "./github-login.mjs";

/** GitHub's limit on assignees per issue. */
export const MAX_ASSIGNEES = 10;

/**
 * repo_name (lowercased) -> the logins whose records name it, in record order,
 * each once. Records that cannot be read are simply absent: this decides who
 * is TOLD, never who is synced.
 *
 * @param {Array<{ github_login?: string, repo_name?: string } | null | undefined>} records
 * @returns {Map<string, string[]>}
 */
export function loginsByRepo(records) {
  const out = new Map();
  for (const r of records || []) {
    if (!r?.github_login || !r?.repo_name) continue;
    const key = r.repo_name.toLowerCase();
    const list = out.get(key) || [];
    if (!list.some((l) => normalizeLogin(l) === normalizeLogin(r.github_login))) list.push(r.github_login);
    out.set(key, list);
  }
  return out;
}

/**
 * The accounts to assign this repository's issue to: the record's own login
 * first, then everyone else sharing the repository, at most MAX_ASSIGNEES.
 *
 * @param {{ login?: string, repoName: string, byRepo: Map<string, string[]> }} input
 * @returns {string[]}
 */
export function issueAssignees({ login, repoName, byRepo }) {
  const all = [...(login ? [login] : []), ...(byRepo.get(String(repoName).toLowerCase()) || [])];
  const seen = new Set();
  const out = [];
  for (const l of all) {
    const k = normalizeLogin(l);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(l);
  }
  return out.slice(0, MAX_ASSIGNEES);
}
