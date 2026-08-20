import { test } from "node:test";
import assert from "node:assert/strict";
import { runDiagnostics } from "../lib/diagnostics.mjs";
import { EXPECTED_APP_PERMISSIONS } from "../lib/audit.mjs";

function createMockRequest({
  userStatus = 200,
  rateLimitRemaining = 4500,
  installStatus = 200,
  permissions = { ...EXPECTED_APP_PERMISSIONS },
  orgsYamlStatus = 200,
  orgsYaml = "orgs:\n  - login: TestOrg\n    budget_owner_login: admin",
  controlRepoStatus = 200,
  controlIsPrivate = true,
  missingScaffold = [],
  assignmentYmlStatus = 200,
  assignmentYml = "title: Homework 1\ntemplate: TestOrg/template-hw1\nrepository_name_pattern: 'hw1-{github_login}'\nopens_at: '2026-09-01T08:00:00Z'\ndeadline_at: '2026-09-15T22:00:00Z'\nstate: published\nroster_mode: open\n",
  templateStatus = 200,
  templateIsTemplate = true,
  rosterStatus = 200,
  brokerStatus = 200,
  brokerIsPrivate = false,
  brokerWorkflowStatus = 200,
  controlPublicStatus = 200,
  controlPublicJson = JSON.stringify({ assignments: { hw1: { id: "hw1", state: "published" } } }),
}) {
  return async (method, path) => {
    // Tier 0
    if (path === "/user") {
      return { status: userStatus, ok: userStatus === 200, data: { login: "testlecturer" } };
    }
    if (path === "/rate_limit") {
      return { status: 200, ok: true, data: { resources: { core: { remaining: rateLimitRemaining, limit: 5000, reset: 1700000000 } } } };
    }

    // Tier 1
    if (path === "/user/installations") {
      return {
        status: installStatus,
        ok: installStatus === 200,
        data: {
          installations: [
            { id: 999, account: { login: "TestOrg" }, permissions },
          ],
        },
      };
    }
    if (path === "/repos/hub/repo/contents/participating-orgs.yml?ref=participating-orgs") {
      if (orgsYamlStatus !== 200) return { status: orgsYamlStatus, ok: false };
      return { status: 200, ok: true, data: { content: Buffer.from(orgsYaml).toString("base64") } };
    }

    // Tier 2
    if (path === "/repos/TestOrg/pxl-classroom-control") {
      return { status: controlRepoStatus, ok: controlRepoStatus === 200, data: { private: controlIsPrivate } };
    }
    if (path.startsWith("/repos/TestOrg/pxl-classroom-control/contents/")) {
      const p = path.replace("/repos/TestOrg/pxl-classroom-control/contents/", "");
      if (missingScaffold.includes(p)) return { status: 404, ok: false };

      if (p === "assignments/hw1.yml") {
        if (assignmentYmlStatus !== 200) return { status: assignmentYmlStatus, ok: false };
        return { status: 200, ok: true, data: { content: Buffer.from(assignmentYml).toString("base64") } };
      }
      if (p === "rosters/hw1.csv") {
        return { status: rosterStatus, ok: rosterStatus === 200 };
      }
      if (p === "public/assignments.json") {
        if (controlPublicStatus !== 200) return { status: controlPublicStatus, ok: false };
        return { status: 200, ok: true, data: { content: Buffer.from(controlPublicJson).toString("base64") } };
      }
      return { status: 200, ok: true };
    }

    // Tier 3
    if (path === "/repos/TestOrg/template-hw1") {
      if (templateStatus !== 200) return { status: templateStatus, ok: false };
      return { status: 200, ok: true, data: { is_template: templateIsTemplate } };
    }

    // Tier 4
    if (path === "/repos/TestOrg/broker-hw1") {
      if (brokerStatus !== 200) return { status: brokerStatus, ok: false };
      return { status: 200, ok: true, data: { private: brokerIsPrivate } };
    }
    if (path === "/repos/TestOrg/broker-hw1/contents/.github/workflows/acceptance-trigger.yml") {
      if (brokerWorkflowStatus !== 200) return { status: brokerWorkflowStatus, ok: false };
      return { status: 200, ok: true };
    }

    return { status: 404, ok: false };
  };
}

test("runDiagnostics - Happy Path (100% Green)", async () => {
  const req = createMockRequest({});
  const fetchPages = async (org) => ({ assignments: { hw1: { id: "hw1", state: "published" } } });

  const res = await runDiagnostics({
    request: req,
    org: "TestOrg",
    assignmentId: "hw1",
    hubOwner: "hub",
    hubRepo: "repo",
    fetchPages,
  });

  assert.equal(res.overall, "ok");
  assert.equal(res.tiers.length, 6);
  assert.equal(res.tiers.every(t => t.severity === "ok"), true);
});

