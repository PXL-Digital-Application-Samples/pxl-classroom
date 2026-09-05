import test from "node:test";
import assert from "node:assert/strict";

import { lockdownRowFor, unlockability, unlockRecord, applyUnlock } from "../lib/repo-unlock.mjs";
import { releaseSubmissionLock, SUBMISSION_LOCK_NAME } from "../lib/submission-lock.mjs";
import { unlockRecordPath } from "../lib/control-layout.mjs";
import { validateAgainst } from "../lib/validate.mjs";

const ORG = "PXL-Test";
const REPO = "lab-3-ella-dev";

const lockRow = (over = {}) => ({
  github_login: "ella-dev",
  repo_name: `${ORG}/${REPO}`,
  lock_method: "ruleset",
  verified: true,
  permission_after: null,
  snapshot_sha: "a".repeat(40),
  ...over,
});

const reportRow = (over = {}) => ({
  github_login: "ella-dev",
  preservation_status: "preserved",
  preserved_sha: "a".repeat(40),
  ...over,
});

// ------------------------------------------------------------- finding a row

test("the lockdown row is found by login, case-insensitively", () => {
  // A GitHub login is compared lowercased everywhere else here for a reason:
  // the spelling a lecturer sees and the one a workflow wrote can differ.
  const record = { results: [lockRow({ github_login: "Ella-Dev" })] };
  assert.ok(lockdownRowFor(record, "ella-dev"));
  assert.ok(lockdownRowFor(record, "ELLA-DEV"));
});

test("a missing row, record or login is null rather than a throw", () => {
  assert.equal(lockdownRowFor({ results: [lockRow()] }, "somebody-else"), null);
  assert.equal(lockdownRowFor(null, "ella-dev"), null);
  assert.equal(lockdownRowFor({}, "ella-dev"), null);
  assert.equal(lockdownRowFor({ results: "nope" }, "ella-dev"), null);
  assert.equal(lockdownRowFor({ results: [lockRow()] }, ""), null);
  assert.equal(lockdownRowFor({ results: [lockRow()] }, null), null);
});

// ------------------------------------------------------------ can it be done

test("a preserved, ruleset-locked repository can be reopened", () => {
  const v = unlockability({ row: reportRow(), lockdownRow: lockRow() });
  assert.equal(v.can, true);
  assert.equal(v.method, "ruleset");
  assert.equal(v.repo, `${ORG}/${REPO}`);
  assert.equal(v.permission, null, "a ruleset flip restores no permission");
  assert.equal(v.reason, null);
});

test("PRESERVATION FIRST: pending refuses, and says to wait", () => {
  // Unlocking before the snapshot is in the archive lets the thing being
  // graded move underneath the grade.
  const v = unlockability({ row: reportRow({ preservation_status: "pending" }), lockdownRow: lockRow() });
  assert.equal(v.can, false);
  assert.match(v.reason, /has not been preserved yet/);
  assert.match(v.reason, /wait for the nightly/);
});

test("a FAILED preservation refuses, and says something different", () => {
  // Not the same situation as pending: waiting will not fix it, and there is
  // no immutable copy of what the student handed in.
  const v = unlockability({ row: reportRow({ preservation_status: "failed" }), lockdownRow: lockRow() });
  assert.equal(v.can, false);
  assert.match(v.reason, /FAILED/);
  assert.match(v.reason, /nothing to grade against/);
  assert.doesNotMatch(v.reason, /wait for the nightly/);
});

test("an unknown preservation status refuses - absent is not 'fine'", () => {
  assert.equal(unlockability({ row: reportRow({ preservation_status: null }), lockdownRow: lockRow() }).can, false);
  assert.equal(unlockability({ row: null, lockdownRow: lockRow() }).can, false);
});

test("'not-required' is an answer, and it permits the unlock", () => {
  // Nothing was preserved because nothing needed to be - a repository with no
  // submission. There is no snapshot to protect, so there is nothing to wait for.
  const v = unlockability({ row: reportRow({ preservation_status: "not-required" }), lockdownRow: lockRow() });
  assert.equal(v.can, true);
});

