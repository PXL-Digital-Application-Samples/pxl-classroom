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

function validate() {
  if (!cfg.token) return "GITHUB_TOKEN is required (App installation token)";
  for (const [k, v] of [["ORG", cfg.org], ["TEMPLATE_OWNER", cfg.templateOwner], ["TEMPLATE_REPO", cfg.templateRepo], ["TARGET_REPO", cfg.targetRepo]]) {
    if (!v) return `${k} is required`;
    if (!NAME.test(v)) return `${k}="${v}" is not a valid GitHub name`;
  }
  if (!LOGIN.test(cfg.studentLogin || "")) return `STUDENT_LOGIN="${cfg.studentLogin}" is not a valid GitHub login`;
  if (!PERMS.includes(cfg.permission)) return `STUDENT_PERMISSION="${cfg.permission}" must be one of ${PERMS.join(", ")}`;
  return null;
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

  const outcome = cfg.dryRun ? "dry-run:ok" : alreadyExists ? "reused" : "created";
  await setOutput("repo_id", repo?.id ?? "");
  await setOutput("repo_url", repo?.html_url ?? "");
  await setOutput("repo_name", repo?.full_name ?? "");
  await setOutput("outcome", outcome);
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
