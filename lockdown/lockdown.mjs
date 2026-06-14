#!/usr/bin/env node
// PXL Classroom — deadline lock-down.
//
// Based on spikes/04-deadline/deadline.mjs. For each managed repository:
//   1. Takes a final snapshot of the submission ref
//   2. Demotes the student from current permission to "pull" (read-only)
//   3. Verifies the demotion
//   4. Records lockdown time and uncertainty interval (lockdown_at − deadline_at)
//
// Continues on per-student errors. No npm dependencies (Node 18+ fetch).

import { appendFile, readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

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
  await summary(`### Lockdown FAILED: \`${category}\`\n\n${note ?? ""}`);
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

// --- GitHub API helper with retry (4 retries, exponential backoff) -----------
async function gh(method, path, body, { retries = 4 } = {}) {
  const url = `${cfg.apiBase}${path}`;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "pxl-classroom-lockdown",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const remaining = res.headers.get("x-ratelimit-remaining");
    const retriable = res.status >= 500 || res.status === 429 || (res.status === 403 && remaining === "0");
    if (retriable && attempt < retries) {
      const retryAfter = Number(res.headers.get("retry-after")) || 0;
      await new Promise((r) => setTimeout(r, retryAfter * 1000 || Math.min(30000, 2 ** attempt * 1000)));
      continue;
    }
    const text = await res.text();
    let data = null; if (text) { try { data = JSON.parse(text); } catch { data = { raw: text }; } }
    return { status: res.status, ok: res.ok, data };
  }
}

