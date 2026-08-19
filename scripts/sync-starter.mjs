#!/usr/bin/env node
// PXL Classroom - smart starter code synchronization.
//
// Fetches the latest updates from the assignment template repository and applies
// them to student repositories using Smart Auto-Merge (with safe PR fallback on conflicts).

import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { gh } from "../lib/gh.mjs";
import { loadYaml } from "../lib/yaml.mjs";

const env = (k, d) => process.env[k] ?? d;
const cfg = {
  token: env("GITHUB_TOKEN"),
  org: env("ORG"),
  assignmentId: env("ASSIGNMENT_ID"),
  dataDir: env("DATA_DIR", "."),
  selectedFiles: env("SELECTED_FILES", '["*"]'),
  prTitle: env("PR_TITLE", ""),
  prBody: env("PR_BODY", ""),
  createIssue: env("CREATE_ISSUE", "true") === "true",
  actor: env("ACTOR", "lecturer"),
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function generateSyncId() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const ts = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;
  const rand = Math.random().toString(36).slice(2, 8);
  return `sync-${ts}-${rand}`;
}

async function main() {
  if (!cfg.token) throw new Error("GITHUB_TOKEN is required");
  if (!cfg.org) throw new Error("ORG is required");
  if (!cfg.assignmentId) throw new Error("ASSIGNMENT_ID is required");

  let filesList = ["*"];
  try {
    filesList = JSON.parse(cfg.selectedFiles);
    if (!Array.isArray(filesList) || filesList.length === 0) filesList = ["*"];
  } catch {
    filesList = ["*"];
  }

  // 1. Read assignment YAML
  const asgnPath = join(cfg.dataDir, "assignments", `${cfg.assignmentId}.yml`);
  const asgnYaml = await readFile(asgnPath, "utf8");
  const assignment = loadYaml(asgnYaml);

  const tplOwner = assignment.template?.owner || cfg.org;
  const tplRepo = assignment.template?.repository;
  if (!tplRepo) throw new Error("Assignment has no template repository configured");

  const templateFullName = `${tplOwner}/${tplRepo}`;
  console.log(`[sync] Template repository: ${templateFullName}`);

  // 2. Fetch latest commit from template default branch
  const tplCommits = await gh("GET", `/repos/${tplOwner}/${tplRepo}/commits?per_page=1`, null, { token: cfg.token });
  if (!tplCommits.ok || !tplCommits.data?.[0]) {
    throw new Error(`Could not fetch commits from template ${templateFullName} (HTTP ${tplCommits.status})`);
  }

  const latestCommit = tplCommits.data[0];
  const templateSha = latestCommit.sha;
  const commitMsgTitle = (latestCommit.commit?.message || "").split("\n")[0] || "Update starter code";
  console.log(`[sync] Target template commit: ${templateSha.slice(0, 7)} - "${commitMsgTitle}"`);

  const syncTitle = cfg.prTitle || `Starter Code Update: ${commitMsgTitle}`;
  const syncBody = cfg.prBody || [
    "### Starter Code Update",
    "",
    `An update from the starter template repository (\`${templateFullName}\`) is available.`,
    "",
    `- **Commit:** \`${templateSha.slice(0, 7)}\` - ${commitMsgTitle}`,
    `- **Selected Files:** ${filesList.includes("*") ? "All changed files" : filesList.join(", ")}`,
    "",
    "#### What you need to do:",
    "- If this update merged cleanly, run `git pull` in your local workspace to get the latest files.",
    "- If this is a Pull Request, review the diff tab on GitHub and click **Merge pull request**.",
  ].join("\n");

  // 3. Read student repository records
  const reposDir = join(cfg.dataDir, "repositories", cfg.assignmentId);
  let repoFiles = [];
  try {
    repoFiles = (await readdir(reposDir)).filter((f) => f.endsWith(".json"));
  } catch {
    console.log(`[sync] No repositories directory for ${cfg.assignmentId}`);
  }

  const syncId = generateSyncId();
  const results = [];
  let autoMerged = 0;
  let prOpened = 0;
  let skipped = 0;
  let failed = 0;

  for (const file of repoFiles) {
    const filePath = join(reposDir, file);
    const rec = JSON.parse(await readFile(filePath, "utf8"));
    const login = rec.github_login;
    const teamSlug = rec.team_slug;
    const repoNameFull = rec.repo_name;
    const repoName = repoNameFull?.split("/")[1] || repoNameFull;

    if (!repoName) {
      skipped++;
      results.push({ github_login: login, team_slug: teamSlug, repo_name: "unknown", outcome: "skipped-no-repo" });
      continue;
    }

    try {
      // Check if student repo main is already at or ahead of this template commit
      const compRes = await gh("GET", `/repos/${cfg.org}/${repoName}/compare/${templateSha}...main`, null, { token: cfg.token });
      if (compRes.ok && compRes.data?.status === "identical") {
        console.log(`[skip] ${login}: already up to date with ${templateSha.slice(0, 7)}`);
        skipped++;
        results.push({ github_login: login, team_slug: teamSlug, repo_name: `${cfg.org}/${repoName}`, outcome: "skipped-up-to-date" });
        continue;
      }

      // Strategy 1: Attempt Smart Direct Merge into main
      const mergeRes = await gh(
        "POST",
        `/repos/${cfg.org}/${repoName}/merges`,
        {
          base: "main",
          head: templateSha,
          commit_message: `Update starter code from template: ${commitMsgTitle}`,
        },
        { token: cfg.token }
      );

      if (mergeRes.ok || mergeRes.status === 204) {
        // Direct merge succeeded cleanly
        autoMerged++;
        const newSha = mergeRes.data?.sha || templateSha;
        console.log(`[auto-merged] ${login}: cleanly merged ${templateSha.slice(0, 7)} into main -> ${newSha.slice(0, 7)}`);

        let issueNum = null;
        let issueUrl = null;
        if (cfg.createIssue) {
          const issueRes = await gh(
            "POST",
            `/repos/${cfg.org}/${repoName}/issues`,
            {
              title: `[Notice] Starter Code Updated: ${commitMsgTitle}`,
              body: `The starter code in this repository was automatically updated with latest template changes.\n\nRun \`git pull\` in your workspace to get the latest fixes.`,
            },
            { token: cfg.token }
          );
          if (issueRes.ok) {
            issueNum = issueRes.data.number;
            issueUrl = issueRes.data.html_url;
          }
        }

        results.push({
          github_login: login,
          team_slug: teamSlug,
          repo_name: `${cfg.org}/${repoName}`,
          outcome: "auto-merged",
          commit_sha: newSha,
          issue_number: issueNum,
          issue_url: issueUrl,
        });
      } else if (mergeRes.status === 409) {
        // Merge conflict: Safely fall back to a Pull Request branch
        console.log(`[conflict -> PR] ${login}: conflict detected on main, creating safe update branch & PR`);
        const branchName = `starter-update-${Date.now().toString(36)}`;
        
        // Create ref pointing to templateSha in student repo
        const createRefRes = await gh(
          "POST",
          `/repos/${cfg.org}/${repoName}/git/refs`,
          {
            ref: `refs/heads/${branchName}`,
            sha: templateSha,
          },
          { token: cfg.token }
        );

        if (!createRefRes.ok) {
          throw new Error(`Failed to create update branch ${branchName} (HTTP ${createRefRes.status})`);
        }

        // Open Pull Request
        const prRes = await gh(
          "POST",
          `/repos/${cfg.org}/${repoName}/pulls`,
          {
            title: syncTitle,
            body: `${syncBody}\n\n> Note: A merge conflict occurred when attempting to apply this update directly. Please review the modified files and resolve any conflicts.`,
            head: branchName,
            base: "main",
          },
          { token: cfg.token }
        );

        if (!prRes.ok) {
          throw new Error(`Failed to open sync PR (HTTP ${prRes.status}): ${prRes.data?.message || ""}`);
        }

        prOpened++;
        const prNum = prRes.data.number;
        const prUrl = prRes.data.html_url;
        console.log(`[pr-opened] ${login}: opened PR #${prNum} (${prUrl})`);

        let issueNum = null;
        let issueUrl = null;
        if (cfg.createIssue) {
          const issueRes = await gh(
            "POST",
            `/repos/${cfg.org}/${repoName}/issues`,
            {
              title: `[Action Required] Starter Code Update Available in PR #${prNum}`,
              body: `A starter code update is available in Pull Request [#${prNum}](${prUrl}). Please review and merge it.`,
            },
            { token: cfg.token }
          );
          if (issueRes.ok) {
            issueNum = issueRes.data.number;
            issueUrl = issueRes.data.html_url;
          }
        }

        results.push({
          github_login: login,
          team_slug: teamSlug,
          repo_name: `${cfg.org}/${repoName}`,
          outcome: "pr-opened",
          pr_number: prNum,
          pr_url: prUrl,
          issue_number: issueNum,
          issue_url: issueUrl,
        });
      } else {
        throw new Error(`Merge attempt returned HTTP ${mergeRes.status}: ${mergeRes.data?.message || ""}`);
      }
    } catch (err) {
      failed++;
      console.log(`[fail] ${login}: ${err.message}`);
      results.push({
        github_login: login,
        team_slug: teamSlug,
        repo_name: `${cfg.org}/${repoName}`,
        outcome: "failed",
        error: err.message,
      });
    }

    // Rate-limit throttle
    await sleep(300);
  }

  // 4. Write sync record
  const syncRecord = {
    schema_version: 1,
    sync_id: syncId,
    assignment_id: cfg.assignmentId,
    synced_at: new Date().toISOString(),
    synced_by: cfg.actor,
    template_repo: templateFullName,
    template_sha: templateSha,
    selected_files: filesList,
    pr_title: syncTitle,
    pr_body: syncBody,
    created_issues: cfg.createIssue,
    summary: {
      total: repoFiles.length,
      auto_merged: autoMerged,
      pr_opened: prOpened,
      skipped,
      failed,
    },
    results,
  };

  const syncDir = join(cfg.dataDir, "syncs", cfg.assignmentId);
  await mkdir(syncDir, { recursive: true });
  await writeFile(join(syncDir, `${syncId}.json`), JSON.stringify(syncRecord, null, 2) + "\n");

  console.log(`\nSync complete (${syncId}): ${autoMerged} auto-merged, ${prOpened} PRs opened, ${skipped} skipped, ${failed} failed.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
