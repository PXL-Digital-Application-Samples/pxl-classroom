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
