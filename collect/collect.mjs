#!/usr/bin/env node
// PXL Classroom — submission ref snapshot collector.
//
// Reads repository records for an assignment, snapshots each student's
// submission ref HEAD SHA, and writes observation files. Continues on
// per-student errors. No npm dependencies (Node 18+ fetch).

import { appendFile, readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { loadYaml } from "../lib/yaml.mjs";
import { gh } from "../lib/gh.mjs";

const env = (k, d) => process.env[k] ?? d;
const cfg = {
  token: env("GITHUB_TOKEN"),
  org: env("ORG"),
  assignmentId: env("ASSIGNMENT_ID"),
  dataDir: env("DATA_DIR"),
  apiBase: env("GITHUB_API_URL", "https://api.github.com"),
  runUrl: `${env("GITHUB_SERVER_URL", "https://github.com")}/${env("GITHUB_REPOSITORY", "_")}` +
          `/actions/runs/${env("GITHUB_RUN_ID", "0")}`,
};

// --- Actions output / summary helpers ----------------------------------------
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
  await summary(`### Collect FAILED: \`${category}\`\n\n${note ?? ""}`);
  process.exit(1);
}

// --- Strict input validation -------------------------------------------------
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,99}$/;
const PATH = /^[A-Za-z0-9._/\\:-]+$/;

function validate() {
  if (!cfg.token) return "GITHUB_TOKEN is required (App installation token)";
  if (!cfg.org || !NAME.test(cfg.org)) return `ORG="${cfg.org}" is not a valid GitHub name`;
  if (!cfg.assignmentId || !SLUG.test(cfg.assignmentId)) return `ASSIGNMENT_ID="${cfg.assignmentId}" is not a valid slug`;
  if (!cfg.dataDir || !PATH.test(cfg.dataDir)) return `DATA_DIR="${cfg.dataDir}" is not a valid path`;
  return null;
}

// --- Read assignment definition ----------------------------------------------
async function readAssignment() {
  for (const ext of ["yml", "yaml"]) {
    try {
      return await loadYaml(join(cfg.dataDir, "assignments", `${cfg.assignmentId}.${ext}`));
    } catch { /* try next extension */ }
  }
  try {
    const raw = await readFile(join(cfg.dataDir, "assignments", `${cfg.assignmentId}.json`), "utf8");
    return JSON.parse(raw);
  } catch { return null; }
}

// --- Read repository records -------------------------------------------------
async function readRepoRecords() {
  const dir = join(cfg.dataDir, "repositories", cfg.assignmentId);
  let files;
  try { files = await readdir(dir); } catch { return []; }
  const records = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      records.push(JSON.parse(await readFile(join(dir, f), "utf8")));
    } catch (e) {
      log(`read ${f}`, { ok: false, note: e.message });
    }
  }
  return records;
}

// --- Main --------------------------------------------------------------------
async function main() {
  const bad = validate();
  if (bad) await fail("fail:validation", bad);

  // 1. Auth check
  const ping = await gh("GET", "/rate_limit");
  if (!ping.ok) await fail("fail:auth", `token rejected (HTTP ${ping.status})`);
  log("auth", { ok: true, note: "installation token accepted" });

  // 2. Read assignment
  const assignment = await readAssignment();
  if (!assignment) await fail("fail:assignment", `no assignment file for "${cfg.assignmentId}"`);
  const submissionRef = assignment.submission_ref || "refs/heads/main";
  log("assignment", { ok: true, note: `submission_ref=${submissionRef}` });

  // 3. Read repo records
  const records = await readRepoRecords();
  if (records.length === 0) await fail("fail:no-repos", `no repository records in repositories/${cfg.assignmentId}/`);
  log("repo-records", { ok: true, note: `${records.length} student(s)` });

  // 4. Snapshot each repo
  let collectedCount = 0;
  let errorCount = 0;
  const rows = [];

  for (const rec of records) {
    const login = rec.github_login;
    const repoName = rec.repo_name?.split("/")?.[1] ?? rec.repo_name;
    try {
      // Get default branch
      const repoRes = await gh("GET", `/repos/${cfg.org}/${repoName}`);
      if (!repoRes.ok) {
        log(`snapshot ${login}`, { ok: false, note: `repo HTTP ${repoRes.status}` });
        errorCount++;
        rows.push(`| ${login} | — | error (repo ${repoRes.status}) |`);
        continue;
      }

      // Resolve the branch from the submission ref
      const branch = submissionRef.startsWith("refs/heads/")
        ? submissionRef.slice("refs/heads/".length)
        : repoRes.data.default_branch;

      // Get head commit SHA
      const commitRes = await gh("GET", `/repos/${cfg.org}/${repoName}/commits/${branch}`);
      if (!commitRes.ok) {
        log(`snapshot ${login}`, { ok: false, note: `commit HTTP ${commitRes.status}` });
        errorCount++;
        rows.push(`| ${login} | — | error (commit ${commitRes.status}) |`);
        continue;
      }

      const now = new Date().toISOString();
      const observation = {
        schema_version: 1,
        assignment_id: cfg.assignmentId,
        github_login: login,
        repo_id: repoRes.data.id,
        observed_at: now,
        ref: submissionRef,
        sha: commitRes.data.sha,
        observer_run: cfg.runUrl,
        collection_type: "scheduled",
      };

      // Write observation file
      const safeTs = now.replace(/[:.]/g, "-");
      const obsDir = join(cfg.dataDir, "observations", cfg.assignmentId, login);
      const obsPath = join(obsDir, `${safeTs}.json`);
      await mkdir(obsDir, { recursive: true });
      await writeFile(obsPath, JSON.stringify(observation, null, 2) + "\n");

      log(`snapshot ${login}`, { ok: true, note: `${branch}@${commitRes.data.sha.slice(0, 12)}` });
      collectedCount++;
      rows.push(`| ${login} | \`${commitRes.data.sha.slice(0, 12)}\` | ✓ |`);
    } catch (e) {
      log(`snapshot ${login}`, { ok: false, note: e.message });
      errorCount++;
      rows.push(`| ${login} | — | exception |`);
    }
  }

  // 5. Outputs & summary
  const outcome = errorCount === 0 ? "collected" : collectedCount > 0 ? "partial" : "fail:all-errors";
  await setOutput("collected_count", collectedCount);
  await setOutput("error_count", errorCount);
  await setOutput("outcome", outcome);
  await summary(
    `### Collect: \`${outcome}\`\n\n` +
    `| student | SHA | status |\n|---|---|---|\n` +
    rows.join("\n") + "\n\n" +
    `**${collectedCount}** collected, **${errorCount}** errors.\n`
  );
  log("done", { ok: errorCount === 0, note: `${outcome} (${collectedCount} ok, ${errorCount} err)` });
  process.exit(outcome.startsWith("fail:") ? 1 : 0);
}

main().catch(async (e) => { await fail("fail:exception", e.message); });
