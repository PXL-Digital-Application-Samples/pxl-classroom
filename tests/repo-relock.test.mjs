// lib/repo-relock.mjs and lib/submission-lock.mjs `addRepoToOrgLock`: locking a
// reopened repository again (review 2026-10-15, P2-57). Every lockdown run skips
// a repository with a reopen record, so without this nothing could ever lock it
// again. The real functions run over a fake `request`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { relockability, applyRelock, relockedRecord } from "../lib/repo-relock.mjs";
import { unlockability } from "../lib/repo-unlock.mjs";
import { addRepoToOrgLock, orgSubmissionLockName } from "../lib/submission-lock.mjs";

const reopen = (over = {}) => ({
  schema_version: 1, assignment_id: "lab", github_login: "ann", repo_name: "Org/lab-ann",
  unlocked_at: "2026-10-15T08:00:00Z", unlocked_by: "lect", reason: "appeal", lock_method: "org-ruleset", snapshot_sha: "a".repeat(40),
  ...over,
});

test("relockability: only a reopened repository, how it was locked, and whether a permission comes down again", () => {
  assert.equal(relockability({ reopenRecord: null }), null, "not reopened: no control at all");
  const org = relockability({ reopenRecord: reopen() });
  assert.deepEqual([org.can, org.method, org.repo, org.demote, org.by, org.why], [true, "org-ruleset", "Org/lab-ann", false, "lect", "appeal"]);
  assert.equal(relockability({ reopenRecord: reopen({ permission_restored: "admin" }) }).demote, true, "demoted on top of the ruleset");
  assert.equal(relockability({ reopenRecord: reopen({ lock_method: "demotion", permission_restored: "admin" }) }).demote, true);
  const odd = relockability({ reopenRecord: reopen({ lock_method: "none" }) });
  assert.equal(odd.can, false);
  assert.match(odd.reason, /does not say how this repository was locked/);
  assert.equal(relockability({ reopenRecord: reopen({ repo_name: undefined }) }).can, false);
});

test("unlockability: a repository with a reopen record is open already, whatever the lockdown row still says", () => {
  const row = { github_login: "ann", repo_name: "Org/lab-ann", lock_method: "org-ruleset", verified: true };
  const v = unlockability({ row: { preservation_status: "preserved" }, lockdownRow: row, reopenRecord: reopen() });
  assert.equal(v.can, false);
  assert.equal(v.reason, "This repository was reopened on 2026-10-15T08:00:00Z by @lect. Lock again puts the deadline's lock back.");
  // Without one, as before.
  assert.equal(unlockability({ row: { preservation_status: "preserved" }, lockdownRow: row }).can, true);
});

/** Records the writes; answers each (method, path) from `answers` or 404. */
function fake(answers) {
  const calls = [];
  const request = async (method, path, body) => {
    calls.push({ method, path, body: body ?? null });
    const a = typeof answers === "function" ? answers(method, path, body) : answers[`${method} ${path}`];
    return a ?? { ok: false, status: 404, data: { message: "Not Found" } };
  };
  return { request, calls };
}
const NAME = orgSubmissionLockName("lab");
const orgRuleset = (ids, enforcement = "active") => ({
  id: 7, name: NAME, enforcement,
  conditions: { repository_id: { repository_ids: ids }, ref_name: { include: ["refs/heads/main"], exclude: [] } },
});
function orgApi(ruleset, { putAnswer } = {}) {
  return fake((method, path, body) => {
    if (method === "GET" && path.startsWith("/orgs/Org/rulesets?")) return { ok: true, status: 200, data: ruleset ? [{ id: 7, name: NAME }] : [] };
    if (method === "GET" && path === "/orgs/Org/rulesets/7") return { ok: true, status: 200, data: ruleset };
    if (method === "PUT" && path === "/orgs/Org/rulesets/7") return putAnswer ? putAnswer(body) : { ok: true, status: 200, data: { ...ruleset, ...body } };
    return null;
  });
}

test("addRepoToOrgLock: added to an active ruleset, the rest kept", async () => {
  const api = orgApi(orgRuleset([1, 2]));
  const r = await addRepoToOrgLock(api.request, { org: "Org", assignmentId: "lab", repositoryId: 3 });
  assert.deepEqual(r, { ok: true, action: "added", dropped: [], reason: null });
  const put = api.calls.find((c) => c.method === "PUT");
  assert.deepEqual(put.body.conditions.repository_id.repository_ids, [1, 2, 3]);
  assert.equal(put.body.enforcement, "active");
  assert.deepEqual(put.body.conditions.ref_name, { include: ["refs/heads/main"], exclude: [] }, "the ref condition is kept");
});

