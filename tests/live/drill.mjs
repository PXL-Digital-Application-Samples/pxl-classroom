#!/usr/bin/env node
// PXL Classroom - LIVE deadline drill. Not part of `npm test`.
//
// Takes one fresh assignment through its whole life on a real org, with the
// real accounts in .env.test, so a change to the jobs that run an exam can be
// proven the same day instead of at the next real deadline:
//
//   node tests/live/drill.mjs start [--minutes 45] [--repo-lock]
//       create and publish drill-<utc stamp> (individual, late work blocked,
//       lock on), accept it as both students with their invitation labels,
//       push one commit each, have the lecturer refused, retry one student.
//       --repo-lock locks with repository rulesets and demotion instead.
//
//   node tests/live/drill.mjs verify <assignment-id> [--wait] [--timeout 40]
//       after the deadline: the sentinel stopped writes, the lock method is the
//       one the org's plan and the assignment allow, a late push is refused,
//       both submissions are preserved, the report says on-time, the broker is
//       closed, and a retry cannot hand back a locked repository
//
//   node tests/live/drill.mjs migrate <assignment-id>
//       after verify on a --repo-lock drill: run migrate-org-lock for real and
//       check the organization ruleset, the disabled repository rulesets and
//       the rewritten record
//
//   node tests/live/drill.mjs cleanup <assignment-id>... | cleanup --all
//       delete finished drills the way the Admin Panel deletes an assignment.
//       One run per organization at a time: a second one is refused while the
//       lock ref in the control repository is held.
//
//   node tests/live/drill.mjs cleanup --break-lock
//       clear that lock after a cleanup died holding it. Deletes nothing else.
//
// WHY A FRESH ASSIGNMENT EVERY TIME. Finalize locks and preserves an assignment
// once, so a second drill against the same one proves nothing about a job that
// changed in between. Each run leaves a public broker, two student repositories
// and an archive on the org; delete them from the Admin Panel.
//
// THE PLAN DECIDES WHAT IS PROVEN. A free organization cannot hold a ruleset on
// a private repository, so lockdown degrades organization ruleset -> repository
// ruleset -> demotion and still reports `locked`. A narrowed token that lost the
// ruleset permission degrades the SAME way, silently, on a Team organization.
// So verify expects `org-ruleset` on Team and `demotion` on free, per row, and a
// free org's drill says out loud that it did not exercise rulesets.
//
// Point a worktree at the main checkout's credentials with LIVE_ENV_FILE.

import { hostname } from "node:os";
import { basename } from "node:path";

import { parse, stringify } from "yaml";

import { buildAssignmentDoc, utcToLocalInput } from "../../lib/assignment-doc.mjs";
import { validateAgainst } from "../../lib/validate.mjs";
import { brokerRepoName } from "../../lib/broker-repo.mjs";
import { resolveArchiveRepo, archiveBranchName, reportArchiveRepo } from "../../lib/archive-repo.mjs";
import {
  ASSIGNMENT_OWNED_DIRS, DASHBOARD_PATH, assignmentIdFromFile, assignmentPath, gradingSummaryPath,
  reportCsvPath, reportPath, retiredDir, retiredManifestPath,
} from "../../lib/control-layout.mjs";
import { buildRetiredManifest } from "../../lib/retired-manifest.mjs";
import { commitWithRebase } from "../../lib/gittree.mjs";
import { linkSecretFrom, parseInviteFields } from "../../lib/invite-token-format.mjs";
import { normalizeLogin } from "../../lib/github-login.mjs";
import { INVITED_LABEL, REJECTED_LABEL } from "../../lib/acceptance-labels.mjs";
import { deadlineIsImminent, SENTINEL_ARM_WINDOW_MS } from "../../lib/sentinel-window.mjs";
import { CONTROL_REPO, HUB_OWNER, HUB_REPO_NAME, TIMEZONE } from "../../lib/deployment.mjs";
import { usesOrgScope, demotesAfterStop } from "../../lib/lock-scope.mjs";
import { findOrgSubmissionLock, findSubmissionLock, targetedRepositoryIds } from "../../lib/submission-lock.mjs";
import {
  accounts, acceptInvitation, api, checkAccounts, checkOrg, decode, die, loadEnv,
  openAcceptanceIssue, reporter, signAcceptance, sleep,
} from "./live-kit.mjs";
import { CLEANUP_LOCK_REF, acquireCleanupLock, breakCleanupLock, releaseCleanupLock } from "./cleanup-lock.mjs";
import { deletePlanStale } from "./cleanup-plan.mjs";

const ORG = process.env.DRILL_ORG || "pxl-classroom-testbed";
const TEMPLATE = process.env.DRILL_TEMPLATE || "starter-template";
const HUB = `${HUB_OWNER}/${HUB_REPO_NAME}`;
const ON_TIME_MESSAGE = "drill: on-time submission";
// Written on every drill assignment; cleanup refuses anything without it.
const DRILL_DESCRIPTION = "Automated deadline drill (tests/live/drill.mjs). Safe to delete.";

const [command, ...rest] = process.argv.slice(2);
const flag = (name) => rest.includes(`--${name}`);
const option = (name, fallback) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 && rest[i + 1] ? Number(rest[i + 1]) : fallback;
};

const env = loadEnv();
const ACCOUNTS = accounts(env);
const LECTURER = ACCOUNTS.LECTURER;
const STUDENTS = [ACCOUNTS.STUDENT_A, ACCOUNTS.STUDENT_B];
const r = reporter();
const { ok, bad, note } = r;

// A repository record's `repo_name` is `owner/name` (write-repository-record.mjs),
// the same field lockdown and preserve read with this expression.
const bareRepo = (repoName) => repoName?.split("/")?.[1] ?? repoName;

const isoSeconds = (d) => new Date(d).toISOString().replace(/\.\d{3}Z$/, "Z");
const local = (iso) => new Date(iso).toLocaleString("en-GB", { timeZone: TIMEZONE, dateStyle: "short", timeStyle: "short" });

