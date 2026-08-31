#!/usr/bin/env node
// PXL Classroom - production provisioner.
//
// Creates a private org repo from a private template, grants a student a role
// (default admin), records the immutable repo ID, and is idempotent: a re-run
// reuses the existing repo instead of creating a duplicate.
//
// Auth: GITHUB_TOKEN must be a GitHub App INSTALLATION token (minted by the
// composite action via actions/create-github-app-token). Inputs come from env.
// Emits GitHub Actions outputs (repo_id, repo_url, repo_name, outcome) and a
// step summary. No npm dependencies (Node 18+ fetch).

import { appendFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { gh } from "../lib/gh.mjs";
import { parse, stringify as stringifyYaml } from "yaml";
import { CONTROL_REPO } from "../lib/deployment.mjs";

const env = (k, d) => process.env[k] ?? d;
const cfg = {
  token: env("GITHUB_TOKEN"),
  org: env("ORG"),
  templateOwner: env("TEMPLATE_OWNER"),
  templateRepo: env("TEMPLATE_REPO"),
  targetRepo: env("TARGET_REPO"),
  assignmentId: env("ASSIGNMENT_ID"),
  studentLogin: env("STUDENT_LOGIN"),
  permission: env("STUDENT_PERMISSION", "admin"),
  isPrivate: env("PRIVATE", "true") !== "false",
  dryRun: env("DRY_RUN", "0") === "1",
  feedbackPr: env("FEEDBACK_PR", "false") === "true",
  baselineBranch: env("FEEDBACK_PR_BASELINE_BRANCH", "pxl-baseline"),
  previousRepo: env("PREVIOUS_REPO", ""),
  apiBase: env("GITHUB_API_URL", "https://api.github.com"),
};

// --- Actions output / summary helpers --------------------------------------
async function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `${name}=${value ?? ""}\n`);
}
async function summary(md) {
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, md + "\n");
}
const steps = [];
const log = (step, detail) => { steps.push({ step, ...detail }); console.log(`[${detail.ok === false ? "FAIL" : "ok"}] ${step}${detail.note ? ` - ${detail.note}` : ""}`); };

async function fail(category, note) {
  log(category, { ok: false, note });
  await setOutput("outcome", category);
  await summary(`### Provisioning FAILED: \`${category}\`\n\n${note ?? ""}`);
  process.exit(1);
}

// --- Strict input validation (security requirement) -------------------------
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;          // org / repo names
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;        // GitHub login
const PERMS = ["pull", "triage", "push", "maintain", "admin"];
const BRANCH = /^[A-Za-z0-9._/-]{1,100}$/;                  // baseline branch name

function validate() {
  if (!cfg.token) return "GITHUB_TOKEN is required (App installation token)";
  for (const [k, v] of [["ORG", cfg.org], ["TEMPLATE_OWNER", cfg.templateOwner], ["TEMPLATE_REPO", cfg.templateRepo], ["TARGET_REPO", cfg.targetRepo]]) {
    if (!v) return `${k} is required`;
    if (!NAME.test(v)) return `${k}="${v}" is not a valid GitHub name`;
  }
  if (!LOGIN.test(cfg.studentLogin || "")) return `STUDENT_LOGIN="${cfg.studentLogin}" is not a valid GitHub login`;
  if (!PERMS.includes(cfg.permission)) return `STUDENT_PERMISSION="${cfg.permission}" must be one of ${PERMS.join(", ")}`;
  if (cfg.feedbackPr && !BRANCH.test(cfg.baselineBranch)) return `FEEDBACK_PR_BASELINE_BRANCH="${cfg.baselineBranch}" is not a valid branch name`;
  return null;
}

