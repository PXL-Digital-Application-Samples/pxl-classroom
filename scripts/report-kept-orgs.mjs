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

const file = process.env.KEPT_ORGS_FILE || "";
if (!file || !existsSync(file)) {
  console.log("No organization was kept as last published.");
  process.exit(0);
}

const kept = JSON.parse(readFileSync(file, "utf8"));
const [owner, repo] = String(process.env.GITHUB_REPOSITORY || "").split("/");
const day = new Date().toISOString().slice(0, 10);

for (const { org, why } of kept) {
  const posted = await alertOnce({
    owner,
    repo,
    token: process.env.GITHUB_TOKEN,
    notifyLogins: PIPELINE_ALERTS.notify_logins || [],
    dedupKey: `kept-${String(org).toLowerCase()}-${day}`,
    title: `[ALERT] Student pages of ${org} are not being updated`,
    body:
      `The Pages deploy could not read **${org}** (${why}), so its student pages are kept as they were ` +
      `last published, and every other organization's are updated. New assignments and changes in ${org} ` +
      `will not reach its students until it can be read again. The likely cause is the PXL Classroom App ` +
      `no longer having access to \`${org}/${CONTROL_REPO}\`: check the App's repository access in ` +
      `that organization's settings.`,
  });
  console.log(`${org}: ${posted ? "alert posted" : "already alerted today"}.`);
}
