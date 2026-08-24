import { test } from "node:test";
import assert from "node:assert/strict";
import { runDiagnostics } from "../lib/diagnostics.mjs";
import { signInviteToken, generateKeyPair } from "../lib/invite-token.mjs";
import { EXPECTED_APP_PERMISSIONS, MANIFEST_APP_PERMISSIONS, APP_SLUG } from "../lib/audit.mjs";

// A published assignment is only healthy if its invitation chain agrees: the
// assignment holds a signed token, the hub publishes the key it was signed
// with, and the broker's nonce matches. The fixture therefore carries a real
// token rather than pretending invitations do not exist.
const KEYPAIR = generateKeyPair();
const INVITE_NONCE = "0badc0de";
export const DEEP_TEST_TOKEN = signInviteToken({
  org: "PXL-CSMobile",
  assignmentId: "deep-test-hw",
  expiresAt: "2099-01-01T00:00:00.000Z",
  nonce: INVITE_NONCE,
  privateKeyPem: KEYPAIR.privateKeyPem,
});

function createMockRequest(overrides = {}) {
  return async (method, path, body = null) => {
    if (overrides[path]) {
      return overrides[path](method, path, body);
    }
    if (path === "/user") return { status: 200, ok: true, data: { login: "lecturer-bob" } };
    // The App's own declaration. Unmocked it fell through to the 404 below,
    // which used to mean "add no check at all" - the branch WS6 filled in,
    // because "no such App" is the one thing every tier below is downstream
    // of and the only moment anybody needs /setup.
    if (path === `/apps/${APP_SLUG}`) {
      return { status: 200, ok: true, data: { slug: APP_SLUG, permissions: { ...MANIFEST_APP_PERMISSIONS } } };
    }
    if (path === "/rate_limit") return { status: 200, ok: true, data: { resources: { core: { remaining: 4950, limit: 5000, reset: Math.floor(Date.now() / 1000) + 3600 } } } };
    if (path === "/user/installations") {
      return {
        status: 200,
        ok: true,
        data: {
          installations: [
            { id: 456, account: { login: "PXL-CSMobile" }, permissions: { ...EXPECTED_APP_PERMISSIONS } },
          ],
        },
      };
    }
    if (path.startsWith("/organizations/PXL-CSMobile/settings/billing/usage?")) {
      return { status: 200, ok: true, data: { usageItems: [] } };
    }
    if (path === "/repos/hub/repo/contents/participating-orgs.yml?ref=participating-orgs") {
      const yaml = "orgs:\n  - login: PXL-CSMobile\n    budget_owner_login: admin";
      return { status: 200, ok: true, data: { content: Buffer.from(yaml).toString("base64") } };
    }
    if (path.includes("acceptance/invite-keys.json")) {
      const json = JSON.stringify({ keys: { 1: KEYPAIR.publicKeyBase64 } });
      return { status: 200, ok: true, data: { content: Buffer.from(json).toString("base64") } };
    }
    // Tier 4 exposure sweep: a broker with no leftover pxl-accept issue.
    if (path.includes("/issues?state=all")) {
      return { status: 200, ok: true, data: [] };
    }
    if (path.includes("/actions/variables")) {
      return {
        status: 200,
        ok: true,
        data: {
          variables: [
            { name: "INVITE_NONCE", value: INVITE_NONCE },
            { name: "INVITE_ENABLED", value: "true" },
          ],
        },
      };
    }
    if (path === "/repos/PXL-CSMobile/pxl-classroom-control") {
      return { status: 200, ok: true, data: { private: true } };
    }
    if (path === "/repos/PXL-CSMobile/pxl-classroom-control/contents/public/assignments.json") {
      const json = JSON.stringify({
        assignments: {
          "deep-test-hw": { id: "deep-test-hw", state: "published" },
        },
      });
      return { status: 200, ok: true, data: { content: Buffer.from(json).toString("base64") } };
    }
    // A real roster, because "all 6 tiers green" now requires one that
    // somebody could actually accept against. The catch-all below answers
    // every other control-repo path with empty content, which used to satisfy
    // the roster check too - it asked only whether the file existed.
    if (path === "/repos/PXL-CSMobile/pxl-classroom-control/contents/students/roster.yml") {
      const roster = "students:\n  - student_number: '0123456'\n    full_name: Alice Example\n    github_login: alice\n";
      return { status: 200, ok: true, data: { content: Buffer.from(roster).toString("base64") } };
    }
    if (path.startsWith("/repos/PXL-CSMobile/pxl-classroom-control/contents/")) {
      return { status: 200, ok: true, data: { content: "" } };
    }
    if (path === "/repos/PXL-CSMobile/template-project") {
      return { status: 200, ok: true, data: { is_template: true } };
    }
    if (path === "/repos/PXL-CSMobile/broker-deep-test-hw") {
      return { status: 200, ok: true, data: { private: false } };
    }
    if (path === "/repos/PXL-CSMobile/broker-deep-test-hw/contents/.github/workflows/acceptance-trigger.yml") {
      return { status: 200, ok: true };
    }
    return { status: 404, ok: false, data: { message: "Not Found" } };
  };
}

