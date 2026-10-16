#!/usr/bin/env node
// PXL Classroom - LIVE: the stop a moved deadline no longer wants (review
// 2026-10-16, R7-1). Not part of `npm test`.
//
// The sentinel stopped a cohort at the old instant, the lecturer moved the
// deadline later before any lock record, and the finalize's queue - reading
// the new deadline - queued nothing. The publish the save dispatches must let
// go of the stop: `scripts/release-stale-stop.mjs`, last in
// publish-assignment.yml, on a token minted only for it.
//
// Racing the real sentinel for that ordering is a coin toss, so the state is
// made the way the sentinel makes it and nothing else differs: the
// organization ruleset this system writes (lib/submission-lock.mjs, with the
// App as bypass actor), and a fired timeline at an instant before the
// deadline, beside no lock record.
//
//   node tests/live/drill.mjs start --minutes 60
//   node tests/live/stale-stop.mjs <drill-id>          (at least 25 minutes before its deadline)
//   node tests/live/drill.mjs verify <drill-id> --wait (the real stop and finalize, after a release)
//   node tests/live/drill.mjs cleanup <drill-id>
//
// WRITES on pxl-classroom-testbed: the drill's organization ruleset (active,
// then released by the workflow), `lockdowns/<id>/sentinel-live-stale.json`
// (removed again at the end, so the drill's own sentinel and finalize run as
// they always do), one file in STUDENT_A's repository, two publishes.

import { api, accounts, checkAccounts, decode, die, loadEnv, reporter, sleep } from "./live-kit.mjs";
import { CONTROL_REPO, HUB_OWNER, HUB_REPO_NAME } from "../../lib/deployment.mjs";
import { ensureOrgSubmissionLock, findOrgSubmissionLock, resolveAppId, targetedRepositoryIds } from "../../lib/submission-lock.mjs";
import { parse } from "yaml";

const ORG = process.env.DRILL_ORG || "pxl-classroom-testbed";
const ID = process.argv[2];
if (!ID) die("usage: node tests/live/stale-stop.mjs <drill-id>");
const ACCOUNTS = accounts(loadEnv());
const r = reporter();
const L = ACCOUNTS.LECTURER.token;
const request = (method, path, body) => api(path, { token: L, method, body });
const hub = `/repos/${HUB_OWNER}/${HUB_REPO_NAME}/actions/workflows/publish-assignment.yml`;

async function controlFile(path) {
  const res = await api(`/repos/${ORG}/${CONTROL_REPO}/contents/${path}`, { token: L });
  return res.ok ? decode(res.data.content) : null;
}

/** A write to STUDENT_A's submission branch, as the student: refused under the stop. */
async function studentWrite(repo, branch, label) {
  const path = `stale-stop-${label}-${Date.now()}.txt`;
  const res = await api(`/repos/${ORG}/${repo}/contents/${path}`, {
    token: ACCOUNTS.STUDENT_A.token, method: "PUT",
    body: { message: `live stale-stop: ${label}`, content: Buffer.from(label).toString("base64"), branch },
  });
  return res;
}