test("runDiagnostics - Tier 0: Invalid token short-circuits execution", async () => {
  const req = createMockRequest({ userStatus: 401 });
  const res = await runDiagnostics({ request: req, org: "TestOrg", assignmentId: "hw1" });

  assert.equal(res.overall, "fail");
  const authCheck = res.checks.find(c => c.id === "auth-session");
  assert.ok(authCheck);
  assert.equal(authCheck.severity, "fail");
  assert.equal(authCheck.fixAction.type, "login");
});

test("runDiagnostics - Tier 0: Low API Rate Limit yields warning", async () => {
  const req = createMockRequest({ rateLimitRemaining: 42 });
  const res = await runDiagnostics({ request: req, org: "TestOrg", assignmentId: "hw1" });

  const rlCheck = res.checks.find(c => c.id === "api-rate-limit");
  assert.ok(rlCheck);
  assert.equal(rlCheck.severity, "warn");
  assert.ok(rlCheck.message.includes("42 GitHub API calls remaining"));
});

test("runDiagnostics - Tier 1: App not installed on organization", async () => {
  const req = createMockRequest({ installStatus: 404 });
  const res = await runDiagnostics({ request: req, org: "TestOrg", assignmentId: "hw1", hubOwner: "hub", hubRepo: "repo" });

  assert.equal(res.overall, "fail");
  const appCheck = res.checks.find(c => c.id === "app-installed");
  assert.ok(appCheck);
  assert.equal(appCheck.severity, "fail");
  assert.equal(appCheck.fixAction.type, "link");
  assert.ok(appCheck.fixAction.url.includes("installations/new"));
});

test("runDiagnostics - Tier 1: App permissions drift detected", async () => {
  const req = createMockRequest({ permissions: { ...EXPECTED_APP_PERMISSIONS, administration: "read" } });
  const res = await runDiagnostics({ request: req, org: "TestOrg", assignmentId: "hw1", hubOwner: "hub", hubRepo: "repo" });

  const permCheck = res.checks.find(c => c.id === "app-permissions");
  assert.ok(permCheck);
  assert.equal(permCheck.severity, "fail");
  assert.ok(permCheck.message.includes("administration=read"));
});

test("runDiagnostics - Tier 1: Missing from participating-orgs.yml", async () => {
  const req = createMockRequest({ orgsYaml: "orgs:\n  - login: OtherOrg" });
  const res = await runDiagnostics({ request: req, org: "TestOrg", assignmentId: "hw1", hubOwner: "hub", hubRepo: "repo" });

  const hubCheck = res.checks.find(c => c.id === "hub-registry");
  assert.ok(hubCheck);
  assert.equal(hubCheck.severity, "fail");
  assert.equal(hubCheck.fixAction.type, "setup_org");
});

test("runDiagnostics - Tier 2: Control repo missing", async () => {
  const req = createMockRequest({ controlRepoStatus: 404 });
  const res = await runDiagnostics({ request: req, org: "TestOrg", assignmentId: "hw1" });

  const ctrlCheck = res.checks.find(c => c.id === "control-repo");
  assert.ok(ctrlCheck);
  assert.equal(ctrlCheck.severity, "fail");
});

test("runDiagnostics - Tier 2: Control repo public is flagged critical fail", async () => {
  const req = createMockRequest({ controlIsPrivate: false });
  const res = await runDiagnostics({ request: req, org: "TestOrg", assignmentId: "hw1" });

  const privacyCheck = res.checks.find(c => c.id === "control-repo-privacy");
  assert.ok(privacyCheck);
  assert.equal(privacyCheck.severity, "fail");
  assert.ok(privacyCheck.message.includes("must be private"));
});

test("runDiagnostics - Tier 3: Template not marked as template offers 1-click fix", async () => {
  const req = createMockRequest({ templateIsTemplate: false });
  const res = await runDiagnostics({ request: req, org: "TestOrg", assignmentId: "hw1" });

  const tplCheck = res.checks.find(c => c.id === "template-is-template");
  assert.ok(tplCheck);
  assert.equal(tplCheck.severity, "fail");
  assert.ok(tplCheck.message.includes("NOT marked as a Template"));
  assert.equal(tplCheck.fixAction.type, "mark_template");
  assert.equal(tplCheck.fixAction.owner, "TestOrg");
  assert.equal(tplCheck.fixAction.repo, "template-hw1");
});

