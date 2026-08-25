// PXL Classroom - shared audit engine.
//
// Runs read-only GitHub API checks against an org's PXL Classroom install.
// Same module is imported by the CLI (`pxl-classroom audit`) and the SPA
// (DashboardView's System Health panel) - the difference is what they pass
// as `request`. See ARCHITECTURE.md §12.
//
// request(method, path) -> { status, ok, data } (Promise)
//   CLI: wraps Octokit so it matches the lib/gh.mjs shape.
//   SPA: passes the existing ghApi() function directly.

import { parseYaml } from "./yaml.mjs";
import { CONTROL_SCAFFOLD_DIRS } from "./control-layout.mjs";

export { CONTROL_SCAFFOLD_DIRS };

export const CONTROL_REPO = "pxl-classroom-control";
export const ARCHIVE_REPO = "pxl-classroom-archive";
export const APP_SLUG = "pxl-classroom-provisioner";

// Where a lecturer goes to put the App on an organization. GitHub's own page is
// the org picker: it lists only accounts they can actually install on, with
// search - so the SPA never has to enumerate or filter organizations itself.
export const APP_INSTALL_URL = `https://github.com/apps/${APP_SLUG}/installations/new`;

// The App's public client id. Public by design (it is in the SPA bundle), and
// here because an installation record carries `client_id` but not always a
// usable `app_slug`.
export const APP_CLIENT_ID = "Iv23li0H0Je93H2FkMPW";

/**
 * Pick this App's installation out of a GitHub installations response.
 *
 * Accepts BOTH shapes, because they are not the same and the difference was
 * silent. `/user/installations` answers `{ total_count, installations: [...] }`
 * - which one caller handled - while `/orgs/{org}/installations` was read as a
 * bare array, so `Array.isArray(data)` was false and the whole branch never
 * ran. It is the fallback for an org owner whose `/user/installations` does
 * not list the org, and the step after it (`/orgs/{org}/installation`,
 * singular) needs an App JWT and answers 401 to a user token. So when this one
 * quietly did nothing, System Health reported the App as NOT INSTALLED on an
 * org where it plainly was - a Tier 1 false negative, and CLAUDE.md already
 * records that a Tier 1 misattribution is what made the 2026-08-21 onboarding
 * failure take hours.
 *
 * Both shapes confirmed against the live API on 2026-08-24. Shared rather than
 * duplicated because the two copies had already drifted on exactly this.
 */
export function pickClassroomInstallation(data) {
  const list = Array.isArray(data)
    ? data
    : Array.isArray(data?.installations)
      ? data.installations
      : null;
  if (!list) return null;
  return (
    list.find((i) => i.app_slug?.startsWith("pxl-classroom") || i.client_id === APP_CLIENT_ID) ||
    list[0] ||
    null
  );
}

// The central hub. Brokers read acceptance/invite-keys.json from it at ref main
// to verify invitations, so a diagnostic that wants to know whether a token can
// possibly verify has to look here (ARCHITECTURE 4.3.2).
export const HUB_REPO = "PXL-Digital-Application-Samples/pxl-classroom";

// The permissions declared in the SetupView App Manifest. Kept here so the
// audit engine and the manifest form share one source of truth. If you change
// these, also update frontend/src/views/SetupView.vue.
export const MANIFEST_APP_PERMISSIONS = Object.freeze({
  actions: "write",
  administration: "write",
  contents: "write",
  issues: "write",
  metadata: "read",
  organization_administration: "read",
  pull_requests: "write",
  secrets: "write",
  workflows: "write",
});

// The complete expected permission set on an installed App. Account-level
// starring cannot be declared in default_permissions and is verified
// separately during setup because it applies to user authorization, not an
// organization installation.
export const EXPECTED_APP_PERMISSIONS = Object.freeze({
  ...MANIFEST_APP_PERMISSIONS,
});

const PERMISSION_RANK = Object.freeze({ read: 1, write: 2, admin: 3 });

