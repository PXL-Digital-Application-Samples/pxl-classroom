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
import { isAlreadyExists, feedbackPrTitle, feedbackPrBody } from "../lib/feedback-pr.mjs";

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

  // Read assignment YAML. `loadYaml` takes a PATH and is async - passing it the
  // text and not awaiting it made `assignment` a Promise, so `feedback_pr` was
  // undefined and this exited "does not have feedback_pr enabled" for every
  // assignment. Same fault as scripts/sync-starter.mjs had, in the same two
  // scripts that also could not mint a token: nothing had ever run either.
  const asgnPath = join(cfg.dataDir, "assignments", `${cfg.assignmentId}.yml`);
  const assignment = await loadYaml(asgnPath);

  if (assignment.feedback_pr !== true) {
    console.log(`Assignment ${cfg.assignmentId} does not have feedback_pr enabled.`);
    process.exit(0);
  }

  const baseline = assignment.feedback_pr_baseline_branch || "pxl-baseline";
  const title = feedbackPrTitle(assignment, cfg.assignmentId);
  const body = feedbackPrBody(baseline);

  const reposDir = join(cfg.dataDir, "repositories", cfg.assignmentId);
  let files = [];
  try {
    files = (await readdir(reposDir)).filter((f) => f.endsWith(".json"));
  } catch (err) {
    console.log(`No repositories directory found for ${cfg.assignmentId}: ${err.message}`);
    process.exit(0);
  }

  // Created and adopted are counted apart, the same way `pxl-classroom feedback
  // open` reports them: "12 opened" reads very differently when eleven of them
  // were already there.
  let created = 0;
  let adopted = 0;
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
      // Labelled `fail`, not `skip`: it is counted as a failure and it makes
      // the run exit non-zero, so calling it a skip in the log is the one line
      // a lecturer would read to decide it was fine.
      console.log(`[fail] ${login}: could not compare ${baseline}...main (HTTP ${compRes.status})`);
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
      created++;
      console.log(`[ok] ${login}: opened PR #${prRes.data.number} (${prRes.data.html_url})`);
      rec.feedback_pr_number = prRes.data.number;
      rec.feedback_pr_url = prRes.data.html_url;
      await writeFile(filePath, JSON.stringify(rec, null, 2) + "\n");
    } else if (isAlreadyExists(prRes.status, prRes.data)) {
      // Adopt the pull request that already exists. `state=open`, not `all`:
      // "already exists" can only be an OPEN one - a closed pull request does
      // not block a new one, verified live - and asking for `all` and taking
      // [0] leant on GitHub's default sort to avoid recording a closed pull
      // request as this assignment's feedback thread.
      const listPrs = await gh("GET", `/repos/${cfg.org}/${repoName}/pulls?head=${cfg.org}:main&base=${baseline}&state=open`, null, { token: cfg.token });
      const found = listPrs.ok ? listPrs.data?.[0] : null;
      if (found) {
        adopted++;
        console.log(`[ok] ${login}: adopted existing PR #${found.number}`);
        rec.feedback_pr_number = found.number;
        rec.feedback_pr_url = found.html_url;
        await writeFile(filePath, JSON.stringify(rec, null, 2) + "\n");
      } else {
        // GitHub said one exists and then did not list it. Counted, not
        // swallowed: this branch used to fall through recording nothing at
        // all, so the student had a feedback PR the control repo never knew
        // about and the summary said neither opened nor failed.
        failed++;
        console.log(`[fail] ${login}: GitHub reports a pull request already exists but did not list it (HTTP ${listPrs.status})`);
      }
    } else {
      console.log(`[fail] ${login}: PR creation failed (HTTP ${prRes.status}): ${prRes.data?.message || ""}`);
      failed++;
    }

    // Gentle 250ms delay between repo writes to stay within secondary rate limits
    await sleep(250);
  }

  console.log(
    `\nFeedback PR summary: ${created} opened, ${adopted} adopted, ${existing} already recorded, ` +
    `${skipped} skipped (no commits), ${failed} failed.`,
  );

  // Non-zero on partial failure, matching `pxl-classroom feedback open`. A run
  // that could not open a PR for four students out of forty is not a success,
  // and a lecturer reading a green tick would never go looking.
  //
  // This is why the workflow's commit step is `if: always()`: the records for
  // the PRs that DID open are already written, and abandoning them means the
  // next run has to rediscover every one of them through the adopt path.
  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
