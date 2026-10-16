#!/usr/bin/env node
// PXL Classroom - LIVE: an extension's end is watched (review 2026-10-16,
// R7-12, R7-19). Not part of `npm test`.
//
//   node tests/live/drill.mjs start --minutes 20
//   node tests/live/extension-sentinel.mjs <drill-id>      (right after; it waits for both instants)
//   node tests/live/drill.mjs cleanup <drill-id>
//
// STUDENT_B is given an extension to 12 minutes after the drill's deadline, as
// the Admin Panel writes it, and the sentinel is armed the way granting one
// does. Then, on the testbed:
//   - the arming plans a sentinel at the extension's end, for STUDENT_B;
//   - at the deadline STUDENT_A is locked and STUDENT_B is deferred, and can
//     still push while STUDENT_A cannot;
//   - at the extension's end STUDENT_B is locked, credited to that sentinel's
//     stop (lockdown_at = the end), with a delay figure near zero.
//
// WRITES on pxl-classroom-testbed: overrides/<id>/<STUDENT_B>.json, two files
// pushed by the students, one sentinel dispatch.

import { api, accounts, checkAccounts, decode, die, loadEnv, reporter, sleep } from "./live-kit.mjs";
import { CONTROL_REPO, HUB_OWNER, HUB_REPO_NAME } from "../../lib/deployment.mjs";
import { sentinelKey } from "../../scripts/find-armable.mjs";
import { parse } from "yaml";

const ORG = process.env.DRILL_ORG || "pxl-classroom-testbed";
const ID = process.argv[2];
if (!ID) die("usage: node tests/live/extension-sentinel.mjs <drill-id>");
const ACCOUNTS = accounts(loadEnv());
const r = reporter();
const L = ACCOUNTS.LECTURER.token;
const MIN = 60_000;

async function control(path) {
  const res = await api(`/repos/${ORG}/${CONTROL_REPO}/contents/${path}`, { token: L });
  return res.ok ? decode(res.data.content) : null;
}
async function record() {
  const text = await control(`lockdowns/${ID}/lockdown-record.json`);
  return text ? JSON.parse(text) : null;
}
const rowOf = (rec, login) => (rec?.results || []).find((x) => String(x.github_login).toLowerCase() === login.toLowerCase());
async function waitFor(what, fn, { until, every = 30_000 }) {
  while (Date.now() < until) {
    const v = await fn();
    if (v) return v;
    await sleep(every);
  }
  r.bad(`${what}: not by ${new Date(until).toISOString()}`);
  return null;
}
async function push(student, repo, branch, label) {
  return api(`/repos/${ORG}/${repo}/contents/ext-sentinel-${label}-${Date.now()}.txt`, {
    token: student.token, method: "PUT",
    body: { message: `live extension-sentinel: ${label}`, content: Buffer.from(label).toString("base64"), branch },
  });
}

await checkAccounts(ACCOUNTS, r);
const doc = parse((await control(`assignments/${ID}.yml`)) ?? die(`${ID}: no assignment`));
const deadline = Date.parse(doc.deadline_at);
if (!(deadline > Date.now() + 5 * MIN)) die(`${ID}: the deadline must be at least 5 minutes ahead (${doc.deadline_at})`);
const end = new Date(deadline + 12 * MIN).toISOString();
const branch = String(doc.submission_ref || "refs/heads/main").replace("refs/heads/", "");
const repoOf = async (login) => {
  const rec = JSON.parse((await control(`repositories/${ID}/${login}.json`)) ?? "null");
  return rec ? String(rec.repo_name).split("/").pop() : null;
};
const A = ACCOUNTS.STUDENT_A;
const B = ACCOUNTS.STUDENT_B;
const repoA = await repoOf(A.login);
const repoB = await repoOf(B.login);
if (!repoA || !repoB) die("both students need a repository record - run drill.mjs start first");

// 1. The extension, as the Admin Panel writes it.
const override = { schema_version: 1, assignment_id: ID, github_login: B.login,
  overrides: [{ type: "deadline_extension", value: end, reason: "live extension-sentinel", overridden_by: "admin-panel", overridden_at: new Date().toISOString() }] };
const put = await api(`/repos/${ORG}/${CONTROL_REPO}/contents/overrides/${ID}/${B.login}.json`, { token: L, method: "PUT",
  body: { message: `live: extension for ${B.login} on ${ID}`, content: Buffer.from(JSON.stringify(override, null, 2)).toString("base64") } });
put.ok ? r.ok(`${B.login} extended to ${end}`) : die(`override: HTTP ${put.status}`);

