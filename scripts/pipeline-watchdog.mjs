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
import { pagesOutcome } from "../lib/pages-kept.mjs";

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

const isWorkflow = (run, file) => String(run?.path || "").endsWith(`/${file}`);
const finishedAt = (run) => Date.parse(run?.updated_at || run?.created_at || "") || 0;

/** How long the ordinary path (regenerate, then dispatch, then deploy) gets first. */
export const PAGES_GRACE_MS = 10 * 60 * 1000;
/** Failed deploys in a row after which redeploying is a loop, not a cure. */
export const PAGES_FAILURES_TO_STOP = 3;

/**
 * Are the student pages behind, with nothing on its way to fix it?
 *
 * 2026-10-06, during a GitHub incident: a lecturer's publish regenerated the
 * data, the deploy it dispatched failed on one 504, and the student page went
 * live only because the lecturer published again a quarter of an hour later.
 * This watchdog already redeployed after a deploy that HUNG; one that FAILED,
 * or a dispatch that never started one, waited for the next change anywhere.
 *
 * Due when the data was regenerated after the last deploy that brought every
 * page up to date (a regeneration whose dispatch failed counts - its run
 * fails), or the newest deploy did not - it failed, or it kept an
 * organization's old pages because it could not read it (lib/pages-kept.mjs:
 * such a deploy succeeds, and was read as up to date, so one 502 for one org
 * left its new assignment off the site until the next change anywhere). And
 * that is older than the grace, and no deploy is queued, waiting or running.
 * Not due after PAGES_FAILURES_TO_STOP such deploys in a row: each was
 * alerted already, and a fourth would end the same.
 *
 * `deploys` is the deploy workflow's own history (`deployHistory`), each run
 * with `kept`; without it, the deploys among `completed`.
 *
 * @param {{completed?: object[], deploys?: object[]|null, active?: object[], now?: number}} runs
 * @returns {{due: boolean, reason: string}}
 */
export function pagesRedeployDue({ completed = [], deploys = null, active = [], now = Date.now() }) {
  if (active.some((r) => isWorkflow(r, "deploy-frontend.yml"))) return { due: false, reason: "a deploy is on its way" };
  const history = (deploys ?? completed.filter((r) => isWorkflow(r, "deploy-frontend.yml")))
    .filter((r) => r.conclusion !== "cancelled" && r.conclusion !== "skipped")
    .sort((a, b) => finishedAt(b) - finishedAt(a));
  const upToDate = (r) => r.conclusion === "success" && !r.kept;
  const lastOk = history.find(upToDate);
  const lastOkAt = lastOk ? finishedAt(lastOk) : 0;
  const firstOk = history.findIndex(upToDate);
  const streak = firstOk === -1 ? history.length : firstOk;
  if (streak >= PAGES_FAILURES_TO_STOP) {
    return { due: false, reason: `${streak} deploys in a row failed or kept an organization's old pages - alerted, not retried again` };
  }
  const newestRegen = completed
    .filter((r) => isWorkflow(r, "regenerate-dashboard.yml") && (r.conclusion === "success" || r.conclusion === "failure"))
    .map(finishedAt)
    .reduce((a, b) => Math.max(a, b), 0);
  const newest = history[0];
  const newestBehind = newest && !upToDate(newest) ? finishedAt(newest) : 0;
  const behindSince = Math.max(newestRegen > lastOkAt ? newestRegen : 0, newestBehind);
  if (!behindSince) return { due: false, reason: "the pages are as new as the data" };
  if (now - behindSince < PAGES_GRACE_MS) return { due: false, reason: "the ordinary path still has time" };
  if (newestBehind && newestBehind >= newestRegen) {
    return { due: true, reason: newest.kept ? "the newest deploy kept an organization's old pages" : "the newest deploy failed" };
  }
  return { due: true, reason: "the data was regenerated after the last successful deploy" };
}

/**
 * The Pages deploys on main, newest first, from the deploy workflow's own
 * list - not the scan's six-hour window, which forgot a failure as it aged,
 * so a deploy that always fails was retried three times every six hours, for
 * ever (review 2026-10-07). Each run is read by its jobs (one read each): did
 * the pages go live, and did it keep an organization's old ones
 * (`pagesOutcome`). Newest first and only as far as the decision needs: to the
 * first deploy that brought every page up to date, or PAGES_FAILURES_TO_STOP
 * that did not.
 */