// --- Feedback-PR: baseline branch + protection ------------------------------
//
// Creates a frozen branch (idempotent) pointing at the repo's default-branch
// HEAD and protects it against force-push/delete. The Feedback PR itself
// cannot be opened at provisioning time because main and the baseline point
// at the same SHA - GitHub returns 422 "No commits between …". The PR is
// opened lazily by `pxl-classroom feedback open` once the student has pushed.
async function setupFeedbackBaseline(repo) {
  const branch = cfg.baselineBranch;
  const defaultBranch = repo.default_branch || "main";

  const head = await gh("GET", `/repos/${cfg.org}/${cfg.targetRepo}/git/ref/heads/${defaultBranch}`);
  if (!head.ok) { log("feedback-baseline", { ok: false, note: `read ${defaultBranch} HTTP ${head.status}` }); return null; }
  const sha = head.data.object.sha;

  const exists = await gh("GET", `/repos/${cfg.org}/${cfg.targetRepo}/git/ref/heads/${branch}`);
  if (exists.status === 404) {
    const make = await gh("POST", `/repos/${cfg.org}/${cfg.targetRepo}/git/refs`, {
      ref: `refs/heads/${branch}`, sha,
    });
    if (!make.ok) { log("feedback-baseline", { ok: false, note: `create ${branch} HTTP ${make.status}` }); return null; }
    log("feedback-baseline", { ok: true, note: `created ${branch}@${sha.slice(0, 12)}` });
  } else if (exists.ok) {
    log("feedback-baseline", { ok: true, note: `${branch} already exists @${exists.data.object.sha.slice(0, 12)}` });
  }

  // Protection: only the fields we care about; the App's admin role outranks
  // student admin so the student cannot force-push or delete the baseline.
  const prot = await gh("PUT", `/repos/${cfg.org}/${cfg.targetRepo}/branches/${encodeURIComponent(branch)}/protection`, {
    required_status_checks: null,
    enforce_admins: false,
    required_pull_request_reviews: null,
    restrictions: null,
    allow_force_pushes: false,
    allow_deletions: false,
  });
  if (!prot.ok) {
    log("feedback-baseline-protect", { ok: false, note: `protect HTTP ${prot.status} ${prot.data?.message ?? ""}` });
  } else {
    log("feedback-baseline-protect", { ok: true, note: `protected ${branch}` });
  }
  return sha;
}

// Built as an object and serialised by the YAML library, never by string
// concatenation.
//
// The previous version pasted lecturer-authored test config straight into a
// YAML template: `command: "${t.command}"`. A command containing a double quote
// - `grep "needle" file` - closed the string early and produced a workflow that
// does not parse, in EVERY student repository, discovered by the student when
// their grading run goes red. A colon in an id did the same to `- name:`. There
// is no escaping to get right if nothing is concatenated.
export function buildAutogradingWorkflow(assignment, org) {
  const shell = {
    name: "Autograding",
    on: { push: { branches: ["main"] } },
    concurrency: { group: "autograde-${{ github.ref }}", "cancel-in-progress": true },
  };

  const isPublic = assignment?.autograde?.visibility === "public";
  if (!isPublic) {
    return stringifyYaml({
      ...shell,
      jobs: { grade: { uses: `${org}/${CONTROL_REPO}/.github/workflows/grade.yml@main` } },
    });
  }

  const tests = assignment?.autograde?.tests || [];
  if (tests.length === 0) {
    // Public visibility with no checks used to emit `run: npm test` - a
    // hardcoded guess at the student's toolchain, reported as this
    // assignment's grade in every repository. `tests` has `minItems: 1` and the
    // Admin Panel can no longer produce an enabled-but-empty configuration
    // (ARCHITECTURE §11.6), so this is now only reachable from a hand-written YAML
    // the schema would reject - and a guess was never a defensible default
    // there either. A job that does nothing is honest; a job that runs someone
    // else's test command and calls the result a grade is not.
    return stringifyYaml({
      ...shell,
      jobs: {
        grade: {
          "runs-on": "ubuntu-latest",
          "timeout-minutes": 10,
          steps: [
            {
              name: "No checks configured",
              run: "echo 'This assignment has autograding enabled but defines no checks.' >&2\nexit 1",
            },
          ],
        },
      },
    });
  }

  // v4 runs on Node 20, which GitHub has deprecated - every student's grading
  // run carried a warning annotation saying so, measured live 2026-08-26. A
  // FLOATING major here, unlike the hub's pinned SHAs: this workflow is written
  // into every student repository, so a pin freezes hundreds of copies at a
  // commit somebody has to remember to bump, and those repos hold no credential
  // beyond their own GITHUB_TOKEN. The classroom-resources graders below are
  // still v1 and still on Node 20 - upstream has published nothing newer, so
  // that warning is not ours to remove.
  const steps = [{ name: "Checkout code", uses: "actions/checkout@v7" }];
  const runnerIds = [];
  const env = {};

  for (const t of tests) {
    const runnerId = String(t.id || "test").toLowerCase().replace(/[^a-z0-9_-]/g, "-");
    runnerIds.push(runnerId);
    // Two ids differing only by `-` vs `_` collapsed onto one env key, so one
    // test's results silently replaced the other's in the reporter. Suffix the
    // collisions rather than losing a result.
    let envKey = `${runnerId.toUpperCase().replace(/[^A-Z0-9_]/g, "_")}_RESULTS`;
    for (let n = 2; envKey in env; n++) envKey = `${envKey.replace(/_RESULTS$/, "")}_${n}_RESULTS`;
    env[envKey] = `\${{ steps.${runnerId}.outputs.result }}`;

    const common = { name: String(t.id ?? "test"), id: runnerId };
    if (t.type === "io") {
      steps.push({
        ...common,
        uses: "classroom-resources/autograding-io-grader@v1",
        with: {
          "test-name": String(t.id ?? "test"),
          command: t.command || "",
          input: t.stdin || "",
          "expected-output": t.expected_stdout || "",
          "comparison-method": "included",
          timeout: t.timeout_s || 10,
          "max-score": t.points || 1,
        },
      });
    } else if (t.type === "python") {
      // `script` is the ONLY field a python test reads, here and on both CLI
      // runners (`runner-host.mjs` and `runner-docker.mjs` each write it to
      // `t.py` and run `python3` over it). This used to emit
      // `t.command || "pytest"` and ignore `script` entirely - and the Admin
      // Panel only ever writes `script` - so the same test definition meant the
      // lecturer's script on the CLI and the student repo's own pytest suite on
      // Actions. The schema now requires `script` for `type: python`, so there
      // is no second field left to disagree about.
      //
      // The script reaches the file through `env:`, never through the run text.
      // Pasting it in is F15 again: the first quote in a lecturer's source
      // closes the string and every student's workflow stops parsing.
      const scriptPath = `.pxl-autograde/${runnerId}.py`;
      steps.push({
        name: `Write ${runnerId} script`,
        run: `mkdir -p .pxl-autograde\nprintf '%s' "$PXL_SCRIPT" > "$PXL_SCRIPT_PATH"\n`,
        env: { PXL_SCRIPT: String(t.script ?? ""), PXL_SCRIPT_PATH: scriptPath },
      });
      steps.push({
        ...common,
        uses: "classroom-resources/autograding-python-grader@v1",
        with: {
          "test-name": String(t.id ?? "test"),
          // The CLI runners install nothing before running the script, so
          // neither does this. `setup_command` was read here and is not a
          // schema field - `additionalProperties: false` means it could never
          // legitimately arrive.
          "setup-command": "",
          command: `python3 ${scriptPath}`,
          timeout: t.timeout_s || 10,
          "max-score": t.points || 1,
        },
      });
    } else {
      steps.push({
        ...common,
        uses: "classroom-resources/autograding-command-grader@v1",
        with: {
          "test-name": String(t.id ?? "test"),
          command: t.command || "exit 0",
          timeout: t.timeout_s || 10,
          "max-score": t.points || 1,
        },
      });
    }
  }

  steps.push({
    name: "Autograding Reporter",
    uses: "classroom-resources/autograding-grading-reporter@v1",
    env,
    with: { runners: runnerIds.join(",") },
  });

  return stringifyYaml({
    ...shell,
    jobs: { grade: { "runs-on": "ubuntu-latest", "timeout-minutes": 10, steps } },
  });
}