// 2. Armed as granting one arms it.
const since = new Date(Date.now() - 5_000).toISOString().replace(/\.\d{3}Z$/, "Z");
const hub = `/repos/${HUB_OWNER}/${HUB_REPO_NAME}/actions/workflows/deadline-sentinel.yml`;
const disp = await api(`${hub}/dispatches`, { token: L, method: "POST", body: { ref: "main", inputs: { org: ORG } } });
disp.ok ? r.ok("sentinel arming dispatched") : die(`dispatch: HTTP ${disp.status}`);
const armRun = await waitFor("the arming run", async () => {
  const runs = (await api(`${hub}/runs?created=${encodeURIComponent(`>=${since}`)}&per_page=20`, { token: L })).data?.workflow_runs || [];
  return runs.find((x) => x.actor?.login?.toLowerCase() === ACCOUNTS.LECTURER.login.toLowerCase()) ?? null;
}, { until: Date.now() + 5 * MIN, every: 10_000 });
if (armRun) {
  const jobs = await waitFor("its watch jobs", async () => {
    const j = (await api(`/repos/${HUB_OWNER}/${HUB_REPO_NAME}/actions/runs/${armRun.id}/jobs?per_page=50`, { token: L })).data?.jobs || [];
    return j.some((x) => /watch/.test(x.name)) ? j : null;
  }, { until: Date.now() + 8 * MIN, every: 15_000 });
  const keyEnd = sentinelKey(end);
  const names = (jobs || []).map((x) => x.name);
  names.some((n) => n.includes(keyEnd)) ? r.ok(`a sentinel is watching the extension's end (${keyEnd})`) : r.bad(`no watch job for ${keyEnd}: ${names.join(" | ")}`);
  names.some((n) => n.includes(sentinelKey(doc.deadline_at))) ? r.ok("and one the deadline") : r.note(`no watch job for the deadline in this run (another firing may hold it): ${names.join(" | ")}`);
}

// 3. After the deadline: A locked, B deferred and still able to push.
console.log(`\n  waiting for the deadline ${doc.deadline_at} and its finalize...`);
await sleep(Math.max(0, deadline - Date.now()));
const first = await waitFor("the lock record at the deadline", async () => {
  const rec = await record();
  return rec && rowOf(rec, A.login)?.lock_method && rowOf(rec, B.login)?.deferred_until ? rec : null;
}, { until: deadline + 11 * MIN });
if (first) {
  r.ok(`${A.login} locked (${rowOf(first, A.login).lock_method}) at ${rowOf(first, A.login).lockdown_at}`);
  r.ok(`${B.login} deferred until ${rowOf(first, B.login).deferred_until}`);
  const a = await push(A, repoA, branch, "after-deadline");
  a.ok ? r.bad(`${A.login} could still push after the deadline`) : r.ok(`${A.login} is refused after the deadline (HTTP ${a.status})`);
  const b = await push(B, repoB, branch, "inside-extension");
  b.ok ? r.ok(`${B.login} can push inside the extension`) : r.bad(`${B.login} is refused inside the extension (HTTP ${b.status} ${b.data?.message ?? ""})`);
}

// 4. After the extension's end: B locked by the extension's sentinel.
console.log(`\n  waiting for the extension's end ${end}...`);
await sleep(Math.max(0, Date.parse(end) - Date.now()));
const second = await waitFor("B's lock at the extension's end", async () => {
  const rec = await record();
  return rowOf(rec, B.login)?.lock_method ? rec : null;
}, { until: Date.parse(end) + 14 * MIN });
if (second) {
  const row = rowOf(second, B.login);
  row.lockdown_at === new Date(end).toISOString()
    ? r.ok(`${B.login} locked at the extension's end, credited to its sentinel (${row.lockdown_at})`)
    : r.bad(`${B.login} locked at ${row.lockdown_at}, not at the extension's end ${end} - the nightly, not the sentinel?`);
  Number.isFinite(row.uncertainty_seconds) && row.uncertainty_seconds >= 0 && row.uncertainty_seconds < 120
    ? r.ok(`delay figure ${row.uncertainty_seconds}s`) : r.bad(`delay figure ${row.uncertainty_seconds}`);
  const b = await push(B, repoB, branch, "after-extension");
  b.ok ? r.bad(`${B.login} could still push after the extension`) : r.ok(`${B.login} is refused after the extension (HTTP ${b.status})`);
  const timeline = await control(`lockdowns/${ID}/sentinel-${sentinelKey(end)}.json`);
  timeline ? r.ok("the extension's sentinel wrote its timeline") : r.bad("no timeline for the extension's sentinel");
}

console.log(r.failures() ? `\n${r.failures()} failure(s)` : "\nall ok");
process.exit(r.failures() ? 1 : 0);