export function permissionMeetsRequirement(actual, expected) {
  return (PERMISSION_RANK[actual] || 0) >= (PERMISSION_RANK[expected] || 0);
}

// Manifest permissions the live App does not declare. `declared` is the
// `permissions` object from GET /apps/{slug}.
export function missingManifestPermissions(declared) {
  const actual = declared || {};
  return Object.entries(MANIFEST_APP_PERMISSIONS)
    .filter(([perm, expected]) => !permissionMeetsRequirement(actual[perm], expected))
    .map(([permission, expected]) => ({ permission, expected, actual: actual[permission] ?? null }));
}

/**
 * Installations that have not yet approved what the App now declares.
 *
 * Widening an App's permissions does NOT widen its existing installations:
 * every org owner has to accept the request, and until they do that
 * installation keeps the OLD set while `GET /apps/{slug}` already advertises
 * the new one. So the App looks correct, `check-app-declaration.mjs` passes,
 * and the feature is simply dead on the orgs that never clicked - which is
 * indistinguishable from a bug until someone thinks to ask.
 *
 * Compared against the App's own live declaration rather than
 * MANIFEST_APP_PERMISSIONS on purpose. The question is "has this org accepted
 * what the App asks for today?", so the target moves with the App and no
 * constant has to be bumped in lockstep - bumping the manifest first would
 * paint every org amber for a permission nobody had been asked to approve yet.
 *
 * @param {object} declared      `permissions` from GET /apps/{slug}.
 * @param {object[]} installations  Items from GET /app/installations.
 * @returns {{account: string, installationId: number|null,
 *            missing: {permission: string, declared: string, actual: string|null}[]}[]}
 *          one entry per lagging installation, sorted by account.
 */
export function installationApprovalGaps(declared, installations) {
  const want = Object.entries(declared || {});
  const gaps = [];

  for (const inst of installations || []) {
    if (!inst || typeof inst !== "object") continue;
    const actual = inst.permissions || {};
    const missing = want
      .filter(([perm, level]) => !permissionMeetsRequirement(actual[perm], level))
      .map(([permission, level]) => ({
        permission,
        declared: level,
        actual: actual[permission] ?? null,
      }));
    if (missing.length === 0) continue;
    gaps.push({
      account: inst.account?.login ?? "(unknown account)",
      installationId: typeof inst.id === "number" ? inst.id : null,
      missing,
    });
  }

  return gaps.sort((a, b) => a.account.localeCompare(b.account));
}

// Files that must exist for the control repo scaffold to be considered intact.
// We don't enforce directory contents - just that the scaffold was bootstrapped.
const SCAFFOLD_PATHS = ["README.md", ...CONTROL_SCAFFOLD_DIRS];

// Severity ordering - used to compute the worst-case overall verdict.
const SEVERITY_RANK = { ok: 0, info: 1, warn: 2, fail: 3 };
const worse = (a, b) => (SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b);

function check(id, label, severity, message, detail) {
  return { id, label, severity, message, detail: detail ?? null };
}

// --- Individual checks -------------------------------------------------------

// The App Manifest at /setup only applies at App *creation*. Widening
// MANIFEST_APP_PERMISSIONS afterwards does nothing to an App that already
// exists, and no organization can approve a permission the App does not
// declare - which surfaces as identical "installation drift" on every org at
// once. Checking the App itself first puts the remediation in front of the
// only person who can act on it: the App owner. GET /apps/{slug} is public.
async function checkAppDeclaration(request) {
  const label = "App declares the manifest permissions";
  const res = await request("GET", `/apps/${APP_SLUG}`);
  if (!res.ok) {
    return {
      check: check("app-declaration", label, "info", `Skipped - could not read /apps/${APP_SLUG} (HTTP ${res.status}).`),
      declared: null,
    };
  }
  const declared = res.data?.permissions || {};
  const missing = missingManifestPermissions(declared);
  if (missing.length === 0) {
    return { check: check("app-declaration", label, "ok", "The App declares every permission in the manifest."), declared };
  }
  const labels = missing.map((m) => `${m.permission}=${m.actual ?? "missing"} (want ${m.expected})`).join(", ");
  return {
    check: check(
      "app-declaration",
      label,
      "fail",
      `The App itself does not declare: ${labels}. No organization can approve a permission the App does not declare - the App owner adds it under the App's Permissions & events, then every org owner approves the update. See RUNBOOK.md section 10.6.`,
      { missing },
    ),
    declared,
  };
}