function finish() {
  console.log(`\n${r.failures() === 0 ? "All checks passed." : `${r.failures()} check(s) failed.`}\n`);
  process.exit(r.failures() === 0 ? 0 : 1);
}

function stopIfFailed() {
  if (r.failures() > 0) finish();
}

// --- control repo and hub helpers ---------------------------------------------

async function readControl(path) {
  const res = await api(`/repos/${ORG}/${CONTROL_REPO}/contents/${path}`, { token: LECTURER.token });
  return res.ok ? { ok: true, sha: res.data.sha, text: decode(res.data.content) } : { ok: false, status: res.status };
}

async function readControlJson(path) {
  const res = await readControl(path);
  if (!res.ok) return null;
  try { return JSON.parse(res.text); } catch { return null; }
}

async function dispatch(workflow, inputs) {
  const res = await api(`/repos/${HUB}/actions/workflows/${workflow}/dispatches`, {
    token: LECTURER.token,
    method: "POST",
    body: { ref: "main", inputs },
  });
  if (res.status === 204) ok(`dispatched ${workflow} ${JSON.stringify(inputs)}`);
  else bad(`could not dispatch ${workflow}: HTTP ${res.status} ${res.data?.message ?? ""}`);
  return res.status === 204;
}

async function runsSince(workflow, since) {
  const q = new URLSearchParams({ created: `>=${isoSeconds(since)}`, per_page: "50" });
  const res = await api(`/repos/${HUB}/actions/workflows/${workflow}/runs?${q}`, { token: LECTURER.token });
  return (res.data?.workflow_runs || []).sort((a, b) => a.created_at.localeCompare(b.created_at));
}

/** The run the lecturer's dispatch started, or null after a minute. */
async function findDispatchedRun(workflow, since) {
  for (let i = 0; i < 12; i++) {
    await sleep(5_000);
    const run = (await runsSince(workflow, since))
      .find((x) => normalizeLogin(x.actor?.login) === normalizeLogin(LECTURER.login));
    if (run) return run;
  }
  return null;
}

async function waitForLabel(broker, issue, label, ms) {
  for (let waited = 0; waited <= ms; waited += 10_000) {
    const res = await api(`/repos/${ORG}/${broker}/issues/${issue}/labels`, { token: LECTURER.token });
    if ((res.data || []).some?.((l) => l.name === label)) return true;
    await sleep(10_000);
  }
  return false;
}

async function waitForRun(run, { minutes = 10 } = {}) {
  for (let waited = 0; waited < minutes * 60_000; waited += 10_000) {
    const res = await api(`/repos/${HUB}/actions/runs/${run.id}`, { token: LECTURER.token });
    if (res.data?.status === "completed") return res.data;
    await sleep(10_000);
  }
  return null;
}

// --- start ----------------------------------------------------------------------