async function injectAutogradingWorkflow(assignment) {
  // Check if template repository already supplied an autograding workflow
  const checkAutograde = await gh("GET", `/repos/${cfg.org}/${cfg.targetRepo}/contents/.github/workflows/autograding.yml`);
  const checkClassroom = await gh("GET", `/repos/${cfg.org}/${cfg.targetRepo}/contents/.github/workflows/classroom.yml`);
  if (checkAutograde.status === 200 || checkClassroom.status === 200) {
    log("inject-autograding", { ok: true, note: "workflow already present from template - skipping injection" });
    return;
  }

  const content = buildAutogradingWorkflow(assignment, cfg.org);
  const b64 = Buffer.from(content).toString("base64");
  const res = await gh("PUT", `/repos/${cfg.org}/${cfg.targetRepo}/contents/.github/workflows/autograding.yml`, {
    message: "Add autograding workflow",
    content: b64
  });
  if (!res.ok) {
    log("inject-autograding", { ok: false, note: `failed to inject workflow HTTP ${res.status}` });
  } else {
    log("inject-autograding", { ok: true, note: "injected .github/workflows/autograding.yml" });
  }
}

async function main() {
  const bad = validate();
  if (bad) await fail("fail:validation", bad);

  // 1. Token live (App installation tokens have no /user; /rate_limit works).
  const ping = await gh("GET", "/rate_limit");
  if (!ping.ok) await fail("fail:auth", `token rejected (HTTP ${ping.status})`);
  log("auth", { ok: true, note: "installation token accepted" });

  // 2. Validate template.
  const tpl = await gh("GET", `/repos/${cfg.templateOwner}/${cfg.templateRepo}`);
  if (!tpl.ok) await fail("fail:template-missing", `template ${cfg.templateOwner}/${cfg.templateRepo} HTTP ${tpl.status}`);
  if (!tpl.data.is_template) await fail("fail:not-a-template", `${cfg.templateOwner}/${cfg.templateRepo} is not a template repository`);
  log("template", { ok: true, note: `private=${tpl.data.private} is_template=true` });

  // 3. Idempotency: existing repo?
  const existing = await gh("GET", `/repos/${cfg.org}/${cfg.targetRepo}`);
  const alreadyExists = existing.status === 200;
  log("idempotency", { ok: existing.status === 200 || existing.status === 404, note: alreadyExists ? `exists id=${existing.data.id} - reuse` : "absent - create" });

  // 4. Create from template (skip if exists / dry-run).
  let repo = alreadyExists ? existing.data : null;
  if (!alreadyExists && !cfg.dryRun) {
    const gen = await gh("POST", `/repos/${cfg.templateOwner}/${cfg.templateRepo}/generate`, {
      owner: cfg.org, name: cfg.targetRepo, private: cfg.isPrivate, include_all_branches: false,
    });
    if (!gen.ok) await fail("fail:create", `generate HTTP ${gen.status} ${gen.data?.message ?? ""}`);
    repo = gen.data;
    log("create", { ok: true, note: `id=${repo.id} ${repo.html_url}` });
  }

  // 5. Grant the student their role (skip in dry-run).
  if (!cfg.dryRun) {
    const add = await gh("PUT", `/repos/${cfg.org}/${cfg.targetRepo}/collaborators/${cfg.studentLogin}`, { permission: cfg.permission });
    if (!(add.status === 201 || add.status === 204)) await fail("fail:grant", `grant HTTP ${add.status} ${add.data?.message ?? ""}`);
    log("grant", { ok: true, note: add.status === 201 ? `invitation created (${cfg.permission})` : `already a collaborator (${cfg.permission})` });

    // 5.1 If student switched teams, remove collaborator access and cancel pending invitations on previous repository
    if (cfg.previousRepo && cfg.previousRepo !== cfg.targetRepo) {
      const prevRepoName = cfg.previousRepo.split("/").pop();
      const remove = await gh("DELETE", `/repos/${cfg.org}/${prevRepoName}/collaborators/${cfg.studentLogin}`);
      log("remove-old-collab", { ok: remove.ok || remove.status === 404, note: `removed from ${prevRepoName} (HTTP ${remove.status})` });

      // Also clean up any pending invitations for this student on the old repo
      try {
        const invRes = await gh("GET", `/repos/${cfg.org}/${prevRepoName}/invitations`);
        if (invRes.ok && Array.isArray(invRes.data)) {
          const pendingInv = invRes.data.find((inv) => inv.invitee?.login?.toLowerCase() === cfg.studentLogin.toLowerCase());
          if (pendingInv) {
            const cancelRes = await gh("DELETE", `/repos/${cfg.org}/${prevRepoName}/invitations/${pendingInv.id}`);
            log("cancel-old-invitation", { ok: cancelRes.ok || cancelRes.status === 404, note: `cancelled invitation #${pendingInv.id} on ${prevRepoName}` });
          }
        }
      } catch (e) {
        log("cancel-old-invitation", { ok: false, note: `non-critical invitation check error: ${e.message}` });
      }
    }
  }

  // 5.5 Inject Autograding workflow if github_actions
  if (!cfg.dryRun && repo && cfg.assignmentId) {
    try {
      const yamlStr = await readFile(`control/assignments/${cfg.assignmentId}.yml`, "utf-8");
      const assignment = parse(yamlStr);
      if (assignment?.autograde?.enabled && assignment.autograde.execution_environment === "github_actions") {
        await injectAutogradingWorkflow(assignment);
      }
    } catch (e) {
      log("inject-autograding", { ok: false, note: `failed to read assignment config: ${e.message}` });
    }
  }

  // 6. Optional Feedback-PR scaffold: baseline branch + protection. PR open
  //    is deferred to `pxl-classroom feedback open` once student commits land.
  let baselineSha = "";
  if (cfg.feedbackPr && !cfg.dryRun && repo) {
    baselineSha = (await setupFeedbackBaseline(repo)) || "";
  }

  const outcome = cfg.dryRun ? "dry-run:ok" : alreadyExists ? "reused" : "created";
  await setOutput("repo_id", repo?.id ?? "");
  await setOutput("repo_url", repo?.html_url ?? "");
  await setOutput("repo_name", repo?.full_name ?? "");
  await setOutput("outcome", outcome);
  await setOutput("baseline_sha", baselineSha);
  await summary(
    `### Provisioning: \`${outcome}\`\n\n` +
    `| field | value |\n|---|---|\n` +
    `| repo | ${repo?.full_name ?? "(dry-run)"} |\n| id | ${repo?.id ?? "-"} |\n` +
    `| student | ${cfg.studentLogin} (${cfg.permission}) |\n| template | ${cfg.templateOwner}/${cfg.templateRepo} |\n`
  );
  log("done", { ok: true, note: outcome });
  process.exit(0);
}

const isMain = process.argv[1] && (resolve(process.argv[1]) === fileURLToPath(import.meta.url) || resolve(process.argv[1]).endsWith("provision.mjs"));
if (isMain) {
  main().catch(async (e) => { await fail("fail:exception", e.message); });
}
