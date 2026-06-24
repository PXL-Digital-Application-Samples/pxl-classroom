// PXL Classroom — shared audit engine.
//
// Runs read-only GitHub API checks against an org's PXL Classroom install.
// Same module is imported by the CLI (`pxl-classroom audit`) and the SPA
// (DashboardView's System Health panel) — the difference is what they pass
// as `request`. See EXTRA_FEATURES_PLAN.md §5.
//
// request(method, path) → { status, ok, data } (Promise)
//   CLI: wraps Octokit so it matches the lib/gh.mjs shape.
//   SPA: passes the existing ghApi() function directly.

import { parseYaml } from "./yaml.mjs";

export const CONTROL_REPO = "pxl-classroom-control";
export const ARCHIVE_REPO = "pxl-classroom-archive";

// The permissions declared in the SetupView App Manifest. Kept here so the
// audit engine and the manifest form share one source of truth. If you change
// these, also update frontend/src/views/SetupView.vue.
export const EXPECTED_APP_PERMISSIONS = Object.freeze({
  actions: "write",
  administration: "write",
  contents: "write",
  metadata: "read",
  secrets: "write",
});

// Files that must exist for the control repo scaffold to be considered intact.
// We don't enforce directory contents — just that the scaffold was bootstrapped.
const SCAFFOLD_PATHS = ["README.md", "assignments", "students", "acceptances", "repositories", "observations", "reports", "overrides"];

// Severity ordering — used to compute the worst-case overall verdict.
const SEVERITY_RANK = { ok: 0, info: 1, warn: 2, fail: 3 };
const worse = (a, b) => (SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b);

function check(id, label, severity, message, detail) {
  return { id, label, severity, message, detail: detail ?? null };
}

// --- Individual checks -------------------------------------------------------

async function checkInstallation(request, org) {
  const res = await request("GET", `/orgs/${org}/installation`);
  if (res.status === 404) {
    return { check: check("app-installed", "App installed on org", "fail", "No PXL Classroom App installation found on this org."), installation: null };
  }
  if (!res.ok) {
    return { check: check("app-installed", "App installed on org", "warn", `Could not read installation (HTTP ${res.status}).`), installation: null };
  }
  return { check: check("app-installed", "App installed on org", "ok", `Installation ID ${res.data.id}.`, { installation_id: res.data.id }), installation: res.data };
}

function checkPermissions(installation) {
  if (!installation) return check("app-permissions", "App permissions match manifest", "info", "Skipped — no installation.");
  const actual = installation.permissions || {};
  const drift = [];
  for (const [perm, expected] of Object.entries(EXPECTED_APP_PERMISSIONS)) {
    const got = actual[perm];
    if (got !== expected) drift.push({ permission: perm, expected, actual: got ?? null });
  }
  if (drift.length === 0) {
    return check("app-permissions", "App permissions match manifest", "ok", "All expected permissions present at the right level.");
  }
  const labels = drift.map((d) => `${d.permission}=${d.actual ?? "missing"} (want ${d.expected})`).join(", ");
  return check("app-permissions", "App permissions match manifest", "fail", `Permission drift: ${labels}. Re-approve the App with the manifest permissions.`, { drift });
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
    return check("participating-orgs", "Org listed on participating-orgs branch", "info", "Skipped — hub repo not provided.");
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
    return check("assignment-lockdown", `Lockdown record matches repo permissions (${assignmentId})`, "info", "No lockdown record yet — deadline may not have passed.");
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
    if (got !== "read" && got !== "pull" && got !== "none") {
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
    return check("assignment-archive", `Archive branches exist for reported submissions (${assignmentId})`, "info", "No report yet — preservation may not have run.");
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

// --- Public API --------------------------------------------------------------

export async function runAudit({ request, org, assignmentId = null, hubOwner = null, hubRepo = null }) {
  if (typeof request !== "function") throw new Error("runAudit requires a request(method, path) function");
  if (!org) throw new Error("runAudit requires an org");

  const checks = [];

  // Core org-level checks
  const { check: installCheck, installation } = await checkInstallation(request, org);
  checks.push(installCheck);
  checks.push(checkPermissions(installation));
  checks.push(await checkControlRepo(request, org));
  checks.push(await checkParticipatingOrgs(request, org, hubOwner, hubRepo));

  // Optional per-assignment deep checks
  if (assignmentId) {
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
    try { return decodeURIComponent(escape(atob(compact))); } catch { return atob(compact); }
  }
  return Buffer.from(compact, "base64").toString("utf8");
}