async function start() {
  const minutes = option("minutes", 45);
  // Long enough for two acceptances and two pushes; short enough that the
  // publish-time arming reaches it, rather than waiting for the 4-hourly cron.
  if (!(minutes >= 15 && minutes * 60_000 <= SENTINEL_ARM_WINDOW_MS)) {
    die(`--minutes must be between 15 and ${SENTINEL_ARM_WINDOW_MS / 60_000}`);
  }

  console.log(`PXL Classroom live drill - START on ${ORG} (writes!)`);

  console.log("\n1. Preflight\n");
  await checkAccounts(ACCOUNTS, r);
  const { plan } = await checkOrg(ORG, LECTURER, r);
  note(`plan: ${plan ?? "unreadable"}`);
  stopIfFailed();

  const roster = await readControl("students/roster.yml");
  const rosterLogins = new Set(
    roster.ok ? (parse(roster.text)?.students || []).map((s) => normalizeLogin(s.github_login || "")) : [],
  );
  for (const s of STUDENTS) {
    if (rosterLogins.has(normalizeLogin(s.login))) ok(`${s.login} is on the roster`);
    else bad(`${s.login} is not on ${ORG}'s roster - roster_mode enforced would refuse them`);
  }

  const tpl = await api(`/repos/${ORG}/${TEMPLATE}`, { token: LECTURER.token });
  if (!tpl.ok) bad(`template ${ORG}/${TEMPLATE}: HTTP ${tpl.status}`);
  else ok(`template ${ORG}/${TEMPLATE} #${tpl.data.id}, default branch ${tpl.data.default_branch}`);
  stopIfFailed();

  console.log("\n2. The assignment, saved the way the Admin Panel saves it\n");
  const now = Date.now();
  const stamp = isoSeconds(now).replace(/[-:]/g, "").replace("T", "-").slice(0, 13).toLowerCase();
  const id = `drill-${stamp}`;
  const opensAt = new Date(now - 60_000).toISOString();
  const deadlineAt = new Date(Math.ceil((now + minutes * 60_000) / 60_000) * 60_000).toISOString();

  if ((await readControl(`assignments/${id}.yml`)).ok) die(`assignments/${id}.yml already exists - wait a minute and start again`);

  // The editor's form state, through the SAME builder the Admin Panel uses, so
  // the drill publishes a document the panel could have written. The `_original`
  // fields make preserveOrLocal keep the exact instants rather than
  // round-tripping them through this machine's zone.
  const form = {
    id,
    title: `Deadline drill ${isoSeconds(now).slice(0, 16).replace("T", " ")} UTC`,
    description: DRILL_DESCRIPTION,
    organization: ORG,
    template: `${ORG}/${TEMPLATE}`,
    repository_name_pattern: `${id}-{github_login}`,
    opens_at_local: utcToLocalInput(opensAt),
    _opens_at_original: opensAt,
    deadline_at_local: utcToLocalInput(deadlineAt),
    _deadline_at_original: deadlineAt,
    timezone: TIMEZONE,
    submission_ref: `refs/heads/${tpl.data.default_branch}`,
    student_permission: "admin",
    acceptance_mode: "self-service",
    roster_mode: "enforced",
    late_policy: "block",
    lock_down_enabled: true,
    assignment_type: "individual",
    state: "published",
    // --repo-lock opts out of organization scope, so the deadline is held by one
    // repository ruleset per student - the path assignments saved with
    // `org_scoped_lock: false` take, and the one `migrate` moves. Either way
    // `lock_down_enabled: true` demotes on top of the ruleset.
    ...(flag("repo-lock") ? { org_scoped_lock: false } : {}),
  };
  const doc = buildAssignmentDoc(form, { templateRepositoryId: tpl.data.id });
  // A copy: lib/validate.mjs runs Ajv with useDefaults, which writes into the
  // document it validates.
  const { valid, errors } = validateAgainst("assignment", structuredClone(doc));
  if (!valid) { bad(`schema refuses the drill document: ${JSON.stringify(errors)}`); finish(); }
  ok(`${id}: deadline ${deadlineAt} (${local(deadlineAt)} ${TIMEZONE})`);

  const put = await api(`/repos/${ORG}/${CONTROL_REPO}/contents/assignments/${id}.yml`, {
    token: LECTURER.token,
    method: "PUT",
    body: { message: `Create assignment ${id}`, content: Buffer.from(stringify(doc)).toString("base64") },
  });
  if (!put.ok) { bad(`could not commit assignments/${id}.yml: HTTP ${put.status} ${put.data?.message ?? ""}`); finish(); }
  ok(`committed assignments/${id}.yml as ${LECTURER.login}`);

  console.log("\n3. Publish\n");
  const dispatchedAt = Date.now() - 5_000;
  // Same order as saveAssignment: arm the sentinel when the deadline is inside
  // its window, then publish. publish-assignment.yml arms it again afterwards.
  if (deadlineIsImminent(deadlineAt)) await dispatch("deadline-sentinel.yml", { org: ORG });
  if (!(await dispatch("publish-assignment.yml", { org: ORG, assignment_id: id, regenerate_invite: "false" }))) finish();

  const publishRun = await findDispatchedRun("publish-assignment.yml", dispatchedAt);
  if (!publishRun) { bad("no publish-assignment run appeared within 60s"); finish(); }
  note(`watching ${publishRun.html_url}`);
  const published = await waitForRun(publishRun);
  if (published?.conclusion !== "success") { bad(`publish run ${published?.conclusion ?? "did not finish in 10 minutes"}: ${publishRun.html_url}`); finish(); }
  ok("publish run succeeded");

  const stored = await readControl(`assignments/${id}.yml`);
  const storedDoc = stored.ok ? parse(stored.text) : null;
  const secret = stored.ok ? linkSecretFrom(parseInviteFields(stored.text)) : null;
  if (storedDoc?.state !== "published") bad(`state after publish is "${storedDoc?.state}"`);
  if (!secret) bad("no invitation secret after publish");
  const broker = brokerRepoName({ assignment: storedDoc, assignmentId: id });
  const brokerRepo = await api(`/repos/${ORG}/${broker}`, { token: LECTURER.token });
  if (brokerRepo.ok) ok(`broker ${ORG}/${broker} exists`);
  else bad(`broker ${ORG}/${broker}: HTTP ${brokerRepo.status}`);
  stopIfFailed();

  for (const [i, student] of STUDENTS.entries()) {
    console.log(`\n${4 + i}. ${student.login} accepts and hands in\n`);
    const title = await signAcceptance({ secret, assignmentId: id, student }, r);
    const issue = title ? await openAcceptanceIssue({ org: ORG, broker, title, student }, r) : null;
    if (!issue) continue;

    // The record is what provisioning writes after the repository exists and
    // the invitation is sent, so it names the repository rather than this
    // script guessing from the pattern. Read as the lecturer: until the student
    // accepts, the private repository is 404 to them.
    const recordPath = `repositories/${id}/${normalizeLogin(student.login)}.json`;
    let record = null;
    for (let waited = 0; waited < 240_000 && !record; waited += 8_000) {
      await sleep(8_000);
      record = await readControlJson(recordPath);
    }
    if (!record) { bad(`no ${recordPath} after 240s - check the hub's acceptance-handler run`); continue; }
    ok(`provisioned ${record.repo_url}`);

    // The label step runs with continue-on-error, so a token that cannot label
    // leaves the run green. The label is the only evidence it worked. It is put
    // on only when GitHub sent an invitation, which the record says.
    if (record.access_state === "invited") {
      if (await waitForLabel(broker, issue, INVITED_LABEL, 60_000)) ok(`#${issue} carries ${INVITED_LABEL}`);
      else bad(`#${issue} has no ${INVITED_LABEL} label although the record says invited`);
    }

    await handIn(student, record);
  }

  // The lecturer is not on the roster, and roster_mode is enforced. A refusal
  // runs the rejection label and the lecturer's notification, neither of which
  // a successful acceptance reaches.
  console.log(`\n${4 + STUDENTS.length}. ${LECTURER.login}, who is not on the roster, is refused\n`);
  const refusedTitle = await signAcceptance({ secret, assignmentId: id, student: LECTURER }, r);
  const refusedIssue = refusedTitle ? await openAcceptanceIssue({ org: ORG, broker, title: refusedTitle, student: LECTURER }, r) : null;
  if (refusedIssue) {
    if (await waitForLabel(broker, refusedIssue, REJECTED_LABEL, 300_000)) ok(`#${refusedIssue} carries ${REJECTED_LABEL}`);
    else bad(`#${refusedIssue} has no ${REJECTED_LABEL} label after 300s - check the hub's acceptance-handler run`);
    if (await readControlJson(`repositories/${id}/${normalizeLogin(LECTURER.login)}.json`)) bad(`${LECTURER.login} was provisioned a repository`);
    else ok(`${LECTURER.login} has no repository`);
  }

  // What a lecturer reaches for when a student is stuck: wipe the acceptance
  // and run acceptance and provisioning again. The repository already exists,
  // so provisioning reuses it.
  console.log(`\n${5 + STUDENTS.length}. A lecturer retries ${STUDENTS[0].login}'s acceptance\n`);
  const retryAt = Date.now() - 5_000;
  if (await dispatch("retry-acceptance.yml", { org: ORG, assignment_id: id, github_login: STUDENTS[0].login })) {
    const run = await findDispatchedRun("retry-acceptance.yml", retryAt);
    const done = run ? await waitForRun(run) : null;
    if (done?.conclusion === "success") ok(`retry run succeeded: ${run.html_url}`);
    else bad(`retry run ${done?.conclusion ?? "did not appear or finish"}${run ? `: ${run.html_url}` : ""}`);
  }

  if (Date.now() >= new Date(deadlineAt).getTime()) {
    bad("the deadline passed before both students handed in - start again with a larger --minutes");
  }

  printNext(id, deadlineAt, plan);
}