// Provisioning creates repositories that did not exist when the App was
// installed. A "selected repositories" installation cannot see them, so every
// student repo 404s right after creation. The hub's own installation is
// deliberately scoped to pxl-classroom (ARCHITECTURE.md section 3.2).
function checkRepositoryAccess(installation, org, hubOwner) {
  const label = "App installed on all repositories";
  if (!installation) return check("app-repository-access", label, "info", "Skipped - no installation.");
  if (hubOwner && org.toLowerCase() === hubOwner.toLowerCase()) {
    return check("app-repository-access", label, "ok", "Hub installation - intentionally scoped to the hub repository.");
  }
  const selection = installation.repository_selection;
  if (!selection) return check("app-repository-access", label, "info", "Installation did not report repository_selection.");
  if (selection === "all") return check("app-repository-access", label, "ok", "Installed on all repositories.");
  return check(
    "app-repository-access",
    label,
    "fail",
    `Installation is scoped to selected repositories. Student repositories do not exist yet at install time, so the App cannot see them once provisioned - set Repository access to "All repositories" at https://github.com/organizations/${org}/settings/installations.`,
    { repository_selection: selection },
  );
}

async function checkInstallation(request, org) {
  // 1. Try GET /user/installations (works for App user-to-server tokens)
  const userInsts = await request("GET", "/user/installations");
  if (userInsts.ok) {
    const list = Array.isArray(userInsts.data?.installations) ? userInsts.data.installations : [];
    const inst = list.find((i) => i.account?.login?.toLowerCase() === org.toLowerCase());
    if (inst) {
      return {
        check: check("app-installed", "App installed on org", "ok", `Installation ID ${inst.id}.`, { installation_id: inst.id }),
        installation: inst,
      };
    }
  }

  // 2. Try GET /orgs/{org}/installations (works for org owners with PAT)
  const listRes = await request("GET", `/orgs/${org}/installations`);
  if (listRes.ok) {
    const inst = pickClassroomInstallation(listRes.data);
    if (inst) {
      return {
        check: check("app-installed", "App installed on org", "ok", `Installation ID ${inst.id}.`, { installation_id: inst.id }),
        installation: inst,
      };
    }
  }

  // 3. Try GET /orgs/{org}/installation (works for JWT/App auth)
  const res = await request("GET", `/orgs/${org}/installation`);
  if (res.status === 404) {
    return { check: check("app-installed", "App installed on org", "fail", "No PXL Classroom App installation found on this org."), installation: null };
  }
  if (!res.ok) {
    return { check: check("app-installed", "App installed on org", "warn", `Could not read installation (HTTP ${res.status}).`), installation: null };
  }
  return { check: check("app-installed", "App installed on org", "ok", `Installation ID ${res.data.id}.`, { installation_id: res.data.id }), installation: res.data };
}

