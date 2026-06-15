#!/usr/bin/env node
// PXL Classroom — submission preservation.
//
// Based on spikes/05-preservation/preserve.sh, rewritten in Node.js.
// Preserves a candidate SHA from a student repo into an instructor-controlled
// archive repo, verifies the hash, and records the result.
//
// Uses child_process.execSync for git operations (authenticated via the App
// installation token). No npm dependencies (Node 18+ fetch).

import { appendFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { gh } from "../lib/gh.mjs";

const env = (k, d) => process.env[k] ?? d;
const cfg = {
  token: env("GITHUB_TOKEN"),
  org: env("ORG"),
  assignmentId: env("ASSIGNMENT_ID"),
  sourceRepo: env("SOURCE_REPO"),
  sourceSha: env("SOURCE_SHA"),
  archiveRepo: env("ARCHIVE_REPO"),
  login: env("STUDENT_LOGIN"),
  dataDir: env("DATA_DIR"),
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
  await setOutput("verified", "false");
  await summary(`### Preserve FAILED: \`${category}\`\n\n${note ?? ""}`);
  process.exit(1);
}

// --- Strict input validation -------------------------------------------------
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,99}$/;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const SHA = /^[0-9a-f]{40}$/;
const PATH = /^[A-Za-z0-9._/\\:-]+$/;

function validate() {
  if (!cfg.token) return "GITHUB_TOKEN is required (App installation token)";
  if (!cfg.org || !NAME.test(cfg.org)) return `ORG="${cfg.org}" is not a valid GitHub name`;
  if (!cfg.assignmentId || !SLUG.test(cfg.assignmentId)) return `ASSIGNMENT_ID="${cfg.assignmentId}" is not a valid slug`;
  if (!cfg.sourceRepo || !NAME.test(cfg.sourceRepo)) return `SOURCE_REPO="${cfg.sourceRepo}" is not a valid repo name`;
  if (!cfg.sourceSha || !SHA.test(cfg.sourceSha)) return `SOURCE_SHA="${cfg.sourceSha}" is not a valid 40-char hex SHA`;
  if (!cfg.archiveRepo || !NAME.test(cfg.archiveRepo)) return `ARCHIVE_REPO="${cfg.archiveRepo}" is not a valid repo name`;
  if (!cfg.login || !LOGIN.test(cfg.login)) return `STUDENT_LOGIN="${cfg.login}" is not a valid GitHub login`;
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

  // 2. Verify source repo exists
  const srcCheck = await gh("GET", `/repos/${cfg.org}/${cfg.sourceRepo}`);
  if (!srcCheck.ok) await fail("fail:source-repo", `source repo HTTP ${srcCheck.status}`);
  log("source-repo", { ok: true, note: `id=${srcCheck.data.id}` });

  // 3. Ensure archive repo exists (create if missing)
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

  // 4. Clone source repo and push to archive
  const workDir = await mkdtemp(join(tmpdir(), "pxl-preserve-"));
  const presRef = `refs/heads/preserved/${cfg.assignmentId}/${cfg.login}`;
  let verified = false;

  try {
    // Fetch only the specific SHA (shallow)
    const srcUrl = authedUrl(cfg.sourceRepo);
    const arcUrl = authedUrl(cfg.archiveRepo);
    const cloneDir = join(workDir, "src");

    await mkdir(cloneDir);
    git(`init --bare`, { cwd: cloneDir });
    git(`fetch --depth=1 "${srcUrl}" ${cfg.sourceSha}`, { cwd: cloneDir });
    log("fetch", { ok: true, note: `fetched ${cfg.sourceSha} from ${cfg.org}/${cfg.sourceRepo}` });

    // Verify the requested SHA exists in the clone
    try {
      git(`cat-file -e ${cfg.sourceSha}`, { cwd: cloneDir });
    } catch {
      await fail("fail:sha-missing", `SHA ${cfg.sourceSha} not found in ${cfg.org}/${cfg.sourceRepo}`);
    }

    // Push the SHA to the archive repo
    git(`push --quiet --force "${arcUrl}" ${cfg.sourceSha}:${presRef}`, { cwd: cloneDir });
    log("push", { ok: true, note: `${cfg.sourceSha.slice(0, 12)} → ${presRef}` });

    // 5. Verify via ls-remote
    const lsOut = git(`ls-remote "${arcUrl}" ${presRef}`, { cwd: cloneDir });
    const remoteSha = lsOut.split(/\s/)[0] || "";
    verified = remoteSha === cfg.sourceSha;
    log("verify", { ok: verified, note: verified ? `match ${remoteSha.slice(0, 12)}` : `mismatch remote=${remoteSha} expected=${cfg.sourceSha}` });
  } finally {
    // Clean up work directory
    try { await rm(workDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  // 6. Record preservation status
  const preservation = {
    schema_version: 1,
    assignment_id: cfg.assignmentId,
    github_login: cfg.login,
    source_repo: `${cfg.org}/${cfg.sourceRepo}`,
    source_repo_id: srcCheck.data.id,
    source_sha: cfg.sourceSha,
    archive_repo: `${cfg.org}/${cfg.archiveRepo}`,
    preserved_ref: presRef,
    verified,
    preserved_at: new Date().toISOString(),
    observer_run: cfg.runUrl,
  };
  const presDir = join(cfg.dataDir, "observations", cfg.assignmentId, cfg.login);
  await mkdir(presDir, { recursive: true });
  await writeFile(join(presDir, "preservation.json"), JSON.stringify(preservation, null, 2) + "\n");

  // 7. Outputs & summary
  const outcome = verified ? "preserved" : "fail:verify";
  await setOutput("preserved_sha", cfg.sourceSha);
  await setOutput("verified", String(verified));
  await setOutput("outcome", outcome);
  await summary(
    `### Preserve: \`${outcome}\`\n\n` +
    `| field | value |\n|---|---|\n` +
    `| source | ${cfg.org}/${cfg.sourceRepo} |\n` +
    `| SHA | \`${cfg.sourceSha}\` |\n` +
    `| archive | ${cfg.org}/${cfg.archiveRepo} |\n` +
    `| ref | \`${presRef}\` |\n` +
    `| verified | ${verified} |\n`
  );
  log("done", { ok: verified, note: outcome });
  process.exit(verified ? 0 : 1);
}

main().catch(async (e) => { await fail("fail:exception", e.message); });
