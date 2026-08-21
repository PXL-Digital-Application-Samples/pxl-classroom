import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runAudit,
  EXPECTED_APP_PERMISSIONS,
  MANIFEST_APP_PERMISSIONS,
  permissionMeetsRequirement,
} from "../lib/audit.mjs";

test("EXPECTED_APP_PERMISSIONS shape", () => {
  assert.equal(typeof EXPECTED_APP_PERMISSIONS, "object");
  assert.equal(EXPECTED_APP_PERMISSIONS.actions, "write");
  assert.equal(EXPECTED_APP_PERMISSIONS.administration, "write");
  assert.equal(EXPECTED_APP_PERMISSIONS.contents, "write");
  assert.equal(EXPECTED_APP_PERMISSIONS.issues, "write");
  assert.equal(EXPECTED_APP_PERMISSIONS.metadata, "read");
  assert.equal(EXPECTED_APP_PERMISSIONS.organization_administration, "read");
  assert.equal(EXPECTED_APP_PERMISSIONS.pull_requests, "write");
  assert.equal(EXPECTED_APP_PERMISSIONS.secrets, "write");
  assert.equal(EXPECTED_APP_PERMISSIONS.workflows, "write");
  assert.equal(EXPECTED_APP_PERMISSIONS.organization_plan, undefined);
});

test("permission comparison accepts stronger levels", () => {
  assert.equal(permissionMeetsRequirement("write", "read"), true);
  assert.equal(permissionMeetsRequirement("admin", "write"), true);
  assert.equal(permissionMeetsRequirement("read", "write"), false);
  assert.equal(permissionMeetsRequirement(undefined, "read"), false);
});

function createMockRequest({
  installStatus = 200,
  permissions = { ...EXPECTED_APP_PERMISSIONS },
  declaredPermissions = { ...MANIFEST_APP_PERMISSIONS },
  appStatus = 200,
  repositorySelection = "all",
  repoStatus = 200,
  isPrivate = true,
  missingPaths = [],
  orgsYamlStatus = 200,
  orgsYaml = "orgs:\n  - login: TestOrg\n    budget_owner_login: admin"
}) {
  return async (method, path) => {
    if (path === "/apps/pxl-classroom-provisioner") {
      return { status: appStatus, ok: appStatus === 200, data: { permissions: declaredPermissions } };
    }
    if (path === `/orgs/TestOrg/installation`) {
      return {
        status: installStatus,
        ok: installStatus === 200,
        data: { id: 123, permissions, repository_selection: repositorySelection },
      };
    }
    if (path === `/repos/TestOrg/pxl-classroom-control`) {
      return { status: repoStatus, ok: repoStatus === 200, data: { private: isPrivate } };
    }
    if (path.startsWith(`/repos/TestOrg/pxl-classroom-control/contents/`)) {
      const p = path.split("/").pop();
      if (missingPaths.includes(p)) return { status: 404, ok: false };
      return { status: 200, ok: true };
    }
    if (path === `/repos/hub/repo/contents/participating-orgs.yml?ref=participating-orgs`) {
      if (orgsYamlStatus !== 200) return { status: orgsYamlStatus, ok: false };
      return { status: 200, ok: true, data: { content: Buffer.from(orgsYaml).toString("base64") } };
    }
    return { status: 404, ok: false };
  };
}

test("runAudit - happy path", async () => {
  const req = createMockRequest({});
  const res = await runAudit({ request: req, org: "TestOrg", hubOwner: "hub", hubRepo: "repo" });
  assert.equal(res.overall, "ok");
  assert.equal(res.checks.length, 6);
  assert.equal(res.checks.every(c => c.severity === "ok"), true);
});

test("runAudit - missing perm", async () => {
  const req = createMockRequest({ permissions: { ...EXPECTED_APP_PERMISSIONS, actions: "read" } });
  const res = await runAudit({ request: req, org: "TestOrg", hubOwner: "hub", hubRepo: "repo" });
  assert.equal(res.overall, "fail");
  const check = res.checks.find(c => c.id === "app-permissions");
  assert.equal(check.severity, "fail");
  assert.ok(check.message.includes("Permission drift: actions=read (want write)"));
});

// The failure that cost two hours on 2026-08-21: the App itself never declared
// organization_administration, so every org read as installation drift and the
// remediation pointed at org owners who were powerless to act.
test("runAudit - permission the App never declared is attributed to the App", async () => {
  const declared = { ...MANIFEST_APP_PERMISSIONS };
  delete declared.organization_administration;
  const installed = { ...EXPECTED_APP_PERMISSIONS };
  delete installed.organization_administration;

  const req = createMockRequest({ declaredPermissions: declared, permissions: installed });
  const res = await runAudit({ request: req, org: "TestOrg", hubOwner: "hub", hubRepo: "repo" });

  const declaration = res.checks.find((c) => c.id === "app-declaration");
  assert.equal(declaration.severity, "fail");
  assert.ok(declaration.message.includes("organization_administration=missing (want read)"));
  assert.equal(declaration.detail.missing.length, 1);

  const perms = res.checks.find((c) => c.id === "app-permissions");
  assert.equal(perms.severity, "fail");
  assert.ok(perms.message.includes("Blocked upstream"));
  assert.equal(perms.detail.drift[0].upstream, true);
  assert.equal(res.overall, "fail");
});

