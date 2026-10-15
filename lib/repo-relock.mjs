// PXL Classroom - locking a reopened repository again.
//
// Reopen (lib/repo-unlock.mjs) lets one student push again after the deadline
// and writes `lockdowns/<id>/unlocked/<login>.json`. Nothing could undo it:
// every lockdown run skips a repository with that record, the manual "Lock
// everyone out" included (it dispatches the nightly, which runs the same
// lockdown), while RUNBOOK said "to close it again, re-run the freeze" (review
// 2026-10-15, P2-57). This is the inverse, run from the student's own actions
// where Reopen is: the lock that record says was undone is put back, and the
// record goes, so every later run treats the repository as locked again.
//
// THE REOPEN RECORD IS THE AUTHORITY. It is written when the reopen happens and
// says how the repository had been locked (`lock_method`) and whether a
// permission was restored (`permission_restored`). The lockdown record's row
// learns of a reopen only when a LATER pass rewrites it (`lock_method: null`,
// `reopened_at`), so before that pass the row still reads locked; after it, the
// method is gone from the row. Both are handled from the record.
//
// The snapshot does not move: it was preserved before the reopen, and what was
// graded is unaffected, exactly as when the repository was reopened.
//
// Dependency-free, like lib/repo-unlock.mjs: the GitHub writers are passed in,
// so a test drives the real functions over a fake `request`.

import { LOCKING_METHODS } from "./repo-unlock.mjs";
import { sameLogin } from "./github-login.mjs";

/**
 * May this reopened repository be locked again? Null when it was not reopened
 * (no record), which hides the control; `can: false` says why it cannot.
 *
 * @param {{ reopenRecord?: import("./types.mjs").UnlockRecord|null }} [args]
 * @returns {null | { can: boolean, method: string|null, repo: string|null, demote: boolean,
 *                    by: string|null, at: string|null, why: string|null, reason: string|null }}
 *   `by`, `at`, `why`: who reopened it, when, and the reason they gave
 */
export function relockability({ reopenRecord = null } = {}) {
  if (!reopenRecord) return null;
  const method = reopenRecord.lock_method ?? null;
  const base = {
    method,
    repo: typeof reopenRecord.repo_name === "string" ? reopenRecord.repo_name : null,
    by: reopenRecord.unlocked_by ?? null,
    at: reopenRecord.unlocked_at ?? null,
    why: reopenRecord.reason ?? null,
  };
  if (!LOCKING_METHODS.has(method)) {
    return { ...base, can: false, demote: false, reason: `The reopen record does not say how this repository was locked (lock_method: ${method ?? "absent"}), so there is no lock to put back.` };
  }
  if (!base.repo) return { ...base, can: false, demote: false, reason: "The reopen record does not name the repository, so there is nothing to lock." };
  // A demotion was the lock, or rode on a ruleset (`permission_restored` is
  // set exactly when Reopen gave a permission back).
  return { ...base, can: true, demote: method === "demotion" || Boolean(reopenRecord.permission_restored), reason: null };
}

/**
 * Put the lock back: the ruleset the reopen switched off or left, then - where
 * one was restored - every member's permission down to read again.
 *
 * @param {object} [args]
 * @param {Function} [args.request] the GitHub request adapter, (method, path, body)
 * @param {Function} [args.ensureLock] lib/submission-lock.mjs `ensureSubmissionLock`
 * @param {Function} [args.addToOrgLock] lib/submission-lock.mjs `addRepoToOrgLock`
 * @param {(a: {org: string, repo: string, login: string, permission: string}) => Promise<{ok: boolean, reason?: string|null}>} [args.setPermission]
 * @param {(login: string) => Promise<string>} [args.presence] lib/permission-change.mjs `studentPresence`
 * @param {string} [args.org]
 * @param {string} [args.repo]  the repository's name
 * @param {number|null} [args.repositoryId]  for the organization ruleset
 * @param {string} [args.assignmentId]
 * @param {string} [args.submissionRef]
 * @param {number|null} [args.appId]  a repository ruleset's bypass actor
 * @param {string} [args.login]
 * @param {string[]} [args.logins]  everyone on the repository: a team's members
 * @param {string} [args.method]  relockability's
 * @param {boolean} [args.demote] relockability's
 * @returns {Promise<{ok: boolean, reason: string|null, locked?: boolean}>}
 *   `locked` on a failure: the ruleset is back on and only a permission failed
 */