// --- Read assignment definition ----------------------------------------------
async function readAssignment() {
  for (const ext of ["yml", "yaml", "json"]) {
    try {
      const raw = await readFile(join(cfg.dataDir, "assignments", `${cfg.assignmentId}.${ext}`), "utf8");
      if (ext === "json") return JSON.parse(raw);
      const obj = {};
      for (const line of raw.split(/\r?\n/)) {
        const m = line.match(/^([a-z_]+)\s*:\s*(.+)$/);
        if (m) obj[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
      return obj;
    } catch { /* try next extension */ }
  }
  return null;
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
  const deadlineAt = assignment.deadline_at || null;
  log("assignment", { ok: true, note: `deadline_at=${deadlineAt} submission_ref=${submissionRef}` });

  // 3. Read repo records
  const records = await readRepoRecords();
  if (records.length === 0) await fail("fail:no-repos", `no repository records in repositories/${cfg.assignmentId}/`);
  log("repo-records", { ok: true, note: `${records.length} student(s)` });

  // 4. Lockdown each repo
  let lockedCount = 0;
  let errorCount = 0;
  let maxUncertainty = 0;
  const rows = [];
  const lockdownResults = [];

  for (const rec of records) {
    const login = rec.github_login;
    const repoName = rec.repo_name?.split("/")?.[1] ?? rec.repo_name;
    try {
      // 4a. Final snapshot
      const repoRes = await gh("GET", `/repos/${cfg.org}/${repoName}`);
      if (!repoRes.ok) {
        log(`lockdown ${login}`, { ok: false, note: `repo HTTP ${repoRes.status}` });
        errorCount++;
        rows.push(`| ${login} | — | — | error |`);
        continue;
      }
      const branch = submissionRef.startsWith("refs/heads/")
        ? submissionRef.slice("refs/heads/".length)
        : repoRes.data.default_branch;

      const commitRes = await gh("GET", `/repos/${cfg.org}/${repoName}/commits/${branch}`);
      const snapshotSha = commitRes.ok ? commitRes.data.sha : null;

      // Write the final observation
      if (snapshotSha) {
        const now = new Date().toISOString();
        const observation = {
          schema_version: 1,
          assignment_id: cfg.assignmentId,
          github_login: login,
          repo_id: repoRes.data.id,
          observed_at: now,
          ref: submissionRef,
          sha: snapshotSha,
          observer_run: cfg.runUrl,
          collection_type: "lockdown",
        };
        const safeTs = now.replace(/[:.]/g, "-");
        const obsDir = join(cfg.dataDir, "observations", cfg.assignmentId, login);
        await mkdir(obsDir, { recursive: true });
        await writeFile(join(obsDir, `${safeTs}.json`), JSON.stringify(observation, null, 2) + "\n");
      }

      // 4b. Demote student to pull (read-only)
      const demote = await gh("PUT", `/repos/${cfg.org}/${repoName}/collaborators/${login}`, { permission: "pull" });
      const lockdownAt = new Date().toISOString();
      if (!(demote.status === 204 || demote.status === 201)) {
        log(`lockdown ${login}`, { ok: false, note: `demote HTTP ${demote.status}` });
        errorCount++;
        rows.push(`| ${login} | \`${(snapshotSha || "—").slice(0, 12)}\` | — | demote failed |`);
        continue;
      }

      // 4c. Verify demotion
      const verify = await gh("GET", `/repos/${cfg.org}/${repoName}/collaborators/${login}/permission`);
      const permAfter = verify.ok ? verify.data.permission : `error-${verify.status}`;
      const isLocked = permAfter === "read";

      // 4d. Uncertainty interval
      let uncertaintySec = null;
      if (deadlineAt) {
        const ms = new Date(lockdownAt) - new Date(deadlineAt);
        uncertaintySec = Math.round(ms / 1000);
        if (Math.abs(uncertaintySec) > maxUncertainty) maxUncertainty = Math.abs(uncertaintySec);
      }

      // Record lockdown result
      const result = {
        github_login: login,
        repo_name: `${cfg.org}/${repoName}`,
        repo_id: repoRes.data.id,
        snapshot_sha: snapshotSha,
        snapshot_ref: submissionRef,
        lockdown_at: lockdownAt,
        permission_after: permAfter,
        verified: isLocked,
        uncertainty_seconds: uncertaintySec,
      };
      lockdownResults.push(result);

      if (isLocked) {
        lockedCount++;
        log(`lockdown ${login}`, { ok: true, note: `${branch}@${(snapshotSha || "?").slice(0, 12)} → pull (${uncertaintySec ?? "?"}s)` });
        rows.push(`| ${login} | \`${(snapshotSha || "—").slice(0, 12)}\` | ${uncertaintySec ?? "—"}s | ✓ locked |`);
      } else {
        errorCount++;
        log(`lockdown ${login}`, { ok: false, note: `permission after=${permAfter}, expected read` });
        rows.push(`| ${login} | \`${(snapshotSha || "—").slice(0, 12)}\` | ${uncertaintySec ?? "—"}s | perm=${permAfter} |`);
      }
    } catch (e) {
      log(`lockdown ${login}`, { ok: false, note: e.message });
      errorCount++;
      rows.push(`| ${login} | — | — | exception |`);
    }
  }

  // 5. Write lockdown record
  const lockdownDir = join(cfg.dataDir, "lockdowns", cfg.assignmentId);
  await mkdir(lockdownDir, { recursive: true });
  const lockdownRecord = {
    schema_version: 1,
    assignment_id: cfg.assignmentId,
    deadline_at: deadlineAt,
    executed_at: new Date().toISOString(),
    observer_run: cfg.runUrl,
    locked_count: lockedCount,
    error_count: errorCount,
    max_uncertainty_seconds: maxUncertainty,
    results: lockdownResults,
  };
  await writeFile(join(lockdownDir, "lockdown-record.json"), JSON.stringify(lockdownRecord, null, 2) + "\n");

  // 6. Outputs & summary
  const outcome = errorCount === 0 ? "locked" : lockedCount > 0 ? "partial" : "fail:all-errors";
  await setOutput("locked_count", lockedCount);
  await setOutput("error_count", errorCount);
  await setOutput("uncertainty_seconds", maxUncertainty);
  await setOutput("outcome", outcome);
  await summary(
    `### Lockdown: \`${outcome}\`\n\n` +
    `| student | SHA | uncertainty | status |\n|---|---|---|---|\n` +
    rows.join("\n") + "\n\n" +
    `**${lockedCount}** locked, **${errorCount}** errors. Max uncertainty: **${maxUncertainty}s**.\n`
  );
  log("done", { ok: errorCount === 0, note: `${outcome} (${lockedCount} locked, ${errorCount} err, ${maxUncertainty}s max uncertainty)` });
  process.exit(outcome.startsWith("fail:") ? 1 : 0);
}

main().catch(async (e) => { await fail("fail:exception", e.message); });
