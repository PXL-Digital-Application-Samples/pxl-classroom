#!/usr/bin/env node
// PXL Classroom — submission preservation.
//
// Based on spikes/05-preservation/preserve.sh, rewritten in Node.js.
// Preserves a candidate SHA from each student's repo into an instructor-controlled
// archive repo, verifies the hash, and records the result.
//
// Uses child_process.execSync for git operations (authenticated via the App
// installation token). No npm dependencies (Node 18+ fetch).

import { appendFile, readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { gh } from "../lib/gh.mjs";

const env = (k, d) => process.env[k] ?? d;
const cfg = {
  token: env("GITHUB_TOKEN"),
  org: env("ORG"),
  assignmentId: env("ASSIGNMENT_ID"),
  dataDir: env("DATA_DIR"),
  archiveRepo: "pxl-classroom-archive",
  apiBase: env("GITHUB_API_URL", "https://api.github.com"),
  serverUrl: env("GITHUB_SERVER_URL", "https://github.com"),
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
  await summary(`### Preserve FAILED: \`${category}\`\n\n${note ?? ""}`);
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

// --- Git helpers (execSync, authenticated via token) -------------------------
function git(args, opts = {}) {
  const cmd = `git ${args}`;
  console.log(`$ ${cmd}`);
  return execSync(cmd, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], ...opts }).trim();
}

function authedUrl(repo) {
  return `https://x-access-token:${cfg.token}@${new URL(cfg.serverUrl).host}/${cfg.org}/${repo}.git`;
}

// --- Main --------------------------------------------------------------------
async function main() {
  const bad = validate();
  if (bad) await fail("fail:validation", bad);

  // 1. Auth check
  const ping = await gh("GET", "/rate_limit");
  if (!ping.ok) await fail("fail:auth", `token rejected (HTTP ${ping.status})`);
  log("auth", { ok: true, note: "installation token accepted" });

  // 2. Ensure archive repo exists (create if missing)
  const arcCheck = await gh("GET", `/repos/${cfg.org}/${cfg.archiveRepo}`);
  if (arcCheck.status === 404) {
    const create = await gh("POST", `/orgs/${cfg.org}/repos`, {
      name: cfg.archiveRepo,
      private: true,
      description: "PXL Classroom preservation archive",
      auto_init: true,
    });
    if (!create.ok) await fail("fail:create-archive", `create archive HTTP ${create.status} ${create.data?.message ?? ""}`);
    log("archive-repo", { ok: true, note: `created id=${create.data.id}` });
  } else if (!arcCheck.ok) {
    await fail("fail:archive-repo", `archive repo HTTP ${arcCheck.status}`);
  } else {
    log("archive-repo", { ok: true, note: `exists id=${arcCheck.data.id}` });
  }

  // 3. Read lockdown record
  let lockdownRecord;
  try {
    const raw = await readFile(join(cfg.dataDir, "lockdowns", cfg.assignmentId, "lockdown-record.json"), "utf8");
    lockdownRecord = JSON.parse(raw);
  } catch (err) {
    await fail("fail:no-lockdowns", `Could not read lockdown-record.json: ${err.message}`);
  }

  const results = lockdownRecord.results || [];
  if (results.length === 0) {
    log("preserve", { ok: true, note: "no students to preserve" });
    await setOutput("outcome", "preserved");
    process.exit(0);
  }

  let preservedCount = 0;
  let errorCount = 0;
  const rows = [];

  for (const rec of results) {
    const login = rec.github_login;
    const repoNameFull = rec.repo_name;
    const sourceRepo = repoNameFull.split("/")[1];
    const sourceSha = rec.snapshot_sha;

    if (!sourceSha) {
      log(`preserve ${login}`, { ok: false, note: "no snapshot_sha" });
      errorCount++;
      rows.push(`| ${login} | — | skipped (no SHA) |`);
      continue;
    }

    const workDir = await mkdtemp(join(tmpdir(), `pxl-preserve-${login}-`));
    const presRef = `refs/heads/preserved/${cfg.assignmentId}/${login}`;
    let verified = false;

    try {
      const srcUrl = authedUrl(sourceRepo);
      const arcUrl = authedUrl(cfg.archiveRepo);
      const cloneDir = join(workDir, "src");

      await mkdir(cloneDir);
      git(`init --bare`, { cwd: cloneDir });
      git(`fetch --depth=1 "${srcUrl}" ${sourceSha}`, { cwd: cloneDir });
      
      try {
        git(`cat-file -e ${sourceSha}`, { cwd: cloneDir });
      } catch {
        throw new Error(`SHA ${sourceSha} not found in ${cfg.org}/${sourceRepo}`);
      }

      git(`push --quiet --force "${arcUrl}" ${sourceSha}:${presRef}`, { cwd: cloneDir });
      
      const lsOut = git(`ls-remote "${arcUrl}" ${presRef}`, { cwd: cloneDir });
      const remoteSha = lsOut.split(/\s/)[0] || "";
      verified = remoteSha === sourceSha;
      
      if (!verified) throw new Error("remote SHA mismatch after push");

      // Record preservation status
      const preservation = {
        schema_version: 1,
        assignment_id: cfg.assignmentId,
        github_login: login,
        source_repo: `${cfg.org}/${sourceRepo}`,
        source_repo_id: rec.repo_id,
        source_sha: sourceSha,
        archive_repo: `${cfg.org}/${cfg.archiveRepo}`,
        preserved_ref: presRef,
        verified,
        preserved_at: new Date().toISOString(),
        observer_run: cfg.runUrl,
      };
      const presDir = join(cfg.dataDir, "observations", cfg.assignmentId, login);
      await mkdir(presDir, { recursive: true });
      await writeFile(join(presDir, "preservation.json"), JSON.stringify(preservation, null, 2) + "\n");

      preservedCount++;
      log(`preserve ${login}`, { ok: true, note: `preserved ${sourceSha.slice(0, 12)}` });
      rows.push(`| ${login} | \`${sourceSha.slice(0, 12)}\` | ✓ preserved |`);
    } catch (e) {
      log(`preserve ${login}`, { ok: false, note: e.message });
      errorCount++;
      rows.push(`| ${login} | \`${sourceSha.slice(0, 12)}\` | fail: ${e.message} |`);
    } finally {
      try { await rm(workDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }

  // 4. Outputs & summary
  const outcome = errorCount === 0 ? "preserved" : preservedCount > 0 ? "partial" : "fail:all-errors";
  await setOutput("outcome", outcome);
  await setOutput("preserved_count", preservedCount);
  await setOutput("error_count", errorCount);
  await summary(
    `### Preserve: \`${outcome}\`\n\n` +
    `| student | SHA | status |\n|---|---|---|\n` +
    rows.join("\n") + "\n\n" +
    `**${preservedCount}** preserved, **${errorCount}** errors.\n`
  );
  log("done", { ok: errorCount === 0, note: `${outcome} (${preservedCount} preserved, ${errorCount} err)` });
  process.exit(outcome.startsWith("fail:") ? 1 : 0);
}

main().catch(async (e) => { await fail("fail:exception", e.message); });
