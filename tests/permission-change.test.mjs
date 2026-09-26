// Applying a changed student_permission to students who already accepted:
// lib/permission-change.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  planPermissionApply,
  applyStudentPermission,
  invitationPermission,
} from "../lib/permission-change.mjs";

const NOW = new Date("2026-10-01T12:00:00Z");
const A = (deadline = "2026-10-09T21:11:00Z") => ({ deadline_at: deadline });
const rec = (login, extra = {}) => ({ github_login: login, repo_name: `Org/pe-${login}`, ...extra });
const ext = (login, until) => ({
  schema_version: 1, assignment_id: "a", github_login: login,
  overrides: [{ type: "deadline_extension", value: until, reason: "ill", overridden_by: "l", overridden_at: "2026-09-30T00:00:00Z" }],
});

test("before the deadline: everyone with a repository", () => {
  const plan = planPermissionApply({ records: [rec("ann"), rec("ben")], assignment: A(), now: NOW });
  assert.deepEqual(plan.apply, [{ login: "ann", repo: "Org/pe-ann" }, { login: "ben", repo: "Org/pe-ben" }]);
  assert.deepEqual(plan.skip, []);
});

test("PAST the deadline: nobody is changed - the lock may already hold them", () => {
  const plan = planPermissionApply({ records: [rec("ann")], assignment: A("2026-09-30T00:00:00Z"), now: NOW });
  assert.deepEqual(plan.apply, []);
  assert.deepEqual(plan.skip, [{ login: "ann", repo: "Org/pe-ann", reason: "past-deadline" }]);
});

test("exactly AT the deadline counts as past", () => {
  const plan = planPermissionApply({ records: [rec("ann")], assignment: A(NOW.toISOString()), now: NOW });
  assert.equal(plan.skip[0].reason, "past-deadline");
});

test("a student with an extension is judged by THEIR deadline", () => {
  const plan = planPermissionApply({
    records: [rec("ann"), rec("ben")], assignment: A("2026-09-30T00:00:00Z"),
    overrides: [ext("ben", "2026-10-05T00:00:00Z")], now: NOW,
  });
  assert.deepEqual(plan.apply.map((x) => x.login), ["ben"]);
  assert.deepEqual(plan.skip.map((x) => x.login), ["ann"]);
});

test("overrides as a Map, as the SPA holds them, work the same", () => {
  const plan = planPermissionApply({
    records: [rec("ben")], assignment: A("2026-09-30T00:00:00Z"),
    overrides: new Map([["ben", ext("ben", "2026-10-05T00:00:00Z")]]), now: NOW,
  });
  assert.deepEqual(plan.apply.map((x) => x.login), ["ben"]);
});

test("a group repository follows its most generous member's deadline", () => {
  const plan = planPermissionApply({
    records: [rec("ann", { team_slug: "t1", repo_name: "Org/grp-t1" }), rec("ben", { team_slug: "T1", repo_name: "Org/grp-t1" })],
    assignment: A("2026-09-30T00:00:00Z"), overrides: [ext("ben", "2026-10-05T00:00:00Z")], now: NOW,
  });
  assert.deepEqual(plan.apply.map((x) => x.login), ["ann", "ben"]);
});

test("a repository a lecturer REOPENED after the deadline follows the change", () => {
  const plan = planPermissionApply({
    records: [rec("ann"), rec("ben")], assignment: A("2026-09-30T00:00:00Z"), reopened: ["BEN"], now: NOW,
  });
  assert.deepEqual(plan.apply.map((x) => x.login), ["ben"]);
  assert.deepEqual(plan.skip.map((x) => x.login), ["ann"]);
});

// --- review 2026-09-26 -------------------------------------------------------

const lockRow = (login, method = "ruleset", extra = {}) => ({ github_login: login, repo_name: `Org/pe-${login}`, lock_method: method, verified: true, ...extra });

test("A LOCK THAT EXISTS WINS over a later deadline: an extension granted after the lock does not unlock by the back door", () => {
  // Locked at the deadline, then given an extension: lockdown still holds them
  // (an extension after the lock does not reopen), and a grant would have.
  for (const method of ["ruleset", "org-ruleset", "demotion"]) {
    const plan = planPermissionApply({
      records: [rec("ann"), rec("ben")], assignment: A("2026-09-30T00:00:00Z"),
      overrides: [ext("ann", "2026-10-05T00:00:00Z")],
      lockRecord: { results: [lockRow("ann", method)] }, now: NOW,
    });
    assert.deepEqual(plan.skip.find((s) => s.login === "ann"), { login: "ann", repo: "Org/pe-ann", reason: "locked" }, method);
  }
});