function checkPermissions(installation, declared) {
  if (!installation) return check("app-permissions", "App permissions match manifest", "info", "Skipped - no installation.");
  const actual = installation.permissions || {};
  const drift = [];
  for (const [perm, expected] of Object.entries(EXPECTED_APP_PERMISSIONS)) {
    const got = actual[perm];
    if (!permissionMeetsRequirement(got, expected)) {
      drift.push({
        permission: perm,
        expected,
        actual: got ?? null,
        // Undeclared upstream means approving at the org level is impossible,
        // not merely pending - a different person has to act.
        upstream: declared ? !permissionMeetsRequirement(declared[perm], expected) : false,
      });
    }
  }
  if (drift.length === 0) {
    return check("app-permissions", "App permissions match manifest", "ok", "All expected permissions present at the right level.");
  }
  const labels = drift.map((d) => `${d.permission}=${d.actual ?? "missing"} (want ${d.expected})`).join(", ");
  const upstream = drift.filter((d) => d.upstream);
  if (upstream.length && upstream.length === drift.length) {
    return check(
      "app-permissions",
      "App permissions match manifest",
      "fail",
      `Permission drift: ${labels}. Blocked upstream - the App does not declare ${upstream.length === 1 ? "this permission" : "these permissions"}, so there is nothing for an org owner to approve yet. Fix the App first (see the App declaration check).`,
      { drift },
    );
  }
  const partial = upstream.length
    ? ` ${upstream.map((d) => d.permission).join(", ")} must additionally be added to the App itself first.`
    : "";
  return check("app-permissions", "App permissions match manifest", "fail", `Permission drift: ${labels}. Re-approve the App with the manifest permissions.${partial}`, { drift });
}

async function checkControlRepo(request, org) {
  const repoRes = await request("GET", `/repos/${org}/${CONTROL_REPO}`);
  if (repoRes.status === 404) {
    return check("control-repo", "Control repo exists, private, scaffold intact", "fail", `${org}/${CONTROL_REPO} does not exist. Run Setup Organization.`);
  }
  if (!repoRes.ok) {
    return check("control-repo", "Control repo exists, private, scaffold intact", "warn", `Could not read ${CONTROL_REPO} (HTTP ${repoRes.status}).`);
  }
  if (!repoRes.data.private) {
    return check("control-repo", "Control repo exists, private, scaffold intact", "fail", `${CONTROL_REPO} is public. Data-only repos must be private.`);
  }
  const missing = [];
  for (const path of SCAFFOLD_PATHS) {
    const r = await request("GET", `/repos/${org}/${CONTROL_REPO}/contents/${path}`);
    if (r.status === 404) missing.push(path);
  }
  if (missing.length > 0) {
    return check("control-repo", "Control repo exists, private, scaffold intact", "warn", `Scaffold paths missing: ${missing.join(", ")}.`, { missing });
  }
  return check("control-repo", "Control repo exists, private, scaffold intact", "ok", `Private, all ${SCAFFOLD_PATHS.length} scaffold paths present.`);
}

async function checkParticipatingOrgs(request, org, hubOwner, hubRepo) {
  if (!hubOwner || !hubRepo) {
    return check("participating-orgs", "Org listed on participating-orgs branch", "info", "Skipped - hub repo not provided.");
  }
  const res = await request("GET", `/repos/${hubOwner}/${hubRepo}/contents/participating-orgs.yml?ref=participating-orgs`);
  if (res.status === 404) {
    return check("participating-orgs", "Org listed on participating-orgs branch", "warn", "participating-orgs.yml not found on the hub's participating-orgs branch.");
  }
  if (!res.ok) {
    return check("participating-orgs", "Org listed on participating-orgs branch", "warn", `Could not read participating-orgs.yml (HTTP ${res.status}).`);
  }
  let parsed;
  try {
    const raw = res.data?.content ? atobSafe(res.data.content) : (res.data?.raw || "");
    parsed = parseYaml(raw);
  } catch (e) {
    return check("participating-orgs", "Org listed on participating-orgs branch", "warn", `participating-orgs.yml could not be parsed: ${e.message}.`);
  }
  const entry = (parsed.orgs || []).find((o) => o.login?.toLowerCase() === org.toLowerCase());
  if (!entry) {
    return check("participating-orgs", "Org listed on participating-orgs branch", "fail", `${org} is missing from participating-orgs.yml. Weekly usage report will not include this org.`);
  }
  return check("participating-orgs", "Org listed on participating-orgs branch", "ok", `Listed (budget owner: @${entry.budget_owner_login}).`, { entry });
}

