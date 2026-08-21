// PXL Classroom - Comprehensive Assignment & Organization Diagnostic Engine.
//
// Evaluates an organization and its assignments across a strict 5-tier
// dependency hierarchy. Used by the unified System Health / Diagnostic Modal
// and the CLI audit command.
//
// request(method, path, body) -> { status, ok, data } (Promise)

import { parseYaml } from "./yaml.mjs";
import {
  CONTROL_REPO,
  EXPECTED_APP_PERMISSIONS,
  CONTROL_SCAFFOLD_DIRS,
  permissionMeetsRequirement,
} from "./audit.mjs";

const SCAFFOLD_PATHS = ["README.md", ...CONTROL_SCAFFOLD_DIRS];

const SEVERITY_RANK = { ok: 0, info: 1, warn: 2, fail: 3 };
const worse = (a, b) => (SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b);

function check(id, tierId, label, severity, message, detail = null, fixAction = null) {
  return { id, tierId, label, severity, message, detail, fixAction };
}

function atobSafe(b64) {
  const compact = String(b64).replace(/\n/g, "");
  if (typeof atob === "function") {
    return new TextDecoder().decode(Uint8Array.from(atob(compact), (c) => c.charCodeAt(0)));
  }
  return Buffer.from(compact, "base64").toString("utf8");
}

