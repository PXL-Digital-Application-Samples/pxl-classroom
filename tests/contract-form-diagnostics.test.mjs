import { test } from "node:test";
import assert from "node:assert/strict";
import { runDiagnostics } from "../lib/diagnostics.mjs";
import { EXPECTED_APP_PERMISSIONS, MANIFEST_APP_PERMISSIONS, APP_SLUG } from "../lib/audit.mjs";
import { signInviteToken, generateKeyPair } from "../lib/invite-token.mjs";
import { buildAssignmentDoc } from "../lib/assignment-doc.mjs";

// A published assignment without a signed invitation genuinely cannot work,
// so these contract fixtures carry a real one rather than asserting a green
// panel for a state that would strand every student.
const KEYPAIR = generateKeyPair();
const INVITE_NONCE = "0badc0de";

// THE REAL buildDoc, not a copy of it.
//
// This was a hand-maintained reimplementation - `Helper recreating
// AdminView.vue's exact buildDoc() logic` - and it had already drifted past
// the fields that decide whether an assignment works: no invite_key /
// invite_pubkey (the signed-acceptance keypair, ARCHITECTURE §4.3.2, so it
// still emitted only the withdrawn invite_token), no claim_domains, no
// autograde, no feedback_pr, and `min_team_size || 1` against a shared default
// of 0. The diagnostics contract was therefore checked against a document the
// Admin Panel had not produced for months: a mock that accepts anything tests
// nothing.
//
// buildAssignmentDoc takes the form state as a parameter precisely so a Node
// test can drive the shipped implementation. The invitation fields are supplied
// as form state, exactly as publish-assignment.yml supplies them in production,
// rather than minted inside a second copy of the builder.
function vueBuildDoc(formState) {
  return buildAssignmentDoc({
    student_permission: "admin",
    acceptance_mode: "self-service",
    late_policy: "block",
    state: "draft",
    ...formState,
    template:
      typeof formState.template === "string"
        ? formState.template
        : `${formState.template?.owner ?? ""}/${formState.template?.repository ?? ""}`,
    invite_token: signInviteToken({
      org: formState.organization,
      assignmentId: formState.id,
      expiresAt: "2099-01-01T00:00:00.000Z",
      nonce: INVITE_NONCE,
      privateKeyPem: KEYPAIR.privateKeyPem,
    }),
    invite_nonce: INVITE_NONCE,
  });
}

