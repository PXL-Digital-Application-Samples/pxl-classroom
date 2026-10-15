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
// AND A RULESET ROW CAN HOLD BOTH. `lock_down_enabled` demotes on top of the
// ruleset in phase 4 and records `demoted: true` on the row, so that row takes
// both inverses: the ruleset released, then the permission restored.
//
// PRESERVATION FIRST, ALWAYS. Unlocking before the snapshot is safely in the
// archive means the thing being graded can move underneath the grade. The
// snapshot is what preserve.mjs pushed; it is immutable once there, so
// unlocking afterwards costs nothing and takes nothing away.
//
// Isomorphic and dependency-free - the Admin Panel drives it through
// `frontend/src/lib/repo-unlock.js`, and the operation itself goes through
// lib/submission-lock.mjs, which is HTTP-stack-agnostic for this reason.

// (No npm dependency; the one import is the shared login comparison.)
import { sameLogin } from "./github-login.mjs";

/** What `lock_method` values mean an actual lock is in place. */
export const LOCKING_METHODS = new Set(["org-ruleset", "ruleset", "demotion"]);

/**
 * The lockdown record's row for one login.
 *
 * A group assignment writes one row per member over one repository, so a login
 * is the key even when the repository is shared - and unlocking any member's
 * row unlocks the team's repository, which is correct: there is one repository
 * and one lock on it.
 *
 * @param {import("./types.mjs").LockdownRecord|null} record `lockdowns/<id>/lockdown-record.json`
 * @param {string} login
 * @returns {import("./types.mjs").LockdownRecordResult|null}
 */
export function lockdownRowFor(record, login) {
  if (!String(login ?? "").trim()) return null;
  const rows = Array.isArray(record?.results) ? record.results : [];
  return rows.find((r) => sameLogin(r?.github_login, login)) ?? null;
}

/**
 * Whose permission a Reopen restores (review 2026-10-14, LD6, TL-6): the team's
 * members with a lock row on THIS repository - they held it at the lock - and
 * never one the lock found with no access (`permission_after: none`, LD8), so
 * a teammate a lecturer removed is not re-invited even when the live presence
 * check cannot answer. The student clicked is always in it: that is the act.
 *
 * @param {object} a
 * @param {import("./types.mjs").LockdownRecord|null} a.record the lockdown record
 * @param {string} a.login the student the lecturer clicked
 * @param {string[]} a.members every login on that student's team (just theirs for an individual)
 * @returns {string[]}
 */
export function unlockLogins({ record, login, members }) {
  const own = lockdownRowFor(record, login);
  const out = [login];
  for (const m of members || []) {
    if (!m || sameLogin(m, login)) continue;
    const row = lockdownRowFor(record, m);
    if (!row || row.repo_name !== own?.repo_name) continue;
    if (row.permission_after === "none") continue;
    out.push(m);
  }
  return out;
}

/**
 * Can this repository be reopened, and by doing what?
 *
 * Every refusal names what would have to change, because "cannot unlock" with
 * no reason sends a lecturer to the GitHub UI to do it unrecorded - which is
 * the situation this exists to replace.
 *
 * @param {object} [args]
 * @param {import("./types.mjs").ReportStudent|null} [args.row] the report row for this student
 * @param {import("./types.mjs").LockdownRecordResult|null} [args.lockdownRow] the lockdown
 *   record's row, from lockdownRowFor
 * @param {import("./types.mjs").Assignment|null} [args.assignment] the assignment document
 * @param {import("./types.mjs").UnlockRecord|null} [args.reopenRecord] its reopen record,
 *   `lockdowns/<id>/unlocked/<login>.json` for anyone on the repository, or null
 * @returns {{can: boolean, method: string|null, repo: string|null,
 *            permission: string|null, reason: string|null}}
 */