test("no lockdown record row means nothing was locked, and says which case that is", () => {
  const v = unlockability({ row: reportRow(), lockdownRow: null });
  assert.equal(v.can, false);
  assert.match(v.reason, /no lockdown record/);
  assert.match(v.reason, /accepted after it did/);
});

test("an assignment that locks nothing has nothing to unlock", () => {
  // `lock_down_enabled: false` is a deliberate decision. Reporting an unlock
  // over it would be a control claiming work it did not do.
  const v = unlockability({ row: reportRow(), lockdownRow: lockRow({ lock_method: "none" }) });
  assert.equal(v.can, false);
  assert.match(v.reason, /does not lock repositories at the deadline/);
});

test("a lock that never succeeded is not reported as reopened", () => {
  // `verified: false` means the freeze itself failed. Claiming to have undone
  // it would hide that the repository was never stopped in the first place.
  const v = unlockability({ row: reportRow(), lockdownRow: lockRow({ verified: false }) });
  assert.equal(v.can, false);
  assert.match(v.reason, /did not manage to lock/);
});

test("an unrecognised lock method refuses rather than guessing an inverse", () => {
  const v = unlockability({ row: reportRow(), lockdownRow: lockRow({ lock_method: "sorcery" }) });
  assert.equal(v.can, false);
  assert.match(v.reason, /lock_method: sorcery/);

  const absent = unlockability({ row: reportRow(), lockdownRow: lockRow({ lock_method: undefined }) });
  assert.match(absent.reason, /lock_method: absent/);
});

test("a row with no repository name refuses", () => {
  const v = unlockability({ row: reportRow(), lockdownRow: lockRow({ repo_name: null }) });
  assert.equal(v.can, false);
  assert.match(v.reason, /does not name the repository/);
});

test("a DEMOTED repository restores the assignment's own student_permission", () => {
  // The lockdown record stores permission_after and never what the student had
  // before, so the level has to come from the assignment - which is what
  // provisioning granted, and therefore what "restored" means.
  const v = unlockability({
    row: reportRow(),
    lockdownRow: lockRow({ lock_method: "demotion", permission_after: "pull" }),
    assignment: { student_permission: "push" },
  });
  assert.equal(v.can, true);
  assert.equal(v.method, "demotion");
  assert.equal(v.permission, "push");
});

test("an assignment predating student_permission restores admin, the schema's default", () => {
  // Not `pull`: silently leaving a student read-only would look like a
  // successful unlock and leave them unable to push.
  const v = unlockability({
    row: reportRow(),
    lockdownRow: lockRow({ lock_method: "demotion" }),
    assignment: {},
  });
  assert.equal(v.permission, "admin");
  assert.equal(unlockability({ row: reportRow(), lockdownRow: lockRow({ lock_method: "demotion" }) }).permission, "admin");
});

// -------------------------------------------------- doing it, over the REAL
// releaseSubmissionLock rather than a mock that agrees with whatever it is told

/** A fake transport shaped like lib/gh.mjs's `gh(method, path, body)`. */
function transport({ rulesets = [], putStatus = 200, putEnforcement = "disabled", listStatus = 200 } = {}) {
  const calls = [];
  const request = async (method, path, body) => {
    calls.push({ method, path, body });
    if (method === "GET" && path.endsWith("/rulesets")) {
      return listStatus === 200
        ? { ok: true, status: 200, data: rulesets }
        : { ok: false, status: listStatus, data: { message: "boom" } };
    }
    if (method === "PUT" && /\/rulesets\/\d+$/.test(path)) {
      return putStatus === 200
        ? { ok: true, status: 200, data: { id: 7, enforcement: putEnforcement } }
        : { ok: false, status: putStatus, data: { message: "denied" } };
    }
    return { ok: false, status: 404, data: {} };
  };
  return { request, calls };
}

const activeLock = { id: 7, name: SUBMISSION_LOCK_NAME, enforcement: "active", source_type: "Repository" };

