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
  assignmentId: env("ASSIGNMENT_ID", ""),
  dataDir: env("DATA_DIR"),
  cronSchedule: env("CRON_SCHEDULE", ""),
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
  if (cfg.assignmentId && !SLUG.test(cfg.assignmentId)) return `ASSIGNMENT_ID="${cfg.assignmentId}" is not a valid slug`;
  if (!cfg.dataDir || !PATH.test(cfg.dataDir)) return `DATA_DIR="${cfg.dataDir}" is not a valid path`;
  return null;
}

// --- Read assignment definition ----------------------------------------------
async function readAssignment(assignmentId) {
  for (const ext of ["yml", "yaml"]) {
    try {
      return await loadYaml(join(cfg.dataDir, "assignments", `${assignmentId}.${ext}`));
    } catch { /* try next extension */ }
  }
  try {
    const raw = await readFile(join(cfg.dataDir, "assignments", `${assignmentId}.json`), "utf8");
    return JSON.parse(raw);
  } catch { return null; }
}

// --- Submit-tag discovery ----------------------------------------------------
// Lists refs/tags/submit/* on a repo, parses the declared timestamp out of the
// tag name, and returns the lexicographically latest tag (== latest declared
// time, since the format is ISO-8601-Z). Returns null when no submit/ tags are
// present or the latest one is malformed. We intentionally do NOT trust the
// student-supplied timestamp for classification — the tag itself is the
// observation (lecturer-side declared_at is observed-not-authoritative).
const SUBMIT_TAG_RE = /^refs\/tags\/(submit\/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)-[0-9a-f]{7,40})$/;

async function findLatestSubmitTag(org, repoName) {
  // List up to 100 matching refs (GitHub's max per page). A student spamming
  // more than 100 submit tags is degenerate; we take the latest by name sort
  // among whatever we got.
  const res = await gh("GET", `/repos/${org}/${repoName}/git/matching-refs/tags/submit/?per_page=100`);
  if (!res.ok || !Array.isArray(res.data) || res.data.length === 0) return null;

  const candidates = [];
  for (const entry of res.data) {
    const m = SUBMIT_TAG_RE.exec(entry.ref || "");
    if (!m) continue;
    candidates.push({ ref: entry.ref, tag: m[1], declared_at: m[2], objectSha: entry.object?.sha, objectType: entry.object?.type });
  }
  if (candidates.length === 0) return null;
  // Tag name format is lexicographically sortable on declared_at, then sha.
  candidates.sort((a, b) => (a.tag < b.tag ? 1 : a.tag > b.tag ? -1 : 0));
  const latest = candidates[0];

  // Resolve the tagged SHA. If the tag is annotated, object.sha points at the
  // tag object, not the commit — we need to follow it through /git/tags.
  let taggedSha = latest.objectSha;
  if (latest.objectType === "tag" && latest.objectSha) {
    const tagObj = await gh("GET", `/repos/${org}/${repoName}/git/tags/${latest.objectSha}`);
    if (tagObj.ok && tagObj.data?.object?.sha) taggedSha = tagObj.data.object.sha;
  }
  if (!taggedSha || !/^[0-9a-f]{40}$/.test(taggedSha)) return null;

  return { tag: latest.tag, declared_at: latest.declared_at, tagged_sha: taggedSha };
}

