// PXL Classroom - a student repository that a record names and GitHub no
// longer has.
//
// The nightly collect reads every repository the records name. One that
// answers 404 was deleted (by its student, who is admin of it, or by someone
// in the organization) or has been put out of the App's reach - either way
// nothing is collected, locked, archived or graded for it, and until
// 2026-11-14 the only trace was a `[FAIL] snapshot <login> - repo HTTP 404`
// line in a GREEN collect job (PXL-2TIN-DevOps-2627: a team's repository gone
// overnight, its records still naming it). This turns those lines into one
// `unexpected-deletion` notice per organization, deduplicated on the set of
// repositories, so the same loss is one comment, updated, not one a night.
//
// Nothing is restored or removed automatically: a lecturer may have deleted it
// on purpose, and only an organization owner can restore one.
//
// Pure: collect/collect.mjs gathers the 404s and writes the outputs.

import { createHash } from "node:crypto";

/**
 * The notice for the repositories that answered 404, or null when none did.
 *
 * @param {Array<{assignmentId: string, login: string, repo: string}>} missing
 *   one entry per record whose repository answered 404 (`repo` is `owner/name`
 *   or a bare name); a team's repository appears once per member
 * @returns {{count: number, details: string, dedup: string}|null}
 */
export function missingRepoNotice(missing) {
  const byRepo = new Map();
  for (const m of missing || []) {
    if (!m?.repo) continue;
    const key = `${m.assignmentId}\n${String(m.repo).toLowerCase()}`;
    const entry = byRepo.get(key) ?? { assignmentId: m.assignmentId, repo: String(m.repo), logins: [] };
    if (m.login && !entry.logins.includes(m.login)) entry.logins.push(m.login);
    byRepo.set(key, entry);
  }
  if (byRepo.size === 0) return null;
  const entries = [...byRepo.values()].sort((a, b) => `${a.assignmentId}/${a.repo}`.localeCompare(`${b.assignmentId}/${b.repo}`));
  const lines = entries.map(
    (e) => `- \`${e.repo}\` (assignment \`${e.assignmentId}\`) - ${e.logins.length === 1 ? "student" : "students"} ${e.logins.map((l) => `\`${l}\``).join(", ")}`,
  );
  const one = entries.length === 1;
  // The organization, for the link to its Deleted repositories page: every
  // record names its repository as `owner/name`. Only a name that is a GitHub
  // login goes into the link; otherwise the page is named in words.
  const owners = new Set(entries.map((e) => (e.repo.includes("/") ? e.repo.split("/")[0] : "")));
  const [only] = owners;
  const org = owners.size === 1 && /^[A-Za-z0-9](?:-?[A-Za-z0-9]){0,38}$/.test(only ?? "") ? only : null;
  const details =
    `${one ? "A student repository" : `${entries.length} student repositories`} that PXL Classroom has on record ` +
    `${one ? "no longer exists" : "no longer exist"} on GitHub, or PXL Classroom can no longer see ${one ? "it" : "them"}. ` +
    `Nothing in ${one ? "it" : "them"} is collected, and at the deadline nothing is locked, archived or graded.\n\n` +
    `${lines.join("\n")}\n\n` +
    `**Deleted by mistake:** an owner of this organization can restore it for 90 days after the deletion. ` +
    `${org ? `Open https://github.com/organizations/${org}/settings/deleted_repositories` : "Open the organization's **Settings**, **Deleted repositories**"}, ` +
    `click **Restore** beside it, then **I understand, restore this repository**. ` +
    `It comes back with the same name and id and its pending invitations, so the records are right again ` +
    `and the next nightly run reads it.\n\n` +
    `**Deleted on purpose:** nothing is needed; this notice stays while the records name it.\n\n` +
    `**A student on an individual assignment who needs a new one:** delete their file under ` +
    `\`repositories/<assignment>/\` in the control repository and ask them to accept again from their invitation link.`;
  const dedup = `missing-${createHash("sha256").update(entries.map((e) => `${e.assignmentId}/${e.repo.toLowerCase()}`).join("\n")).digest("hex").slice(0, 16)}`;
  return { count: entries.length, details, dedup };
}
