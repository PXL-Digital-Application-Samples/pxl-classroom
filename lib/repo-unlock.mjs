// PXL Classroom - reopening a student repository after the deadline.
//
// Lockdown stops writes to the submission ref at the deadline. It is meant to
// be permanent for that assignment, and for a whole cohort it is - but a
// deadline is a rule about a cohort and a repository belongs to a person, and
// the two come apart often enough that "no way back" is the wrong answer:
//
//   * a student with a certificate whose extension arrived after the freeze;
//   * an appeal upheld, where the work must be pushed to be re-marked;
//   * a resit taken in the same repository;
//   * a repository frozen by a run that should not have included it.
//
// Doing it by hand means an org owner deleting a ruleset in the GitHub UI, with
// nothing recorded anywhere - so a grade dispute months later turns on somebody
// remembering. This records it.
//
// UNLOCKING IS NOT DELETING THE RULESET. `enforcement` is a flag, and
// lib/submission-lock.mjs's header says so: "the lock is a thing that gets
// flipped, not scheduled. The flip is one PUT with a partial body." Flipping it
// to `disabled` leaves the rules and the App's bypass exactly as they are, so a
// later re-lock is another flip rather than a re-creation - which matters,
// because a re-created ruleset without the App in `bypass_actors` locks the
// system out of the repository too.
//
// TWO LOCK METHODS, TWO INVERSES. lockdown.mjs prefers a ruleset and degrades
// to demoting the student to `pull` when it cannot apply one - per repository,
// so one assignment can hold both. `lock_method` on the lockdown record's row
// says which happened for THIS repository, and the inverse is read from it
// rather than assumed: undoing a demotion with a ruleset flip would report
// success over a student who still cannot push.
//
// PRESERVATION FIRST, ALWAYS. Unlocking before the snapshot is safely in the
// archive means the thing being graded can move underneath the grade. The
// snapshot is what preserve.mjs pushed; it is immutable once there, so
// unlocking afterwards costs nothing and takes nothing away.
//
// Isomorphic and dependency-free - the Admin Panel drives it through
// `frontend/src/lib/repo-unlock.js`, and the operation itself goes through
// lib/submission-lock.mjs, which is HTTP-stack-agnostic for this reason.

/** What `lock_method` values mean an actual lock is in place. */
const LOCKING_METHODS = new Set(["org-ruleset", "ruleset", "demotion"]);

/**
 * The lockdown record's row for one login.
 *
 * A group assignment writes one row per member over one repository, so a login
 * is the key even when the repository is shared - and unlocking any member's
 * row unlocks the team's repository, which is correct: there is one repository
 * and one lock on it.
 *
 * @param {object|null} record `lockdowns/<id>/lockdown-record.json`
 * @param {string} login
 * @returns {object|null}
 */
export function lockdownRowFor(record, login) {
  const want = String(login ?? "").trim().toLowerCase();
  if (!want) return null;
  const rows = Array.isArray(record?.results) ? record.results : [];
  return rows.find((r) => String(r?.github_login ?? "").toLowerCase() === want) ?? null;
}

/**
 * Can this repository be reopened, and by doing what?
 *
 * Every refusal names what would have to change, because "cannot unlock" with
 * no reason sends a lecturer to the GitHub UI to do it unrecorded - which is
 * the situation this exists to replace.
 *
 * @param {object} args
 * @param {object|null} args.row        the report row for this student
 * @param {object|null} args.lockdownRow the lockdown record's row, from lockdownRowFor
 * @param {object|null} args.assignment the assignment document
 * @returns {{can: boolean, method: string|null, repo: string|null,
 *            permission: string|null, reason: string|null}}
 */
export function unlockability({ row = null, lockdownRow = null, assignment = null } = {}) {
  const no = (reason) => ({ can: false, method: null, repo: null, permission: null, reason });

  if (!lockdownRow) {
    return no(
      "There is no lockdown record for this student, so nothing has been locked - " +
      "the deadline has not run for them yet, or they accepted after it did.",
    );
  }

  const method = lockdownRow.lock_method ?? null;
  if (!LOCKING_METHODS.has(method)) {
    // `none` is `lock_down_enabled: false` - a deliberate decision that the
    // deadline stops nothing. There is nothing to undo, and saying "unlocked"
    // over it would be a control that reports work it did not do.
    return no(
      method === "none"
        ? "This assignment does not lock repositories at the deadline, so this one was never locked."
        : `The lockdown record does not say how this repository was locked (lock_method: ${method ?? "absent"}), so there is no inverse to apply.`,
    );
  }

  if (lockdownRow.verified === false) {
    // The freeze itself failed. Reporting an unlock would claim to have undone
    // something that never happened, and hide that the repository was never
    // actually stopped.
    return no("The deadline run did not manage to lock this repository, so there is nothing to reopen.");
  }

  // Preservation is the gate, and it is read off the REPORT rather than the
  // lockdown record: preservation happens after the freeze, in a later phase,
  // so the lockdown record cannot know how it went.
  const preservation = row?.preservation_status ?? null;
  if (preservation === "pending" || preservation === null) {
    return no(
      "The deadline snapshot for this student has not been preserved yet. Reopening now would let " +
      "the work being graded move before it is safely in the archive - wait for the nightly, then try again.",
    );
  }
  if (preservation === "failed") {
    return no(
      "Preserving this student's deadline snapshot FAILED, so there is no immutable copy of what they " +
      "handed in. Reopening now would leave nothing to grade against. Fix the preservation first.",
    );
  }

  const repo = typeof lockdownRow.repo_name === "string" ? lockdownRow.repo_name : null;
  if (!repo) return no("The lockdown record does not name the repository, so there is nothing to act on.");

  return {
    can: true,
    method,
    repo,
    // Undoing a demotion means restoring a permission, and the lockdown record
    // does NOT say what the student had before it - it records
    // `permission_after` alone. So the level comes from the assignment, which
    // is what provisioning granted in the first place and therefore what
    // "restored" has to mean. `admin` matches the schema's own default, so an
    // assignment predating the field is not silently demoted to `pull`.
    permission: method === "demotion" ? (assignment?.student_permission || "admin") : null,
    reason: null,
  };
}

