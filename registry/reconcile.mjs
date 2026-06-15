#!/usr/bin/env node
// PXL Classroom — registry reconciliation.
//
// Scans the local `repositories/` registry and compares it to the actual GitHub
// state. Detects deleted repos, public repos (should be private), and missing
// student permissions. Updates the local JSON records accordingly.

import { readdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { gh } from "../lib/gh.mjs";

const env = (k, d) => process.env[k] ?? d;
const cfg = {
  token: env("GITHUB_TOKEN"),
  org: env("GITHUB_ORG"),
  assignmentId: env("ASSIGNMENT_ID"),
  dataDir: env("DATA_DIR", "."),
  apiBase: env("GITHUB_API_URL", "https://api.github.com"),
};

async function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `${name}=${value ?? ""}\n`);
}

async function readJsonSafe(path) {
  try { return JSON.parse(await readFile(path, "utf-8")); } catch { return null; }
}

async function getAssignmentRepos(assignmentDir) {
  if (!existsSync(assignmentDir)) return [];
  const files = (await readdir(assignmentDir)).filter(f => f.endsWith(".json"));
  const repos = [];
  for (const f of files) {
    const data = await readJsonSafe(join(assignmentDir, f));
    if (data && data.repo_name) repos.push({ path: join(assignmentDir, f), data });
  }
  return repos;
}

async function main() {
  if (!cfg.token || !cfg.org) {
    console.error("GITHUB_TOKEN and GITHUB_ORG are required.");
    process.exit(1);
  }

  const reposDir = join(cfg.dataDir, "repositories");
  if (!existsSync(reposDir)) {
    console.log("No repositories directory found. Nothing to reconcile.");
    await setOutput("drift_detected", "false");
    return;
  }

  let driftDetected = false;
  
  // Determine assignments to scan
  let assignmentsToScan = [];
  if (cfg.assignmentId) {
    assignmentsToScan = [cfg.assignmentId];
  } else {
    assignmentsToScan = (await readdir(reposDir, { withFileTypes: true }))
      .filter(d => d.isDirectory())
      .map(d => d.name);
  }

  for (const assignment of assignmentsToScan) {
    const assignmentDir = join(reposDir, assignment);
    const repos = await getAssignmentRepos(assignmentDir);
    
    console.log(`Reconciling ${repos.length} repos for assignment: ${assignment}`);
    
    for (const { path, data } of repos) {
      let changed = false;
      const originalState = data.access_state;
      const originalVisibility = data.visibility || "private";
      
      const repoNameParts = data.repo_name.split('/');
      const repoName = repoNameParts.length === 2 ? repoNameParts[1] : data.repo_name;

      // 1. Check if repo exists
      const repoCheck = await gh("GET", `/repos/${cfg.org}/${repoName}`);
      
      if (repoCheck.status === 404) {
        if (data.access_state !== "deleted") {
          console.log(`[DRIFT] Repo deleted: ${data.repo_name}`);
          data.access_state = "deleted";
          changed = true;
        }
      } else if (repoCheck.ok) {
        // Exists. Check visibility
        const currentVisibility = repoCheck.data.private ? "private" : "public";
        if (data.visibility !== currentVisibility) {
          console.log(`[DRIFT] Visibility changed for ${data.repo_name}: ${originalVisibility} -> ${currentVisibility}`);
          data.visibility = currentVisibility;
          changed = true;
        }
        
        // 2. Check student access
        const accessCheck = await gh("GET", `/repos/${cfg.org}/${repoName}/collaborators/${data.github_login}/permission`);
        if (accessCheck.ok) {
          const actualRole = accessCheck.data.permission; // admin, write, read, none
          // If the role was demoted, but the control repo doesn't expect it (lockdown hasn't happened), it's drift.
          // For now, we mainly care if they were completely removed.
          if (actualRole === "none") {
            if (data.access_state !== "revoked") {
              console.log(`[DRIFT] Access revoked for ${data.github_login} on ${data.repo_name}`);
              data.access_state = "revoked";
              changed = true;
            }
          } else {
            // Restore access state if they were previously marked revoked but now have access
            if (data.access_state === "revoked" || data.access_state === "deleted") {
              console.log(`[DRIFT] Repo/Access restored for ${data.github_login} on ${data.repo_name}`);
              data.access_state = "invited"; // or active
              changed = true;
            }
          }
        } else if (accessCheck.status === 404) {
          if (data.access_state !== "revoked") {
            console.log(`[DRIFT] Access revoked (404) for ${data.github_login} on ${data.repo_name}`);
            data.access_state = "revoked";
            changed = true;
          }
        }
      }

      if (changed) {
        driftDetected = true;
        data.last_checked_at = new Date().toISOString();
        await writeFile(path, JSON.stringify(data, null, 2) + "\n");
      }
    }
  }

  await setOutput("drift_detected", driftDetected ? "true" : "false");
  console.log(`Reconciliation complete. Drift detected: ${driftDetected}`);
}

main().catch(e => {
  console.error("Reconciliation failed:", e);
  process.exit(1);
});
