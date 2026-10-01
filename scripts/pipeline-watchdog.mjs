#!/usr/bin/env node
// PXL Classroom - Central Hub Pipeline Watchdog & Alert Sentinel.
//
// Monitors GitHub Actions runs on the central hub repository to detect:
// 1. Stuck runs in status=waiting (>15m, deadlocked on concurrency or environment protection).
// 2. Overlong runs in status=in_progress (>45m).
// 3. Recently failed critical workflows.
//
// Automatically cancels zombie runs to unblock subsequent deploys and dispatches
// email notifications to admins via tracking issue mentions.
//
// Inputs via env:
//   GITHUB_TOKEN, HUB_OWNER, HUB_REPO, ALERT_LEVEL, AUTO_CANCEL, NOTIFY_LOGINS

import { gh, ghAll } from "../lib/gh.mjs";
import { HUB_OWNER, HUB_REPO, PIPELINE_ALERTS } from "../lib/deployment.mjs";

const TRACKING_ISSUE_TITLE = "[NOTICE] PXL Classroom - Pipeline Watchdog Alerts";
const DEDUP_MARKER = "<!-- pxl-watchdog-dedup:";

const owner = process.env.HUB_OWNER || HUB_OWNER;
const repo = process.env.HUB_REPO || HUB_REPO;
const token = process.env.GITHUB_TOKEN;
const alertLevel = process.env.ALERT_LEVEL || PIPELINE_ALERTS.level || "stuck_and_failures";
const autoCancel = process.env.AUTO_CANCEL !== "false";

const rawLogins = process.env.NOTIFY_LOGINS || (PIPELINE_ALERTS.notify_logins || []).join(",");
const notifyLogins = rawLogins
  .split(",")
  .map((s) => s.trim().replace(/^@/, ""))
  .filter(Boolean);

