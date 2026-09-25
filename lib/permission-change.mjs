// Applying a changed `student_permission` to students who already accepted.
//
// The field is read at acceptance: a student is granted what the assignment
// said THEN, and a later edit reached nobody who had a repository. That made
// the choice irreversible in practice - "make them maintain after all" meant
// clicking through GitHub once per student, unrecorded.
//
// ISOMORPHIC: `request(method, path, body)` resolves `{ ok, status, data }`,
// the shape the SPA's ghApi and the live kit both give. No `node:` imports.
//
// TWO RULES, both measured on pxl-classroom-testbed on 2026-09-26:
//
//   * PAST A STUDENT'S DEADLINE, NOTHING IS CHANGED. The lock is applied at the
//     instant, before any lock record exists, and a changed permission is an
//     unlock in two of its three forms: raising a student whose repository is
//     held by a REPOSITORY ruleset lets them edit that ruleset (admin can -
//     tests/live/permission-probe.mjs), and ANY grant above `pull` undoes a
//     demotion. So "no lock record yet" proves nothing, and the one exception
//     is a repository a lecturer deliberately reopened (lockdowns/<id>/unlocked/),
//     which is already back at the assignment's permission and may follow it.
//   * A PENDING INVITATION IS NOT UPDATED BY GRANTING AGAIN. PUT /collaborators
//     for an invitee answers 201 with the SAME invitation at the OLD permission.
//     It is updated through the invitation itself, and the answer is checked.

import { effectiveDeadlineFor } from "./effective-deadline.mjs";
import { normalizeLogin } from "./github-login.mjs";

/** The repository permission names the schema uses. */
export const STUDENT_PERMISSIONS = Object.freeze(["pull", "triage", "push", "maintain", "admin"]);

/** An invitation spells two of them differently. */
export function invitationPermission(permission) {
  return { pull: "read", push: "write" }[permission] ?? permission;
}

/**
 * Who to change, and who not and why - PURE.
 *
 * @param {object} args
 * @param {Array<{github_login?: string, repo_name?: string, team_slug?: string}>} args.records repositories/<id>/*.json
 * @param {object} args.assignment the SAVED assignment document
 * @param {Map|Array|null} [args.overrides] deadline extensions, for each student's own deadline
 * @param {Iterable<string>} [args.reopened] logins whose repository a lecturer reopened
 * @param {Date} [args.now]
 * @returns {{ apply: Array<{login: string, repo: string}>,
 *             skip: Array<{login: string, repo: string|null, reason: 'past-deadline'|'no-repository'}> }}
 */
export function planPermissionApply({ records, assignment, overrides = null, reopened = [], now = new Date() }) {
  const back = new Set([...reopened].map(normalizeLogin));
  const docs = overrides instanceof Map ? [...overrides.values()] : overrides;
  // A group repository has one deadline, its most generous member's, so a
  // member is past it only when the whole team is (effective-deadline.mjs).
  const teams = new Map();
  for (const rec of records || []) {
    if (!rec?.team_slug || !rec.github_login) continue;
    const k = rec.team_slug.toLowerCase();
    teams.set(k, [...(teams.get(k) || []), rec.github_login]);
  }
  const apply = [];
  const skip = [];
  const seen = new Set();
  for (const rec of records || []) {
    const login = rec?.github_login;
    if (!login) continue;
    const key = normalizeLogin(login);
    if (seen.has(key)) continue;
    seen.add(key);
    const repo = typeof rec.repo_name === "string" && rec.repo_name.includes("/") ? rec.repo_name : null;
    if (!repo) {
      skip.push({ login, repo: null, reason: "no-repository" });
      continue;
    }
    const team = rec.team_slug ? { members: teams.get(rec.team_slug.toLowerCase()) || [] } : null;
    const { deadline } = effectiveDeadlineFor(assignment, login, { overrides: docs, team });
    // No deadline at all is an assignment that never locks.
    const past = deadline ? now.getTime() >= deadline.getTime() : false;
    if (past && !back.has(key)) {
      skip.push({ login, repo, reason: "past-deadline" });
      continue;
    }
    apply.push({ login, repo });
  }
  return { apply, skip };
}

/**
 * Give one student `permission` on one repository, whether they are a
 * collaborator already or still have the invitation. Never throws.
 *
 * @returns {Promise<{ ok: boolean, via: 'collaborator'|'invitation'|null, status: number, message?: string }>}
 */
export async function applyStudentPermission(request, { repo, login, permission }) {
  if (!STUDENT_PERMISSIONS.includes(permission)) {
    return { ok: false, via: null, status: 0, message: `"${permission}" is not a permission` };
  }
  let res;
  try {
    res = await request("PUT", `/repos/${repo}/collaborators/${encodeURIComponent(login)}`, { permission });
  } catch (e) {
    return { ok: false, via: null, status: 0, message: e?.message || String(e) };
  }
  // 204: an existing collaborator, now at `permission`.
  if (res?.status === 204) return { ok: true, via: "collaborator", status: 204 };
  if (res?.status !== 201) {
    return { ok: false, via: null, status: res?.status ?? 0, message: res?.data?.message };
  }
  // 201: an invitation - possibly the old one, untouched.
  const want = invitationPermission(permission);
  const invitation = res.data;
  if (invitation?.permissions === want) return { ok: true, via: "invitation", status: 201 };
  if (!invitation?.id) return { ok: false, via: "invitation", status: 201, message: "GitHub did not say which invitation" };
  let patched;
  try {
    patched = await request("PATCH", `/repos/${repo}/invitations/${invitation.id}`, { permissions: want });
  } catch (e) {
    return { ok: false, via: "invitation", status: 0, message: e?.message || String(e) };
  }
  if (patched?.ok && patched.data?.permissions === want) return { ok: true, via: "invitation", status: patched.status };
  return {
    ok: false, via: "invitation", status: patched?.status ?? 0,
    message: patched?.data?.message || `the invitation still says ${patched?.data?.permissions ?? invitation.permissions}`,
  };
}