async function checkAssignmentLockdown(request, org, assignmentId) {
  const lockdownRes = await request("GET", `/repos/${org}/${CONTROL_REPO}/contents/lockdowns/${assignmentId}/lockdown-record.json`);
  if (lockdownRes.status === 404) {
    return check("assignment-lockdown", `Lockdown record matches repo permissions (${assignmentId})`, "info", "No lockdown record yet - deadline may not have passed.");
  }
  if (!lockdownRes.ok) {
    return check("assignment-lockdown", `Lockdown record matches repo permissions (${assignmentId})`, "warn", `Could not read lockdown record (HTTP ${lockdownRes.status}).`);
  }
  let record;
  try {
    const raw = lockdownRes.data?.content ? atobSafe(lockdownRes.data.content) : "";
    record = JSON.parse(raw);
  } catch (e) {
    return check("assignment-lockdown", `Lockdown record matches repo permissions (${assignmentId})`, "warn", `Lockdown record unparseable: ${e.message}.`);
  }
  const mismatches = [];
  const results = Array.isArray(record.results) ? record.results : [];
  // Sample up to 10 students rather than hammering the API on a large class.
  const sample = results.slice(0, 10);
  for (const r of sample) {
    if (!r.repo_name || !r.login) continue;
    const repoOnly = r.repo_name.includes("/") ? r.repo_name.split("/")[1] : r.repo_name;
    const permRes = await request("GET", `/repos/${org}/${repoOnly}/collaborators/${r.login}/permission`);
    if (!permRes.ok) continue;
    const got = permRes.data?.permission ?? "unknown";
    if (got !== "read" && got !== "none") {
      mismatches.push({ login: r.login, expected: "read", got });
    }
  }
  if (mismatches.length > 0) {
    return check("assignment-lockdown", `Lockdown record matches repo permissions (${assignmentId})`, "fail", `${mismatches.length} student(s) still have write access after lockdown.`, { mismatches });
  }
  return check("assignment-lockdown", `Lockdown record matches repo permissions (${assignmentId})`, "ok", `Sampled ${sample.length} student(s); all demoted to read or less.`);
}

async function checkAssignmentArchive(request, org, assignmentId) {
  const reportRes = await request("GET", `/repos/${org}/${CONTROL_REPO}/contents/reports/${assignmentId}.json`);
  if (reportRes.status === 404) {
    return check("assignment-archive", `Archive branches exist for reported submissions (${assignmentId})`, "info", "No report yet - preservation may not have run.");
  }
  if (!reportRes.ok) {
    return check("assignment-archive", `Archive branches exist for reported submissions (${assignmentId})`, "warn", `Could not read report (HTTP ${reportRes.status}).`);
  }
  let report;
  try {
    const raw = reportRes.data?.content ? atobSafe(reportRes.data.content) : "";
    report = JSON.parse(raw);
  } catch (e) {
    return check("assignment-archive", `Archive branches exist for reported submissions (${assignmentId})`, "warn", `Report unparseable: ${e.message}.`);
  }
  const submitters = (report.students || []).filter((s) => s.preservation_status === "preserved" && s.github_login);
  if (submitters.length === 0) {
    return check("assignment-archive", `Archive branches exist for reported submissions (${assignmentId})`, "info", "No preserved submissions in the report.");
  }
  const missing = [];
  const sample = submitters.slice(0, 10);
  for (const s of sample) {
    const branchName = `preserved/${assignmentId}/${s.github_login}`;
    const br = await request("GET", `/repos/${org}/${ARCHIVE_REPO}/branches/${encodeURIComponent(branchName)}`);
    if (br.status === 404) missing.push(s.github_login);
  }
  if (missing.length > 0) {
    return check("assignment-archive", `Archive branches exist for reported submissions (${assignmentId})`, "fail", `${missing.length} archive branch(es) missing.`, { missing });
  }
  return check("assignment-archive", `Archive branches exist for reported submissions (${assignmentId})`, "ok", `Sampled ${sample.length} student(s); all archive branches present.`);
}