export async function applyRelock(args = {}) {
  const { request, ensureLock, addToOrgLock, setPermission, org, repo, repositoryId, assignmentId, submissionRef, appId, login, logins, method, demote } = args;
  if (method === "org-ruleset") {
    const r = await addToOrgLock(request, { org, assignmentId, repositoryId });
    if (!r?.ok) {
      return { ok: false, reason: r?.action === "absent" ? `${r.reason} - it may have been removed on GitHub` : (r?.reason || "the organization ruleset could not be updated") };
    }
  } else if (method === "ruleset") {
    const r = await ensureLock(request, { org, repo, submissionRef, appId, enforcement: "active" });
    if (!r?.ok) return { ok: false, reason: r?.reason || "the repository's deadline ruleset could not be switched back on" };
  } else if (method !== "demotion") {
    return { ok: false, reason: `unknown lock method ${method}` };
  }
  if (!demote) return { ok: true, reason: null };

  const who = Array.isArray(logins) && logins.length ? logins : [login];
  const failed = [];
  for (const l of who) {
    // NOT RE-INVITED (P2-29): lowering the permission of somebody who is neither
    // a collaborator nor invited SENDS them an invitation. Only a member GitHub
    // says has access is touched (review 2026-10-15, R6-26): a check that could
    // not answer fell through to the write, and invited a teammate a lecturer
    // had removed. Not answered is said, and that member left as they are.
    if (args.presence) {
      const presence = await args.presence(l);
      if (presence === "gone") continue;
      if (presence !== "collaborator" && presence !== "invited") {
        failed.push(`@${l}: could not tell whether they still have access, so they were not changed`);
        continue;
      }
    }
    const r = await setPermission({ org, repo, login: l, permission: "pull" });
    if (!r?.ok) failed.push(`@${l}: ${r?.reason || "the permission could not be lowered"}`);
  }
  if (failed.length) {
    const ruleset = method !== "demotion";
    return {
      ok: false,
      ...(ruleset ? { locked: true } : {}),
      reason: `${ruleset ? "the deadline ruleset is back on, but " : ""}not everyone is read-only again: ${failed.join("; ")}`,
    };
  }
  return { ok: true, reason: null };
}

/**
 * The reopen record as it is kept when the repository is locked again
 * (`lockdowns/<id>/relocked/<login>/<at>.json`): the same document, with when
 * and by whom it was locked again. Lock again removes the record under
 * `unlocked/` - every lockdown run reads that as "leave it open" - and the
 * lockdown row then reads locked from its lock time, so without this nothing
 * said the student could push after the deadline (review 2026-10-15, R6-13).
 *
 * @param {import("./types.mjs").UnlockRecord} reopenRecord
 * @param {{ by: string, at: string }} relock
 */
export function relockHistoryDoc(reopenRecord, { by, at }) {
  return { ...reopenRecord, relocked_at: at, relocked_by: by };
}

/**
 * The lockdown record after a relock. A row a later pass wrote "reopened"
 * (`lock_method: null` and `reopened_at`) gets its lock back - the method,
 * when, and the permission it leaves - so the record says what holds the
 * repository and Reopen is offered again. A row no pass rewrote still says
 * how it was locked and is left as it is. The counts follow the rows.
 *
 * @param {import("./types.mjs").LockdownRecord} record
 * @param {{ logins: string[], method: import("./types.mjs").LockdownRecord["results"][number]["lock_method"], demote: boolean, at: string }} change
 * @returns {import("./types.mjs").LockdownRecord}
 */
export function relockedRecord(record, { logins, method, demote, at }) {
  let moved = 0;
  const results = (record?.results || []).map((row) => {
    if (!row?.reopened_at || !logins.some((l) => sameLogin(l, row.github_login))) return row;
    moved++;
    const { reopened_at: _reopened, ...rest } = row;
    return {
      ...rest,
      lock_method: method,
      lockdown_at: at,
      verified: true,
      permission_after: demote ? "read" : (rest.permission_after ?? null),
      ...(demote && method !== "demotion" ? { demoted: true } : {}),
    };
  });
  if (!moved) return record;
  return {
    ...record,
    results,
    ...(Number.isInteger(record.reopened_count) ? { reopened_count: Math.max(0, record.reopened_count - moved) } : {}),
    ...(Number.isInteger(record.locked_count) ? { locked_count: record.locked_count + moved } : {}),
  };
}
