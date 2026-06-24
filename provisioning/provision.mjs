#!/usr/bin/env node
// PXL Classroom — production provisioner.
//
// Creates a private org repo from a private template, grants a student a role
// (default admin), records the immutable repo ID, and is idempotent: a re-run
// reuses the existing repo instead of creating a duplicate.
//
// Auth: GITHUB_TOKEN must be a GitHub App INSTALLATION token (minted by the
// composite action via actions/create-github-app-token). Inputs come from env.
// Emits GitHub Actions outputs (repo_id, repo_url, repo_name, outcome) and a
// step summary. No npm dependencies (Node 18+ fetch).

import { appendFile } from "node:fs/promises";
import { gh } from "../lib/gh.mjs";

const env = (k, d) => process.env[k] ?? d;
const cfg = {
  token: env("GITHUB_TOKEN"),
  org: env("ORG"),
  templateOwner: env("TEMPLATE_OWNER"),
  templateRepo: env("TEMPLATE_REPO"),
  targetRepo: env("TARGET_REPO"),
  studentLogin: env("STUDENT_LOGIN"),
  permission: env("STUDENT_PERMISSION", "admin"),
  isPrivate: env("PRIVATE", "true") !== "false",
  dryRun: env("DRY_RUN", "0") === "1",
  feedbackPr: env("FEEDBACK_PR", "false") === "true",
  baselineBranch: env("FEEDBACK_PR_BASELINE_BRANCH", "pxl-baseline"),
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
const log = (step, detail) => { steps.push({ step, ...detail }); console.log(`[${detail.ok === false ? "FAIL" : "ok"}] ${step}${detail.note ? ` — ${detail.note}` : ""}`); };

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
// at the same SHA — GitHub returns 422 "No commits between …". The PR is
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
  log("idempotency", { ok: existing.status === 200 || existing.status === 404, note: alreadyExists ? `exists id=${existing.data.id} — reuse` : "absent — create" });

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
    `| repo | ${repo?.full_name ?? "(dry-run)"} |\n| id | ${repo?.id ?? "—"} |\n` +
    `| student | ${cfg.studentLogin} (${cfg.permission}) |\n| template | ${cfg.templateOwner}/${cfg.templateRepo} |\n`
  );
  log("done", { ok: true, note: outcome });
  process.exit(0);
}

main().catch(async (e) => { await fail("fail:exception", e.message); });