test("THE SENTINEL'S STOP is a lock: before the nightly writes a lock record, an extended deadline still changes nobody", () => {
  // Review 2026-09-26: the sentinel stops writes at the instant and writes no
  // lock record; a deadline extended in the minutes before finalize read
  // "future deadline, no lock", and Apply unlocked the cohort.
  const fired = { outcome: "fired", deadline_at: "2026-09-30T00:00:00Z" };
  const plan = planPermissionApply({
    records: [rec("ann"), rec("ben")], assignment: A("2026-12-01T00:00:00Z"),
    sentinelTimelines: [fired], reopened: ["ben"], now: NOW,
  });
  assert.deepEqual(plan.apply.map((x) => x.login), ["ben"], "a repository a lecturer reopened still follows");
  assert.deepEqual(plan.skip, [{ login: "ann", repo: "Org/pe-ann", reason: "locked" }]);
  // Not a stop: gave up, or fired for a group while THIS assignment was extended past it.
  for (const t of [{ outcome: "gave-up:runtime", deadline_at: "2026-09-30T00:00:00Z" }, { ...fired, due: false }]) {
    const p = planPermissionApply({ records: [rec("ann")], assignment: A("2026-12-01T00:00:00Z"), sentinelTimelines: [t], now: NOW });
    assert.equal(p.apply.length, 1, JSON.stringify(t));
  }
});

test("a lock and a deadline moved LATER: locked, not applied", () => {
  const plan = planPermissionApply({
    records: [rec("ann")], assignment: A("2026-12-01T00:00:00Z"),
    lockRecord: { results: [lockRow("ann")] }, now: NOW,
  });
  assert.equal(plan.skip[0].reason, "locked");
});

test("a row that is NOT a lock (none, null) does not block; demoted:true does", () => {
  const rows = { results: [lockRow("ann", "none"), lockRow("ben", null), lockRow("cas", "none", { demoted: true })] };
  const plan = planPermissionApply({ records: [rec("ann"), rec("ben"), rec("cas")], assignment: A(), lockRecord: rows, now: NOW });
  assert.deepEqual(plan.apply.map((x) => x.login), ["ann", "ben"]);
  assert.deepEqual(plan.skip, [{ login: "cas", repo: "Org/pe-cas", reason: "locked" }]);
});

test("a REOPENED repository follows the change even with a lock row - the reopen is later than the lock", () => {
  const plan = planPermissionApply({
    records: [rec("ann")], assignment: A("2026-09-30T00:00:00Z"),
    lockRecord: { results: [lockRow("ann")] }, reopened: ["ann"], now: NOW,
  });
  assert.deepEqual(plan.apply.map((x) => x.login), ["ann"]);
});

test("TEAM: reopening for one member reopened the one repository for every member", () => {
  const t = (login) => rec(login, { team_slug: "t1", repo_name: "Org/grp-t1" });
  const plan = planPermissionApply({
    records: [t("ann"), t("ben")], assignment: A("2026-09-30T00:00:00Z"),
    lockRecord: { results: [{ ...lockRow("ann"), repo_name: "Org/grp-t1" }, { ...lockRow("ben"), repo_name: "Org/grp-t1" }] },
    reopened: ["ann"], now: NOW,
  });
  assert.deepEqual(plan.apply.map((x) => x.login), ["ann", "ben"]);
});

test("a REMOVED record (the schema's word) - or revoked/deleted (reconcile's) - is never re-granted", () => {
  const plan = planPermissionApply({
    records: [rec("ann", { access_state: "removed" }), rec("ben", { access_state: "revoked" }), rec("dee", { access_state: "deleted" }), rec("cas", { access_state: "active" })],
    assignment: A(), now: NOW,
  });
  assert.deepEqual(plan.apply.map((x) => x.login), ["cas"]);
  assert.deepEqual(plan.skip.map((x) => x.reason), ["no-access", "no-access", "no-access"]);
});

