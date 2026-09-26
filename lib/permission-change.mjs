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
import { LOCKING_METHODS } from "./repo-unlock.mjs";

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
 * @param {Array<{github_login?: string, repo_name?: string, team_slug?: string, access_state?: string}>} args.records repositories/<id>/*.json
 * @param {object} args.assignment the SAVED assignment document
 * @param {Map|Array|null} [args.overrides] deadline extensions, for each student's own deadline
 * @param {Iterable<string>} [args.reopened] logins whose repository a lecturer reopened
 * @param {{results?: Array<{repo_name?: string, lock_method?: string|null, demoted?: boolean}>}|null} [args.lockRecord] lockdowns/<id>/lockdown-record.json, when there is one
 * @param {Date} [args.now]
 * @returns {{ apply: Array<{login: string, repo: string}>,
 *             skip: Array<{login: string, repo: string|null, reason: 'past-deadline'|'locked'|'no-repository'|'no-access'}> }}
 */
export function planPermissionApply({ records, assignment, overrides = null, reopened = [], lockRecord = null, now = new Date() }) {
  const docs = overrides instanceof Map ? [...overrides.values()] : overrides;
  const repoKey = (r) => String(r ?? "").toLowerCase();
  // A REOPEN is per repository: a team's repository is one object with one
  // lock, so reopening it for one member reopened it for all of them - the
  // match lockdown itself makes (`teamMembers`). Matched by login only, a
  // teammate stayed "past deadline" on a repository that was open.
  const reopenedLogins = new Set([...reopened].map(normalizeLogin));
  const reopenedRepos = new Set(
    (records || []).filter((r) => reopenedLogins.has(normalizeLogin(r?.github_login))).map((r) => repoKey(r.repo_name)),
  );
  // A LOCK THAT EXISTS proves something, whatever the deadline says now. An
  // extension granted after the lock, a deadline moved later, or a lockdown a
  // lecturer ran early all leave a locked repository with a FUTURE deadline -
  // and a changed permission would unlock it around Reopen's preservation
  // check, with no record. The rows name the method that holds each one.
  const lockedRepos = new Set(
    (lockRecord?.results || [])
      .filter((row) => LOCKING_METHODS.has(row?.lock_method) || row?.demoted === true)
      .map((row) => repoKey(row.repo_name)),
  );
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
    // Removed by hand, or the repository is gone: granting again would send a
    // NEW invitation - an email, and the access a lecturer took away, back.
    // `removed` is the schema's word; `revoked`/`deleted` are what
    // registry/reconcile.mjs writes. The Apply call also asks GitHub
    // (applyStudentPermission `onlyIfPresent`), because a removal made in
    // GitHub's settings changes no record at all.
    if (rec.access_state === "removed" || rec.access_state === "revoked" || rec.access_state === "deleted") {
      skip.push({ login, repo, reason: "no-access" });
      continue;
    }
    const reopenedHere = reopenedRepos.has(repoKey(repo));
    if (lockedRepos.has(repoKey(repo)) && !reopenedHere) {
      skip.push({ login, repo, reason: "locked" });
      continue;
    }
    const team = rec.team_slug ? { members: teams.get(rec.team_slug.toLowerCase()) || [] } : null;
    const { deadline } = effectiveDeadlineFor(assignment, login, { overrides: docs, team });
    // No deadline at all is an assignment that never locks.
    const past = deadline ? now.getTime() >= deadline.getTime() : false;
    if (past && !reopenedHere) {
      skip.push({ login, repo, reason: "past-deadline" });
      continue;
    }
    apply.push({ login, repo });
  }
  return { apply, skip };
}

/**
 * Is `login` still in `repo` - a collaborator, or holding an invitation?
 * "unreadable" when GitHub did not say; never guessed either way.
 *
 * @returns {Promise<"collaborator"|"invited"|"gone"|"unreadable">}
 */
export async function studentPresence(request, { repo, login }) {
  let res;
  try {
    res = await request("GET", `/repos/${repo}/collaborators/${encodeURIComponent(login)}`);
  } catch {
    return "unreadable";
  }
  if (res?.status === 204) return "collaborator";
  if (res?.status !== 404) return "unreadable";
  // Not a collaborator: an invitation still counts. Walked whole - one page
  // is not the list.
  for (let page = 1; page <= 10; page++) {
    let inv;
    try {
      inv = await request("GET", `/repos/${repo}/invitations?per_page=100&page=${page}`);
    } catch {
      return "unreadable";
    }
    if (!inv?.ok || !Array.isArray(inv.data)) return "unreadable";
    if (inv.data.some((i) => normalizeLogin(i?.invitee?.login) === normalizeLogin(login))) return "invited";
    if (inv.data.length < 100) return "gone";
  }
  return "unreadable";
}

/**
 * Give one student `permission` on one repository, whether they are a
 * collaborator already or still have the invitation. Never throws.
 *
 * @returns {Promise<{ ok: boolean, via: 'collaborator'|'invitation'|null, status: number, message?: string, skipped?: boolean }>}
 */
export async function applyStudentPermission(request, { repo, login, permission, onlyIfPresent = false }) {
  if (!STUDENT_PERMISSIONS.includes(permission)) {
    return { ok: false, via: null, status: 0, message: `"${permission}" is not a permission` };
  }
  // CHANGING a permission must not become GRANTING one (`onlyIfPresent`, the
  // Admin Panel's Apply; provisioning grants on purpose and passes false).
  // PUT /collaborators on somebody who is neither a collaborator nor invited
  // sends a NEW invitation - an email, and access a lecturer took away in
  // GitHub's own settings, back. The repository record cannot say: nothing
  // updates it when a collaborator is removed by hand (review 2026-09-26). So
  // GitHub is asked, and "neither" is a skip, not an error.
  if (onlyIfPresent) {
    const presence = await studentPresence(request, { repo, login });
    if (presence === "unreadable") return { ok: false, via: null, status: 0, message: "could not read whether they still have access" };
    if (presence === "gone") return { ok: false, skipped: true, via: null, status: 0, message: "no longer has access - not re-invited" };
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
