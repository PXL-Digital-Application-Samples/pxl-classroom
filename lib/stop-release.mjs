// Let go of a deadline stop that the deadline in force no longer wants
// (review 2026-10-16, R7-1 and R7-2).
//
// The Deadline Sentinel stops the whole cohort at the instant; the finalize
// follows 5 to 10 minutes later and writes the lock record. A deadline moved
// later, or an extension granted, in those minutes left the stop where it was:
// the organization ruleset only ever gains ids (`keepCurrent`), so a student's
// page counted down to a deadline while every push was refused, and with no
// lock on their row Reopen refused too. Two callers ask this, with one answer:
// lockdown for a student it defers, and the publish a reopening save
// dispatches for a cohort whose deadline moved after a stop and before any
// lock record (scripts/release-stale-stop.mjs).
//
// Each step is what Reopen's own inverse does (lib/repo-unlock.mjs), and each
// is idempotent: an id already out answers `already`, a disabled repository
// ruleset `absent`, a member already at the assignment's permission is not
// asked again. Nobody is re-invited (`onlyIfPresent`). Isomorphic: the caller
// passes `request`, `gh(method, path, body)` or the SPA's adapter over it.

import { findOrgSubmissionLock, releaseSubmissionLock, removeRepoFromOrgLock, targetedRepositoryIds } from "./submission-lock.mjs";
import { applyStudentPermission } from "./permission-change.mjs";

/**
 * The repository ids this assignment's organization stop holds while it is
 * on. A disabled ruleset, or none, holds nobody; one that could not be read is
 * `ok: false` with no ids, never "nobody".
 *
 * @param {Function} request
 * @param {{org: string, assignmentId: string}} p
 * @returns {Promise<{ok: boolean, ids: Set<number>, reason: string|null}>}
 */
export async function orgStopIds(request, { org, assignmentId }) {
  const found = await findOrgSubmissionLock(request, { org, assignmentId });
  // A 403 on the list is the free plan's gate: no organization ruleset can be
  // enforcing, and this App's token cannot have made one (frozenFromRulesets).
  if (!found?.ok && found?.status === 403) return { ok: true, ids: new Set(), reason: null };
  if (!found?.ok) return { ok: false, ids: new Set(), reason: found?.reason || "the organization's rulesets could not be read" };
  return { ok: true, ids: new Set(found.ruleset?.enforcement === "active" ? targetedRepositoryIds(found.ruleset) : []), reason: null };
}

/**
 * Release one repository from a stop. `probeRepo` asks its repository ruleset
 * and its members' permission too: only where a stop can have put one there
 * (a sentinel fired), so a cohort no sentinel touched costs no request.
 *
 * @param {Function} request
 * @param {object} p
 * @param {string} p.org
 * @param {string} p.assignmentId
 * @param {string} p.repo the repository's name, without the owner
 * @param {number|null|undefined} p.repositoryId
 * @param {string[]} p.members everyone with access through this repository's record (a team's members)
 * @param {string} p.permission the assignment's student_permission
 * @param {Set<number>} p.orgIds orgStopIds
 * @param {boolean} p.probeRepo
 * @returns {Promise<Array<{step: "org-ruleset"|"repository-ruleset"|"permission", ok: boolean, login?: string, note: string}>>}
 *   one entry per thing that WAS stopped; empty when nothing held it
 */
export async function releaseStop(request, { org, assignmentId, repo, repositoryId, members, permission, orgIds, probeRepo }) {
  const steps = [];
  if (Number.isInteger(repositoryId) && orgIds.has(repositoryId)) {
    const res = await removeRepoFromOrgLock(request, { org, assignmentId, repositoryId });
    steps.push({ step: "org-ruleset", ok: !!res?.ok, note: res?.ok ? "taken out of the organization's stop" : `still in the organization's stop: ${res?.reason}` });
  }
  if (!probeRepo) return steps;
  const own = await releaseSubmissionLock(request, { org, repo });
  if (own?.action === "released") steps.push({ step: "repository-ruleset", ok: true, note: "its repository ruleset is switched off" });
  // A 403 listing them is the free plan's gate on a private repository: none
  // can be enforcing, so there is nothing to release - the stop there was a
  // demotion, which the members below give back.
  // A 404 is a repository that is gone, which nothing holds.
  else if (own?.action === "failed" && own.status !== 403 && own.status !== 404) {
    steps.push({ step: "repository-ruleset", ok: false, note: `its repository ruleset may still be on: ${own.reason}` });
  }
  // At `pull` the assignment itself gives read: nothing to give back.
  if (permission === "pull") return steps;
  for (const login of members) {
    const level = await Promise.resolve(request("GET", `/repos/${org}/${repo}/collaborators/${encodeURIComponent(login)}/permission`)).catch(() => null);
    if (!level?.ok || level.data?.role_name !== "read") continue;
    const back = await applyStudentPermission(request, { repo: `${org}/${repo}`, login, permission, onlyIfPresent: true });
    if (back.skipped) continue;
    steps.push({ step: "permission", login, ok: !!back.ok, note: back.ok ? `${login} has ${permission} again` : `${login} is left at read: ${back.message}` });
  }
  return steps;
}