test("a ruleset unlock DISABLES the ruleset and never deletes it", async () => {
  // A deleted ruleset re-created without the App in bypass_actors locks this
  // system out of the repository along with the student.
  const t = transport({ rulesets: [activeLock] });
  const res = await applyUnlock({
    request: t.request, releaseLock: releaseSubmissionLock, org: ORG, repo: REPO, method: "ruleset",
  });
  assert.equal(res.ok, true);
  assert.ok(!t.calls.some((c) => c.method === "DELETE"), "nothing is deleted");
  const put = t.calls.find((c) => c.method === "PUT");
  assert.deepEqual(put.body, { enforcement: "disabled" }, "only enforcement is sent");
});

test("an already-disabled ruleset is a success with no write", async () => {
  const t = transport({ rulesets: [{ ...activeLock, enforcement: "disabled" }] });
  const res = await applyUnlock({
    request: t.request, releaseLock: releaseSubmissionLock, org: ORG, repo: REPO, method: "ruleset",
  });
  assert.equal(res.ok, true);
  assert.ok(!t.calls.some((c) => c.method === "PUT"));
});

test("a MISSING ruleset is reported, not shrugged off as done", async () => {
  // The lockdown record says this repository was locked with a ruleset. If
  // there is no ruleset, something removed it, and a green toast over that
  // would hide it.
  const t = transport({ rulesets: [] });
  const res = await applyUnlock({
    request: t.request, releaseLock: releaseSubmissionLock, org: ORG, repo: REPO, method: "ruleset",
  });
  assert.equal(res.ok, false);
  assert.match(res.reason, /already have been removed on GitHub/);
});

test("somebody else's ruleset is not ours to touch", async () => {
  const t = transport({ rulesets: [{ id: 9, name: "org-wide-protection", enforcement: "active", source_type: "Organization" }] });
  const res = await applyUnlock({
    request: t.request, releaseLock: releaseSubmissionLock, org: ORG, repo: REPO, method: "ruleset",
  });
  assert.equal(res.ok, false);
  assert.ok(!t.calls.some((c) => c.method === "PUT"), "no write to a ruleset we do not own");
});

test("a 403 on the write is reported with its status - it is the common failure", async () => {
  // Editing a repository ruleset needs admin. A lecturer who is hub-writable
  // but not an organization owner gets exactly this, and has to be told so
  // rather than shown "unlock failed".
  const t = transport({ rulesets: [activeLock], putStatus: 403 });
  const res = await applyUnlock({
    request: t.request, releaseLock: releaseSubmissionLock, org: ORG, repo: REPO, method: "ruleset",
  });
  assert.equal(res.ok, false);
  assert.match(res.reason, /403/);
});

test("an unreadable ruleset list refuses rather than reporting nothing to do", async () => {
  const t = transport({ listStatus: 500 });
  const res = await applyUnlock({
    request: t.request, releaseLock: releaseSubmissionLock, org: ORG, repo: REPO, method: "ruleset",
  });
  assert.equal(res.ok, false);
  assert.match(res.reason, /500/);
});

test("a PUT that answers 200 with the lock still ACTIVE is a failure", async () => {
  // The answer is read back rather than assumed. A button that reports an
  // unlock it did not perform sends somebody to argue with a student who
  // still cannot hand in.
  const t = transport({ rulesets: [activeLock], putEnforcement: "active" });
  const res = await applyUnlock({
    request: t.request, releaseLock: releaseSubmissionLock, org: ORG, repo: REPO, method: "ruleset",
  });
  assert.equal(res.ok, false);
  assert.match(res.reason, /still active/);
});

test("a demotion unlock restores the permission, and never touches a ruleset", async () => {
  const t = transport({ rulesets: [activeLock] });
  const seen = [];
  const res = await applyUnlock({
    request: t.request,
    releaseLock: releaseSubmissionLock,
    setPermission: async (a) => { seen.push(a); return { ok: true }; },
    org: ORG, repo: REPO, login: "ella-dev", method: "demotion", permission: "admin",
  });
  assert.equal(res.ok, true);
  assert.deepEqual(seen, [{ org: ORG, repo: REPO, login: "ella-dev", permission: "admin" }]);
  assert.equal(t.calls.length, 0, "the ruleset is not read or written");
});

