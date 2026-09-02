import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runAudit,
  EXPECTED_APP_PERMISSIONS,
  MANIFEST_APP_PERMISSIONS,
  ACCOUNT_APP_PERMISSIONS,
  permissionMeetsRequirement,
  missingManifestPermissions,
  excessDeclaredPermissions,
} from "../lib/audit.mjs";

test("EXPECTED_APP_PERMISSIONS shape", () => {
  assert.equal(typeof EXPECTED_APP_PERMISSIONS, "object");
  assert.equal(EXPECTED_APP_PERMISSIONS.actions, "write");
  assert.equal(EXPECTED_APP_PERMISSIONS.administration, "write");
  assert.equal(EXPECTED_APP_PERMISSIONS.contents, "write");
  assert.equal(EXPECTED_APP_PERMISSIONS.issues, "write");
  assert.equal(EXPECTED_APP_PERMISSIONS.metadata, "read");
  // Deliberately not pinned to a literal. This permission is held ABOVE what
  // the code uses - read covers billing and default_repository_permission,
  // write is kept for ARCHITECTURE §11.2.1's org-scoped lockdown - so the level
  // is a recorded decision rather than a fact about an endpoint. Pinning "read"
  // is what made this test fail when that decision was taken; what must stay
  // true is that it is declared at all.
  assert.ok(
    ["read", "write"].includes(EXPECTED_APP_PERMISSIONS.organization_administration),
    "organization_administration must be declared - billing needs it at minimum",
  );
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
  orgsYaml = "orgs:\n  - login: TestOrg\n    budget_owner_login: admin",
  // The viewer's own access to the hub repo. `null` omits `permissions`
  // entirely, which is what GitHub returns when nobody is authenticated - a
  // different answer from "no access", and checked separately below.
  hubStatus = 200,
  hubPush = true,
  // assignments/ directory: { "<name>.yml": <yaml string> | number(status) }.
  // The default is a healthy org - one published assignment whose broker
  // exists - because that is what "happy path" has to mean once the audit
  // checks brokers org-wide.
  assignmentFiles = { "hw1.yml": "schema_version: 1\nid: hw1\nstate: published\n" },
  // broker repo name -> HTTP status. Anything unlisted is 200.
  brokerStatuses = {},
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
    // assignments/ listing and its documents, for the org-wide broker sweep.
    // BEFORE the generic contents/ branch below, which answers 200 with no body
    // and would make every listing look like an empty directory.
    if (path === `/repos/TestOrg/pxl-classroom-control/contents/assignments`) {
      // missingPaths still wins: the scaffold tests remove `assignments`
      // entirely, and this branch must not resurrect it.
      if (missingPaths.includes("assignments")) return { status: 404, ok: false };
      if (!assignmentFiles) return { status: 404, ok: false };
      return {
        status: 200,
        ok: true,
        data: Object.keys(assignmentFiles).map((name) => ({ type: "file", name })),
      };
    }
    if (path.startsWith(`/repos/TestOrg/pxl-classroom-control/contents/assignments/`)) {
      const name = path.split("/").pop();
      const entry = assignmentFiles?.[name];
      if (entry === undefined) return { status: 404, ok: false };
      if (typeof entry === "number") return { status: entry, ok: false };
      return { status: 200, ok: true, data: { content: Buffer.from(entry).toString("base64") } };
    }
    if (/^\/repos\/TestOrg\/broker-/.test(path)) {
      const name = path.split("/").pop();
      const st = brokerStatuses[name] ?? 200;
      return { status: st, ok: st === 200, data: { full_name: `TestOrg/${name}` } };
    }
    // Everything else under contents/ - scaffold presence checks.
    if (path.startsWith(`/repos/TestOrg/pxl-classroom-control/contents/`)) {
      const p = path.split("/").pop();
      if (missingPaths.includes(p)) return { status: 404, ok: false };
      return { status: 200, ok: true };
    }
    if (path === `/repos/hub/repo`) {
      if (hubStatus !== 200) return { status: hubStatus, ok: false };
      return {
        status: 200,
        ok: true,
        data: hubPush === null ? {} : { permissions: { admin: false, push: hubPush, pull: true } },
      };
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
  assert.equal(res.checks.length, 8);
  assert.equal(res.checks.every(c => c.severity === "ok"), true);
});

// Publishing dispatches a workflow on the hub with the LECTURER's own token, so
// a lecturer without write there discovers it as a 403 after the assignment has
// been written. These say so first. OPEN-ITEMS §4 - and note the collaborator
// grant ADMIN.md §1.4 prescribes has never actually been used, so the warning
// below is the only thing standing between that instruction and a confused
// lecturer.
test("hub dispatch - write access is what Publish needs", async () => {
  const res = await runAudit({ request: createMockRequest({}), org: "TestOrg", hubOwner: "hub", hubRepo: "repo" });
  const c = res.checks.find((x) => x.id === "hub-dispatch");
  assert.equal(c.severity, "ok");
  assert.equal(c.detail.push, true);
});

test("hub dispatch - no write access warns before the 403, and names the org-membership trap", async () => {
  const res = await runAudit({
    request: createMockRequest({ hubPush: false }),
    org: "TestOrg", hubOwner: "hub", hubRepo: "repo",
  });
  const c = res.checks.find((x) => x.id === "hub-dispatch");
  assert.equal(c.severity, "warn");
  assert.equal(c.detail.push, false);
  // The specific confusion this is for: being an org member is not access.
  assert.match(c.message, /member of the hub organization is not enough/i);
  // And it must not overstate the damage - editing still works.
  assert.match(c.message, /Creating and editing assignments still works/i);
});

test("hub dispatch - permissions absent is no verdict, not a green one", async () => {
  // GitHub omits `permissions` when nobody is authenticated. That is not the
  // same answer as "no access", and reporting either colour would be a claim
  // the response does not support.
  const res = await runAudit({
    request: createMockRequest({ hubPush: null }),
    org: "TestOrg", hubOwner: "hub", hubRepo: "repo",
  });
  const c = res.checks.find((x) => x.id === "hub-dispatch");
  assert.equal(c.severity, "info");
  assert.equal(c.detail, null);
});

test("hub dispatch - an unreadable hub repo yields no check", async () => {
  const res = await runAudit({
    request: createMockRequest({ hubStatus: 500 }),
    org: "TestOrg", hubOwner: "hub", hubRepo: "repo",
  });
  const c = res.checks.find((x) => x.id === "hub-dispatch");
  assert.equal(c.severity, "warn");
  assert.match(c.message, /could not be checked/i);
});

// A published assignment with no broker cannot be accepted by anybody - the
// invitation link resolves to nothing - and until this check existed it was
// invisible everywhere except that one assignment's Admin panel. Two sat in
// that state on 2026-09-02 and were only found by a hand-written sweep.
const PUBLISHED = (id) => `schema_version: 1\nid: ${id}\nstate: published\n`;
const DRAFT = (id) => `schema_version: 1\nid: ${id}\nstate: draft\n`;

const sweep = (opts) =>
  runAudit({ request: createMockRequest(opts), org: "TestOrg", hubOwner: "hub", hubRepo: "repo" })
    .then((r) => r.checks.find((c) => c.id === "published-brokers"));

test("published brokers - all present is ok", async () => {
  const c = await sweep({ assignmentFiles: { "a.yml": PUBLISHED("a"), "b.yml": PUBLISHED("b") } });
  assert.equal(c.severity, "ok");
  assert.equal(c.detail.published, 2);
});

test("published brokers - a missing broker fails and names the assignment", async () => {
  const c = await sweep({
    assignmentFiles: { "a.yml": PUBLISHED("a"), "b.yml": PUBLISHED("b") },
    brokerStatuses: { "broker-b": 404 },
  });
  assert.equal(c.severity, "fail");
  assert.deepEqual(c.detail.missing, [{ id: "b", broker: "broker-b" }]);
  assert.match(c.message, /\bb\b/);
  // It must say what to do, not just what is wrong.
  assert.match(c.message, /Complete Setup/);
});

test("published brokers - a draft needs no broker", async () => {
  // Drafts have no accept link, so a missing broker is correct, not a fault.
  const c = await sweep({
    assignmentFiles: { "a.yml": DRAFT("a") },
    brokerStatuses: { "broker-a": 404 },
  });
  assert.equal(c.severity, "info");
  assert.equal(c.detail.published, 0);
});

test("published brokers - an unreadable assignment BLOCKS a green result", async () => {
  // The rule that makes this check worth trusting. "All brokers present" while
  // one could not be read is the answer somebody acts on, and it would be a
  // claim the data does not support.
  const c = await sweep({
    assignmentFiles: { "a.yml": PUBLISHED("a"), "b.yml": 500 },
  });
  assert.equal(c.severity, "warn");
  assert.equal(c.detail.unreadable.length, 1);
});

test("published brokers - a missing broker outranks an unreadable one", async () => {
  // Both present: the actionable failure must not be downgraded to a warning,
  // and the unreadable count still has to be reported rather than dropped.
  const c = await sweep({
    assignmentFiles: { "a.yml": PUBLISHED("a"), "b.yml": PUBLISHED("b"), "c.yml": 500 },
    brokerStatuses: { "broker-a": 404 },
  });
  assert.equal(c.severity, "fail");
  assert.equal(c.detail.missing.length, 1);
  assert.match(c.message, /1 could not be checked/);
});

test("published brokers - a custom broker_repo is honoured, not guessed", async () => {
  // brokerRepoName reads what the document RECORDS before falling back to the
  // default naming. Checking `broker-a` here would report a false failure.
  const c = await sweep({
    assignmentFiles: { "a.yml": `schema_version: 1\nid: a\nstate: published\nbroker_repo: broker-custom-name\n` },
    brokerStatuses: { "broker-a": 404 },
  });
  assert.equal(c.severity, "ok");
});

test("hub dispatch - skipped when the hub is not known", async () => {
  const res = await runAudit({ request: createMockRequest({}), org: "TestOrg" });
  const c = res.checks.find((x) => x.id === "hub-dispatch");
  assert.equal(c.severity, "info");
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
  // Derived from the manifest rather than spelled out: the message quotes
  // whatever level the manifest asks for, and that level can legitimately move.
  assert.ok(
    declaration.message.includes(
      `organization_administration=missing (want ${MANIFEST_APP_PERMISSIONS.organization_administration})`,
    ),
  );
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

// --- excessDeclaredPermissions ------------------------------------------------
//
// Never named in a test, and it carries a deliberate argument SWAP that reads
// like a bug:
//
//     permissionMeetsRequirement(actual, expected)   // rank(actual) >= rank(expected)
//     ...
//     !permissionMeetsRequirement(want, level)       // want=required, level=granted
//
// Passing (required, granted) asks "does the requirement meet the grant?", and
// negating it gives "the requirement is BELOW the grant" - excess. Read quickly
// it looks like the missing-permission test with the arguments the wrong way
// round, so an edit that "corrects" it would invert the check that guards the
// blast radius on PXL_APP_PRIVATE_KEY, and nothing would have said so.

test("excessDeclaredPermissions flags a grant ABOVE what the manifest asks for", () => {
  const required = { ...MANIFEST_APP_PERMISSIONS };
  const [firstPerm, firstLevel] = Object.entries(required).find(([, v]) => v === "read")
    ?? Object.entries(required)[0];

  // Granted one rank higher than required.
  const higher = firstLevel === "read" ? "write" : "admin";
  const excess = excessDeclaredPermissions({ ...required, [firstPerm]: higher });
  const hit = excess.find((e) => e.permission === firstPerm);
  assert.ok(hit, `${firstPerm} granted ${higher} over a required ${firstLevel} must be excess`);
  assert.equal(hit.actual, higher);
  assert.equal(hit.required, firstLevel);
});

test("excessDeclaredPermissions does NOT flag a grant that is short - that is the other check", () => {
  // The inversion this guards against. A permission granted BELOW what the
  // manifest asks for is missingManifestPermissions' business; reporting it here
  // too would put a second, differently-worded error beside it and send the App
  // owner to remove a permission they need to add.
  const required = { ...MANIFEST_APP_PERMISSIONS };
  const writePerm = Object.entries(required).find(([, v]) => v === "write")?.[0];
  if (!writePerm) return; // nothing to prove with this manifest

  const short = excessDeclaredPermissions({ ...required, [writePerm]: "read" });
  assert.ok(
    !short.some((e) => e.permission === writePerm),
    "a permission granted below the requirement is missing, not excess",
  );
  assert.ok(
    missingManifestPermissions({ ...required, [writePerm]: "read" })
      .some((m) => m.permission === writePerm),
    "and it must be reported by the check that does own it",
  );
});

test("excessDeclaredPermissions flags a permission nothing asks for at all", () => {
  const excess = excessDeclaredPermissions({ ...MANIFEST_APP_PERMISSIONS, packages: "write" });
  const hit = excess.find((e) => e.permission === "packages");
  assert.ok(hit, "a permission absent from the manifest is pure blast radius");
  assert.equal(hit.required, null, "and it must say nothing asks for it");
});

test("excessDeclaredPermissions is empty for an App declaring exactly the manifest", () => {
  // The state the weekly check expects. If this ever fails, the check fires on
  // every run and stops being read.
  assert.deepEqual(
    excessDeclaredPermissions({ ...MANIFEST_APP_PERMISSIONS, ...ACCOUNT_APP_PERMISSIONS }),
    [],
  );
});