test("addRepoToOrgLock: a DISABLED ruleset is everyone reopened - enabled with this repository alone, never the one it still lists", async () => {
  // The last removal switched it off with the last reopened repository (2) still listed.
  const api = orgApi(orgRuleset([2], "disabled"));
  const r = await addRepoToOrgLock(api.request, { org: "Org", assignmentId: "lab", repositoryId: 3 });
  assert.equal(r.action, "enabled");
  assert.deepEqual(api.calls.find((c) => c.method === "PUT").body.conditions.repository_id.repository_ids, [3]);
  // ...and the repository that disabled it, locked again on its own.
  const same = orgApi(orgRuleset([2], "disabled"));
  assert.equal((await addRepoToOrgLock(same.request, { org: "Org", assignmentId: "lab", repositoryId: 2 })).ok, true);
  assert.deepEqual(same.calls.find((c) => c.method === "PUT").body.conditions.repository_id.repository_ids, [2]);
});

test("addRepoToOrgLock: another student's DELETED repository in the list is left out and named; this one gone is a failure", async () => {
  // GitHub refuses a list naming a deleted repository, without saying which
  // (measured live 2026-10-15, where it stopped a reopen on the same ruleset).
  const gone = [2];
  const answers = (putIds) => fake((method, path, body) => {
    if (method === "GET" && path.startsWith("/orgs/Org/rulesets?")) return { ok: true, status: 200, data: [{ id: 7, name: NAME }] };
    if (method === "GET" && path === "/orgs/Org/rulesets/7") return { ok: true, status: 200, data: orgRuleset([1, 2]) };
    if (method === "GET" && path.startsWith("/repositories/")) {
      const id = Number(path.split("/").pop());
      return gone.includes(id) ? null : { ok: true, status: 200, data: { id, owner: { login: "org" } } };
    }
    if (method === "PUT") {
      const ids = body.conditions.repository_id.repository_ids;
      putIds.push(ids);
      if (ids.some((id) => gone.includes(id))) return { ok: false, status: 422, data: { message: "Validation Failed" } };
      return { ok: true, status: 200, data: { ...orgRuleset(ids), enforcement: body.enforcement } };
    }
    return null;
  });
  const putIds = [];
  const r = await addRepoToOrgLock(answers(putIds).request, { org: "Org", assignmentId: "lab", repositoryId: 3 });
  assert.deepEqual(r, { ok: true, action: "added", dropped: [2], reason: null });
  assert.deepEqual(putIds, [[1, 2, 3], [1, 3]], "refused with the deleted one, written without it");

  const self = [];
  gone.push(3);
  const s = await addRepoToOrgLock(answers(self).request, { org: "Org", assignmentId: "lab", repositoryId: 3 });
  assert.deepEqual([s.ok, s.reason], [false, "the repository no longer exists"]);
  assert.equal(self.length, 1, "nothing is written for a repository that is gone");
});

test("addRepoToOrgLock: already covered writes nothing; no ruleset is never made here; a write GitHub did not apply fails", async () => {
  const already = orgApi(orgRuleset([1, 3]));
  assert.deepEqual(await addRepoToOrgLock(already.request, { org: "Org", assignmentId: "lab", repositoryId: 3 }), { ok: true, action: "already", reason: null });
  assert.equal(already.calls.filter((c) => c.method === "PUT").length, 0);

  const absent = orgApi(null);
  const a = await addRepoToOrgLock(absent.request, { org: "Org", assignmentId: "lab", repositoryId: 3 });
  assert.equal(a.action, "absent");
  assert.ok(!absent.calls.some((c) => c.method === "POST" || c.method === "PUT"), "nothing created");

  const ignored = orgApi(orgRuleset([1]), { putAnswer: () => ({ ok: true, status: 200, data: orgRuleset([1]) }) });
  assert.equal((await addRepoToOrgLock(ignored.request, { org: "Org", assignmentId: "lab", repositoryId: 3 })).ok, false);

  const refused = orgApi(orgRuleset([1]), { putAnswer: () => ({ ok: false, status: 403, data: { message: "Forbidden" } }) });
  assert.match((await addRepoToOrgLock(refused.request, { org: "Org", assignmentId: "lab", repositoryId: 3 })).reason, /HTTP 403/);
  assert.equal((await addRepoToOrgLock(fake({}).request, { org: "Org", assignmentId: "lab", repositoryId: "3" })).ok, false, "an id that is not a number");
});