test("runAudit - drift the App does declare stays an org-owner re-approval", async () => {
  const req = createMockRequest({ permissions: { ...EXPECTED_APP_PERMISSIONS, actions: "read" } });
  const res = await runAudit({ request: req, org: "TestOrg", hubOwner: "hub", hubRepo: "repo" });

  assert.equal(res.checks.find((c) => c.id === "app-declaration").severity, "ok");
  const perms = res.checks.find((c) => c.id === "app-permissions");
  assert.ok(perms.message.includes("Re-approve the App"));
  assert.equal(perms.message.includes("Blocked upstream"), false);
  assert.equal(perms.detail.drift[0].upstream, false);
});

test("runAudit - unreadable /apps degrades to info, never a false alarm", async () => {
  const req = createMockRequest({ appStatus: 503 });
  const res = await runAudit({ request: req, org: "TestOrg", hubOwner: "hub", hubRepo: "repo" });

  const declaration = res.checks.find((c) => c.id === "app-declaration");
  assert.equal(declaration.severity, "info");
  assert.equal(res.overall, "info");
  // With no declaration to compare against, drift must not be blamed upstream.
  assert.equal(res.checks.find((c) => c.id === "app-permissions").severity, "ok");
});

// "Only select repositories" installs cleanly and then 404s on every student
// repo, because provisioned repos do not exist when the selection is made.
test("runAudit - selected-repositories installation fails", async () => {
  const req = createMockRequest({ repositorySelection: "selected" });
  const res = await runAudit({ request: req, org: "TestOrg", hubOwner: "hub", hubRepo: "repo" });

  const access = res.checks.find((c) => c.id === "app-repository-access");
  assert.equal(access.severity, "fail");
  assert.equal(access.detail.repository_selection, "selected");
  assert.ok(access.message.includes("All repositories"));
});

test("runAudit - the hub's own scoped installation is exempt", async () => {
  const req = createMockRequest({ repositorySelection: "selected" });
  const res = await runAudit({ request: req, org: "TestOrg", hubOwner: "testorg", hubRepo: "repo" });

  assert.equal(res.checks.find((c) => c.id === "app-repository-access").severity, "ok");
});

test("runAudit - missing scaffold", async () => {
  const req = createMockRequest({ missingPaths: ["assignments"] });
  const res = await runAudit({ request: req, org: "TestOrg", hubOwner: "hub", hubRepo: "repo" });
  assert.equal(res.overall, "warn");
  const check = res.checks.find(c => c.id === "control-repo");
  assert.equal(check.severity, "warn");
  assert.ok(check.message.includes("Scaffold paths missing: assignments"));
});

test("runAudit - missing org from participating-orgs.yml (regression §2.1)", async () => {
  const req = createMockRequest({ orgsYaml: "orgs:\n  - login: OtherOrg" });
  const res = await runAudit({ request: req, org: "TestOrg", hubOwner: "hub", hubRepo: "repo" });
  assert.equal(res.overall, "fail");
  const check = res.checks.find(c => c.id === "participating-orgs");
  assert.equal(check.severity, "fail");
  assert.ok(check.message.includes("TestOrg is missing from participating-orgs.yml"));
});

test("runAudit - assignment broker audit: published and broker exists", async () => {
  const baseReq = createMockRequest({});
  const customReq = async (method, path) => {
    if (path === `/repos/TestOrg/pxl-classroom-control/contents/assignments/hw1.yml`) {
      return { status: 200, ok: true, data: { content: Buffer.from("state: published\nbroker_repo: broker-hw1").toString("base64") } };
    }
    if (path === `/repos/TestOrg/broker-hw1`) {
      return { status: 200, ok: true, data: { name: "broker-hw1" } };
    }
    return baseReq(method, path);
  };
  const res = await runAudit({ request: customReq, org: "TestOrg", assignmentId: "hw1", hubOwner: "hub", hubRepo: "repo" });
  const brokerCheck = res.checks.find(c => c.id === "assignment-broker");
  assert.ok(brokerCheck);
  assert.equal(brokerCheck.severity, "ok");
  assert.ok(brokerCheck.message.includes("broker-hw1 exists"));
});

test("runAudit - assignment broker audit: published but broker missing", async () => {
  const baseReq = createMockRequest({});
  const customReq = async (method, path) => {
    if (path === `/repos/TestOrg/pxl-classroom-control/contents/assignments/hw1.yml`) {
      return { status: 200, ok: true, data: { content: Buffer.from("state: published\nbroker_repo: broker-hw1").toString("base64") } };
    }
    if (path === `/repos/TestOrg/broker-hw1`) {
      return { status: 404, ok: false };
    }
    return baseReq(method, path);
  };
  const res = await runAudit({ request: customReq, org: "TestOrg", assignmentId: "hw1", hubOwner: "hub", hubRepo: "repo" });
  const brokerCheck = res.checks.find(c => c.id === "assignment-broker");
  assert.ok(brokerCheck);
  assert.equal(brokerCheck.severity, "fail");
  assert.ok(brokerCheck.message.includes("broker repo TestOrg/broker-hw1 does not exist"));
});

test("runAudit - assignment broker audit: draft assignment", async () => {
  const baseReq = createMockRequest({});
  const customReq = async (method, path) => {
    if (path === `/repos/TestOrg/pxl-classroom-control/contents/assignments/hw1.yml`) {
      return { status: 200, ok: true, data: { content: Buffer.from("state: draft").toString("base64") } };
    }
    return baseReq(method, path);
  };
  const res = await runAudit({ request: customReq, org: "TestOrg", assignmentId: "hw1", hubOwner: "hub", hubRepo: "repo" });
  const brokerCheck = res.checks.find(c => c.id === "assignment-broker");
  assert.ok(brokerCheck);
  assert.equal(brokerCheck.severity, "info");
  assert.ok(brokerCheck.message.includes("broker not required"));
});