// --- Read repository records -------------------------------------------------
async function readRepoRecords(assignmentId) {
  const dir = join(cfg.dataDir, "repositories", assignmentId);
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

  let assignmentsToProcess = [];

  if (cfg.assignmentId) {
    assignmentsToProcess.push(cfg.assignmentId);
  } else {
    // Collect all assignments in the data directory
    const assignmentsDir = join(cfg.dataDir, "assignments");
    let files = [];
    try { files = await readdir(assignmentsDir); } catch { /* ignore */ }
    for (const f of files) {
      if (f.endsWith(".yml") || f.endsWith(".yaml") || f.endsWith(".json")) {
        const id = f.replace(/\.(yml|yaml|json)$/, '');
        if (!assignmentsToProcess.includes(id)) assignmentsToProcess.push(id);
      }
    }
  }

  let totalCollected = 0;
  let totalErrors = 0;
  const allRows = [];

  for (const assignmentId of assignmentsToProcess) {
    const assignment = await readAssignment(assignmentId);
    if (!assignment) {
      if (cfg.assignmentId) await fail("fail:assignment", `no assignment file for "${assignmentId}"`);
      continue;
    }

    // Smart schedule logic
    if (!cfg.assignmentId && cfg.cronSchedule) {
      const now = Date.now();
      const opensAt = assignment.opens_at ? new Date(assignment.opens_at).getTime() : 0;
      const deadlineAt = assignment.deadline_at ? new Date(assignment.deadline_at).getTime() : Number.MAX_SAFE_INTEGER;
      const graceMs = (assignment.grace_period_hours || 0) * 3600 * 1000;
      const state = assignment.state || 'draft';

      if (cfg.cronSchedule.includes('*/15')) {
        const isNearDeadline = Math.abs(now - deadlineAt) <= 2 * 3600 * 1000;
        if (!isNearDeadline || state !== 'published') continue;
      } else if (cfg.cronSchedule.includes('*/6') || cfg.cronSchedule.includes('0 */6')) {
        if (state !== 'published' && state !== 'closed') continue;
        const isOpenWindow = now >= opensAt && now <= (deadlineAt + graceMs);
        if (!isOpenWindow) continue;
      }
    }

    const submissionRef = assignment.submission_ref || "refs/heads/main";
    log("assignment", { ok: true, note: `Processing ${assignmentId} (submission_ref=${submissionRef})` });

    const records = await readRepoRecords(assignmentId);
    if (records.length === 0) {
      if (cfg.assignmentId) await fail("fail:no-repos", `no repository records in repositories/${assignmentId}/`);
      continue;
    }
    
    allRows.push(`\n**Assignment: ${assignmentId}**`);
    
    for (const rec of records) {
      const login = rec.github_login;
      const repoName = rec.repo_name?.split("/")?.[1] ?? rec.repo_name;
      try {
        const repoRes = await gh("GET", `/repos/${cfg.org}/${repoName}`);
        if (!repoRes.ok) {
          log(`snapshot ${login}`, { ok: false, note: `repo HTTP ${repoRes.status}` });
          totalErrors++;
          allRows.push(`| ${login} | — | error (repo ${repoRes.status}) |`);
          continue;
        }

        const branch = submissionRef.startsWith("refs/heads/")
          ? submissionRef.slice("refs/heads/".length)
          : repoRes.data.default_branch;

        const commitRes = await gh("GET", `/repos/${cfg.org}/${repoName}/commits/${branch}`);
        if (!commitRes.ok) {
          log(`snapshot ${login}`, { ok: false, note: `commit HTTP ${commitRes.status}` });
          totalErrors++;
          allRows.push(`| ${login} | — | error (commit ${commitRes.status}) |`);
          continue;
        }

        const now = new Date().toISOString();
        const observation = {
          schema_version: 1,
          type: "snapshot",
          assignment_id: assignmentId,
          github_login: login,
          repo_id: repoRes.data.id,
          observed_at: now,
          ref: submissionRef,
          sha: commitRes.data.sha,
          observer_run: cfg.runUrl,
          collection_type: env("COLLECTION_TYPE", "scheduled"),
        };

        const safeTs = now.replace(/[:.]/g, "-");
        const obsDir = join(cfg.dataDir, "observations", assignmentId, login);
        const obsPath = join(obsDir, `${safeTs}.json`);
        await mkdir(obsDir, { recursive: true });
        await writeFile(obsPath, JSON.stringify(observation, null, 2) + "\n");

        log(`snapshot ${login}`, { ok: true, note: `${branch}@${commitRes.data.sha.slice(0, 12)}` });
        totalCollected++;

        // Also look for submit/ tags. Failures here are non-fatal — the
        // default-branch snapshot is the floor.
        let tagNote = "";
        try {
          const submit = await findLatestSubmitTag(cfg.org, repoName);
          if (submit) {
            const tagObservation = {
              schema_version: 1,
              type: "tagged-submission",
              assignment_id: assignmentId,
              github_login: login,
              repo_id: repoRes.data.id,
              observed_at: now,
              tag: submit.tag,
              declared_at: submit.declared_at,
              tagged_sha: submit.tagged_sha,
              observer_run: cfg.runUrl,
            };
            const tagPath = join(obsDir, `${safeTs}-tag.json`);
            await writeFile(tagPath, JSON.stringify(tagObservation, null, 2) + "\n");
            tagNote = ` · tag ${submit.tag}`;
            log(`tag ${login}`, { ok: true, note: `${submit.tag} → ${submit.tagged_sha.slice(0, 12)}` });
          }
        } catch (e) {
          log(`tag ${login}`, { ok: false, note: e.message });
        }
        allRows.push(`| ${login} | \`${commitRes.data.sha.slice(0, 12)}\`${tagNote} | ✓ |`);
      } catch (e) {
        log(`snapshot ${login}`, { ok: false, note: e.message });
        totalErrors++;
        allRows.push(`| ${login} | — | exception |`);
      }
    }
  }

  // 5. Outputs & summary
  const outcome = totalErrors === 0 ? "collected" : totalCollected > 0 ? "partial" : "fail:all-errors";
  await setOutput("collected_count", totalCollected);
  await setOutput("error_count", totalErrors);
  await setOutput("outcome", outcome);
  await summary(
    `### Collect: \`${outcome}\`\n\n` +
    `| student | SHA | status |\n|---|---|---|\n` +
    allRows.join("\n") + "\n\n" +
    `**${totalCollected}** collected, **${totalErrors}** errors.\n`
  );
  log("done", { ok: totalErrors === 0, note: `${outcome} (${totalCollected} ok, ${totalErrors} err)` });
  process.exit(outcome.startsWith("fail:") ? 1 : 0);
}

main().catch(async (e) => { await fail("fail:exception", e.message); });
