#!/usr/bin/env node
// PXL Classroom — Spike 4: deadline snapshot + lock-down.
//
// Run by a trusted workflow with a GitHub App installation token. It:
//   1. snapshots the submission ref (repo id, default branch, head SHA, observed_at)
//   2. records the student's current permission
//   3. locks down: demotes the student admin -> read (pull)
//   4. verifies the student is now read-only
//   5. snapshots again, and records the lock-down time + uncertainty interval
//
// No npm deps (Node 18+ fetch).

import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const env = (k, d) => process.env[k] ?? d;
const cfg = {
  token: env("GITHUB_TOKEN"),
  org: env("ORG"),
  repo: env("REPO"),
  student: env("STUDENT_LOGIN"),
  deadlineAt: env("DEADLINE_AT"), // optional ISO; for the uncertainty interval
  apiBase: env("GITHUB_API_URL", "https://api.github.com"),
};
for (const k of ["token", "org", "repo", "student"]) {
  if (!cfg[k]) { console.error(`Missing ${k.toUpperCase()}`); process.exit(2); }
}

async function gh(method, path, body) {
  const res = await fetch(`${cfg.apiBase}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "pxl-spike-04",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null; if (text) { try { data = JSON.parse(text); } catch { data = { raw: text }; } }
  return { status: res.status, ok: res.ok, data };
}

const out = { spike: "04-deadline", startedAt: new Date().toISOString(), input: { ...cfg, token: undefined }, steps: [] };
const log = (step, detail) => { out.steps.push({ step, at: new Date().toISOString(), ...detail }); console.log(`[${detail.ok === false ? "FAIL" : "ok"}] ${step}: ${detail.note ?? ""}`); };

async function snapshot(label) {
  const repo = await gh("GET", `/repos/${cfg.org}/${cfg.repo}`);
  if (!repo.ok) { log(`snapshot ${label}`, { ok: false, note: `repo HTTP ${repo.status}` }); return null; }
  const branch = repo.data.default_branch;
  const commit = await gh("GET", `/repos/${cfg.org}/${cfg.repo}/commits/${branch}`);
  const snap = { repo_id: repo.data.id, default_branch: branch, sha: commit.ok ? commit.data.sha : null, observed_at: new Date().toISOString() };
  log(`snapshot ${label}`, { ok: commit.ok, note: `${branch}@${snap.sha}` });
  return snap;
}

async function permissionOf() {
  const p = await gh("GET", `/repos/${cfg.org}/${cfg.repo}/collaborators/${cfg.student}/permission`);
  return p.ok ? p.data.permission : `error-${p.status}`;
}

async function main() {
  out.snapshot_before = await snapshot("before");

  const permBefore = await permissionOf();
  log("student permission (before)", { ok: true, note: permBefore });
  out.permission_before = permBefore;

  // Lock-down: demote to read.
  const lock = await gh("PUT", `/repos/${cfg.org}/${cfg.repo}/collaborators/${cfg.student}`, { permission: "pull" });
  out.lockdown_at = new Date().toISOString();
  log("lock-down (demote to read)", { ok: lock.status === 204 || lock.status === 201, note: lock.status === 204 ? "updated (was a collaborator)" : lock.status === 201 ? "invitation (was NOT a collaborator — demotion needs an accepted admin)" : `HTTP ${lock.status} ${lock.data?.message ?? ""}` });

  const permAfter = await permissionOf();
  log("student permission (after)", { ok: permAfter === "read", note: permAfter });
  out.permission_after = permAfter;

  out.snapshot_after = await snapshot("after");

  if (cfg.deadlineAt) {
    const ms = new Date(out.lockdown_at) - new Date(cfg.deadlineAt);
    out.uncertainty_interval_seconds = Math.round(ms / 1000);
    log("uncertainty interval", { ok: true, note: `${out.uncertainty_interval_seconds}s (deadline -> lock-down execution)` });
  }

  out.outcome = out.permission_after === "read" ? "locked-down" : "lockdown-incomplete";
  const p = `spikes/04-deadline/out/status-${cfg.org}-${cfg.repo}.json`;
  await mkdir(dirname(p), { recursive: true }); await writeFile(p, JSON.stringify(out, null, 2) + "\n");
  console.log(`\noutcome=${out.outcome}\nStatus written: ${p}`);
  process.exit(out.outcome === "locked-down" ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
