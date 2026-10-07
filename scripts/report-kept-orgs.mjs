#!/usr/bin/env node
// PXL Classroom - tell an administrator which organizations' student pages a
// deploy kept as they were.
//
// scripts/fetch-pages-data.mjs keeps an organization it cannot read as the
// previous deployment published it, so one organization's fault no longer
// stops every other one's student pages. The price is that this one's new
// assignments and changes do not reach its students until it can be read, and
// the deploy itself succeeds - so nothing else would say so. One alert per
// organization per day, on the hub's alert issue, beside the watchdog's.
//
// Inputs via env: KEPT_ORGS_FILE (written by fetch-pages-data.mjs), GITHUB_TOKEN,
// GITHUB_REPOSITORY.

import { existsSync, readFileSync } from "node:fs";
import { alertOnce } from "./pipeline-watchdog.mjs";
import { CONTROL_REPO, PIPELINE_ALERTS } from "../lib/deployment.mjs";

/**
 * Post one alert per kept organization. Never throws: AN ALERT THAT CANNOT BE
 * POSTED MUST NOT STOP THE DEPLOY. It ran in the build job with nothing to
 * catch it, so during the very kind of GitHub incident that keeps an org, one
 * 502 on this comment failed the deploy of every organization (review
 * 2026-10-07). A warning in the run instead.
 *
 * @param {{kept: Array<{org: string, why: string}>, owner: string, repo: string, token: string,
 *          alerts?: {level?: string, notify_logins?: string[]}, day?: string, log?: (line: string) => void}} a
 * @returns {Promise<Array<{org: string, outcome: "posted"|"already"|"failed"|"off"}>>}
 */
export async function reportKeptOrgs({ kept, owner, repo, token, alerts = PIPELINE_ALERTS, day = new Date().toISOString().slice(0, 10), log = console.log }) {
  // Alerts switched off are off here too, as they are for the watchdog. The
  // run's own warning (fetch-pages-data.mjs) still says it.
  if (alerts?.level === "off") {
    log(`Pipeline alerts are off: not posting about ${kept.map((k) => k.org).join(", ")}.`);
    return kept.map(({ org }) => ({ org, outcome: "off" }));
  }
  const results = [];
  for (const { org, why } of kept) {
    try {
      const posted = await alertOnce({
        owner,
        repo,
        token,
        notifyLogins: alerts?.notify_logins || [],
        dedupKey: `kept-${String(org).toLowerCase()}-${day}`,
        title: `[ALERT] Student pages of ${org} are not being updated`,
        body:
          `The Pages deploy could not read **${org}** (${why}), so its student pages are kept as they were ` +
          `last published, and every other organization's are updated. New assignments and changes in ${org} ` +
          `will not reach its students until it can be read again; the watchdog deploys again up to three times. ` +
          `If it keeps happening, check that the PXL Classroom App is installed on ${org} and that its ` +
          `repository access includes \`${org}/${CONTROL_REPO}\`.`,
      });
      log(`${org}: ${posted ? "alert posted" : "already alerted today"}.`);
      results.push({ org, outcome: posted ? "posted" : "already" });
    } catch (err) {
      log(`::warning::Could not post the alert that ${org}'s student pages were kept as they were: ${err?.message || err}`);
      results.push({ org, outcome: "failed" });
    }
  }
  return results;
}

// CLI entry point
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  const file = process.env.KEPT_ORGS_FILE || "";
  if (!file || !existsSync(file)) {
    console.log("No organization was kept as last published.");
  } else {
    const [owner, repo] = String(process.env.GITHUB_REPOSITORY || "").split("/");
    await reportKeptOrgs({ kept: JSON.parse(readFileSync(file, "utf8")), owner, repo, token: process.env.GITHUB_TOKEN });
  }
}