export async function runDiagnostics({
  request,
  org,
  assignmentId = null,
  formDoc = null,
  hubOwner = null,
  hubRepo = null,
  fetchPages = null,
}) {
  if (typeof request !== "function") throw new Error("runDiagnostics requires a request(method, path) function");
  if (!org) throw new Error("runDiagnostics requires an org");

  const tiers = [
    {
      id: "tier-0-auth",
      label: "Authentication & Quota",
      subtitle: "GitHub user session and API rate-limit headroom",
      severity: "ok",
      checks: [],
    },
    {
      id: "tier-1-org",
      label: "Course Organization & GitHub App",
      subtitle: "Provisioner App installation, permissions, and hub enrollment",
      severity: "ok",
      checks: [],
    },
    {
      id: "tier-2-control",
      label: "Course Control Repository",
      subtitle: "Private repository (pxl-classroom-control) storing assignments and rosters",
      severity: "ok",
      checks: [],
    },
  ];

  if (assignmentId || formDoc) {
    tiers.push(
      {
        id: "tier-3-assignment",
        label: "Assignment & Starter Template",
        subtitle: "Assignment YAML schema, roster file, and starter template repository",
        severity: "ok",
        checks: [],
      },
      {
        id: "tier-4-broker",
        label: "Student Acceptance Broker",
        subtitle: "Automated provisioning service repository (broker-<id>) and trigger workflow",
        severity: "ok",
        checks: [],
      },
      {
        id: "tier-5-pages",
        label: "Student Portal & Web Edge",
        subtitle: "Public assignment compilation and GitHub Pages CDN reachability",
        severity: "ok",
        checks: [],
      }
    );
  } else {
    tiers.push(
      {
        id: "tier-3-assignments-overview",
        label: "Registered Assignments",
        subtitle: "Scanned assignment configurations in the control repository",
        severity: "ok",
        checks: [],
      }
    );
  }

  const req = async (method, path, body = null) => {
    try {
      const res = await request(method, path, body);
      return res || { status: 500, ok: false, data: { message: "No response" } };
    } catch (e) {
      return { status: 500, ok: false, error: e.message, data: { message: e.message } };
    }
  };

  const allChecks = [];
  const addCheck = (tierIdx, c) => {
    tiers[tierIdx].checks.push(c);
    tiers[tierIdx].severity = worse(tiers[tierIdx].severity, c.severity);
    allChecks.push(c);
  };

  // ---------------------------------------------------------------------------
  // TIER 0: Authentication & API Quota
  // ---------------------------------------------------------------------------
  let tokenValid = true;
  const userRes = await req("GET", "/user");
  if (!userRes.ok) {
    tokenValid = false;
    addCheck(
      0,
      check(
        "auth-session",
        "tier-0-auth",
        "GitHub Session & User Token",
        "fail",
        `GitHub session is invalid or expired (HTTP ${userRes.status}). Sign in again.`,
        null,
        { type: "login", label: "Sign in with GitHub" }
      )
    );
  } else {
    addCheck(
      0,
      check(
        "auth-session",
        "tier-0-auth",
        "GitHub Session & User Token",
        "ok",
        `Authenticated as @${userRes.data?.login || "user"}.`
      )
    );
  }

  const rateRes = await req("GET", "/rate_limit");
  if (rateRes.ok && rateRes.data?.resources?.core) {
    const core = rateRes.data.resources.core;
    const remaining = core.remaining;
    const resetMins = core.reset
      ? Math.max(1, Math.ceil((new Date(core.reset * 1000).getTime() - Date.now()) / 60000))
      : 60;
    if (remaining < 100) {
      addCheck(
        0,
        check(
          "api-rate-limit",
          "tier-0-auth",
          "GitHub API Rate Limit",
          remaining === 0 ? "fail" : "warn",
          `Only ${remaining} GitHub API calls remaining (resets in ${resetMins} min).`
        )
      );
    } else {
      addCheck(
        0,
        check(
          "api-rate-limit",
          "tier-0-auth",
          "GitHub API Rate Limit",
          "ok",
          `${remaining} / ${core.limit} API calls available.`
        )
      );
    }
  }

  if (!tokenValid) {
    return finishDiagnostics(org, assignmentId, tiers, allChecks);
  }

  // ---------------------------------------------------------------------------
  // TIER 1: Organization & GitHub App Foundation
  // ---------------------------------------------------------------------------
  let appInstalled = false;
  let installation = null;
  let installationFromUserToken = false;

  const userInsts = await req("GET", "/user/installations");
  if (userInsts.ok && Array.isArray(userInsts.data?.installations)) {
    installation = userInsts.data.installations.find(
      (i) => i.account?.login?.toLowerCase() === org.toLowerCase()
    );
    installationFromUserToken = Boolean(installation);
  }
  if (!installation) {
    const orgInsts = await req("GET", `/orgs/${org}/installations`);
    if (orgInsts.ok && Array.isArray(orgInsts.data)) {
      installation = orgInsts.data.find(
        (i) => i.app_slug?.startsWith("pxl-classroom") || i.client_id === "Iv23li0H0Je93H2FkMPW"
      ) || orgInsts.data[0];
    }
  }
  if (!installation) {
    const singleInst = await req("GET", `/orgs/${org}/installation`);
    if (singleInst.ok) installation = singleInst.data;
  }

  if (installation) {
    appInstalled = true;
    addCheck(
      1,
      check(
        "app-installed",
        "tier-1-org",
        "GitHub App Installation",
        "ok",
        `App installed on ${org} (Installation ID: ${installation.id}).`
      )
    );

    const actualPerms = installation.permissions || {};
    const drift = [];
    for (const [perm, expected] of Object.entries(EXPECTED_APP_PERMISSIONS)) {
      const got = actualPerms[perm];
      if (!permissionMeetsRequirement(got, expected)) {
        drift.push({ permission: perm, expected, actual: got ?? null });
      }
    }

    // A declared permission can still be unusable when an installation has
    // not accepted an update or the organization lacks enhanced billing.
    // Probe with the App user token when available so System Health reports
    // the exact failure that would otherwise make weekly usage silently skip.
    if (installationFromUserToken && permissionMeetsRequirement(actualPerms.organization_administration, "read")) {
      const now = new Date();
      const billingRes = await req(
        "GET",
        `/organizations/${encodeURIComponent(org)}/settings/billing/usage?year=${now.getUTCFullYear()}&month=${now.getUTCMonth() + 1}`
      );
      if (billingRes.ok) {
        addCheck(
          1,
          check(
            "billing-usage-access",
            "tier-1-org",
            "Enhanced Billing Usage API",
            "ok",
            "Weekly usage reporting can read organization billing data."
          )
        );
      } else {
        addCheck(
          1,
          check(
            "billing-usage-access",
            "tier-1-org",
            "Enhanced Billing Usage API",
            "fail",
            `Billing usage is inaccessible (HTTP ${billingRes.status}). Confirm Organization Administration: read, approve the App update, and verify enhanced billing is enabled.`,
            { status: billingRes.status, message: billingRes.data?.message || null },
            {
              type: "link",
              url: `https://github.com/organizations/${org}/settings/installations/${installation.id}`,
              label: "Review App Installation",
            }
          )
        );
      }
    }
    if (drift.length === 0) {
      addCheck(
        1,
        check(
          "app-permissions",
          "tier-1-org",
          "GitHub App Permissions",
          "ok",
          "All expected repository and organization permissions are active."
        )
      );
    } else {
      const labels = drift.map((d) => `${d.permission}=${d.actual ?? "missing"}`).join(", ");
      addCheck(
        1,
        check(
          "app-permissions",
          "tier-1-org",
          "GitHub App Permissions",
          "fail",
          `App permissions drifted (${labels}). Re-approve the App permissions.`,
          { drift },
          {
            type: "link",
            url: `https://github.com/organizations/${org}/settings/installations/${installation.id}`,
            label: "Re-approve App Permissions",
          }
        )
      );
    }
  } else {
    addCheck(
      1,
      check(
        "app-installed",
        "tier-1-org",
        "GitHub App Installation",
        "fail",
        `PXL Classroom Provisioner App is not installed on ${org}.`,
        null,
        {
          type: "link",
          url: "https://github.com/apps/pxl-classroom-provisioner/installations/new",
          label: "Install GitHub App",
        }
      )
    );
  }

  // Check Hub Registry
  if (hubOwner && hubRepo) {
    const orgsRes = await req("GET", `/repos/${hubOwner}/${hubRepo}/contents/participating-orgs.yml?ref=participating-orgs`);
    if (orgsRes.ok) {
      try {
        const raw = orgsRes.data?.content ? atobSafe(orgsRes.data.content) : (orgsRes.data?.raw || "");
        const parsed = parseYaml(raw);
        const entry = (parsed.orgs || []).find((o) => o.login?.toLowerCase() === org.toLowerCase());
        if (entry) {
          addCheck(
            1,
            check(
              "hub-registry",
              "tier-1-org",
              "Course Organization Enrollment (participating-orgs.yml)",
              "ok",
              `Registered in hub (Budget owner: @${entry.budget_owner_login || "unknown"}).`
            )
          );
        } else {
          addCheck(
            1,
            check(
              "hub-registry",
              "tier-1-org",
              "Course Organization Enrollment (participating-orgs.yml)",
              "fail",
              `${org} is missing from participating-orgs.yml. Run Setup Organization to register.`,
              null,
              { type: "setup_org", label: "Run Setup Organization" }
            )
          );
        }
      } catch (e) {
        addCheck(
          1,
          check(
            "hub-registry",
            "tier-1-org",
            "Course Organization Enrollment (participating-orgs.yml)",
            "warn",
            `Could not parse participating-orgs.yml: ${e.message}`
          )
        );
      }
    } else {
      addCheck(
        1,
        check(
          "hub-registry",
          "tier-1-org",
          "Course Organization Enrollment (participating-orgs.yml)",
          "warn",
          "participating-orgs.yml not found on the central hub repository."
        )
      );
    }
  }

  // ---------------------------------------------------------------------------
  // TIER 2: Control Repository Foundation
  // ---------------------------------------------------------------------------
  let controlRepoOk = false;
  const ctrlRes = await req("GET", `/repos/${org}/${CONTROL_REPO}`);
  if (ctrlRes.status === 404) {
    addCheck(
      2,
      check(
        "control-repo",
        "tier-2-control",
        "Control Repository Exists (pxl-classroom-control)",
        "fail",
        `${org}/${CONTROL_REPO} does not exist. Run Setup Organization to initialize your course repository.`,
        null,
        { type: "setup_org", label: "Run Setup Organization" }
      )
    );
  } else if (!ctrlRes.ok) {
    addCheck(
      2,
      check(
        "control-repo",
        "tier-2-control",
        "Control Repository Exists (pxl-classroom-control)",
        "warn",
        `Could not read ${CONTROL_REPO} (HTTP ${ctrlRes.status}).`
      )
    );
  } else {
    if (!ctrlRes.data.private) {
      addCheck(
        2,
        check(
          "control-repo-privacy",
          "tier-2-control",
          "Control Repository Privacy (Private)",
          "fail",
          `${CONTROL_REPO} is public! It must be private to safeguard student rosters and grades.`
        )
      );
    } else {
      controlRepoOk = true;
      addCheck(
        2,
        check(
          "control-repo",
          "tier-2-control",
          "Control Repository Exists & Private",
          "ok",
          `${org}/${CONTROL_REPO} exists and is private.`
        )
      );
    }

    const missingPaths = [];
    for (const p of SCAFFOLD_PATHS) {
      const r = await req("GET", `/repos/${org}/${CONTROL_REPO}/contents/${p}`);
      if (r.status === 404) missingPaths.push(p);
    }
    if (missingPaths.length > 0) {
      addCheck(
        2,
        check(
          "control-scaffold",
          "tier-2-control",
          "Control Repository Scaffold",
          "warn",
          `Missing scaffold directories: ${missingPaths.join(", ")}.`,
          { missing: missingPaths }
        )
      );
    } else {
      addCheck(
        2,
        check(
          "control-scaffold",
          "tier-2-control",
          "Control Repository Scaffold",
          "ok",
          "All standard scaffold folders (assignments, reports, public, etc.) exist."
        )
      );
    }
  }

  // If no specific assignment is targeted, perform Org-level assignments scan
  if (!assignmentId && !formDoc) {
    if (controlRepoOk) {
      const listRes = await req("GET", `/repos/${org}/${CONTROL_REPO}/contents/assignments`);
      if (listRes.ok && Array.isArray(listRes.data)) {
        const ymlFiles = listRes.data.filter((f) => f.name.endsWith(".yml") || f.name.endsWith(".yaml"));
        addCheck(
          3,
          check(
            "assignments-scan",
            "tier-3-assignments-overview",
            "Registered Assignments",
            "ok",
            `Found ${ymlFiles.length} assignment configuration(s) in ${org}/${CONTROL_REPO}.`
          )
        );
      } else {
        addCheck(
          3,
          check(
            "assignments-scan",
            "tier-3-assignments-overview",
            "Registered Assignments",
            "ok",
            "No assignments found in control repository yet."
          )
        );
      }
    }
    return finishDiagnostics(org, assignmentId, tiers, allChecks);
  }

  // ---------------------------------------------------------------------------
  // TIER 3: Assignment Definition & Starter Template
  // ---------------------------------------------------------------------------
  let doc = formDoc ? { ...formDoc } : null;
  if (doc) {
    if (!doc.opens_at && doc.opens_at_local) {
      try { doc.opens_at = new Date(doc.opens_at_local).toISOString(); } catch { /* ignore */ }
    }
    if (!doc.deadline_at && doc.deadline_at_local) {
      try { doc.deadline_at = new Date(doc.deadline_at_local).toISOString(); } catch { /* ignore */ }
    }
  }

  if (!doc && assignmentId) {
    const ymlRes = await req("GET", `/repos/${org}/${CONTROL_REPO}/contents/assignments/${assignmentId}.yml`);
    if (ymlRes.ok) {
      try {
        const raw = ymlRes.data?.content ? atobSafe(ymlRes.data.content) : (ymlRes.data?.raw || "");
        doc = parseYaml(raw);
      } catch (e) {
        addCheck(
          3,
          check(
            "assignment-yaml",
            "tier-3-assignment",
            "Assignment YAML Syntax",
            "fail",
            `assignments/${assignmentId}.yml has syntax errors: ${e.message}`
          )
        );
      }
    } else if (ymlRes.status === 404) {
      addCheck(
        3,
        check(
          "assignment-yaml",
          "tier-3-assignment",
          "Assignment Configuration File",
          "fail",
          `assignments/${assignmentId}.yml not found in control repository.`
        )
      );
    }
  }

  if (doc) {
    const missingFields = [];
    if (!doc.title) missingFields.push("title");

    let tplString = "";
    if (doc.template) {
      if (typeof doc.template === "object" && doc.template.owner && doc.template.repository) {
        tplString = `${doc.template.owner}/${doc.template.repository}`;
      } else if (typeof doc.template === "string") {
        tplString = doc.template;
      }
    }
    if (!tplString) missingFields.push("template");

    if (!doc.repository_name_pattern) missingFields.push("repository_name_pattern");
    if (!doc.opens_at) missingFields.push("opens_at");
    if (!doc.deadline_at) missingFields.push("deadline_at");

    if (missingFields.length > 0) {
      addCheck(
        3,
        check(
          "assignment-fields",
          "tier-3-assignment",
          "Required Assignment Fields",
          "fail",
          `Missing required fields: ${missingFields.join(", ")}.`
        )
      );
    } else {
      addCheck(
        3,
        check(
          "assignment-fields",
          "tier-3-assignment",
          "Assignment Configuration Fields",
          "ok",
          `Title: "${doc.title}", State: "${doc.state || "draft"}".`
        )
      );
    }

    if (tplString && tplString.includes("/")) {
      const [tplOwner, tplRepo] = tplString.split("/");
      const tplRes = await req("GET", `/repos/${tplOwner}/${tplRepo}`);
      if (tplRes.status === 404) {
        addCheck(
          3,
          check(
            "template-repo",
            "tier-3-assignment",
            "Starter Template Repository Exists",
            "fail",
            `Template repository "${tplString}" does not exist on GitHub or is not accessible.`
          )
        );
      } else if (!tplRes.ok) {
        addCheck(
          3,
          check(
            "template-repo",
            "tier-3-assignment",
            "Starter Template Repository Exists",
            "warn",
            `Could not read template repository ${tplString} (HTTP ${tplRes.status}).`
          )
        );
      } else {
        addCheck(
          3,
          check(
            "template-repo",
            "tier-3-assignment",
            "Starter Template Repository Exists",
            "ok",
            `Template "${tplString}" exists and is accessible.`
          )
        );

        if (tplRes.data.is_template === true) {
          addCheck(
            3,
            check(
              "template-is-template",
              "tier-3-assignment",
              "Starter Template Setting (is_template on GitHub)",
              "ok",
              `Repository "${tplString}" is marked as a Template Repository on GitHub.`
            )
          );
        } else {
          addCheck(
            3,
            check(
              "template-is-template",
              "tier-3-assignment",
              "Starter Template Setting (is_template on GitHub)",
              "fail",
              `"${tplString}" exists, but is NOT marked as a Template repository on GitHub. Check "Template repository" under repo Settings.`,
              null,
              {
                type: "mark_template",
                owner: tplOwner,
                repo: tplRepo,
                label: `Mark ${tplRepo} as Template on GitHub`,
              }
            )
          );
        }
      }
    }

    if (doc.roster_mode === "enforced" && assignmentId) {
      const rosterRes = await req("GET", `/repos/${org}/${CONTROL_REPO}/contents/rosters/${assignmentId}.csv`);
      if (rosterRes.status === 404) {
        addCheck(
          3,
          check(
            "roster-check",
            "tier-3-assignment",
            "Enforced Roster File (rosters/<id>.csv)",
            "warn",
            `roster_mode is "enforced", but rosters/${assignmentId}.csv was not found. Students will be blocked until a roster is imported.`,
            null,
            { type: "navigate_roster", label: "Open Roster Editor" }
          )
        );
      } else if (rosterRes.ok) {
        addCheck(
          3,
          check(
            "roster-check",
            "tier-3-assignment",
            "Enforced Roster File (rosters/<id>.csv)",
            "ok",
            `rosters/${assignmentId}.csv exists.`
          )
        );
      }
    }
  }

  // ---------------------------------------------------------------------------
  // TIER 4: Acceptance Broker Infrastructure
  // ---------------------------------------------------------------------------
  const isPublished = doc?.state === "published";
  const brokerName = doc?.broker_repo || (assignmentId ? `broker-${assignmentId}` : null);

  if (brokerName && isPublished) {
    const brokerRes = await req("GET", `/repos/${org}/${brokerName}`);
    if (brokerRes.status === 404) {
      addCheck(
        4,
        check(
          "broker-repo",
          "tier-4-broker",
          "Student Acceptance Broker Repository (broker-<id>)",
          "fail",
          `Student acceptance broker repository "${org}/${brokerName}" does not exist on GitHub. Click below to create it.`,
          null,
          {
            type: "publish_broker",
            label: "Create Broker Repository Now",
          }
        )
      );
    } else if (!brokerRes.ok) {
      addCheck(
        4,
        check(
          "broker-repo",
          "tier-4-broker",
          "Student Acceptance Broker Repository (broker-<id>)",
          "warn",
          `Could not read broker repo ${brokerName} (HTTP ${brokerRes.status}).`
        )
      );
    } else {
      if (brokerRes.data.private === true) {
        addCheck(
          4,
          check(
            "broker-visibility",
            "tier-4-broker",
            "Acceptance Broker Visibility (Public)",
            "fail",
            `"${brokerName}" is currently private. It must be public so students can star it to accept their assignment.`,
            null,
            {
              type: "make_broker_public",
              brokerName,
              label: "Make Broker Public",
            }
          )
        );
      } else {
        addCheck(
          4,
          check(
            "broker-repo",
            "tier-4-broker",
            "Student Acceptance Broker Repository (broker-<id>)",
            "ok",
            `"${org}/${brokerName}" exists and is public.`
          )
        );
      }

      const wfRes = await req("GET", `/repos/${org}/${brokerName}/contents/.github/workflows/acceptance-trigger.yml`);
      if (wfRes.status === 404) {
        addCheck(
          4,
          check(
            "broker-workflow",
            "tier-4-broker",
            "Automated Student Provisioning Workflow (acceptance-trigger.yml)",
            "fail",
            `acceptance-trigger.yml is missing in ${brokerName}. Starring will not trigger automated repository creation.`,
            null,
            {
              type: "publish_broker",
              label: "Republish Provisioning Workflow",
            }
          )
        );
      } else if (wfRes.ok) {
        addCheck(
          4,
          check(
            "broker-workflow",
            "tier-4-broker",
            "Automated Student Provisioning Workflow (acceptance-trigger.yml)",
            "ok",
            "acceptance-trigger.yml provisioning workflow is active."
          )
        );
      }
    }
  } else if (!isPublished) {
    addCheck(
      4,
      check(
        "broker-repo",
        "tier-4-broker",
        "Student Acceptance Broker Repository (broker-<id>)",
        "info",
        `Assignment is in draft mode. Broker repository (${brokerName || "broker-<id>"}) will be created automatically when published.`
      )
    );
  }

  // ---------------------------------------------------------------------------
  // TIER 5: Student Portal & Pages Edge
  // ---------------------------------------------------------------------------
  if (assignmentId && isPublished) {
    const ctlPublicRes = await req("GET", `/repos/${org}/${CONTROL_REPO}/contents/public/assignments.json`);
    let inControlPublic = false;
    if (ctlPublicRes.ok) {
      try {
        const raw = ctlPublicRes.data?.content ? atobSafe(ctlPublicRes.data.content) : (ctlPublicRes.data?.raw || "{}");
        const json = JSON.parse(raw);
        if (json?.assignments?.[assignmentId]) inControlPublic = true;
      } catch {
        // ignore
      }
    }

    if (inControlPublic) {
      addCheck(
        5,
        check(
          "control-public-data",
          "tier-5-pages",
          "Compiled Assignment Public Index (public/assignments.json)",
          "ok",
          `Assignment "${assignmentId}" is compiled in ${CONTROL_REPO}:public/assignments.json.`
        )
      );
    } else {
      addCheck(
        5,
        check(
          "control-public-data",
          "tier-5-pages",
          "Compiled Assignment Public Index (public/assignments.json)",
          "warn",
          `Assignment is not yet compiled in ${CONTROL_REPO}:public/assignments.json. Run Regenerate Dashboard or Publish.`,
          null,
          {
            type: "regen_dashboard",
            label: "Regenerate Public Dashboard Index",
          }
        )
      );
    }

    if (fetchPages) {
      try {
        const pagesData = await fetchPages(org);
        if (pagesData?.assignments?.[assignmentId]) {
          addCheck(
            5,
            check(
              "pages-live-cdn",
              "tier-5-pages",
              "Student Portal CDN Verification",
              "ok",
              "Live student accept portal is verified on GitHub Pages. Student link is active."
            )
          );
        } else {
          addCheck(
            5,
            check(
              "pages-live-cdn",
              "tier-5-pages",
              "Student Portal CDN Verification",
              "warn",
              "GitHub Pages CDN has not yet received this assignment update. Propagating (~1 to 2 min).",
              null,
              {
                type: "deploy_pages",
                label: "Deploy to GitHub Pages",
              }
            )
          );
        }
      } catch {
        addCheck(
          5,
          check(
            "pages-live-cdn",
            "tier-5-pages",
            "Student Portal CDN Verification",
            "warn",
            "Could not query live GitHub Pages endpoint."
          )
        );
      }
    }
  }

  return finishDiagnostics(org, assignmentId, tiers, allChecks);
}

function finishDiagnostics(org, assignmentId, tiers, allChecks) {
  const overall = allChecks.reduce((acc, c) => worse(acc, c.severity), "ok");
  return {
    schema_version: 1,
    org,
    assignment_id: assignmentId,
    generated_at: new Date().toISOString(),
    overall,
    tiers,
    checks: allChecks,
  };
}