function createMockRequest(customHandlers = {}) {
  return async (method, path) => {
    if (customHandlers[path]) {
      return customHandlers[path](method, path);
    }
    if (path === "/user") return { status: 200, ok: true, data: { login: "lecturer" } };
    // Without this the 404 fallback now reports "no such App" - the branch
    // WS6 filled in, which used to add no check at all.
    if (path === `/apps/${APP_SLUG}`) {
      return { status: 200, ok: true, data: { slug: APP_SLUG, permissions: { ...MANIFEST_APP_PERMISSIONS } } };
    }
    if (path === "/rate_limit") return { status: 200, ok: true, data: { resources: { core: { remaining: 4900, limit: 5000 } } } };
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
    if (path === "/user/installations") {
      return {
        status: 200,
        ok: true,
        data: {
          installations: [
            { id: 123, account: { login: "PXL-CSMobile" }, permissions: { ...EXPECTED_APP_PERMISSIONS } },
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
    if (path === "/repos/PXL-CSMobile/pxl-classroom-control") {
      return { status: 200, ok: true, data: { private: true } };
    }
    if (path === "/repos/PXL-CSMobile/pxl-classroom-control/contents/public/assignments.json") {
      const json = JSON.stringify({ assignments: { "voorbeeld-project": { id: "voorbeeld-project", state: "published" }, "group-project": { id: "group-project", state: "published" } } });
      return { status: 200, ok: true, data: { content: Buffer.from(json).toString("base64") } };
    }
    if (path.startsWith("/repos/PXL-CSMobile/pxl-classroom-control/contents/")) {
      return { status: 200, ok: true, data: { content: "" } };
    }
    if (path === "/repos/PXL-CSMobile/Project") {
      return { status: 200, ok: true, data: { is_template: true } };
    }
    if (path === "/repos/PXL-CSMobile/broker-voorbeeld-project") {
      return { status: 200, ok: true, data: { private: false } };
    }
    if (path === "/repos/PXL-CSMobile/broker-voorbeeld-project/contents/.github/workflows/acceptance-trigger.yml") {
      return { status: 200, ok: true };
    }
    return { status: 404, ok: false };
  };
}

test("Contract Test: Vue Form State with raw form object directly", async () => {
  const rawVueForm = {
    schema_version: 1,
    id: "voorbeeld-project",
    title: "Voorbeeld Project",
    organization: "PXL-CSMobile",
    template: "PXL-CSMobile/Project",
    repository_name_pattern: "voorbeeld-project-{github_login}",
    opens_at_local: "2026-08-20T13:39",
    deadline_at_local: "2026-12-03T14:39",
    _opens_at_original: "",
    _deadline_at_original: "",
    state: "published",
    roster_mode: "open",
    max_acceptances: 50,
  };

  const req = createMockRequest();
  const fetchPages = async () => ({ assignments: { "voorbeeld-project": { id: "voorbeeld-project", state: "published" } } });

  const res = await runDiagnostics({
    request: req,
    org: "PXL-CSMobile",
    assignmentId: "voorbeeld-project",
    formDoc: rawVueForm,
    hubOwner: "hub",
    hubRepo: "repo",
    fetchPages,
  });

  assert.equal(res.overall, "ok");
  const fieldsCheck = res.checks.find(c => c.id === "assignment-fields");
  assert.equal(fieldsCheck.severity, "ok");
  assert.ok(fieldsCheck.message.includes('Title: "Voorbeeld Project"'));
});

test("Contract Test: Vue Form State after buildDoc() conversion", async () => {
  const rawVueForm = {
    schema_version: 1,
    id: "voorbeeld-project",
    title: "Voorbeeld Project",
    organization: "PXL-CSMobile",
    template: "PXL-CSMobile/Project",
    repository_name_pattern: "voorbeeld-project-{github_login}",
    opens_at_local: "2026-08-20T13:39",
    deadline_at_local: "2026-12-03T14:39",
    state: "published",
    roster_mode: "open",
    max_acceptances: 50,
  };

  const doc = vueBuildDoc(rawVueForm);
  const req = createMockRequest();
  const fetchPages = async () => ({ assignments: { "voorbeeld-project": { id: "voorbeeld-project", state: "published" } } });

  const res = await runDiagnostics({
    request: req,
    org: "PXL-CSMobile",
    assignmentId: "voorbeeld-project",
    formDoc: doc,
    hubOwner: "hub",
    hubRepo: "repo",
    fetchPages,
  });

  assert.equal(res.overall, "ok");
});

test("Contract Test: Group Assignment with group_config", async () => {
  const groupForm = {
    schema_version: 1,
    id: "group-project",
    title: "Group Project",
    organization: "PXL-CSMobile",
    template: "PXL-CSMobile/Project",
    repository_name_pattern: "group-project-{team_slug}",
    opens_at_local: "2026-08-20T13:39",
    deadline_at_local: "2026-12-03T14:39",
    state: "published",
    roster_mode: "open",
    max_acceptances: 20,
    assignment_type: "group",
    group_config: {
      max_team_size: 4,
      min_team_size: 2,
      formation_mode: "self-service",
      allow_team_creation: true,
    },
  };

  const doc = vueBuildDoc(groupForm);
  const req = createMockRequest({
    "/repos/PXL-CSMobile/broker-group-project": async () => ({ status: 200, ok: true, data: { private: false } }),
    "/repos/PXL-CSMobile/broker-group-project/contents/.github/workflows/acceptance-trigger.yml": async () => ({ status: 200, ok: true }),
  });
  const fetchPages = async () => ({ assignments: { "group-project": { id: "group-project", state: "published" } } });

  const res = await runDiagnostics({
    request: req,
    org: "PXL-CSMobile",
    assignmentId: "group-project",
    formDoc: doc,
    hubOwner: "hub",
    hubRepo: "repo",
    fetchPages,
  });

  assert.equal(res.overall, "ok");
});

test("Contract Test: Date Format Resilience (ISO with ms, ISO without ms, Local strings)", async () => {
  const dates = [
    { opens: "2026-08-20T13:39:00.000Z", deadline: "2026-12-03T14:39:00.000Z" },
    { opens: "2026-08-20T13:39:00Z", deadline: "2026-12-03T14:39:00Z" },
    { opens: "2026-08-20T13:39", deadline: "2026-12-03T14:39" },
  ];

  for (const d of dates) {
    const doc = {
      schema_version: 1,
      id: "hw-test",
      title: "HW Test",
      organization: "PXL-CSMobile",
      template: { owner: "PXL-CSMobile", repository: "Project" },
      repository_name_pattern: "hw-test-{github_login}",
      opens_at: d.opens,
      deadline_at: d.deadline,
      state: "draft",
    };

    const req = createMockRequest();
    const res = await runDiagnostics({
      request: req,
      org: "PXL-CSMobile",
      assignmentId: "hw-test",
      formDoc: doc,
    });

    const fieldsCheck = res.checks.find(c => c.id === "assignment-fields");
    assert.equal(fieldsCheck.severity, "ok");
  }
});