/** Publish the drill as the lecturer's save does, and return its finished run. */
async function publish() {
  const since = new Date(Date.now() - 5_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const res = await api(`${hub}/dispatches`, { token: L, method: "POST",
    body: { ref: "main", inputs: { org: ORG, assignment_id: ID, regenerate_invite: "false", prior_state: "published" } } });
  if (!res.ok) die(`publish dispatch: HTTP ${res.status}`);
  for (let waited = 0; waited < 12 * 60_000; waited += 10_000) {
    await sleep(10_000);
    const runs = (await api(`${hub}/runs?created=${encodeURIComponent(`>=${since}`)}&per_page=20`, { token: L })).data?.workflow_runs || [];
    const run = runs.find((x) => x.actor?.login?.toLowerCase() === ACCOUNTS.LECTURER.login.toLowerCase());
    if (run?.status === "completed") return run;
  }
  die("publish did not finish in 12 minutes");
}

async function steps(run) {
  const jobs = (await api(`/repos/${HUB_OWNER}/${HUB_REPO_NAME}/actions/runs/${run.id}/jobs`, { token: L })).data?.jobs || [];
  return Object.fromEntries(jobs.flatMap((j) => j.steps || []).map((s) => [s.name, s.conclusion]));
}

await checkAccounts(ACCOUNTS, r);
const doc = parse((await controlFile(`assignments/${ID}.yml`)) ?? die(`${ID}: no assignment`));
if (!(Date.parse(doc.deadline_at) > Date.now() + 25 * 60_000)) die(`${ID}: the deadline must be more than 25 minutes ahead (${doc.deadline_at})`);
if (await controlFile(`lockdowns/${ID}/lockdown-record.json`)) die(`${ID}: has a lock record - that is Reopen's, not this`);
const branch = String(doc.submission_ref || "refs/heads/main").replace("refs/heads/", "");

const dir = await api(`/repos/${ORG}/${CONTROL_REPO}/contents/repositories/${ID}`, { token: L });
const records = [];
for (const f of (dir.ok ? dir.data : []).filter((x) => x.name.endsWith(".json"))) {
  records.push(JSON.parse(await controlFile(`repositories/${ID}/${f.name}`)));
}
const mine = records.find((x) => String(x.github_login).toLowerCase() === ACCOUNTS.STUDENT_A.login.toLowerCase());
if (!mine) die(`${ID}: STUDENT_A has no repository record`);
const repo = String(mine.repo_name).split("/").pop();
r.ok(`${records.length} repositor${records.length === 1 ? "y" : "ies"}; STUDENT_A's is ${repo}`);

// 1. The stop, as the sentinel applies it.
const appId = await resolveAppId(request);
const lock = await ensureOrgSubmissionLock(request, {
  org: ORG, assignmentId: ID, submissionRef: doc.submission_ref || "refs/heads/main", appId,
  repositoryIds: records.map((x) => x.repo_id), enforcement: "active",
});
if (!lock.ok) die(`could not apply the stop: ${lock.reason}`);
r.ok(`organization stop ${lock.action}: ruleset ${lock.rulesetId}`);
const timeline = { schema_version: 1, assignment_id: ID, outcome: "fired", due: true, stop: "done",
  deadline_at: new Date(Date.now() - 5 * 60_000).toISOString(), samples: [], note: "tests/live/stale-stop.mjs" };
const put = await api(`/repos/${ORG}/${CONTROL_REPO}/contents/lockdowns/${ID}/sentinel-live-stale.json`, { token: L, method: "PUT",
  body: { message: `live stale-stop: a fired timeline for ${ID}`, content: Buffer.from(JSON.stringify(timeline, null, 2)).toString("base64") } });
if (!put.ok) die(`timeline: HTTP ${put.status}`);
r.ok("a fired timeline at an instant before the deadline, no lock record");

await sleep(5_000);
const refused = await studentWrite(repo, branch, "under-the-stop");
refused.ok ? r.bad(`the stop did not hold: STUDENT_A wrote to ${repo} (HTTP ${refused.status})`) : r.ok(`under the stop STUDENT_A is refused (HTTP ${refused.status})`);

// 2. The publish a reopening save dispatches.
const run = await publish();
const s = await steps(run);
run.conclusion === "success" ? r.ok(`publish ${run.conclusion}: ${run.html_url}`) : r.bad(`publish ${run.conclusion}: ${run.html_url}`);
s["Look for a stop the deadline no longer wants"] === "success" ? r.ok("the check ran") : r.bad(`the check: ${s["Look for a stop the deadline no longer wants"]}`);
s["Mint App token for the stop release"] === "success" ? r.ok("its own token was minted") : r.bad(`the token: ${s["Mint App token for the stop release"]}`);
s["Release the stop"] === "success" ? r.ok("the release ran") : r.bad(`the release: ${s["Release the stop"]}`);

const after = await findOrgSubmissionLock(request, { org: ORG, assignmentId: ID });
const holds = after.ruleset?.enforcement === "active" ? targetedRepositoryIds(after.ruleset).filter((x) => records.some((y) => y.repo_id === x)) : [];
holds.length === 0 ? r.ok(`the organization stop holds nobody (${after.ruleset?.enforcement ?? "none"})`) : r.bad(`still stopped: ${holds.join(", ")}`);
await sleep(5_000);
const written = await studentWrite(repo, branch, "after-the-release");
written.ok ? r.ok("STUDENT_A can push again") : r.bad(`STUDENT_A is still refused (HTTP ${written.status} ${written.data?.message ?? ""})`);

// 3. Again: idempotent, nothing left to release, still green.
const again = await publish();
const s2 = await steps(again);
again.conclusion === "success" && s2["Release the stop"] === "success"
  ? r.ok(`a second publish releases nothing and stays green: ${again.html_url}`)
  : r.bad(`second publish ${again.conclusion}, release ${s2["Release the stop"]}: ${again.html_url}`);

// 4. Leave the drill as it was: its own sentinel stops it at its deadline.
const meta = await api(`/repos/${ORG}/${CONTROL_REPO}/contents/lockdowns/${ID}/sentinel-live-stale.json`, { token: L });
const removed = meta.ok && (await api(`/repos/${ORG}/${CONTROL_REPO}/contents/lockdowns/${ID}/sentinel-live-stale.json`, {
  token: L, method: "DELETE", body: { message: `live stale-stop: remove the made timeline for ${ID}`, sha: meta.data.sha } })).ok;
removed ? r.ok("the made timeline is removed; the drill goes on to its deadline") : r.bad("the made timeline could not be removed - delete it before drill verify");

console.log(r.failures() ? `\n${r.failures()} failure(s)` : "\nall ok");
process.exit(r.failures() ? 1 : 0);