test("applyRelock: each method puts back its own lock, then every member who can still be reached goes back to read", async () => {
  const seen = [];
  const deps = {
    request: async () => ({ ok: true }),
    addToOrgLock: async (_r, a) => { seen.push(["org", a.repositoryId]); return { ok: true }; },
    ensureLock: async (_r, a) => { seen.push(["repo", a.enforcement, a.appId, a.submissionRef]); return { ok: true }; },
    setPermission: async (a) => { seen.push(["perm", a.login, a.permission]); return { ok: true }; },
    presence: async (l) => (l === "gone" ? "gone" : "collaborator"),
    org: "Org", repo: "lab-ann", repositoryId: 9, assignmentId: "lab", submissionRef: "refs/heads/main", appId: 42, login: "ann",
  };
  assert.deepEqual(await applyRelock({ ...deps, method: "org-ruleset", demote: false }), { ok: true, reason: null });
  assert.deepEqual(seen.splice(0), [["org", 9]]);
  assert.equal((await applyRelock({ ...deps, method: "ruleset", demote: true, logins: ["ann", "bob", "gone"] })).ok, true);
  assert.deepEqual(seen.splice(0), [["repo", "active", 42, "refs/heads/main"], ["perm", "ann", "pull"], ["perm", "bob", "pull"]], "a member with no access is not invited");
  assert.equal((await applyRelock({ ...deps, method: "demotion", demote: true })).ok, true);
  assert.deepEqual(seen.splice(0), [["perm", "ann", "pull"]]);
  assert.match((await applyRelock({ ...deps, method: "none" })).reason, /unknown lock method/);
});

test("applyRelock: a ruleset back on with a permission that failed says the half that happened", async () => {
  const base = {
    request: async () => ({ ok: true }), org: "Org", repo: "r", login: "ann", repositoryId: 9, assignmentId: "lab",
    addToOrgLock: async () => ({ ok: true }), setPermission: async () => ({ ok: false, reason: "HTTP 403" }),
  };
  const half = await applyRelock({ ...base, method: "org-ruleset", demote: true });
  assert.equal(half.ok, false);
  assert.equal(half.locked, true);
  assert.match(half.reason, /the deadline ruleset is back on, but not everyone is read-only again: @ann: HTTP 403/);
  const none = await applyRelock({ ...base, addToOrgLock: async () => ({ ok: false, action: "absent", reason: "no ruleset" }), method: "org-ruleset" });
  assert.equal(none.locked, undefined);
  assert.match(none.reason, /no ruleset - it may have been removed on GitHub/);
});

test("relockedRecord: the rows a later pass wrote reopened get their lock back; the rest and the counts follow", () => {
  const record = {
    schema_version: 1, assignment_id: "lab", locked_count: 1, reopened_count: 2,
    results: [
      { github_login: "Ann", repo_name: "Org/grp-a", lock_method: null, reopened_at: "2026-10-15T08:00:00Z", snapshot_sha: "a".repeat(40), permission_after: null },
      { github_login: "bob", repo_name: "Org/grp-a", lock_method: null, reopened_at: "2026-10-15T08:00:00Z", snapshot_sha: "a".repeat(40), permission_after: null },
      { github_login: "cy", repo_name: "Org/grp-b", lock_method: "org-ruleset", verified: true, permission_after: "read" },
    ],
  };
  const after = relockedRecord(record, { logins: ["ann", "bob"], method: "org-ruleset", demote: true, at: "2026-10-15T09:00:00Z" });
  const [ann, bob, cy] = after.results;
  assert.deepEqual(ann, { github_login: "Ann", repo_name: "Org/grp-a", lock_method: "org-ruleset", lockdown_at: "2026-10-15T09:00:00Z", verified: true, snapshot_sha: "a".repeat(40), permission_after: "read", demoted: true });
  assert.equal("reopened_at" in bob, false);
  assert.equal(cy, record.results[2], "someone else's row is not touched");
  assert.deepEqual([after.locked_count, after.reopened_count], [3, 0]);
  // A row no pass rewrote still says how it is locked: nothing to change.
  const pristine = { results: [{ github_login: "ann", lock_method: "ruleset", verified: true }] };
  assert.equal(relockedRecord(pristine, { logins: ["ann"], method: "ruleset", demote: false, at: "x" }), pristine);
});