export async function deployHistory({ owner, repo, ghOpts }) {
  const res = await gh(
    "GET",
    `/repos/${owner}/${repo}/actions/workflows/deploy-frontend.yml/runs?branch=main&status=completed&per_page=20`,
    null,
    ghOpts,
  );
  const runs = (res.data?.workflow_runs || [])
    // Ours: a fork's pull request can run a workflow file by this name too.
    .filter((r) => r.event === "push" || r.event === "workflow_dispatch")
    .sort((a, b) => finishedAt(b) - finishedAt(a));
  const out = [];
  let behind = 0;
  for (const r of runs) {
    if (r.conclusion === "cancelled" || r.conclusion === "skipped") continue;
    // By the job that puts the pages live, and whether it kept an org's old
    // ones (lib/pages-kept.mjs) - never the run's own conclusion, which a
    // failed beta build sets to failure over pages that went out.
    const jobs = await ghAllItems(`/repos/${owner}/${repo}/actions/runs/${r.id}/jobs?per_page=100`, "jobs", ghOpts);
    const { conclusion, kept } = pagesOutcome(r, jobs);
    if (conclusion === "cancelled" || conclusion === "skipped") continue;
    out.push({ ...r, conclusion, kept });
    if (conclusion === "success" && !kept) break;
    if (++behind >= PAGES_FAILURES_TO_STOP) break;
  }
  return out;
}

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
  const [waitingAll, inProgressAll, completedAll, queuedAll] = await Promise.all([
    listRuns("status=waiting"),
    listRuns("status=in_progress"),
    listRuns(`status=completed&created=${encodeURIComponent(`>=${since}`)}`),
    // Only to know whether a deploy is already on its way (pagesRedeployDue).
    listRuns("status=queued"),
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
  // A cancelled stuck deploy whose replacement was dispatched. Only once the
  // dispatch went through: it was assumed, so a failed one was logged as
  // "re-dispatched" and nothing deployed again (review 2026-10-07).
  let deployRedispatched = false;
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
            deployRedispatched = true;
          }
        } catch (err) {
          console.warn(`Failed to auto-cancel or re-dispatch run #${r.id}: ${err.message}`);
        }
      }
    }
  }

  // Student pages behind the data, with nothing on its way: deploy them. A
  // stuck deploy cancelled above was re-dispatched already, so it is on its way.
  //
  // NOTHING HERE MAY STOP THE ALERTS BELOW. The dispatch threw straight out of
  // the scan, so during an incident a 502 on it skipped every stuck and failed
  // run's alert, scan after scan, until those aged out unreported (review
  // 2026-10-07). A dispatch that fails is itself alerted.
  let pagesRedeploy = { due: false, reason: "not checked" };
  if (autoCancel) {
    if (deployRedispatched) {
      pagesRedeploy = { due: false, reason: "re-dispatched after cancelling a stuck deploy" };
    } else {
      let deploys = null;
      try {
        deploys = await deployHistory({ owner, repo, ghOpts });
      } catch (err) {
        // The scan's own list still answers, without knowing which deploy kept
        // an organization's pages.
        console.warn(`Could not read the deploy history (${err.message}); judging from this scan's runs.`);
      }
      pagesRedeploy = pagesRedeployDue({
        completed: completedAll.filter(watchedRun),
        deploys,
        active: [...waitingAll, ...inProgressAll, ...queuedAll].filter(watchedRun),
        now,
      });
    }
    console.log(`Student pages: ${pagesRedeploy.due ? "redeploying" : "no redeploy"} - ${pagesRedeploy.reason}.`);
    if (pagesRedeploy.due) {
      try {
        await gh("POST", `/repos/${owner}/${repo}/actions/workflows/deploy-frontend.yml/dispatches`, { ref: "main" }, ghOpts);
      } catch (err) {
        pagesRedeploy = { ...pagesRedeploy, failed: err.message };
        console.warn(`Could not dispatch the Pages deploy: ${err.message}`);
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
  // Student pages behind, and the deploy that would fix them refused.
  if (pagesRedeploy.failed) shouldNotify = true;

  if (!shouldNotify) {
    console.log("No alerting conditions met for configured alert level.");
    return { outcome: "ok", stuckRuns, failedRuns, cancelledRuns, capped, pagesRedeploy };
  }

  const issue = await trackingIssue(owner, repo, ghOpts);

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

  // Once an hour at most, like the warning above: the next scan tries again.
  if (pagesRedeploy.failed) {
    const dedupKey = `pages-redeploy-${new Date(now).toISOString().slice(0, 13)}`;
    if (!comments.some((c) => c.body?.includes(`${DEDUP_MARKER}${dedupKey}-->`))) {
      const commentBody =
        `${DEDUP_MARKER}${dedupKey}-->\n` +
        `### [ALERT] Student pages are behind, and the deploy could not be started\n\n` +
        `${mentions ? `${mentions} - ` : ""}The student pages need deploying (${pagesRedeploy.reason}), and GitHub ` +
        `refused the dispatch: ${pagesRedeploy.failed}. The next scan tries again; to deploy now, run ` +
        `"Deploy frontend to Pages" from the repository's Actions tab.\n`;
      await gh("POST", `/repos/${owner}/${repo}/issues/${issue.number}/comments`, { body: commentBody }, ghOpts);
      console.log(`Posted failed-redeploy alert to issue #${issue.number}.`);
    }
  }

  return { outcome: capped.length ? "incomplete" : "notified", stuckRuns, failedRuns, cancelledRuns, capped, pagesRedeploy };
}

/** The hub's alert issue, found or created - one place, whoever alerts. */
export async function trackingIssue(owner, repo, ghOpts) {
  const openIssues = await ghAll(
    `/repos/${owner}/${repo}/issues?labels=pxl-tracking&state=open&per_page=100`,
    ghOpts
  );
  const found = openIssues.find((i) => i.title === TRACKING_ISSUE_TITLE && !i.pull_request);
  if (found) return found;
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
  return created.data;
}

/**
 * Post one alert on the hub's alert issue, unless one with this key is there
 * already. For alerts raised outside a watchdog scan (scripts/report-kept-orgs.mjs).
 *
 * @returns {Promise<boolean>} whether it was posted
 */
export async function alertOnce({ owner, repo, token, notifyLogins = [], dedupKey, title, body }) {
  const ghOpts = { token, throwOnError: true };
  const issue = await trackingIssue(owner, repo, ghOpts);
  const comments = await ghAll(`/repos/${owner}/${repo}/issues/${issue.number}/comments?per_page=100`, ghOpts);
  if (comments.some((c) => c.body?.includes(`${DEDUP_MARKER}${dedupKey}-->`))) return false;
  const mentions = notifyLogins.map((l) => `@${l}`).join(" ");
  await gh(
    "POST",
    `/repos/${owner}/${repo}/issues/${issue.number}/comments`,
    { body: `${DEDUP_MARKER}${dedupKey}-->\n### ${title}\n\n${mentions ? `${mentions} - ` : ""}${body}\n` },
    ghOpts
  );
  return true;
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