test("a demotion unlock with no permission to restore refuses", async () => {
  const res = await applyUnlock({
    setPermission: async () => ({ ok: true }), org: ORG, repo: REPO, method: "demotion", permission: null,
  });
  assert.equal(res.ok, false);
});

test("a failed permission restore is reported", async () => {
  const res = await applyUnlock({
    setPermission: async () => ({ ok: false, reason: "HTTP 403" }),
    org: ORG, repo: REPO, method: "demotion", permission: "admin",
  });
  assert.equal(res.ok, false);
  assert.match(res.reason, /403/);
});

test("an unknown method does nothing at all", async () => {
  const res = await applyUnlock({ org: ORG, repo: REPO, method: "sorcery" });
  assert.equal(res.ok, false);
  assert.match(res.reason, /unknown lock method sorcery/);
});

// ------------------------------------------------------------- the record

test("the record validates against its schema and carries the snapshot", () => {
  const doc = unlockRecord({
    assignmentId: "lab-3",
    login: "ella-dev",
    repo: `${ORG}/${REPO}`,
    method: "ruleset",
    by: "tomcoolpxl",
    reason: "Medical certificate, extension approved after the freeze",
    snapshotSha: "a".repeat(40),
    at: "2026-10-08T09:00:00Z",
  });
  assert.deepEqual(validateAgainst("unlock-record", doc).errors, []);
  assert.equal(doc.snapshot_sha, "a".repeat(40), "what was graded is in the record");
  assert.equal(doc.repo_name, `${ORG}/${REPO}`, "owner/name, readable on its own");
});

test("a team unlock records the slug, so a reader knows it reopened for everyone", () => {
  const doc = unlockRecord({
    assignmentId: "lab-3", login: "ella-dev", repo: `${ORG}/lab-3-alpha`, method: "ruleset",
    by: "tomcoolpxl", reason: "Appeal upheld", teamSlug: "alpha", at: "2026-10-08T09:00:00Z",
  });
  assert.deepEqual(validateAgainst("unlock-record", doc).errors, []);
  assert.equal(doc.team_slug, "alpha");
});

test("a demotion record says what level was restored", () => {
  const doc = unlockRecord({
    assignmentId: "lab-3", login: "ella-dev", repo: `${ORG}/${REPO}`, method: "demotion",
    by: "tomcoolpxl", reason: "Resit", permission: "admin", at: "2026-10-08T09:00:00Z",
  });
  assert.deepEqual(validateAgainst("unlock-record", doc).errors, []);
  assert.equal(doc.permission_restored, "admin");
});

test("optional fields are ABSENT rather than null when they do not apply", () => {
  // additionalProperties is false and the enums do not admit null, so a
  // null team_slug would fail the schema - and absent and empty are
  // different answers here as everywhere else.
  const doc = unlockRecord({
    assignmentId: "lab-3", login: "ella-dev", repo: `${ORG}/${REPO}`, method: "ruleset",
    by: "tomcoolpxl", reason: "Appeal upheld", teamSlug: null, permission: null,
  });
  assert.ok(!("team_slug" in doc));
  assert.ok(!("permission_restored" in doc));
  assert.deepEqual(validateAgainst("unlock-record", doc).errors, []);
});

test("a record with no reason is refused by the schema", () => {
  // This document exists to be read by somebody who was not there. A reason
  // field saying "unlocked" answers nothing, so it may not be defaulted.
  const doc = unlockRecord({
    assignmentId: "lab-3", login: "ella-dev", repo: `${ORG}/${REPO}`, method: "ruleset",
    by: "tomcoolpxl", reason: "",
  });
  assert.equal(validateAgainst("unlock-record", doc).valid, false);
});

test("the path is one file per student, beside the lockdown record", () => {
  // Not inside it: the lockdown record is re-written whole by the next
  // finalize attempt, which would erase an unlock stored in it. One file per
  // student is also what makes two lecturers acting at once safe.
  assert.equal(unlockRecordPath("lab-3", "ella-dev"), "lockdowns/lab-3/unlocked/ella-dev.json");
});