test("runDiagnostics - Tier 3: Template repo does not exist", async () => {
  const req = createMockRequest({ templateStatus: 404 });
  const res = await runDiagnostics({ request: req, org: "TestOrg", assignmentId: "hw1" });

  const tplCheck = res.checks.find(c => c.id === "template-repo");
  assert.ok(tplCheck);
  assert.equal(tplCheck.severity, "fail");
  assert.ok(tplCheck.message.includes("does not exist on GitHub"));
});

test("runDiagnostics - Tier 3: Enforced roster mode with missing roster warns lecturer", async () => {
  const yml = "title: HW\ntemplate: TestOrg/template-hw1\nrepository_name_pattern: 'hw-{github_login}'\nopens_at: '2026-09-01T08:00:00Z'\ndeadline_at: '2026-09-15T22:00:00Z'\nstate: draft\nroster_mode: enforced\n";
  const req = createMockRequest({ assignmentYml: yml, rosterStatus: 404 });
  const res = await runDiagnostics({ request: req, org: "TestOrg", assignmentId: "hw1" });

  const rosterCheck = res.checks.find(c => c.id === "roster-check");
  assert.ok(rosterCheck);
  assert.equal(rosterCheck.severity, "warn");
  assert.equal(rosterCheck.fixAction.type, "navigate_roster");
});

test("runDiagnostics - Tier 4: Published assignment with missing broker repo offers Create Broker fix", async () => {
  const req = createMockRequest({ brokerStatus: 404 });
  const res = await runDiagnostics({ request: req, org: "TestOrg", assignmentId: "hw1" });

  const brokerCheck = res.checks.find(c => c.id === "broker-repo");
  assert.ok(brokerCheck);
  assert.equal(brokerCheck.severity, "fail");
  assert.ok(brokerCheck.message.includes("does not exist on GitHub"));
  assert.equal(brokerCheck.fixAction.type, "publish_broker");
});

test("runDiagnostics - Tier 4: Published assignment with private broker offers Make Public fix", async () => {
  const req = createMockRequest({ brokerIsPrivate: true });
  const res = await runDiagnostics({ request: req, org: "TestOrg", assignmentId: "hw1" });

  const visCheck = res.checks.find(c => c.id === "broker-visibility");
  assert.ok(visCheck);
  assert.equal(visCheck.severity, "fail");
  assert.equal(visCheck.fixAction.type, "make_broker_public");
});

test("runDiagnostics - Tier 4: Published assignment missing acceptance-trigger workflow", async () => {
  const req = createMockRequest({ brokerWorkflowStatus: 404 });
  const res = await runDiagnostics({ request: req, org: "TestOrg", assignmentId: "hw1" });

  const wfCheck = res.checks.find(c => c.id === "broker-workflow");
  assert.ok(wfCheck);
  assert.equal(wfCheck.severity, "fail");
  assert.equal(wfCheck.fixAction.type, "publish_broker");
});

test("runDiagnostics - Tier 4: Draft assignment does not fail on missing broker", async () => {
  const draftYml = "title: HW\ntemplate: TestOrg/template-hw1\nrepository_name_pattern: 'hw-{github_login}'\nopens_at: '2026-09-01T08:00:00Z'\ndeadline_at: '2026-09-15T22:00:00Z'\nstate: draft\n";
  const req = createMockRequest({ assignmentYml: draftYml, brokerStatus: 404 });
  const res = await runDiagnostics({ request: req, org: "TestOrg", assignmentId: "hw1" });

  const brokerCheck = res.checks.find(c => c.id === "broker-repo");
  assert.ok(brokerCheck);
  assert.equal(brokerCheck.severity, "info");
  assert.ok(brokerCheck.message.includes("created when published"));
});

test("runDiagnostics - Tier 5: Pages data missing or propagating", async () => {
  const req = createMockRequest({ controlPublicStatus: 404 });
  const fetchPages = async () => ({ assignments: {} });

  const res = await runDiagnostics({
    request: req,
    org: "TestOrg",
    assignmentId: "hw1",
    fetchPages,
  });

  const ctlPubCheck = res.checks.find(c => c.id === "control-public-data");
  assert.ok(ctlPubCheck);
  assert.equal(ctlPubCheck.severity, "warn");
  assert.equal(ctlPubCheck.fixAction.type, "regen_dashboard");

  const pagesCheck = res.checks.find(c => c.id === "pages-live-cdn");
  assert.ok(pagesCheck);
  assert.equal(pagesCheck.severity, "warn");
  assert.equal(pagesCheck.fixAction.type, "deploy_pages");
});