export async function runWatchdog({ owner, repo, token, alertLevel, autoCancel, notifyLogins }) {
  if (alertLevel === "off") {
    console.log("Pipeline alerts are disabled (alertLevel=off). Exiting.");
    return { outcome: "skipped_disabled", stuckRuns: [], failedRuns: [] };
  }

  const ghOpts = { token, throwOnError: true };
  const now = Date.now();

  const [waitingRes, inProgressRes, completedRes] = await Promise.all([
    gh("GET", `/repos/${owner}/${repo}/actions/runs?status=waiting&per_page=30`, null, ghOpts),
    gh("GET", `/repos/${owner}/${repo}/actions/runs?status=in_progress&per_page=30`, null, ghOpts),
    gh("GET", `/repos/${owner}/${repo}/actions/runs?status=completed&per_page=20`, null, ghOpts),
  ]);

  const stuckRuns = [];
  const waitingRuns = Array.isArray(waitingRes.data?.workflow_runs) ? waitingRes.data.workflow_runs : [];
  for (const r of waitingRuns) {
    const ageMs = now - new Date(r.created_at).getTime();
    if (ageMs > 15 * 60 * 1000) {
      stuckRuns.push({
        ...r,
        ageMs,
        durationMin: Math.max(1, Math.round(ageMs / 60000)),
        reason: "waiting_timeout",
      });
    }
  }

  const runningRuns = Array.isArray(inProgressRes.data?.workflow_runs) ? inProgressRes.data.workflow_runs : [];
  for (const r of runningRuns) {
    const ageMs = now - new Date(r.created_at).getTime();
    if (ageMs > 45 * 60 * 1000) {
      stuckRuns.push({
        ...r,
        ageMs,
        durationMin: Math.max(1, Math.round(ageMs / 60000)),
        reason: "in_progress_timeout",
      });
    }
  }

  const failedRuns = [];
  const completedRuns = Array.isArray(completedRes.data?.workflow_runs) ? completedRes.data.workflow_runs : [];
  for (const r of completedRuns) {
    if (r.conclusion === "failure") {
      const ageMs = now - new Date(r.updated_at || r.created_at).getTime();
      // Only failures within the last 60 minutes
      if (ageMs < 60 * 60 * 1000) {
        failedRuns.push({
          ...r,
          ageMs,
          durationMin: Math.max(1, Math.round(ageMs / 60000)),
        });
      }
    }
  }

  console.log(`Watchdog scan: ${stuckRuns.length} stuck run(s), ${failedRuns.length} recent failure(s).`);

  // Auto-cancel zombie runs waiting > 20m
  const cancelledRuns = [];
  if (autoCancel) {
    for (const r of stuckRuns) {
      if (r.reason === "waiting_timeout" && r.ageMs > 20 * 60 * 1000) {
        try {
          console.log(`Auto-cancelling stuck run #${r.id} (${r.name})...`);
          await gh("POST", `/repos/${owner}/${repo}/actions/runs/${r.id}/cancel`, null, ghOpts);
          cancelledRuns.push(r.id);

          // If deploy-frontend.yml was cancelled, trigger a fresh deploy
          if (r.name?.includes("Deploy frontend") || r.path?.includes("deploy-frontend")) {
            console.log("Re-dispatching deploy-frontend.yml following cancellation of stuck run...");
            await gh(
              "POST",
              `/repos/${owner}/${repo}/actions/workflows/deploy-frontend.yml/dispatches`,
              { ref: "main" },
              ghOpts
            );
          }
        } catch (err) {
          console.warn(`Failed to auto-cancel run #${r.id}: ${err.message}`);
        }
      }
    }
  }

  // Determine if notification is warranted based on alertLevel picklist
  let shouldNotify = false;
  if (alertLevel === "all") {
    shouldNotify = stuckRuns.length > 0 || failedRuns.length > 0;
  } else if (alertLevel === "stuck_and_failures") {
    shouldNotify = stuckRuns.length > 0 || failedRuns.length > 0;
  } else if (alertLevel === "critical_only") {
    shouldNotify = stuckRuns.some((r) =>
      r.name?.includes("Deploy frontend") || r.name?.includes("Regenerate Dashboard")
    );
  }

  if (!shouldNotify) {
    console.log("No alerting conditions met for configured alert level.");
    return { outcome: "ok", stuckRuns, failedRuns, cancelledRuns };
  }

  // Find or create tracking issue
  const openIssues = await ghAll(
    `/repos/${owner}/${repo}/issues?labels=pxl-tracking&state=open&per_page=100`,
    ghOpts
  );
  let issue = openIssues.find((i) => i.title === TRACKING_ISSUE_TITLE && !i.pull_request);

  if (!issue) {
    const created = await gh(
      "POST",
      `/repos/${owner}/${repo}/issues`,
      {
        title: TRACKING_ISSUE_TITLE,
        body:
          "This issue is automatically maintained by the PXL Classroom Pipeline Watchdog.\n\n" +
          "When Actions runs are stuck or fail, alerts with @mentions are posted here to notify administrators via email.\n\n" +
          "Labels: `pxl-tracking`",
        labels: ["pxl-tracking"],
      },
      ghOpts
    );
    issue = created.data;
  }

  // Read existing comments for deduplication
  const comments = await ghAll(
    `/repos/${owner}/${repo}/issues/${issue.number}/comments?per_page=100`,
    ghOpts
  );

  const mentions = notifyLogins.map((l) => `@${l}`).join(" ");

  for (const r of stuckRuns) {
    const dedupKey = `stuck-${r.id}`;
    const alreadyPosted = comments.some((c) => c.body?.includes(`${DEDUP_MARKER}${dedupKey}-->`));
    if (alreadyPosted) {
      console.log(`Alert already posted for stuck run #${r.id}, skipping.`);
      continue;
    }

    const wasCancelled = cancelledRuns.includes(r.id);
    const commentBody =
      `${DEDUP_MARKER}${dedupKey}-->\n` +
      `### [ALERT] Pipeline Run Stuck: ${r.name || "Workflow"} (#${r.id})\n\n` +
      `${mentions ? `${mentions} - ` : ""}Workflow run **#${r.id}** is stuck in **${r.status}** for **${r.durationMin}** minutes.\n\n` +
      `- **Workflow:** [${r.name}](${r.html_url})\n` +
      `- **Event:** \`${r.event}\`\n` +
      `- **Triggered at:** ${r.created_at}\n` +
      `- **Action taken:** ${wasCancelled ? "Automatically cancelled to unblock queue." : "Requires manual cancellation or attention."}\n`;

    await gh("POST", `/repos/${owner}/${repo}/issues/${issue.number}/comments`, { body: commentBody }, ghOpts);
    console.log(`Posted stuck run alert for #${r.id} to issue #${issue.number}.`);
  }

  for (const r of failedRuns) {
    const dedupKey = `failed-${r.id}`;
    const alreadyPosted = comments.some((c) => c.body?.includes(`${DEDUP_MARKER}${dedupKey}-->`));
    if (alreadyPosted) {
      console.log(`Alert already posted for failed run #${r.id}, skipping.`);
      continue;
    }

    const commentBody =
      `${DEDUP_MARKER}${dedupKey}-->\n` +
      `### [ERROR] Pipeline Run Failed: ${r.name || "Workflow"} (#${r.id})\n\n` +
      `${mentions ? `${mentions} - ` : ""}Workflow run **#${r.id}** failed after ${r.durationMin} minutes.\n\n` +
      `- **Workflow:** [${r.name}](${r.html_url})\n` +
      `- **Event:** \`${r.event}\`\n` +
      `- **Conclusion:** \`${r.conclusion}\`\n` +
      `- **Updated at:** ${r.updated_at || r.created_at}\n`;

    await gh("POST", `/repos/${owner}/${repo}/issues/${issue.number}/comments`, { body: commentBody }, ghOpts);
    console.log(`Posted failed run alert for #${r.id} to issue #${issue.number}.`);
  }

  return { outcome: "notified", stuckRuns, failedRuns, cancelledRuns };
}

// CLI entry point
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  if (!token) {
    console.error("Missing required GITHUB_TOKEN environment variable.");
    process.exit(1);
  }
  runWatchdog({ owner, repo, token, alertLevel, autoCancel, notifyLogins })
    .then((result) => {
      console.log("Watchdog run complete:", result.outcome);
      process.exit(0);
    })
    .catch((err) => {
      console.error("Watchdog failed:", err);
      process.exit(1);
    });
}
