import { test } from "node:test";
import assert from "node:assert/strict";
import { runAudit, EXPECTED_APP_PERMISSIONS } from "../lib/audit.mjs";

test("EXPECTED_APP_PERMISSIONS shape", () => {
  assert.equal(typeof EXPECTED_APP_PERMISSIONS, "object");
  assert.equal(EXPECTED_APP_PERMISSIONS.actions, "write");
  assert.equal(EXPECTED_APP_PERMISSIONS.administration, "write");
  assert.equal(EXPECTED_APP_PERMISSIONS.contents, "write");
  assert.equal(EXPECTED_APP_PERMISSIONS.metadata, "read");
  assert.equal(EXPECTED_APP_PERMISSIONS.secrets, "write");
});

function createMockRequest({
  installStatus = 200,
  permissions = { ...EXPECTED_APP_PERMISSIONS },
  repoStatus = 200,
  isPrivate = true,
  missingPaths = [],
  orgsYamlStatus = 200,
  orgsYaml = "orgs:\n  - login: TestOrg\n    budget_owner_login: admin"
}) {
  return async (method, path) => {
    if (path === `/orgs/TestOrg/installation`) {
      return { status: installStatus, ok: installStatus === 200, data: { id: 123, permissions } };
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
  assert.equal(res.checks.length, 4);
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
