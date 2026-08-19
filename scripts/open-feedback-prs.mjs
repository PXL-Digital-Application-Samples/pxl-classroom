#!/usr/bin/env node
// PXL Classroom - open feedback PRs in bulk.
//
// Scans provisioned repositories for an assignment with feedback_pr: true,
// checks if student has pushed commits to main ahead of the baseline branch,
// and opens draft feedback PRs if not already opened.

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gh } from "../lib/gh.mjs";
import { loadYaml } from "../lib/yaml.mjs";

const env = (k, d) => process.env[k] ?? d;
const cfg = {
  token: env("GITHUB_TOKEN"),
  org: env("ORG"),
  assignmentId: env("ASSIGNMENT_ID"),
  dataDir: env("DATA_DIR", "."),
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  if (!cfg.token) throw new Error("GITHUB_TOKEN is required");
  if (!cfg.org) throw new Error("ORG is required");
  if (!cfg.assignmentId) throw new Error("ASSIGNMENT_ID is required");

  // Read assignment YAML
  const asgnPath = join(cfg.dataDir, "assignments", `${cfg.assignmentId}.yml`);
  const asgnYaml = await readFile(asgnPath, "utf8");
  const assignment = loadYaml(asgnYaml);

  if (assignment.feedback_pr !== true) {
    console.log(`Assignment ${cfg.assignmentId} does not have feedback_pr enabled.`);
    process.exit(0);
  }

  const baseline = assignment.feedback_pr_baseline_branch || "pxl-baseline";
  const title = `${assignment.title || cfg.assignmentId} - Feedback`;
  const body = [
    "PXL Classroom feedback thread.",
    "",
    `Head: \`main\` · Base: \`${baseline}\` (frozen at provisioning).`,
    "",
    "Lecturers leave inline review comments here; the student keeps pushing to `main`.",
    "The baseline branch is protected against force-push and delete.",
  ].join("\n");

  const reposDir = join(cfg.dataDir, "repositories", cfg.assignmentId);
  let files = [];
  try {
    files = (await readdir(reposDir)).filter((f) => f.endsWith(".json"));
  } catch (err) {
    console.log(`No repositories directory found for ${cfg.assignmentId}: ${err.message}`);
    process.exit(0);
  }

  let opened = 0;
  let existing = 0;
  let skipped = 0;
  let failed = 0;

  for (const file of files) {
    const filePath = join(reposDir, file);
    const rec = JSON.parse(await readFile(filePath, "utf8"));
    const login = rec.github_login;
    const repoName = rec.repo_name?.split("/")[1] || rec.repo_name;

    if (!repoName) {
      skipped++;
      continue;
    }

    if (rec.feedback_pr_number) {
      existing++;
      continue;
    }

    // Check if main has commits ahead of baseline
    const compRes = await gh("GET", `/repos/${cfg.org}/${repoName}/compare/${baseline}...main`, null, { token: cfg.token });
    if (!compRes.ok) {
      console.log(`[skip] ${login}: could not compare ${baseline}...main (HTTP ${compRes.status})`);
      failed++;
      continue;
    }

    if (!compRes.data || compRes.data.ahead_by === 0) {
      console.log(`[skip] ${login}: no commits ahead of ${baseline} yet`);
      skipped++;
      continue;
    }

    // Open PR
    const prRes = await gh(
      "POST",
      `/repos/${cfg.org}/${repoName}/pulls`,
      {
        title,
        body,
        head: "main",
        base: baseline,
        draft: true,
      },
      { token: cfg.token }
    );

    if (prRes.ok && prRes.data) {
      opened++;
      console.log(`[ok] ${login}: opened PR #${prRes.data.number} (${prRes.data.html_url})`);
      rec.feedback_pr_number = prRes.data.number;
      rec.feedback_pr_url = prRes.data.html_url;
      await writeFile(filePath, JSON.stringify(rec, null, 2) + "\n");
    } else if (prRes.status === 422 && String(prRes.data?.errors?.[0]?.message).includes("A pull request already exists")) {
      // Adopt existing PR
      const listPrs = await gh("GET", `/repos/${cfg.org}/${repoName}/pulls?head=${cfg.org}:main&base=${baseline}&state=all`, null, { token: cfg.token });
      if (listPrs.ok && listPrs.data?.[0]) {
        const found = listPrs.data[0];
        opened++;
        console.log(`[ok] ${login}: adopted existing PR #${found.number}`);
        rec.feedback_pr_number = found.number;
        rec.feedback_pr_url = found.html_url;
        await writeFile(filePath, JSON.stringify(rec, null, 2) + "\n");
      }
    } else {
      console.log(`[fail] ${login}: PR creation failed (HTTP ${prRes.status}): ${prRes.data?.message || ""}`);
      failed++;
    }

    // Gentle 250ms delay between repo writes to stay within secondary rate limits
    await sleep(250);
  }

  console.log(`\nFeedback PR summary: ${opened} opened/adopted, ${existing} existing, ${skipped} skipped (no commits), ${failed} failed.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
