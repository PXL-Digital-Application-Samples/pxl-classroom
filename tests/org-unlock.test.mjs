// Reopening ONE repository when the cohort is held by an organization ruleset.
//
// The inverse is not a flag flip. There is no repository ruleset to disable, so
// undoing it means removing one repository id from an object that covers
// everybody else - and applying the wrong inverse reports a successful unlock
// over a student who still cannot push, which is the exact failure `lock_method`
// per row exists to prevent.
//
// The REAL lib/submission-lock.mjs functions are passed in, driven over a
// transport that behaves as the live API was measured to: PUT replaces
// conditions rather than merging them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyUnlock, unlockability } from "../lib/repo-unlock.mjs";
import {
  removeRepoFromOrgLock,
  releaseSubmissionLock,
  orgSubmissionLockName,
  SUBMISSION_LOCK_NAME,
} from "../lib/submission-lock.mjs";
import { pageOf, splitQuery } from "./fixtures/github-pages.mjs";

const ORG = "PXLAutomation";
const REPO = "lab-1-ada";
const ASSIGNMENT = "lab-1";
const REPO_ID = 111;

function transport({ orgRulesets = [], repoRulesets = [], deleted = [] } = {}) {
  const calls = [];
  const request = async (method, path, body) => {
    calls.push({ method, path, body });
    // A repository deleted after the lock: GitHub refuses a write that leaves
    // it in the list, without saying which - and a write sending enforcement
    // alone is checked against the list it already stores (measured, live
    // 2026-10-15).
    if (method === "GET" && path.startsWith("/repositories/")) {
      const id = Number(path.split("/").pop());
      return deleted.includes(id) ? { ok: false, status: 404, data: {} } : { ok: true, status: 200, data: { id, owner: { login: ORG } } };
    }
    const stored = orgRulesets.find((r) => method === "PUT" && path === `/orgs/${ORG}/rulesets/${r.id}`);
    const named = body?.conditions?.repository_id?.repository_ids ?? stored?.conditions?.repository_id?.repository_ids ?? [];
    if (stored && named.some((id) => deleted.includes(id))) {
      return { ok: false, status: 422, data: { message: "Validation Failed", errors: ["Invalid parameter repository_ids: repository selected does not exist or is not in this organization"] } };
    }
    if (method === "GET" && splitQuery(path).pathname === `/orgs/${ORG}/rulesets`) {
      return { ok: true, status: 200, data: pageOf(path, orgRulesets.map((r) => ({ id: r.id, name: r.name }))) };
    }
    if (method === "GET" && path.startsWith(`/orgs/${ORG}/rulesets/`)) {
      const hit = orgRulesets.find((r) => r.id === Number(path.split("/").pop()));
      return hit ? { ok: true, status: 200, data: hit } : { ok: false, status: 404, data: {} };
    }
    if (method === "PUT" && path.startsWith(`/orgs/${ORG}/rulesets/`)) {
      const hit = orgRulesets.find((r) => r.id === Number(path.split("/").pop()));
      if (!hit) return { ok: false, status: 404, data: {} };
      if (body.conditions) hit.conditions = body.conditions;   // REPLACE, measured
      if (body.enforcement) hit.enforcement = body.enforcement;
      return { ok: true, status: 200, data: hit };
    }
    if (method === "GET" && splitQuery(path).pathname === `/repos/${ORG}/${REPO}/rulesets`) {
      return { ok: true, status: 200, data: pageOf(path, repoRulesets) };
    }
    if (method === "PUT" && path.startsWith(`/repos/${ORG}/${REPO}/rulesets/`)) {
      const hit = repoRulesets.find((r) => r.id === Number(path.split("/").pop()));
      if (!hit) return { ok: false, status: 404, data: {} };
      hit.enforcement = body.enforcement;
      return { ok: true, status: 200, data: hit };
    }
    return { ok: false, status: 599, data: {} };
  };
  return { request, calls, orgRulesets, repoRulesets };
}

const orgLock = (ids) => ({
  id: 900,
  name: orgSubmissionLockName(ASSIGNMENT),
  enforcement: "active",
  conditions: { repository_id: { repository_ids: ids }, ref_name: { include: ["refs/heads/main"], exclude: [] } },
});