/** Accept the invitation and push the on-time commit, as the student. */
async function handIn(student, record) {
  const repo = bareRepo(record.repo_name);
  await acceptInvitation({ student, repoName: repo }, r);

  let pushed = null;
  for (let attempt = 0; attempt < 6 && !pushed?.ok; attempt++) {
    if (attempt) await sleep(5_000);
    pushed = await api(`/repos/${ORG}/${repo}/contents/drill/${normalizeLogin(student.login)}.md`, {
      token: student.token,
      method: "PUT",
      body: {
        message: ON_TIME_MESSAGE,
        content: Buffer.from(`Handed in by ${student.login} at ${new Date().toISOString()}\n`).toString("base64"),
      },
    });
  }
  if (pushed?.ok) ok(`pushed ${pushed.data.commit.sha.slice(0, 7)} before the deadline`);
  else bad(`${student.login} could not push: HTTP ${pushed?.status} ${pushed?.data?.message ?? ""}`);
}

// --- handin ---------------------------------------------------------------------

// Finishes a `start` that provisioned both students but stopped short of the
// hand-in: accept each invitation and push, for students not yet handed in.
async function handinOnly() {
  const id = rest.find((a) => !a.startsWith("--"));
  if (!id) die("usage: node tests/live/drill.mjs handin <assignment-id>");
  console.log(`PXL Classroom live drill - HANDIN ${ORG}/${id} (writes!)`);
  await checkAccounts(ACCOUNTS, r);
  const stored = await readControl(`assignments/${id}.yml`);
  if (!stored.ok) die(`assignments/${id}.yml: HTTP ${stored.status}`);
  const doc = parse(stored.text);
  if (Date.now() >= new Date(doc.deadline_at).getTime()) die("the deadline has passed - a hand-in now is late; start a new drill");

  for (const student of STUDENTS) {
    console.log(`\n${student.login}\n`);
    const record = await readControlJson(`repositories/${id}/${normalizeLogin(student.login)}.json`);
    if (!record) { bad(`${student.login} has no repository record - they never accepted`); continue; }
    const q = new URLSearchParams({ per_page: "5" });
    const commits = (await api(`/repos/${ORG}/${bareRepo(record.repo_name)}/commits?${q}`, { token: LECTURER.token })).data;
    if (Array.isArray(commits) && commits.some((c) => c.commit?.message === ON_TIME_MESSAGE)) { ok("already handed in"); continue; }
    await handIn(student, record);
  }
  printNext(id, doc.deadline_at, null);
}

function printNext(id, deadlineAt, plan) {
  console.log(`\nDeadline ${local(deadlineAt)} ${TIMEZONE}. After it, run:\n`);
  console.log(`  node tests/live/drill.mjs verify ${id} --wait`);
  if (plan === "free") {
    console.log(`\n${ORG} is on the free plan: this drill locks by demotion and does NOT exercise rulesets.`);
  }
  finish();
}

// --- verify ---------------------------------------------------------------------

