#!/usr/bin/env node
// PXL Classroom - LIVE: the nightly finds a student repository no record names
// (review S7, TV-11). One record on an ACTIVE drill is removed, the nightly is
// run for the drill org alone, its log must name that repository, and the
// record is put back exactly as it was, whatever happened in between.
//
//   node tests/live/unrecorded-repo.mjs <active drill id> <login>
//
// The record is the evidence everything else reads (lockdown, preservation,
// grading); it is gone for the length of one nightly run and restored in a
// `finally`.

import { accounts, api, die, loadEnv, reporter, sleep } from "./live-kit.mjs";
import { CONTROL_REPO, HUB_OWNER, HUB_REPO_NAME } from "../../lib/deployment.mjs";

const ORG = process.env.DRILL_ORG || "pxl-classroom-testbed";
const HUB = `/repos/${HUB_OWNER}/${HUB_REPO_NAME}`;
const { LECTURER } = accounts(loadEnv());
const T = LECTURER.token;
const [id, login] = process.argv.slice(2);
if (!id || !login) die("usage: node tests/live/unrecorded-repo.mjs <active drill id> <login>");
const r = reporter();

const path = `repositories/${id}/${login.toLowerCase()}.json`;
const at = `/repos/${ORG}/${CONTROL_REPO}/contents/${path}`;
const stored = await api(at, { token: T });
if (!stored.ok) die(`${path}: HTTP ${stored.status}`);
const original = stored.data.content.replace(/\n/g, "");
const repoName = JSON.parse(Buffer.from(original, "base64").toString("utf8")).repo_name;

try {
  const del = await api(at, { token: T, method: "DELETE", body: { message: `live probe: ${login}'s record removed for one nightly run`, sha: stored.data.sha } });
  if (!del.ok) die(`could not remove ${path}: HTTP ${del.status}`);
  r.ok(`removed ${path} (${repoName})`);

  const since = new Date(Date.now() - 5_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const go = await api(`${HUB}/actions/workflows/daily-activity.yml/dispatches`, { token: T, method: "POST", body: { ref: "main", inputs: { org: ORG } } });
  if (!go.ok) die(`dispatch: HTTP ${go.status}`);
  let run = null;
  for (let waited = 0; waited < 20 * 60_000 && run?.status !== "completed"; waited += 15_000) {
    await sleep(15_000);
    const runs = (await api(`${HUB}/actions/workflows/daily-activity.yml/runs?created=${encodeURIComponent(`>=${since}`)}&per_page=20`, { token: T })).data?.workflow_runs || [];
    run = runs.find((x) => x.actor?.login?.toLowerCase() === LECTURER.login.toLowerCase()) || null;
  }
  if (run?.status !== "completed") die("the nightly did not finish in 20 minutes");
  console.log(`  ${run.html_url} (${run.conclusion})`);
  const jobs = (await api(`${HUB}/actions/runs/${run.id}/jobs?per_page=100`, { token: T })).data?.jobs || [];
  let log = "";
  for (const job of jobs.filter((j) => j.name.includes(ORG) || !j.name.includes("("))) log += (await api(`${HUB}/actions/jobs/${job.id}/logs`, { token: T })).data?.raw ?? "";
  // The line scripts/find-unrecorded-repos.mjs prints for each one it finds
  // (`<assignment>: <owner/repo> (<login>)`) - not merely the name somewhere in
  // the log, which the collect names too.
  const found = log.split("\n").some((line) => line.includes(`${id}: ${repoName} (${login})`));
  if (found) r.ok(`the nightly names ${repoName} (${login}) as a repository no record names`);
  else r.bad(`the nightly's "Find student repositories with no record" step does not name ${repoName}`);
} finally {
  const now = await api(at, { token: T });
  const back = await api(at, {
    token: T, method: "PUT",
    body: { message: `live probe: ${login}'s record restored`, content: original, ...(now.ok ? { sha: now.data.sha } : {}) },
  });
  if (back.ok) r.ok(`restored ${path} exactly`);
  else r.bad(`COULD NOT RESTORE ${path} (HTTP ${back.status}) - put it back by hand from the commit before "record removed"`);
}
console.log(`\n${r.failures() === 0 ? "All checks passed." : `${r.failures()} check(s) failed.`}\n`);
process.exit(r.failures() === 0 ? 0 : 1);