/**
 * The record written to `lockdowns/<id>/unlocked/<login>.json`.
 *
 * Written because the alternative is an org owner clicking in the GitHub UI and
 * nothing knowing it happened. A grade dispute months later asks "could this
 * student have pushed after the deadline?", and the honest answer has to come
 * from a document, not from a memory.
 *
 * `snapshot_sha` is copied in deliberately: it is what was graded, and it is
 * the number that makes the rest of the record mean something. A reader meeting
 * this file needs to see, in one place, that the work was already preserved
 * when the repository was reopened.
 *
 * @param {object} args
 * @returns {object} matching schemas/unlock-record.schema.json
 */
export function unlockRecord({
  assignmentId,
  login,
  repo,
  method,
  by,
  reason,
  snapshotSha = null,
  teamSlug = null,
  permission = null,
  at = new Date().toISOString(),
} = {}) {
  const doc = {
    schema_version: 1,
    assignment_id: assignmentId,
    github_login: login,
    repo_name: repo,
    unlocked_at: at,
    unlocked_by: by,
    reason,
    // How it was locked, therefore what was undone. A reader should not have to
    // find the lockdown record to know whether a ruleset was flipped or a
    // permission restored.
    lock_method: method,
    snapshot_sha: snapshotSha,
  };
  if (teamSlug) doc.team_slug = teamSlug;
  if (permission) doc.permission_restored = permission;
  return doc;
}

/**
 * Reopen one repository. The operation, not the decision - call unlockability
 * first.
 *
 * `releaseLock` is lib/submission-lock.mjs's `releaseSubmissionLock`, passed in
 * rather than imported so this module stays dependency-free and so a test
 * drives the REAL function over a fake `request` instead of a mock that agrees
 * with whatever it is told. `setPermission` is the demotion inverse.
 *
 * @param {object} args
 * @returns {Promise<{ok: boolean, reason: string|null}>}
 */
export async function applyUnlock({
  request,
  releaseLock,
  releaseOrgLock,
  setPermission,
  org,
  repo,
  repositoryId,
  assignmentId,
  login,
  method,
  permission,
} = {}) {
  if (method === "org-ruleset") {
    // Removing one repository id from the organization ruleset, not flipping a
    // repository one - there is no repository ruleset here to flip, and
    // reporting a successful unlock over a student who still cannot push is the
    // exact failure `lock_method` exists to prevent.
    if (!Number.isInteger(repositoryId)) {
      return { ok: false, reason: "the lockdown record does not say which repository id the organization ruleset covers" };
    }
    const res = await releaseOrgLock(request, { org, assignmentId, repositoryId });
    if (!res?.ok) {
      if (res?.action === "absent") {
        return { ok: false, reason: `${res.reason} - it may already have been removed on GitHub` };
      }
      return { ok: false, reason: res?.reason || "the organization ruleset could not be updated" };
    }
    // BELT AND BRACES DURING MIGRATION. A cohort locked per repository and then
    // migrated to an organization ruleset can hold both - both block, which is
    // harmless until somebody is reopened, and then the leftover repository
    // ruleset keeps them out with nothing on screen to explain it. Released
    // when one is found; `absent` is the ordinary case and not a failure.
    if (releaseLock) {
      const leftover = await releaseLock(request, { org, repo });
      if (leftover?.ok && leftover.action === "released") {
        return { ok: true, reason: null, alsoReleased: "repository-ruleset" };
      }
    }
    return { ok: true, reason: null };
  }

  if (method === "ruleset") {
    const res = await releaseLock(request, { org, repo });
    if (res?.ok) return { ok: true, reason: null };
    // "absent" is not a success dressed as one: the lockdown record says this
    // repository was locked with a ruleset and there is no ruleset on it, so
    // something removed it and the lecturer should be told rather than shown a
    // green toast over an operation that did nothing.
    if (res?.action === "absent") {
      return { ok: false, reason: `${res.reason} - it may already have been removed on GitHub` };
    }
    return { ok: false, reason: res?.reason || "the ruleset could not be updated" };
  }

  if (method === "demotion") {
    if (!permission) {
      return { ok: false, reason: "no permission level to restore the student to" };
    }
    const res = await setPermission({ org, repo, login, permission });
    if (!res?.ok) return { ok: false, reason: res?.reason || "the collaborator permission could not be restored" };
    return { ok: true, reason: null };
  }

  return { ok: false, reason: `unknown lock method ${method}` };
}