async function verify() {
  const id = rest.find((a) => !a.startsWith("--"));
  if (!id) die("usage: node tests/live/drill.mjs verify <assignment-id> [--wait] [--timeout 40]");
  console.log(`PXL Classroom live drill - VERIFY ${ORG}/${id} (one late push per student is attempted)`);

  console.log("\n1. Preflight\n");
  await checkAccounts(ACCOUNTS, r);
  const { plan } = await checkOrg(ORG, LECTURER, r);
  stopIfFailed();
  if (!plan) die(`cannot read ${ORG}'s plan, so there is no expected lock method to check against`);

  const stored = await readControl(`assignments/${id}.yml`);
  if (!stored.ok) die(`assignments/${id}.yml: HTTP ${stored.status}`);
  const doc = parse(stored.text);

  // lib/lock-scope.mjs decides the scope, the plan decides whether a ruleset
  // can exist at all.
  const expectedLock = plan === "free"
    ? "demotion"
    : usesOrgScope(doc, doc.late_policy === "block") ? "org-ruleset" : "ruleset";
  // Phase 4 demotes on top of either ruleset when lock_down_enabled. Asked of
  // the function lockdown asks: this spelled the rule out again, as "ruleset"
  // only, and so agreed with the defect instead of catching it.
  const expectDemoted = demotesAfterStop(doc, expectedLock);
  ok(`plan ${plan}: every repository should be stopped by ${expectedLock}${expectDemoted ? " and demoted" : ""}`);
  const deadline = new Date(doc.deadline_at);

  const early = deadline.getTime() - Date.now();
  if (early > 0) {
    if (!flag("wait")) die(`the deadline is ${Math.ceil(early / 60_000)} minute(s) away (${local(doc.deadline_at)}) - pass --wait to sleep until then`);
    note(`sleeping ${Math.ceil(early / 60_000)} minute(s) until the deadline`);
    await sleep(early + 30_000);
  }

  console.log("\n2. Waiting for finalize to settle\n");
  const timeout = option("timeout", 40) * 60_000;
  const isSettled = (s) => ["preserved", "failed", "not-required"].includes(s);
  let lockdown = null;
  let report = null;
  let pendingRuns = [];
  for (const began = Date.now(); ; ) {
    lockdown = await readControlJson(`lockdowns/${id}/lockdown-record.json`);
    report = await readControlJson(`reports/${id}.json`);
    pendingRuns = (await runsSince("daily-activity.yml", deadline)).filter((run) => run.status !== "completed");
    const rows = report?.students || [];
    const settled = lockdown && rows.length >= STUDENTS.length && rows.every((row) => isSettled(row.preservation_status));
    if (settled && pendingRuns.length === 0) break;
    if (Date.now() - began > timeout) {
      bad(`not settled after ${timeout / 60_000} minutes: lockdown record ${lockdown ? "present" : "absent"}, ` +
        `report rows ${rows.length}, daily-activity runs still going ${pendingRuns.length}`);
      break;
    }
    await sleep(30_000);
  }

  console.log("\n3. The hub runs since publish\n");
  const since = new Date(doc.opens_at);
  for (const workflow of ["deadline-sentinel.yml", "daily-activity.yml"]) {
    for (const run of await runsSince(workflow, since)) {
      if (run.status !== "completed") { note(`${workflow} ${run.html_url} still ${run.status}`); continue; }
      if (run.conclusion === "success") { ok(`${workflow} ${run.event} ${run.conclusion}: ${run.html_url}`); continue; }
      // A cron run covers every organization, so a failed job may be somebody
      // else's. Only this org's jobs, or a job that is not per org, fail the drill.
      const jobs = (await api(`/repos/${HUB}/actions/runs/${run.id}/jobs?per_page=100`, { token: LECTURER.token })).data?.jobs || [];
      const failed = jobs.filter((j) => j.conclusion === "failure");
      const ours = failed.filter((j) => j.name.includes(ORG) || !j.name.includes("("));
      if (ours.length) bad(`${workflow} ${run.conclusion}: ${ours.map((j) => j.name).join(", ")} - ${run.html_url}`);
      else note(`${workflow} ${run.conclusion} in another org's job (${failed.map((j) => j.name).join(", ") || "none failed"}): ${run.html_url}`);
    }
  }

  console.log("\n4. The sentinel stopped writes at the instant\n");
  const dir = await api(`/repos/${ORG}/${CONTROL_REPO}/contents/lockdowns/${id}`, { token: LECTURER.token });
  const timelines = (Array.isArray(dir.data) ? dir.data : []).filter((f) => /^sentinel-.*\.json$/.test(f.name));
  let fired = false;
  for (const f of timelines) {
    const t = await readControlJson(f.path);
    if (t?.outcome === "fired") fired = true;
    note(`${f.name}: ${t?.outcome ?? "unreadable"}`);
  }
  if (fired) ok("a sentinel timeline says fired");
  else bad("no sentinel fired for this assignment - whatever locked it was the nightly, so the sentinel path was not drilled");

  console.log("\n5. The lock\n");
  const late = new Map();
  if (!lockdown) bad(`lockdowns/${id}/lockdown-record.json is absent`);
  else {
    if (lockdown.error_count === 0) ok(`lockdown record: ${lockdown.locked_count} locked, 0 errors`);
    else bad(`lockdown record: ${lockdown.error_count} error(s)`);
    for (const student of STUDENTS) {
      const login = normalizeLogin(student.login);
      const row = (lockdown.results || []).find((x) => normalizeLogin(x.github_login) === login);
      if (!row) { bad(`${login}: no row in the lockdown record`); continue; }
      if (row.lock_method === expectedLock) ok(`${login}: stopped by ${row.lock_method}`);
      else bad(`${login}: stopped by ${row.lock_method}, expected ${expectedLock} - a degraded lock reports success, which is why this is checked per row`);
      if (row.verified === false) bad(`${login}: lock not verified (permission after: ${row.permission_after})`);
      if (expectDemoted) {
        if (row.demoted === true) ok(`${login}: demoted as well`);
        else bad(`${login}: not demoted although lock_down_enabled (permission after: ${row.permission_after})`);
      }

      const lag = (new Date(row.lockdown_at) - deadline) / 1000;
      if (Number.isFinite(lag) && lag >= 0 && lag <= 600) ok(`${login}: locked ${Math.round(lag)}s after the deadline`);
      else bad(`${login}: lockdown_at ${row.lockdown_at} is not within 10 minutes of the deadline`);

      const repo = bareRepo(row.repo_name);
      const q = new URLSearchParams({ sha: doc.submission_ref.replace(/^refs\/heads\//, ""), until: doc.deadline_at, per_page: "1" });
      const head = (await api(`/repos/${ORG}/${repo}/commits?${q}`, { token: LECTURER.token })).data?.[0];
      if (head?.commit?.message !== ON_TIME_MESSAGE) bad(`${login}: the last commit before the deadline is not the drill's hand-in (start did not finish?)`);
      if (row.snapshot_sha && row.snapshot_sha === head?.sha) ok(`${login}: snapshot ${row.snapshot_sha.slice(0, 7)} is the on-time hand-in`);
      else bad(`${login}: snapshot ${row.snapshot_sha} is not the last commit before the deadline (${head?.sha})`);
      late.set(login, { student, repo, onTime: head?.sha });
    }
  }

  console.log("\n6. A late push is refused\n");
  for (const [login, { student, repo }] of late) {
    const res = await api(`/repos/${ORG}/${repo}/contents/drill/${login}-late.md`, {
      token: student.token,
      method: "PUT",
      body: { message: "drill: late push", content: Buffer.from(`late ${new Date().toISOString()}\n`).toString("base64") },
    });
    if (res.ok) bad(`${login}: a push AFTER the lock was accepted (${res.data?.commit?.sha?.slice(0, 7)}) - the lock does not hold`);
    else ok(`${login}: late push refused, HTTP ${res.status}`);
  }

  console.log("\n7. Preservation and the report\n");
  for (const [login, { onTime }] of late) {
    const row = (report?.students || []).find((x) => normalizeLogin(x.github_login) === login);
    if (!row) { bad(`${login}: no row in reports/${id}.json`); continue; }
    if (row.submission_status === "on-time") ok(`${login}: report says on-time`);
    else bad(`${login}: report says ${row.submission_status}`);
    if (row.preservation_status !== "preserved") { bad(`${login}: preservation ${row.preservation_status}`); continue; }
    if (row.preserved_sha !== onTime) bad(`${login}: preserved ${row.preserved_sha}, but the hand-in was ${onTime}`);
    const archive = resolveArchiveRepo({ org: ORG, recorded: row.archive_repo });
    const branch = archiveBranchName({ assignmentId: id, login, recordedRef: row.archive_ref });
    // git/ref takes the slashes in `preserved/<id>/<login>` as they are; the
    // branches endpoint needs them encoded and is inconsistent about it.
    const ref = await api(`/repos/${archive}/git/ref/heads/${branch}`, { token: LECTURER.token });
    if (ref.ok && ref.data?.object?.sha === row.preserved_sha) ok(`${login}: ${archive}@${branch} holds ${row.preserved_sha.slice(0, 7)}`);
    else bad(`${login}: ${archive}@${branch} is HTTP ${ref.status}${ref.ok ? ` at ${ref.data?.object?.sha}` : ""}, not the preserved sha`);
  }

  console.log("\n8. The broker is closed\n");
  const broker = brokerRepoName({ assignment: doc, assignmentId: id });
  const v = await api(`/repos/${ORG}/${broker}/actions/variables/INVITE_ENABLED`, { token: LECTURER.token });
  const s = await api(`/repos/${ORG}/${broker}/actions/secrets`, { token: LECTURER.token });
  if (v.ok && String(v.data?.value).toLowerCase() === "false") ok("INVITE_ENABLED is false");
  else bad(`INVITE_ENABLED is ${v.ok ? v.data?.value : `unreadable (HTTP ${v.status})`}`);
  const held = s.ok ? (s.data?.secrets || []).map((x) => x.name).filter((n) => n.startsWith("PXL_BROKER_")) : null;
  if (held && held.length === 0) ok("no broker credential left on the broker");
  else bad(held ? `the broker still holds ${held.join(", ")}` : `broker secrets unreadable (HTTP ${s.status})`);

  // LAST, because it wipes this student's acceptance record. accept.mjs reads a
  // 403 on the rulesets list as the free-plan answer - not frozen - so a token
  // that cannot read rulesets would hand a locked repository back to a retried
  // student and say nothing. Only a retry against a repository that IS locked
  // can tell the two apart, and the refusal is in the run log alone.
  console.log(`\n9. A retry cannot hand back a locked repository\n`);
  const frozenStudent = STUDENTS[STUDENTS.length - 1];
  const retryAt = Date.now() - 5_000;
  if (await dispatch("retry-acceptance.yml", { org: ORG, assignment_id: id, github_login: frozenStudent.login })) {
    const run = await findDispatchedRun("retry-acceptance.yml", retryAt);
    const done = run ? await waitForRun(run) : null;
    if (!done) bad("the retry run did not appear or finish");
    else {
      const jobs = (await api(`/repos/${HUB}/actions/runs/${run.id}/jobs`, { token: LECTURER.token })).data?.jobs || [];
      let log = "";
      for (const job of jobs) log += (await api(`/repos/${HUB}/actions/jobs/${job.id}/logs`, { token: LECTURER.token })).data?.raw ?? "";
      if (/exists and is frozen by/.test(log)) ok(`${frozenStudent.login}: refused, the repository is frozen (${run.html_url})`);
      else if (/exists and is not frozen/.test(log)) bad(`${frozenStudent.login}: handed back a LOCKED repository as not frozen - the rulesets read failed (${run.html_url})`);
      else bad(`${frozenStudent.login}: the retry log says nothing about the existing repository (${run.html_url})`);
    }
  }

  if (plan === "free") {
    console.log(`\n${ORG} is on the free plan: rulesets were NOT exercised. Lockdown and sentinel token changes need a drill on a Team organization.`);
  }
  finish();
}

// --- migrate --------------------------------------------------------------------

// For a drill started with --repo-lock and verified: move its lock to one
// organization ruleset the way an administrator would, for real, and check
// what the migration claims - the organization ruleset covers every repository,
// each repository ruleset is disabled, and the record says org-ruleset.
async function migrate() {
  const id = rest.find((a) => !a.startsWith("--"));
  if (!id) die("usage: node tests/live/drill.mjs migrate <assignment-id>");
  console.log(`PXL Classroom live drill - MIGRATE ${ORG}/${id} (writes!)`);
  await checkAccounts(ACCOUNTS, r);
  stopIfFailed();

  const before = await readControlJson(`lockdowns/${id}/lockdown-record.json`);
  const rows = (before?.results || []).filter((x) => x.lock_method === "ruleset" && Number.isInteger(x.repo_id));
  if (rows.length === 0) die(`lockdowns/${id} has no repository-ruleset rows - start the drill with --repo-lock and verify it first`);
  ok(`${rows.length} repository-ruleset row(s) to migrate`);

  const since = Date.now() - 5_000;
  if (!(await dispatch("migrate-org-lock.yml", { org: ORG, assignment_id: id, dry_run: "false" }))) finish();
  const run = await findDispatchedRun("migrate-org-lock.yml", since);
  const done = run ? await waitForRun(run, { minutes: 20 }) : null;
  if (done?.conclusion === "success") ok(`migrate run succeeded: ${run.html_url}`);
  else { bad(`migrate run ${done?.conclusion ?? "did not appear or finish"}${run ? `: ${run.html_url}` : ""}`); finish(); }

  const request = (method, path) => api(path, { token: LECTURER.token, method });
  const org = await findOrgSubmissionLock(request, { org: ORG, assignmentId: id });
  const covered = new Set(targetedRepositoryIds(org.ruleset));
  if (!org.ruleset) bad(`no organization ruleset for ${id} (${org.reason ?? "absent"})`);
  else if (org.ruleset.enforcement !== "active") bad(`organization ruleset ${org.ruleset.id} is ${org.ruleset.enforcement}`);
  else ok(`organization ruleset ${org.ruleset.id} is active`);

  for (const row of rows) {
    const repo = bareRepo(row.repo_name);
    if (covered.has(row.repo_id)) ok(`${repo} is covered by the organization ruleset`);
    else bad(`${repo} (#${row.repo_id}) is NOT covered by the organization ruleset`);
    const own = await findSubmissionLock(request, { org: ORG, repo });
    const detail = own.ruleset ? await request("GET", `/repos/${ORG}/${repo}/rulesets/${own.ruleset.id}`) : null;
    if (!own.ok) bad(`${repo}: repository rulesets unreadable (${own.reason})`);
    else if (detail?.data?.enforcement === "disabled") ok(`${repo}: repository ruleset disabled`);
    else bad(`${repo}: repository ruleset is ${detail?.data?.enforcement ?? "absent"}, expected disabled`);
  }

  const after = await readControlJson(`lockdowns/${id}/lockdown-record.json`);
  const left = (after?.results || []).filter((x) => x.lock_method === "ruleset");
  if (after && left.length === 0) ok("the lockdown record says org-ruleset for every migrated row");
  else bad(`the lockdown record still has ${left.length} repository-ruleset row(s)`);
  finish();
}

// --- cleanup --------------------------------------------------------------------

// Deletes a drill the way the Admin Panel deletes an assignment
// (AdminView.vue deleteAssignment, from the same lib/ pieces): the broker, the
// organization ruleset, then ONE commit writing retired/<id>/ and removing the
// working data and the dashboard entry. Then what the Admin Panel leaves to the
// lecturer on purpose: the student repositories and the archive. The records go
// first because a published assignment whose repositories are gone fails the
// nightly collect with a 404 for every student.
//
// Only ever an assignment this script created: the id prefix AND the
// description it writes, so a real assignment named drill-something is refused.
//
// ONE CLEANUP AT A TIME PER ORGANIZATION (tests/live/cleanup-lock.mjs). Two
// sessions ran `cleanup --all` nine seconds apart, split the deletes between
// them, and retired one drill twice - the second commit rewriting its manifest
// to say nothing was removed. The lock is taken BEFORE the --all listing,
// because the listing is what both runs planned from, and released on every
// way out: `die` and `finish` exit the process, which skips a `finally`, so
// nothing inside the locked section calls either.
async function cleanup() {
  const named = rest.filter((a) => !a.startsWith("--"));
  if (named.length === 0 && !flag("all") && !flag("break-lock")) {
    die("usage: node tests/live/drill.mjs cleanup <assignment-id>... | cleanup --all | cleanup --break-lock");
  }
  console.log(`PXL Classroom live drill - CLEANUP on ${ORG} (deletes repositories!)`);
  await checkAccounts(ACCOUNTS, r);
  stopIfFailed();
  const request = (method, path, body) => api(path, { token: LECTURER.token, method, body });

  if (flag("break-lock")) {
    // A person's decision, for a run that died holding the lock. It deletes
    // nothing else: run the cleanup again afterwards.
    const res = await breakCleanupLock(request, { org: ORG, repo: CONTROL_REPO });
    if (!res.ok) bad(res.reason);
    else if (res.action === "absent") ok("no cleanup lock was held");
    else ok(`removed the cleanup lock held by ${res.holder ?? "an unreadable holder"} since ${res.since ?? "an unreadable time"}`);
    finish();
  }

  const pending = (await runsSince("daily-activity.yml", Date.now() - 3 * 3600_000)).filter((x) => x.status !== "completed");
  if (pending.length) die(`a daily-activity run is still going (${pending[0].html_url}) - clean up once it finishes`);

  const lock = await acquireCleanupLock(request, {
    org: ORG,
    repo: CONTROL_REPO,
    holder: `${LECTURER.login} on ${hostname()} (pid ${process.pid}, ${basename(process.cwd())})`,
  });
  if (!lock.ok) {
    if (lock.held) {
      const minutes = lock.since ? Math.round((Date.now() - new Date(lock.since).getTime()) / 60_000) : null;
      bad(`another cleanup is running on ${ORG}: ${lock.holder ?? "holder unreadable"}` +
        (minutes === null ? "" : `, for ${minutes} minute(s)`) + ". Nothing was deleted.");
      note("if that run is no longer going, clear its lock with: node tests/live/drill.mjs cleanup --break-lock");
    } else {
      bad(`${lock.reason} - nothing was deleted`);
    }
    finish();
  }
  ok(`took the cleanup lock (refs/${CLEANUP_LOCK_REF})`);

  const release = async () => {
    const res = await releaseCleanupLock(request, { org: ORG, repo: CONTROL_REPO, sha: lock.sha });
    if (res.ok) ok(`released the cleanup lock${res.action === "absent" ? " (it was already gone)" : ""}`);
    else bad(`cleanup lock: ${res.reason}`);
  };
  // Ctrl-C mid-cleanup is the ordinary way a run dies, and it must not leave a
  // lock that refuses every later run until somebody breaks it.
  const interrupted = async () => { await release(); finish(); };
  process.once("SIGINT", interrupted);
  try {
    await cleanupLocked(named, request);
  } finally {
    process.removeListener("SIGINT", interrupted);
    await release();
  }
  finish();
}

async function cleanupLocked(named, request) {
  let ids = named;
  if (flag("all")) {
    const dir = await api(`/repos/${ORG}/${CONTROL_REPO}/contents/assignments`, { token: LECTURER.token });
    if (!Array.isArray(dir.data)) { bad(`cannot list assignments (HTTP ${dir.status}) - nothing deleted`); return; }
    ids = dir.data.map((f) => assignmentIdFromFile(f.name)).filter((x) => x?.startsWith("drill-"));
    if (ids.length === 0) { ok("no drill assignments left"); return; }
  }

  for (const id of ids) {
    console.log(`\n${id}\n`);
    const stored = await readControl(assignmentPath(id));
    const doc = stored.ok ? parse(stored.text) : null;
    if (!id.startsWith("drill-") || doc?.description !== DRILL_DESCRIPTION) {
      bad(`${id} is not an assignment this script created - refusing`);
      continue;
    }
    if (Date.now() < new Date(doc.deadline_at).getTime()) {
      bad(`${id}'s deadline has not passed - refusing to delete a live drill`);
      continue;
    }

    // Evidence, and the repositories, read before anything is removed.
    const reportText = await readControl(reportPath(id));
    const reportCsv = await readControl(reportCsvPath(id));
    const grading = await readControl(gradingSummaryPath(id));
    let students = [];
    try { students = reportText.ok ? JSON.parse(reportText.text).students || [] : []; } catch { students = []; }

    const tree = await request("GET", `/repos/${ORG}/${CONTROL_REPO}/git/trees/main?recursive=1`);
    if (!tree.ok || tree.data?.truncated) { bad(`control tree ${tree.ok ? "truncated" : `HTTP ${tree.status}`} - nothing deleted`); continue; }
    const paths = (tree.data.tree || []).filter((e) => e.type === "blob").map((e) => e.path);

    // THE PLAN HAS TO STILL BE TRUE. The document was read before this tree, and
    // `commitWithRebase` rebases onto whatever head it finds - so an assignment
    // deleted in between is retired a second time, by a commit whose manifest
    // says nothing was removed. The lock stops another cleanup; this stops the
    // Admin Panel in a browser tab, and a Contents read served from before the
    // delete. tests/live/cleanup-plan.mjs decides, and it asks after the tree
    // read and before anything is deleted.
    const stale = deletePlanStale({ paths, assignmentId: id });
    if (stale) { bad(`${stale.message} - nothing changed`); continue; }

    const owned = paths
      .filter((p) => p === assignmentPath(id) || p === reportPath(id) || p === reportCsvPath(id) ||
        ASSIGNMENT_OWNED_DIRS.some((d) => p.startsWith(`${d}/${id}/`)));
    const studentRepos = [];
    for (const p of owned.filter((x) => x.startsWith(`repositories/${id}/`))) {
      const rec = await readControlJson(p);
      if (rec?.repo_name) studentRepos.push(bareRepo(rec.repo_name));
    }
    const archive = reportArchiveRepo({ org: ORG, students });

    const broker = brokerRepoName({ assignment: doc, assignmentId: id });
    const brokerRes = await request("GET", `/repos/${ORG}/${broker}`);
    if (brokerRes.ok) {
      const del = await request("DELETE", `/repos/${ORG}/${broker}`);
      if (!del.ok && del.status !== 404) { bad(`could not delete ${broker} (HTTP ${del.status}) - nothing else changed`); continue; }
      ok(`deleted ${ORG}/${broker}`);
    } else if (brokerRes.status !== 404) { bad(`could not read ${broker} (HTTP ${brokerRes.status}) - nothing deleted`); continue; }

    let orgRulesetRemoved = null;
    const orgLock = await findOrgSubmissionLock(request, { org: ORG, assignmentId: id });
    if (orgLock.ok && orgLock.ruleset) {
      const del = await request("DELETE", `/orgs/${ORG}/rulesets/${orgLock.ruleset.id}`);
      orgRulesetRemoved = del.ok || del.status === 404;
      if (orgRulesetRemoved) ok(`deleted organization ruleset ${orgLock.ruleset.id}`);
      else bad(`organization ruleset ${orgLock.ruleset.id} not removed (HTTP ${del.status})`);
    }

    const changes = [
      {
        path: retiredManifestPath(id),
        content: JSON.stringify(buildRetiredManifest({
          org: ORG, assignmentId: id, title: doc.title, deletedBy: LECTURER.login,
          brokerRepo: broker, brokerDeleted: brokerRes.ok, removedPaths: owned, students, orgRulesetRemoved,
        }), null, 2) + "\n",
      },
      ...owned.map((path) => ({ path, content: null })),
    ];
    if (reportText.ok) changes.push({ path: `${retiredDir(id)}/report.json`, content: reportText.text });
    if (reportCsv.ok) changes.push({ path: `${retiredDir(id)}/report.csv`, content: reportCsv.text });
    if (grading.ok) changes.push({ path: `${retiredDir(id)}/grading.json`, content: grading.text });
    const dashboard = await readControl(DASHBOARD_PATH);
    if (dashboard.ok) {
      try {
        const parsed = JSON.parse(dashboard.text);
        if (parsed?.assignments?.[id]) {
          delete parsed.assignments[id];
          changes.push({ path: DASHBOARD_PATH, content: JSON.stringify(parsed, null, 2) + "\n" });
        }
      } catch { /* a dashboard we cannot parse is not ours to rewrite */ }
    }
    try {
      await commitWithRebase({ token: LECTURER.token, owner: ORG, repo: CONTROL_REPO, branch: "main", message: `Delete assignment ${id}`, changes });
      ok(`one commit: retired/${id}/ written, ${owned.length} path(s) removed`);
    } catch (e) {
      bad(`control commit failed (${e.message}) - the broker is gone, the repositories are untouched`);
      continue;
    }

    for (const full of [...new Set([...studentRepos.map((n) => `${ORG}/${n}`), ...(archive ? [archive] : [])])]) {
      const del = await request("DELETE", `/repos/${full}`);
      if (del.ok || del.status === 404) ok(`deleted ${full}${del.status === 404 ? " (already gone)" : ""}`);
      else bad(`could not delete ${full} (HTTP ${del.status})`);
    }
  }
  // The student pages still carry the drill cards until the next regeneration.
  await dispatch("regenerate-dashboard.yml", { org: ORG });
}

if (command === "start") await start();
else if (command === "handin") await handinOnly();
else if (command === "verify") await verify();
else if (command === "migrate") await migrate();
else if (command === "cleanup") await cleanup();
else die("usage: node tests/live/drill.mjs start [--minutes 45] [--repo-lock] | handin <id> | verify <id> [--wait] [--timeout 40] | migrate <id> | cleanup <id>... | cleanup --all | cleanup --break-lock");