const unlock = (t, over = {}) =>
  applyUnlock({
    request: t.request,
    releaseLock: releaseSubmissionLock,
    releaseOrgLock: removeRepoFromOrgLock,
    org: ORG,
    repo: REPO,
    repositoryId: REPO_ID,
    assignmentId: ASSIGNMENT,
    login: "ada",
    method: "org-ruleset",
    ...over,
  });

test("org-ruleset is a method the record can be unlocked from", () => {
  // unlockability refuses a method it does not know, so a row written by the
  // new lockdown path would otherwise be un-reopenable.
  const v = unlockability({
    assignment: { student_permission: "admin" },
    lockdownRow: {
      github_login: "ada", repo_name: `${ORG}/${REPO}`, repo_id: REPO_ID,
      lock_method: "org-ruleset", snapshot_sha: "a", verified: true,
    },
    // Preservation is read off the REPORT row, not the lockdown record - the
    // freeze happens first and cannot know how preserving went.
    row: { preservation_status: "preserved" },
  });
  assert.equal(v.can, true, v.reason);
  assert.equal(v.method, "org-ruleset");
});

test("it removes ONE id and leaves the rest of the cohort locked", async () => {
  const t = transport({ orgRulesets: [orgLock([111, 222, 333])] });
  const res = await unlock(t);
  assert.equal(res.ok, true, res.reason);
  assert.deepEqual(t.orgRulesets[0].conditions.repository_id.repository_ids, [222, 333]);
  assert.equal(t.orgRulesets[0].enforcement, "active", "everybody else stays locked");
});

test("another student's DELETED repository in the list does not stop a reopen: it is left out, and named", async () => {
  // Found live 2026-10-15: one deleted repository made every reopen on the
  // assignment fail 422 while the lockdown, which had this recovery, passed.
  const t = transport({ orgRulesets: [orgLock([111, 222, 333])], deleted: [222] });
  const res = await removeRepoFromOrgLock(t.request, { org: ORG, assignmentId: ASSIGNMENT, repositoryId: REPO_ID });
  assert.deepEqual(res, { ok: true, action: "removed", dropped: [222], reason: null });
  assert.deepEqual(t.orgRulesets[0].conditions.repository_id.repository_ids, [333]);
  assert.equal(t.orgRulesets[0].enforcement, "active", "the living rest stay locked");
  // Through the reopen itself, too.
  const again = transport({ orgRulesets: [orgLock([111, 222, 333])], deleted: [222] });
  assert.equal((await unlock(again)).ok, true);
});

test("everyone else's repository deleted: the ruleset is disabled, as removing the last one does", async () => {
  const t = transport({ orgRulesets: [orgLock([111, 222])], deleted: [222] });
  const res = await removeRepoFromOrgLock(t.request, { org: ORG, assignmentId: ASSIGNMENT, repositoryId: REPO_ID });
  assert.deepEqual(res, { ok: true, action: "disabled", dropped: [222], reason: null });
  assert.equal(t.orgRulesets[0].enforcement, "disabled");
  assert.deepEqual(t.orgRulesets[0].conditions.repository_id.repository_ids, [REPO_ID],
    "the deleted one is out of the list, or every later write is refused for it");
  assert.ok(!t.calls.some((c) => c.method === "DELETE"));
});

