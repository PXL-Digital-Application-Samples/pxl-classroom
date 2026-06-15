#!/usr/bin/env node
// PXL Classroom — acceptance handler.
//
// Runs in the private control repo, triggered by repository_dispatch from the
// public broker.  Validates the dispatch payload, checks assignment guardrails
// (open window, per-assignment cap), and records the acceptance.
//
// Inputs via env:  ASSIGNMENT_ID, GITHUB_LOGIN, GITHUB_ID, WORKFLOW_RUN_URL,
//                  ORG, CONTROL_REPO, DATA_DIR
// Outputs via GITHUB_OUTPUT:  assignment_id, github_login, github_id, outcome,
//                              target_repo

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { loadYaml } from "../lib/yaml.mjs";

const env = (k, d) => process.env[k] ?? d;

// --- Actions output / summary helpers ----------------------------------------
async function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT)
    await appendFile(process.env.GITHUB_OUTPUT, `${name}=${value ?? ""}\n`);
}
async function summary(md) {
  if (process.env.GITHUB_STEP_SUMMARY)
    await appendFile(process.env.GITHUB_STEP_SUMMARY, md + "\n");
}
const log = (step, detail) =>
  console.log(
    `[${detail.ok === false ? "FAIL" : "ok"}] ${step}${detail.note ? ` — ${detail.note}` : ""}`
  );

async function fail(category, note) {
  log(category, { ok: false, note });
  await setOutput("outcome", category);
  await summary(`### Acceptance FAILED: \`${category}\`\n\n${note ?? ""}`);
  process.exit(1);
}

// --- Strict input validation -------------------------------------------------
const SLUG = /^[a-z0-9][a-z0-9-]{0,99}$/;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

function validate(assignmentId, login, id) {
  if (!assignmentId) return "assignment_id is missing from dispatch payload";
  if (!SLUG.test(assignmentId))
    return `assignment_id="${assignmentId}" is not a valid slug`;
  if (!login) return "github_login is missing from dispatch payload";
  if (!LOGIN.test(login))
    return `github_login="${login}" is not a valid GitHub login`;
  if (!id || isNaN(Number(id)))
    return `github_id="${id}" is missing or not a number`;
  return null;
}

async function main() {
  const assignmentId = env("ASSIGNMENT_ID");
  const login = env("GITHUB_LOGIN");
  const githubId = env("GITHUB_ID");
  const workflowRunUrl = env("WORKFLOW_RUN_URL", "");
  const org = env("ORG");
  const dataDir = env("DATA_DIR", ".");

  // 1. Validate inputs
  const bad = validate(assignmentId, login, githubId);
  if (bad) await fail("fail:validation", bad);
  log("validate", { ok: true, note: `${assignmentId} / ${login} / ${githubId}` });

  // 2. Load assignment definition
  const assignmentPath = join(dataDir, "assignments", `${assignmentId}.yml`);
  if (!existsSync(assignmentPath))
    await fail("rejected:no-assignment", `assignment file not found: ${assignmentPath}`);

  const assignment = await loadYaml(assignmentPath);
  log("assignment", { ok: true, note: `state=${assignment.state} title="${assignment.title}"` });

  // 3. Check assignment state
  if (assignment.state !== "published")
    await fail("rejected:not-published", `assignment state is "${assignment.state}", not "published"`);

  // 4. Check open window (guardrail)
  const now = new Date();
  if (assignment.opens_at) {
    const opens = new Date(assignment.opens_at);
    if (now < opens)
      await fail("rejected:not-open", `assignment opens at ${assignment.opens_at}, current time is ${now.toISOString()}`);
  }
  if (assignment.deadline_at) {
    const deadline = new Date(assignment.deadline_at);
    if (now > deadline)
      await fail("rejected:past-deadline", `assignment deadline was ${assignment.deadline_at}, current time is ${now.toISOString()}`);
  }
  log("window", { ok: true, note: `within open window` });

  // 5. Check idempotency — already accepted?
  const acceptDir = join(dataDir, "acceptances", assignmentId);
  const acceptFile = join(acceptDir, `${login}.json`);
  if (existsSync(acceptFile)) {
    const existing = JSON.parse(await readFile(acceptFile, "utf-8"));
    log("idempotent", { ok: true, note: `already accepted at ${existing.accepted_at}` });

    await setOutput("assignment_id", assignmentId);
    await setOutput("github_login", login);
    await setOutput("github_id", githubId);
    await setOutput("outcome", "already-accepted");
    await setOutput("target_repo", deriveRepoName(assignment.repository_name_pattern, login));
    await summary(`### Acceptance: \`already-accepted\`\n\n${login} already accepted ${assignmentId}.`);
    process.exit(0);
  }

  // 6. Check per-assignment cap (guardrail)
  const maxAcceptances = assignment.max_acceptances;
  if (maxAcceptances) {
    let currentCount = 0;
    if (existsSync(acceptDir)) {
      const files = await readdir(acceptDir);
      currentCount = files.filter((f) => f.endsWith(".json")).length;
    }
    if (currentCount >= maxAcceptances)
      await fail(
        "rejected:cap-reached",
        `per-assignment cap reached (${currentCount}/${maxAcceptances}). Acceptance queued for lecturer review.`
      );
    log("cap", { ok: true, note: `${currentCount + 1}/${maxAcceptances}` });
  }

  // 7. Derive deterministic repo name
  const targetRepo = deriveRepoName(assignment.repository_name_pattern, login);
  log("repo-name", { ok: true, note: targetRepo });

  // 8. Record acceptance
  await mkdir(acceptDir, { recursive: true });
  const record = {
    schema_version: 1,
    assignment_id: assignmentId,
    github_login: login,
    github_id: Number(githubId),
    accepted_at: now.toISOString(),
    star_event_ref: workflowRunUrl || null,
    status: "accepted",
  };
  await writeFile(acceptFile, JSON.stringify(record, null, 2) + "\n");
  log("record", { ok: true, note: `wrote ${acceptFile}` });

  // 9. Set outputs
  await setOutput("assignment_id", assignmentId);
  await setOutput("github_login", login);
  await setOutput("github_id", githubId);
  await setOutput("outcome", "accepted");
  await setOutput("target_repo", targetRepo);

  await summary(
    `### Acceptance: \`accepted\`\n\n` +
      `| field | value |\n|---|---|\n` +
      `| assignment | ${assignmentId} |\n| student | ${login} (id ${githubId}) |\n` +
      `| repo | ${org}/${targetRepo} |\n| time | ${now.toISOString()} |\n`
  );
  log("done", { ok: true, note: "accepted" });
}

function deriveRepoName(pattern, login) {
  if (!pattern) return login;
  return pattern.replace("{github_login}", login);
}

main().catch(async (e) => {
  await fail("fail:exception", e.message);
});