test("ONLY IF PRESENT: a student removed in GitHub's settings (record still 'invited') is skipped, not re-invited - review 2026-09-26", async () => {
  const { applyStudentPermission, studentPresence } = await import("../lib/permission-change.mjs");
  const calls = [];
  const gh = (collab, invitees) => async (method, path) => {
    calls.push(`${method} ${path}`);
    if (method === "GET" && path.includes("/collaborators/")) return { ok: collab, status: collab ? 204 : 404, data: null };
    if (method === "GET" && path.includes("/invitations")) return { ok: true, status: 200, data: invitees.map((l) => ({ invitee: { login: l } })) };
    if (method === "PUT") return { ok: true, status: 204, data: null };
    return { ok: false, status: 500 };
  };
  assert.equal(await studentPresence(gh(true, []), { repo: "Org/r", login: "ann" }), "collaborator");
  assert.equal(await studentPresence(gh(false, ["ANN"]), { repo: "Org/r", login: "ann" }), "invited", "login case is not identity");
  assert.equal(await studentPresence(gh(false, ["ben"]), { repo: "Org/r", login: "ann" }), "gone");
  assert.equal(await studentPresence(async () => ({ ok: false, status: 502 }), { repo: "Org/r", login: "ann" }), "unreadable");

  calls.length = 0;
  const skipped = await applyStudentPermission(gh(false, []), { repo: "Org/r", login: "ann", permission: "maintain", onlyIfPresent: true });
  assert.equal(skipped.skipped, true);
  assert.ok(!calls.some((c) => c.startsWith("PUT")), "no PUT: nothing re-invited");
  const unreadable = await applyStudentPermission(async () => ({ ok: false, status: 502 }), { repo: "Org/r", login: "ann", permission: "maintain", onlyIfPresent: true });
  assert.equal(unreadable.ok, false);
  assert.notEqual(unreadable.skipped, true, "unreadable is a failure, never a quiet skip");
  // Provisioning grants on purpose: without the flag, nothing is asked first.
  calls.length = 0;
  const granted = await applyStudentPermission(gh(false, []), { repo: "Org/r", login: "ann", permission: "maintain" });
  assert.equal(granted.ok, true);
  assert.deepEqual(calls, ["PUT /repos/Org/r/collaborators/ann"]);
});

test("the Admin Panel's Apply asks for presence, provisioning does not", async () => {
  const { readFileSync } = await import("node:fs");
  const admin = readFileSync(new URL("../frontend/src/views/AdminView.vue", import.meta.url), "utf8");
  const prov = readFileSync(new URL("../provisioning/provision.mjs", import.meta.url), "utf8");
  assert.match(admin, /applyStudentPermission\([^)]*onlyIfPresent: true/);
  assert.doesNotMatch(prov, /onlyIfPresent/);
});

test("the plan is a function of NOW: made before the deadline, re-planned after it, nobody is changed", () => {
  // The page re-plans at the click (AdminView readPermissionPlan); this is the
  // property that makes that safe.
  const before = planPermissionApply({ records: [rec("ann")], assignment: A(NOW.toISOString()), now: new Date(NOW.getTime() - 60_000) });
  const after = planPermissionApply({ records: [rec("ann")], assignment: A(NOW.toISOString()), now: new Date(NOW.getTime() + 60_000) });
  assert.equal(before.apply.length, 1);
  assert.equal(after.apply.length, 0);
});

test("no deadline at all never locks, so everyone", () => {
  const plan = planPermissionApply({ records: [rec("ann")], assignment: {}, now: NOW });
  assert.equal(plan.apply.length, 1);
});

test("a record with no repository is named, and a login is planned once", () => {
  const plan = planPermissionApply({
    records: [{ github_login: "ghost" }, rec("ann"), rec("ANN"), null, {}], assignment: A(), now: NOW,
  });
  assert.deepEqual(plan.apply.map((x) => x.login), ["ann"]);
  assert.deepEqual(plan.skip, [{ login: "ghost", repo: null, reason: "no-repository" }]);
});

test("the invitation spells push and pull differently", () => {
  assert.equal(invitationPermission("push"), "write");
  assert.equal(invitationPermission("pull"), "read");
  assert.equal(invitationPermission("maintain"), "maintain");
  assert.equal(invitationPermission("admin"), "admin");
});

// --- applying one --------------------------------------------------------------