async function checkAssignmentBroker(request, org, assignmentId) {
  const ymlRes = await request("GET", `/repos/${org}/${CONTROL_REPO}/contents/assignments/${assignmentId}.yml`);
  if (ymlRes.status === 404) {
    return check("assignment-broker", `Acceptance broker exists (${assignmentId})`, "info", `assignments/${assignmentId}.yml not found in control repo.`);
  }
  if (!ymlRes.ok) {
    return check("assignment-broker", `Acceptance broker exists (${assignmentId})`, "warn", `Could not read assignment ${assignmentId}.yml (HTTP ${ymlRes.status}).`);
  }
  let doc;
  try {
    const raw = ymlRes.data?.content ? atobSafe(ymlRes.data.content) : (ymlRes.data?.raw || "");
    doc = parseYaml(raw);
  } catch (e) {
    return check("assignment-broker", `Acceptance broker exists (${assignmentId})`, "warn", `Assignment ${assignmentId}.yml unparseable: ${e.message}.`);
  }
  if (doc?.state !== "published") {
    return check("assignment-broker", `Acceptance broker exists (${assignmentId})`, "info", `Assignment state is "${doc?.state || 'draft'}" - broker not required.`);
  }

  const brokerName = doc.broker_repo || `broker-${assignmentId}`;
  const brokerRes = await request("GET", `/repos/${org}/${brokerName}`);
  if (brokerRes.status === 404) {
    return check(
      "assignment-broker",
      `Acceptance broker exists (${assignmentId})`,
      "fail",
      `Assignment is published, but broker repo ${org}/${brokerName} does not exist. Run Publish/Republish from the Admin Panel.`,
      { broker_repo: brokerName }
    );
  }
  if (!brokerRes.ok) {
    return check("assignment-broker", `Acceptance broker exists (${assignmentId})`, "warn", `Could not check broker ${brokerName} (HTTP ${brokerRes.status}).`);
  }
  return check("assignment-broker", `Acceptance broker exists (${assignmentId})`, "ok", `Published and broker ${brokerName} exists.`);
}

// --- Public API --------------------------------------------------------------

export async function runAudit({ request, org, assignmentId = null, hubOwner = null, hubRepo = null }) {
  if (typeof request !== "function") throw new Error("runAudit requires a request(method, path) function");
  if (!org) throw new Error("runAudit requires an org");

  const checks = [];

  // Core org-level checks
  const { check: declarationCheck, declared } = await checkAppDeclaration(request);
  checks.push(declarationCheck);
  const { check: installCheck, installation } = await checkInstallation(request, org);
  checks.push(installCheck);
  checks.push(checkPermissions(installation, declared));
  checks.push(checkRepositoryAccess(installation, org, hubOwner));
  checks.push(await checkControlRepo(request, org));
  checks.push(await checkParticipatingOrgs(request, org, hubOwner, hubRepo));

  // Optional per-assignment deep checks
  if (assignmentId) {
    checks.push(await checkAssignmentBroker(request, org, assignmentId));
    checks.push(await checkAssignmentLockdown(request, org, assignmentId));
    checks.push(await checkAssignmentArchive(request, org, assignmentId));
  }

  const overall = checks.reduce((acc, c) => worse(acc, c.severity), "ok");
  return {
    schema_version: 1,
    org,
    assignment_id: assignmentId,
    generated_at: new Date().toISOString(),
    overall,
    checks,
  };
}

// Tiny base64 decode that works in both Node and the browser. Used to read
// Contents API responses; the GitHub API returns base64-encoded `content`.
function atobSafe(b64) {
  const compact = String(b64).replace(/\n/g, "");
  if (typeof atob === "function") {
    return new TextDecoder().decode(Uint8Array.from(atob(compact), (c) => c.charCodeAt(0)));
  }
  return Buffer.from(compact, "base64").toString("utf8");
}