// -----------------------------------------------------------------------------
// TEST SUITE: Deep Diagnostics & Edge Cases
// -----------------------------------------------------------------------------

test("Deep Test: All 6 Tiers 100% Green with Subtitles and Educator Labels", async () => {
  const req = createMockRequest();
  const fetchPages = async () => ({ assignments: { "deep-test-hw": { id: "deep-test-hw", state: "published" } } });

  const res = await runDiagnostics({
    request: req,
    org: "PXL-CSMobile",
    assignmentId: "deep-test-hw",
    formDoc: {
      schema_version: 1,
      id: "deep-test-hw",
      title: "Deep Test Homework",
      organization: "PXL-CSMobile",
      template: { owner: "PXL-CSMobile", repository: "template-project" },
      repository_name_pattern: "deep-test-hw-{github_login}",
      opens_at: "2026-09-01T08:00:00Z",
      deadline_at: "2026-10-01T22:00:00Z",
      state: "published",
      invite_token: DEEP_TEST_TOKEN,
      invite_nonce: INVITE_NONCE,
    },
    hubOwner: "hub",
    hubRepo: "repo",
    fetchPages,
  });

  assert.equal(res.overall, "ok");
  assert.equal(res.tiers.length, 6);

  // Check tier subtitles
  for (const t of res.tiers) {
    assert.ok(t.subtitle, `Tier ${t.id} must have a non-empty subtitle`);
    assert.equal(t.severity, "ok");
  }

  // Check specific check label styling
  const brokerCheck = res.checks.find(c => c.id === "broker-repo");
  assert.ok(brokerCheck);
  assert.equal(brokerCheck.label, "Student Acceptance Broker Repository (broker-<id>)");

  const wfCheck = res.checks.find(c => c.id === "broker-workflow");
  assert.ok(wfCheck);
  assert.equal(wfCheck.label, "Automated Student Provisioning Workflow (acceptance-trigger.yml)");
});

test("Deep Test: Rate Limit Edge Cases (Critical 0 vs Low Warning vs Healthy)", async () => {
  // Case A: Remaining = 0 (Fail)
  const req0 = createMockRequest({
    "/rate_limit": async () => ({ status: 200, ok: true, data: { resources: { core: { remaining: 0, limit: 5000, reset: 1234567 } } } }),
  });
  const res0 = await runDiagnostics({ request: req0, org: "PXL-CSMobile", assignmentId: "hw" });
  const check0 = res0.checks.find(c => c.id === "api-rate-limit");
  assert.equal(check0.severity, "fail");

  // Case B: Remaining = 50 (Warn)
  const req50 = createMockRequest({
    "/rate_limit": async () => ({ status: 200, ok: true, data: { resources: { core: { remaining: 50, limit: 5000, reset: 1234567 } } } }),
  });
  const res50 = await runDiagnostics({ request: req50, org: "PXL-CSMobile", assignmentId: "hw" });
  const check50 = res50.checks.find(c => c.id === "api-rate-limit");
  assert.equal(check50.severity, "warn");
});

test("Deep Test: HTTP 500 & Network Throw Handling (Non-Crashing Diagnostics)", async () => {
  const reqThrow = async (method, path) => {
    if (path === "/user") return { status: 200, ok: true, data: { login: "user" } };
    if (path === "/rate_limit") return { status: 200, ok: true, data: { resources: { core: { remaining: 1000, limit: 5000 } } } };
    if (path === "/user/installations") throw new Error("GitHub API Connection Timeout");
    return { status: 500, ok: false, data: { message: "Internal Server Error" } };
  };

  // Must not throw unhandled exception
  let didThrow = false;
  try {
    const res = await runDiagnostics({ request: reqThrow, org: "PXL-CSMobile", assignmentId: "hw" });
    assert.ok(res);
  } catch {
    didThrow = true;
  }
  assert.equal(didThrow, false, "runDiagnostics should handle network throw gracefully");
});