/** A fake GitHub that answers like the measured one. */
function fakeGitHub({ collaborator = true, invitationAt = "maintain", putStatus = null, patchOk = true } = {}) {
  const calls = [];
  const request = async (method, path, body) => {
    calls.push({ method, path, body });
    if (method === "PUT") {
      if (putStatus) return { ok: false, status: putStatus, data: { message: "nope" } };
      if (collaborator) return { ok: true, status: 204, data: null };
      // MEASURED: a second grant returns the SAME invitation, unchanged.
      return { ok: true, status: 201, data: { id: 77, permissions: invitationAt } };
    }
    if (method === "PATCH") {
      return patchOk
        ? { ok: true, status: 200, data: { id: 77, permissions: body.permissions } }
        : { ok: true, status: 200, data: { id: 77, permissions: invitationAt } };
    }
    return { ok: false, status: 404, data: null };
  };
  return { request, calls };
}

test("an existing collaborator: one call, done", async () => {
  const gh = fakeGitHub();
  const res = await applyStudentPermission(gh.request, { repo: "Org/r", login: "ann", permission: "maintain" });
  assert.deepEqual(res, { ok: true, via: "collaborator", status: 204 });
  assert.equal(gh.calls.length, 1);
  assert.deepEqual(gh.calls[0].body, { permission: "maintain" });
});

test("THE MEASURED TRAP: a pending invitation at the old permission is updated through the invitation", async () => {
  const gh = fakeGitHub({ collaborator: false, invitationAt: "admin" });
  const res = await applyStudentPermission(gh.request, { repo: "Org/r", login: "ann", permission: "maintain" });
  assert.equal(res.ok, true);
  assert.equal(res.via, "invitation");
  assert.deepEqual(gh.calls.map((c) => `${c.method} ${c.path}`), ["PUT /repos/Org/r/collaborators/ann", "PATCH /repos/Org/r/invitations/77"]);
  assert.deepEqual(gh.calls[1].body, { permissions: "maintain" });
});

test("push is written to an invitation as write", async () => {
  const gh = fakeGitHub({ collaborator: false, invitationAt: "admin" });
  await applyStudentPermission(gh.request, { repo: "Org/r", login: "ann", permission: "push" });
  assert.deepEqual(gh.calls[1].body, { permissions: "write" });
});

test("an invitation already at the new permission is not touched again", async () => {
  const gh = fakeGitHub({ collaborator: false, invitationAt: "write" });
  const res = await applyStudentPermission(gh.request, { repo: "Org/r", login: "ann", permission: "push" });
  assert.equal(res.ok, true);
  assert.equal(gh.calls.length, 1);
});

test("an invitation that did not change is a failure, not a success", async () => {
  const gh = fakeGitHub({ collaborator: false, invitationAt: "admin", patchOk: false });
  const res = await applyStudentPermission(gh.request, { repo: "Org/r", login: "ann", permission: "maintain" });
  assert.equal(res.ok, false);
  assert.match(res.message, /still says admin/);
});

test("a refused grant is reported with its status, never thrown", async () => {
  const gh = fakeGitHub({ putStatus: 403 });
  const res = await applyStudentPermission(gh.request, { repo: "Org/r", login: "ann", permission: "maintain" });
  assert.deepEqual({ ok: res.ok, status: res.status }, { ok: false, status: 403 });
  const throwing = await applyStudentPermission(async () => { throw new Error("offline"); }, { repo: "Org/r", login: "ann", permission: "maintain" });
  assert.equal(throwing.ok, false);
  assert.match(throwing.message, /offline/);
});

test("provisioning grants through the helper, never with a bare PUT that leaves an invitation stale", async () => {
  // A retry after a changed Student permission re-grants to a student who may
  // still hold the first invitation; a bare PUT answers 201 with it unchanged.
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../provisioning/provision.mjs", import.meta.url), "utf8");
  assert.match(src, /import \{ applyStudentPermission \} from "\.\.\/lib\/permission-change\.mjs"/);
  assert.match(src, /await applyStudentPermission\(/);
  assert.doesNotMatch(src, /gh\("PUT", `\/repos\/[^`]*\/collaborators\//, "a bare collaborator PUT is back in provisioning");
});

test("a value that is not a permission never reaches GitHub", async () => {
  const gh = fakeGitHub();
  const res = await applyStudentPermission(gh.request, { repo: "Org/r", login: "ann", permission: "owner" });
  assert.equal(res.ok, false);
  assert.equal(gh.calls.length, 0);
});
