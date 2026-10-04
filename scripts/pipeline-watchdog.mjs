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

import { gh, ghAll, ghAllItems } from "../lib/gh.mjs";
import { HUB_OWNER, HUB_REPO, PIPELINE_ALERTS } from "../lib/deployment.mjs";
import { REGISTRY_BRANCH } from "../lib/org-registry.mjs";

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

/**
 * Whether a run belongs to the pipeline at all.
 *
 * The registry branch holds one YAML file and runs nothing of ours, but it is
 * protected, and GitHub's code scanning analyses every protected branch on
 * push. So each new org registration fails there once - "no source code seen
 * during build" - which happened 8 times between 2026-09-17 and 2026-10-03,
 * and became an email the day this watchdog started reporting every failure.
 * Not a pipeline failure, so not an alert, a stuck run or a cancel.
 */
export function watchedRun(run) {
  return run?.head_branch !== REGISTRY_BRANCH;
}

/**
 * How long a finished run RAN, in words - or null when GitHub did not say.
 *
 * The alert said "failed after 46 minutes" over a run that took 31 seconds:
 * the number was how long ago it failed, taken when the watchdog happened to
 * look. A message no branch computed is a guess (CLAUDE.md).
 */
export function ranFor(run) {
  const start = Date.parse(run?.run_started_at || run?.created_at);
  const end = Date.parse(run?.updated_at);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  const seconds = Math.round((end - start) / 1000);
  return seconds < 120 ? `${seconds} seconds` : `${Math.round(seconds / 60)} minutes`;
}

/**
 * How far back the finished-run walk reaches. A run is listed by when it was
 * CREATED, and a failure is reported when it FINISHED in the last hour - and
 * the longest job here waits up to 4h45m (deadline-sentinel.yml). So the walk
 * reaches back six hours, and the hour is judged on `updated_at` below.
 */
const LOOKBACK_MS = 6 * 60 * 60 * 1000;

/**
 * GitHub returns at most this many runs for a list filtered by `status` or
 * `created` (REST "List workflow runs for a repository"). A walk that reaches
 * it has not seen the whole list, so it cannot be read as "nothing failed".
 */
export const RUN_LIST_CAP = 1000;

export async function runWatchdog({ owner, repo, token, alertLevel, autoCancel, notifyLogins }) {
  if (alertLevel === "off") {
    console.log("Pipeline alerts are disabled (alertLevel=off). Exiting.");
    return { outcome: "skipped_disabled", stuckRuns: [], failedRuns: [] };
  }

  const ghOpts = { token, throwOnError: true };
  const now = Date.now();

  // EVERY PAGE, not the first. This read one page - 20 finished runs, 30 of
  // each other kind - every 30 minutes, and an acceptance burst finishes more
  // than that between two scans (38 runs in 45 minutes on 2026-10-02), so a
  // failure inside one could fall off the page before any scan saw it. A page
  // that cannot be read throws, which fails this job where it is seen.
  const since = new Date(now - LOOKBACK_MS).toISOString();
  const listRuns = (query) =>
    ghAllItems(`/repos/${owner}/${repo}/actions/runs?${query}&per_page=100`, "workflow_runs", ghOpts);
  const [waitingAll, inProgressAll, completedAll] = await Promise.all([
    listRuns("status=waiting"),
    listRuns("status=in_progress"),
    listRuns(`status=completed&created=${encodeURIComponent(`>=${since}`)}`),
  ]);
  // A list that reached GitHub's cap is not the whole list (RUN_LIST_CAP).
  const capped = [["waiting", waitingAll], ["running", inProgressAll], ["finished", completedAll]]
    .filter(([, runs]) => runs.length >= RUN_LIST_CAP)
    .map(([name]) => name);

  const stuckRuns = [];
  const waitingRuns = waitingAll.filter(watchedRun);
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

  const runningRuns = inProgressAll.filter(watchedRun);
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
  const completedRuns = completedAll.filter(watchedRun);
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
  if (capped.length) console.warn(`Not every run could be read: the ${capped.join(", ")} list reached ${RUN_LIST_CAP}.`);

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

  // A scan that could not read every run cannot be an all-clear, at any alert
  // level: what it did not read may be exactly the failure it exists to report.
  if (capped.length) shouldNotify = true;

  if (!shouldNotify) {
    console.log("No alerting conditions met for configured alert level.");
    return { outcome: "ok", stuckRuns, failedRuns, cancelledRuns, capped };
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

    const ran = ranFor(r);
    const commentBody =
      `${DEDUP_MARKER}${dedupKey}-->\n` +
      `### [ERROR] Pipeline Run Failed: ${r.name || "Workflow"} (#${r.id})\n\n` +
      `${mentions ? `${mentions} - ` : ""}Workflow run **#${r.id}** failed${ran ? ` after running for ${ran}` : ""}.\n\n` +
      `- **Workflow:** [${r.name}](${r.html_url})\n` +
      `- **Event:** \`${r.event}\`\n` +
      `- **Conclusion:** \`${r.conclusion}\`\n` +
      `- **Updated at:** ${r.updated_at || r.created_at}\n`;

    await gh("POST", `/repos/${owner}/${repo}/issues/${issue.number}/comments`, { body: commentBody }, ghOpts);
    console.log(`Posted failed run alert for #${r.id} to issue #${issue.number}.`);
  }

  // Once an hour at most: every scan in a long burst would otherwise say it.
  if (capped.length) {
    const dedupKey = `incomplete-${new Date(now).toISOString().slice(0, 13)}`;
    if (comments.some((c) => c.body?.includes(`${DEDUP_MARKER}${dedupKey}-->`))) {
      console.log("Incomplete-scan warning already posted this hour, skipping.");
    } else {
      const commentBody =
        `${DEDUP_MARKER}${dedupKey}-->\n` +
        `### [WARNING] Pipeline Watchdog could not read every run\n\n` +
        `${mentions ? `${mentions} - ` : ""}GitHub lists at most ${RUN_LIST_CAP} runs per query, and the ` +
        `${capped.join(", ")} list reached that, so this scan cannot say that nothing failed or got stuck. ` +
        `Check the repository's Actions tab.\n`;
      await gh("POST", `/repos/${owner}/${repo}/issues/${issue.number}/comments`, { body: commentBody }, ghOpts);
      console.log(`Posted incomplete-scan warning to issue #${issue.number}.`);
    }
  }

  return { outcome: capped.length ? "incomplete" : "notified", stuckRuns, failedRuns, cancelledRuns, capped };
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