export function unlockability({ row = null, lockdownRow = null, assignment = null, reopenRecord = null } = {}) {
  const no = (reason) => ({ can: false, method: null, repo: null, permission: null, reason });

  // ALREADY OPEN, from the reopen record itself (lockdowns/<id>/unlocked/),
  // which is written when it happens. The lockdown row learns of it only when a
  // later pass rewrites it, so until then the dialog offered Reopen on a
  // repository that was open (review 2026-10-15, with P2-57).
  if (reopenRecord) {
    return no(
      `This repository was reopened${reopenRecord.unlocked_at ? ` on ${reopenRecord.unlocked_at}` : ""}` +
      `${reopenRecord.unlocked_by ? ` by @${reopenRecord.unlocked_by}` : ""}. Lock again puts the deadline's lock back.`,
    );
  }

  if (!lockdownRow) {
    return no(
      "There is no lockdown record for this student, so nothing has been locked - " +
      "the deadline has not run for them yet, or they accepted after it did.",
    );
  }

  // ALREADY OPEN. A finalize pass that skips a reopened student now writes them
  // a row - `lock_method: null` plus this - so without saying it here they would
  // fall into "the record does not say how this repository was locked", which is
  // true and useless: it reads as a broken record rather than as work already
  // done, and invites a lecturer to go and do it by hand on GitHub.
  if (lockdownRow.reopened_at) {
    return no(
      `This repository was already reopened on ${lockdownRow.reopened_at}. ` +
      `The record of who did it and why is in the assignment's lockdown folder.`,
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
    //
    // A ruleset row can carry a demotion TOO: `lock_down_enabled` has phase 4
    // demote on top of whichever ruleset held the repository, and records it as
    // `demoted: true` beside that `lock_method`. Releasing the ruleset alone
    // reports success over a student left at `pull`, so a non-null permission
    // here means "restore it" whatever the method.
    permission: method === "demotion" || lockdownRow.demoted === true
      ? (assignment?.student_permission || "admin")
      : null,
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
 * @param {object} [args]
 * @param {string} [args.assignmentId]
 * @param {string} [args.login]
 * @param {string} [args.repo]
 * @param {import("./types.mjs").UnlockRecord["lock_method"]} [args.method] how it was
 *   locked, therefore what was undone. The record's own vocabulary, so a rung added
 *   to `LOCKING_METHODS` and not to the schema fails here rather than at the write -
 *   which is how `org-ruleset` got as far as a committed document that its own
 *   schema refuses (2026-09-17).
 * @param {string} [args.by]
 * @param {string} [args.reason]
 * @param {string|null} [args.snapshotSha] what was graded, copied in on purpose
 * @param {string|null} [args.teamSlug]
 * @param {import("./types.mjs").UnlockRecord["permission_restored"]} [args.permission]
 *   the permission restored, where one was
 * @param {string} [args.at]
 * @returns {import("./types.mjs").UnlockRecord} matching schemas/unlock-record.schema.json
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
  /** @type {import("./types.mjs").UnlockRecord} */
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
 * `permission` is what unlockability returned: non-null means the student was
 * demoted and is put back to it, whether the demotion WAS the lock or was
 * phase 4 taking admin away on top of a ruleset.
 *
 * `released` appears on a failure only, and it is the half that happened: the
 * ruleset came off and the permission did not. Folded into a generic failure it
 * would read as "nothing changed" over a repository whose lock is already gone.
 *
 * @param {object} [args]
 * @param {Function} [args.request] the GitHub request adapter
 * @param {Function} [args.releaseLock] lib/submission-lock.mjs's releaseSubmissionLock
 * @param {Function} [args.releaseOrgLock] its organization-ruleset sibling
 * @param {Function} [args.setPermission] the demotion inverse
 * @param {string} [args.org]
 * @param {string} [args.repo]
 * @param {number} [args.repositoryId]
 * @param {string} [args.assignmentId]
 * @param {string} [args.login]
 * @param {string[]} [args.logins] everyone whose permission is restored: a team's members with a lock row on this repository
 * @param {(login: string) => Promise<string>} [args.presence] lib/permission-change.mjs `studentPresence` for that login: a teammate it calls "gone" is not re-invited
 * @param {string} [args.method] what unlockability decided
 * @param {string|null} [args.permission] non-null means the student was demoted
 * @returns {Promise<{ok: boolean, reason: string|null, released?: boolean}>}
 */
export async function applyUnlock(args = {}) {
  const { setPermission, org, repo, login, logins, method, permission } = args;
  // EVERY MEMBER THE LOCK DEMOTED (review 2026-10-14, LD6). A team's
  // repository is one object, so reopening it for one member reopens it for
  // the team - and restoring only the member clicked left the others at `pull`
  // while the next pass wrote "reopened" on their rows too, so the UI could no
  // longer reach them. `logins` are the team's members with a lock row on this
  // repository; one student otherwise.
  const who = Array.isArray(logins) && logins.length ? logins : [login];
  const restoreAll = async () => {
    if (!setPermission) return { ok: false, reason: "no way to restore the permission" };
    const failed = [];
    for (const l of who) {
      // A TEAMMATE WITH NO ACCESS IS NOT RE-INVITED (review 2026-10-14,
      // P2-29), the rule the demotion keeps (LD8): restoring a permission to
      // somebody who is neither a collaborator nor invited SENDS an invitation,
      // handing back access a lecturer removed or a team switch took away. The
      // student the lecturer clicked is restored whatever: that is the act.
      if (args.presence && !sameLogin(l, login) && (await args.presence(l)) === "gone") continue;
      const r = await setPermission({ org, repo, login: l, permission });
      if (!r?.ok) failed.push(`@${l}: ${r?.reason || "the collaborator permission could not be restored"}`);
    }
    return failed.length ? { ok: false, reason: failed.join("; ") } : { ok: true, reason: null };
  };

  if (method === "org-ruleset" || method === "ruleset") {
    const released = await releaseRulesetLock(args);
    if (!released.ok || !permission) return released;
    // DEMOTED ON TOP OF THE RULESET. Released first and restored second,
    // because the release is what repeats cleanly: an id already out of the
    // organization ruleset answers `already`, and so does a disabled repository
    // ruleset. A restore that failed can then be retried from the same row
    // without the release refusing as `absent`. The other order would leave a
    // failed release beside a student already back at admin.
    const restored = await restoreAll();
    if (!restored?.ok) {
      // `released` so the caller can say HALF of it happened. Folded into a
      // generic failure, a 403 here reads as "nothing changed" over a
      // repository whose ruleset is already off.
      return {
        ok: false,
        released: true,
        reason: `the deadline ruleset was released, but the student is still read-only: ` +
          (restored?.reason || "the collaborator permission could not be restored"),
      };
    }
    return released;
  }

  if (method === "demotion") {
    if (!permission) {
      return { ok: false, reason: "no permission level to restore the student to" };
    }
    return restoreAll();
  }

  return { ok: false, reason: `unknown lock method ${method}` };
}

/**
 * The ruleset half of an unlock, for either ruleset rung.
 *
 * Not `[args]`: this one has no `= {}` default, so the parameter is required
 * even though every field in it is optional.
 *
 * @param {object} args the caller's whole argument object, passed through
 * @param {Function} [args.request]
 * @param {Function} [args.releaseLock]
 * @param {Function} [args.releaseOrgLock]
 * @param {string} [args.org]
 * @param {string} [args.repo]
 * @param {number} [args.repositoryId]
 * @param {string} [args.assignmentId]
 * @param {string} [args.method]
 */
async function releaseRulesetLock({
  request,
  releaseLock,
  releaseOrgLock,
  org,
  repo,
  repositoryId,
  assignmentId,
  method,
}) {
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
    // BELT AND BRACES IN THE DIRECTION A MIGRATION ACTUALLY PRODUCES. The org
    // branch above guards `org-ruleset` rows that still carry a repository
    // ruleset; this is the other half, and it is the half that can happen by
    // itself. scripts/migrate-org-lock.mjs rewrites the rows it migrates, but
    // the rewrite is committed by the workflow at the end of the run - so a
    // migration that creates the organization ruleset and then dies leaves rows
    // saying `ruleset` over a repository the organization ruleset is really
    // holding. Disabling the repository one would then report a successful
    // unlock over a student who still cannot push: the exact failure
    // `lock_method` exists to prevent, arrived at from the other side.
    //
    // `absent` is the ordinary answer - no organization ruleset, nothing to do
    // - and `already` means one exists but never covered this repository.
    // Neither is a failure, and neither is something to tell the lecturer.
    let alsoReleased = null;
    if (releaseOrgLock && assignmentId && Number.isInteger(repositoryId)) {
      const orgRes = await releaseOrgLock(request, { org, assignmentId, repositoryId });
      if (orgRes?.ok && (orgRes.action === "removed" || orgRes.action === "disabled")) {
        alsoReleased = "organization-ruleset";
      } else if (orgRes && !orgRes.ok && orgRes.action !== "absent") {
        return { ok: false, reason: orgRes.reason || "the organization ruleset could not be updated" };
      }
    }

    const res = await releaseLock(request, { org, repo });
    if (res?.ok) return { ok: true, reason: null, ...(alsoReleased ? { alsoReleased } : {}) };
    // "absent" is not a success dressed as one: the lockdown record says this
    // repository was locked with a ruleset and there is no ruleset on it, so
    // something removed it and the lecturer should be told rather than shown a
    // green toast over an operation that did nothing. Unless an organization
    // ruleset was what actually held it and we just took this repository out of
    // it - then the student can push, which is the thing being reported.
    if (res?.action === "absent") {
      if (alsoReleased) return { ok: true, reason: null, alsoReleased };
      return { ok: false, reason: `${res.reason} - it may already have been removed on GitHub` };
    }
    return { ok: false, reason: res?.reason || "the ruleset could not be updated" };
  }

  return { ok: false, reason: `unknown lock method ${method}` };
}