test("Deep Test: Template Not Marked is_template triggers Auto-Fix with correct owner/repo", async () => {
  const req = createMockRequest({
    "/repos/PXL-CSMobile/template-project": async () => ({ status: 200, ok: true, data: { is_template: false } }),
  });

  const res = await runDiagnostics({
    request: req,
    org: "PXL-CSMobile",
    assignmentId: "deep-test-hw",
    formDoc: {
      title: "HW",
      template: { owner: "PXL-CSMobile", repository: "template-project" },
      repository_name_pattern: "hw-{github_login}",
      opens_at: "2026-09-01T08:00:00Z",
      deadline_at: "2026-10-01T22:00:00Z",
      state: "published",
    },
  });

  const tplCheck = res.checks.find(c => c.id === "template-is-template");
  assert.ok(tplCheck);
  assert.equal(tplCheck.severity, "fail");
  assert.equal(tplCheck.fixAction.type, "mark_template");
  assert.equal(tplCheck.fixAction.owner, "PXL-CSMobile");
  assert.equal(tplCheck.fixAction.repo, "template-project");
  assert.equal(tplCheck.fixAction.label, "Mark template-project as Template on GitHub");
});

test("Deep Test: Private Broker Repository Triggers 'Make Broker Public' Auto-Fix", async () => {
  const req = createMockRequest({
    "/repos/PXL-CSMobile/broker-deep-test-hw": async () => ({ status: 200, ok: true, data: { private: true } }),
  });

  const res = await runDiagnostics({
    request: req,
    org: "PXL-CSMobile",
    assignmentId: "deep-test-hw",
    formDoc: {
      title: "HW",
      template: { owner: "PXL-CSMobile", repository: "template-project" },
      repository_name_pattern: "hw-{github_login}",
      opens_at: "2026-09-01T08:00:00Z",
      deadline_at: "2026-10-01T22:00:00Z",
      state: "published",
    },
  });

  const visCheck = res.checks.find(c => c.id === "broker-visibility");
  assert.ok(visCheck);
  assert.equal(visCheck.severity, "fail");
  assert.equal(visCheck.fixAction.type, "make_broker_public");
  assert.equal(visCheck.fixAction.brokerName, "broker-deep-test-hw");
  assert.equal(visCheck.fixAction.label, "Make Broker Public");
});

test("Deep Test: Enforced Roster Mode Missing roster.yml triggers 'Open Roster Editor' Navigation Action", async () => {
  const req = createMockRequest({
    "/repos/PXL-CSMobile/pxl-classroom-control/contents/students/roster.yml": async () => ({ status: 404, ok: false }),
  });

  const res = await runDiagnostics({
    request: req,
    org: "PXL-CSMobile",
    assignmentId: "deep-test-hw",
    formDoc: {
      title: "HW",
      template: "PXL-CSMobile/template-project",
      repository_name_pattern: "hw-{github_login}",
      opens_at: "2026-09-01T08:00:00Z",
      deadline_at: "2026-10-01T22:00:00Z",
      state: "published",
      roster_mode: "enforced",
    },
  });

  const rosterCheck = res.checks.find(c => c.id === "roster-check");
  assert.ok(rosterCheck);
  assert.equal(rosterCheck.severity, "warn");
  assert.equal(rosterCheck.fixAction.type, "navigate_roster");
  assert.equal(rosterCheck.fixAction.label, "Open Roster Editor");
});

test("Deep Test: Missing Pages CDN Propagation triggers 'Deploy to GitHub Pages' Action", async () => {
  const req = createMockRequest();
  const fetchPages = async () => ({ assignments: {} }); // empty pages data

  const res = await runDiagnostics({
    request: req,
    org: "PXL-CSMobile",
    assignmentId: "deep-test-hw",
    formDoc: {
      title: "HW",
      template: "PXL-CSMobile/template-project",
      repository_name_pattern: "hw-{github_login}",
      opens_at: "2026-09-01T08:00:00Z",
      deadline_at: "2026-10-01T22:00:00Z",
      state: "published",
    },
    fetchPages,
  });

  const pagesCheck = res.checks.find(c => c.id === "pages-live-cdn");
  assert.ok(pagesCheck);
  assert.equal(pagesCheck.severity, "warn");
  assert.equal(pagesCheck.fixAction.type, "deploy_pages");
  assert.equal(pagesCheck.fixAction.label, "Deploy to GitHub Pages");
});