test("a 422 with every repository alive is reported, not retried with the same list", async () => {
  const t = transport({ orgRulesets: [orgLock([111, 222])] });
  let puts = 0;
  const refuse = async (m, p, b) => (m === "PUT" && p.startsWith(`/orgs/${ORG}/rulesets/`))
    ? (puts++, { ok: false, status: 422, data: { message: "Validation Failed" } }) : t.request(m, p, b);
  const res = await removeRepoFromOrgLock(refuse, { org: ORG, assignmentId: ASSIGNMENT, repositoryId: REPO_ID });
  assert.equal(res.ok, false);
  assert.match(res.reason, /HTTP 422 Validation Failed/);
  assert.equal(puts, 1, "one PUT, no identical retry");
  // ...and an unreadable repository is not taken for a deleted one.
  const blind = async (m, p, b) => p.startsWith("/repositories/") ? { ok: false, status: 500, data: {} } : refuse(m, p, b);
  assert.match((await removeRepoFromOrgLock(blind, { org: ORG, assignmentId: ASSIGNMENT, repositoryId: REPO_ID })).reason, /HTTP 500 \(after update org ruleset HTTP 422/);
});

test("it never deletes the organization ruleset", async () => {
  const t = transport({ orgRulesets: [orgLock([111, 222])] });
  await unlock(t);
  assert.ok(!t.calls.some((c) => c.method === "DELETE"),
    "a deleted ruleset re-created without the App in bypass_actors locks this system out too");
});

test("a row with no repo_id cannot be unlocked, and says so", async () => {
  // The id is what an organization ruleset targets. Guessing from the name
  // would be the composition rule lib/archive-repo.mjs exists to forbid.
  const t = transport({ orgRulesets: [orgLock([111])] });
  const res = await unlock(t, { repositoryId: null });
  assert.equal(res.ok, false);
  assert.match(res.reason, /does not say which repository id/);
  assert.equal(t.calls.length, 0, "and it does not go looking");
});

test("no organization ruleset is ABSENT, not a quiet success", async () => {
  const t = transport({ orgRulesets: [] });
  const res = await unlock(t);
  assert.equal(res.ok, false);
  assert.match(res.reason, /may already have been removed/);
});

test("AN ORGANIZATION-RULESET ROW THAT WAS ALSO DEMOTED gets both inverses", async () => {
  // `block` + `lock_down_enabled: true` under the default scope: the id held the
  // ref, and phase 4 took admin as well. Removing the id alone reports "can push
  // again" over a student left at `pull`.
  const v = unlockability({
    assignment: { student_permission: "admin" },
    lockdownRow: {
      github_login: "ada", repo_name: `${ORG}/${REPO}`, repo_id: REPO_ID,
      lock_method: "org-ruleset", demoted: true, snapshot_sha: "a", verified: true,
    },
    row: { preservation_status: "preserved" },
  });
  assert.equal(v.can, true, v.reason);
  assert.equal(v.permission, "admin");

  const t = transport({ orgRulesets: [orgLock([111, 222])] });
  const restored = [];
  const res = await unlock(t, {
    permission: v.permission,
    setPermission: async (a) => { restored.push(a); return { ok: true }; },
  });
  assert.equal(res.ok, true, res.reason);
  assert.deepEqual(t.orgRulesets[0].conditions.repository_id.repository_ids, [222]);
  assert.deepEqual(restored, [{ org: ORG, repo: REPO, login: "ada", permission: "admin" }]);
});

test("a failed restore after the id was removed can be retried from the same row", async () => {
  // Released first because the release repeats cleanly: an id already out of
  // the organization ruleset answers `already`, not `absent`.
  const t = transport({ orgRulesets: [orgLock([111, 222])] });
  const first = await unlock(t, { permission: "admin", setPermission: async () => ({ ok: false, reason: "HTTP 502" }) });
  assert.equal(first.ok, false);
  assert.match(first.reason, /still read-only/);
  const retry = await unlock(t, { permission: "admin", setPermission: async () => ({ ok: true }) });
  assert.equal(retry.ok, true, retry.reason);
});

test("A LEFTOVER REPOSITORY RULESET IS RELEASED TOO", async () => {
  // The migration window: a cohort locked per repository and then moved to an
  // organization ruleset holds both. Both block, which is harmless until
  // somebody is reopened - and then the leftover keeps that student out with
  // nothing on screen to explain it.
  const t = transport({
    orgRulesets: [orgLock([111, 222])],
    repoRulesets: [{ id: 7, name: SUBMISSION_LOCK_NAME, enforcement: "active", source_type: "Repository" }],
  });
  const res = await unlock(t);
  assert.equal(res.ok, true, res.reason);
  assert.equal(res.alsoReleased, "repository-ruleset");
  assert.equal(t.repoRulesets[0].enforcement, "disabled");
  assert.deepEqual(t.orgRulesets[0].conditions.repository_id.repository_ids, [222]);
});

test("no leftover is the ordinary case and not a failure", async () => {
  const t = transport({ orgRulesets: [orgLock([111, 222])] });
  const res = await unlock(t);
  assert.equal(res.ok, true, res.reason);
  assert.equal(res.alsoReleased, undefined);
});

test("a failed removal is reported, never reported as done", async () => {
  const t = transport({ orgRulesets: [orgLock([111, 222])] });
  const request = async (m, p, b) =>
    (m === "PUT" && p.startsWith(`/orgs/${ORG}/rulesets/`)) ? { ok: false, status: 403, data: { message: "Resource not accessible" } } : t.request(m, p, b);
  const res = await unlock({ ...t, request }, {});
  assert.equal(res.ok, false);
  assert.match(res.reason, /403/);
});

// ---------------------------------------------------------------------------
// THE OTHER HALF OF THE MIGRATION WINDOW.
//
// The tests above cover a row that says `org-ruleset` while a repository
// ruleset is still on the repository. This is the reverse, and it is the one
// that happens by itself: scripts/migrate-org-lock.mjs creates the organization
// ruleset and rewrites the rows, but that rewrite is not committed until the
// workflow's last step - so a run that dies in between leaves rows saying
// `ruleset` over repositories an organization ruleset is really holding.
//
// A protection guards the case you were thinking of, not the dangerous one.
// ---------------------------------------------------------------------------

const staleRow = (t, over = {}) => unlock(t, { method: "ruleset", ...over });

test("A STALE `ruleset` ROW UNDER AN ORGANIZATION LOCK RELEASES BOTH", async () => {
  const t = transport({
    orgRulesets: [orgLock([111, 222])],
    repoRulesets: [{ id: 7, name: SUBMISSION_LOCK_NAME, enforcement: "active", source_type: "Repository" }],
  });
  const res = await staleRow(t);
  assert.equal(res.ok, true, res.reason);
  assert.equal(res.alsoReleased, "organization-ruleset");
  assert.equal(t.repoRulesets[0].enforcement, "disabled");
  assert.deepEqual(t.orgRulesets[0].conditions.repository_id.repository_ids, [222],
    "the student is out of the organization ruleset, everybody else stays in");
});

test("a stale row whose repository ruleset is already gone still succeeds", async () => {
  // The migration disables the repository ruleset AFTER the organization one is
  // in place, so this is what a run interrupted one step later looks like. The
  // ordinary "absent means tell the lecturer" answer would be wrong here: the
  // organization ruleset was the lock, and it has just been released.
  const t = transport({ orgRulesets: [orgLock([111, 222])] });
  const res = await staleRow(t);
  assert.equal(res.ok, true, res.reason);
  assert.equal(res.alsoReleased, "organization-ruleset");
  assert.deepEqual(t.orgRulesets[0].conditions.repository_id.repository_ids, [222]);
});

test("an unmigrated cohort is untouched - no organization ruleset, no change", async () => {
  const t = transport({
    repoRulesets: [{ id: 7, name: SUBMISSION_LOCK_NAME, enforcement: "active", source_type: "Repository" }],
  });
  const res = await staleRow(t);
  assert.equal(res.ok, true, res.reason);
  assert.equal(res.alsoReleased, undefined, "nothing to say - this is the ordinary path");
  assert.equal(t.repoRulesets[0].enforcement, "disabled");
});

test("an organization ruleset that never covered this repository is not a release", async () => {
  // It exists, so the lookup succeeds, but this student was never in it - most
  // likely a partly-migrated cohort. Claiming a release here would put
  // "organization-ruleset" in front of a lecturer over an object nothing did.
  const t = transport({
    orgRulesets: [orgLock([222, 333])],
    repoRulesets: [{ id: 7, name: SUBMISSION_LOCK_NAME, enforcement: "active", source_type: "Repository" }],
  });
  const res = await staleRow(t);
  assert.equal(res.ok, true, res.reason);
  assert.equal(res.alsoReleased, undefined);
  assert.deepEqual(t.orgRulesets[0].conditions.repository_id.repository_ids, [222, 333]);
});

test("a stale row still fails when the ORGANIZATION ruleset cannot be updated", async () => {
  // Fail closed. The organization ruleset is the stronger lock, so a repository
  // flip on its own would be a green toast over a student who cannot push.
  const t = transport({
    orgRulesets: [orgLock([111, 222])],
    repoRulesets: [{ id: 7, name: SUBMISSION_LOCK_NAME, enforcement: "active", source_type: "Repository" }],
  });
  const request = async (m, p, b) =>
    (m === "PUT" && p.startsWith(`/orgs/${ORG}/rulesets/`))
      ? { ok: false, status: 403, data: { message: "Resource not accessible" } }
      : t.request(m, p, b);
  const res = await staleRow({ ...t, request });
  assert.equal(res.ok, false);
  assert.match(res.reason, /403/);
  assert.equal(t.repoRulesets[0].enforcement, "active",
    "and it stops before touching the repository ruleset, so the record still describes reality");
});
