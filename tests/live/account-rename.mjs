#!/usr/bin/env node
// PXL Classroom - LIVE renamed account. Not part of `npm test`.
//
// What tests/login-rename-accept.test.mjs proves on disk, against the real thing:
// the real broker, the real hub run, real provisioning, the real nightly leg.
//
// GitHub has no API to change a username and these accounts' passwords are not
// for a script, so the rename is staged from the other side. A record naming a
// login nobody holds, under the account's real id, on a repository named after
// that login, is exactly what a rename leaves: moveLogin (the module under test,
// run backwards) writes it, and a repository rename gives it the old name.
//
//   node tests/live/account-rename.mjs start
//       create and publish drill-acct-<stamp> (individual, open), then:
//         1. A accepts: a repository, a record under A's login
//         2. stage a rename, and A accepts again: no second repository, the
//            records move back, A keeps the repository under its old name
//         3. what the student's page sees: their token lists that repository,
//            and renamedOwnRepo picks it
//         4. stage it again, dispatch the nightly for this organization alone:
//            the records move, and the tracking issue says who is now who
//         5. B accepts under a login whose record holds another id: refused
//
//   node tests/live/drill.mjs cleanup <drill-acct-id>
//       delete it afterwards, like any drill (after its deadline).
//
// Writes to pxl-classroom-testbed.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { buildAssignmentDoc, utcToLocalInput } from "../../lib/assignment-doc.mjs";
import { validateAgainst } from "../../lib/validate.mjs";
import { brokerRepoName } from "../../lib/broker-repo.mjs";
import { linkSecretFrom, parseInviteFields } from "../../lib/invite-token-format.mjs";
import { REJECTED_LABEL } from "../../lib/acceptance-labels.mjs";
import { acceptanceRunName } from "../../lib/acceptance-run-name.mjs";
import { moveLogin, renamesPath } from "../../lib/login-rename.mjs";
import { repositoryNameFor } from "../../lib/repo-name.mjs";
import { renamedRepoFor } from "../../frontend/src/lib/renamed-repo.js";
import { CONTROL_REPO, HUB_OWNER, HUB_REPO_NAME, TIMEZONE } from "../../lib/deployment.mjs";
import {
  accounts, acceptInvitation, api, checkAccounts, checkOrg, decode, loadEnv, openAcceptanceIssue, reporter, signAcceptance, sleep,
} from "./live-kit.mjs";

const ORG = process.env.DRILL_ORG || "pxl-classroom-testbed";
const TEMPLATE = process.env.DRILL_TEMPLATE || "starter-template";
const HUB = `${HUB_OWNER}/${HUB_REPO_NAME}`;
// The same description drill.mjs writes, so `drill.mjs cleanup` deletes these.
const DRILL_DESCRIPTION = "Automated deadline drill (tests/live/drill.mjs). Safe to delete.";

const env = loadEnv();
const ACCOUNTS = accounts(env);
const LECTURER = ACCOUNTS.LECTURER;
const A = ACCOUNTS.STUDENT_A;
const B = ACCOUNTS.STUDENT_B;
const r = reporter();
const { ok, bad, note } = r;

const isoSeconds = (d) => new Date(d).toISOString().replace(/\.\d{3}Z$/, "Z");

function finish() {
  console.log(`\n${r.failures() === 0 ? "All checks passed." : `${r.failures()} check(s) failed.`}\n`);
  process.exit(r.failures() === 0 ? 0 : 1);
}

async function readControl(path) {
  const res = await api(`/repos/${ORG}/${CONTROL_REPO}/contents/${path}`, { token: LECTURER.token });
  if (!res.ok) return null;
  return decode(res.data.content);
}
const readControlJson = async (path) => {
  const text = await readControl(path);
  return text === null ? null : JSON.parse(text);
};

async function putControl(path, content, message) {
  const prior = await api(`/repos/${ORG}/${CONTROL_REPO}/contents/${path}`, { token: LECTURER.token });
  const res = await api(`/repos/${ORG}/${CONTROL_REPO}/contents/${path}`, {
    token: LECTURER.token,
    method: "PUT",
    body: { message, content: Buffer.from(content).toString("base64"), ...(prior.ok ? { sha: prior.data.sha } : {}) },
  });
  return res.ok;
}

async function deleteControl(path, message) {
  const prior = await api(`/repos/${ORG}/${CONTROL_REPO}/contents/${path}`, { token: LECTURER.token });
  if (!prior.ok) return false;
  const res = await api(`/repos/${ORG}/${CONTROL_REPO}/contents/${path}`, {
    token: LECTURER.token, method: "DELETE", body: { message, sha: prior.data.sha },
  });
  return res.ok;
}

// The token through git's own environment configuration: never on a command
// line and never in a remote URL.
function gitEnv() {
  const basic = Buffer.from(`x-access-token:${LECTURER.token}`).toString("base64");
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  };
}

function git(dir, ...args) {
  const res = spawnSync("git", args, { cwd: dir, env: gitEnv(), encoding: "utf8" });
  if (res.status !== 0) throw new Error(`git ${args[0]}: ${res.stderr.trim()}`);
  return res.stdout.trim();
}

/**
 * Leave what a rename leaves: the records under a login nobody holds, the
 * repository under the name that login made.
 */
async function stageRename({ id, student, oldName }) {
  const dir = mkdtempSync(join(tmpdir(), "pxl-live-rename-"));
  try {
    git(dir, "clone", "-q", "--depth", "1", `https://github.com/${ORG}/${CONTROL_REPO}.git`, ".");
    git(dir, "config", "user.name", "pxl-classroom[bot]");
    git(dir, "config", "user.email", "pxl-classroom[bot]@users.noreply.github.com");
    moveLogin(dir, { from: student.login, to: oldName, githubId: student.id });
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", `Drill: stage a rename on ${id}`);
    for (let tries = 0; ; tries++) {
      try {
        git(dir, "push", "-q", "origin", "HEAD:main");
        break;
      } catch (e) {
        if (tries === 4) throw e;
        await sleep(3000);
        git(dir, "pull", "-q", "--rebase", "--depth", "1", "origin", "main");
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function runFor(broker, issue, since, { minutes = 6 } = {}) {
  const name = acceptanceRunName(`${ORG}/${broker}`, issue);
  for (let waited = 0; waited < minutes * 60_000; waited += 10_000) {
    const q = new URLSearchParams({ created: `>=${isoSeconds(since)}`, per_page: "100", event: "repository_dispatch" });
    const res = await api(`/repos/${HUB}/actions/workflows/acceptance-handler.yml/runs?${q}`, { token: LECTURER.token });
    const run = (res.data?.workflow_runs || []).find((x) => x.display_title === name || x.name === name);
    if (run?.status === "completed") return run;
    await sleep(10_000);
  }
  return null;
}

const labelsOf = async (broker, issue) =>
  ((await api(`/repos/${ORG}/${broker}/issues/${issue}/labels`, { token: LECTURER.token })).data || []).map((l) => l.name);

async function accept({ secret, id, broker, student }) {
  const since = Date.now() - 60_000;
  const title = await signAcceptance({ secret, assignmentId: id, student }, r);
  if (!title) return null;
  const issue = await openAcceptanceIssue({ org: ORG, broker, title, student }, r);
  if (!issue) return null;
  const run = await runFor(broker, issue, since);
  if (!run) {
    bad(`no completed hub run for #${issue} within 6 minutes`);
    return null;
  }
  if (run.conclusion !== "success") bad(`the hub run for #${issue} ended ${run.conclusion}: ${run.html_url}`);
  return { run, refused: (await labelsOf(broker, issue)).includes(REJECTED_LABEL) };
}

const repoExists = async (name) => (await api(`/repos/${ORG}/${name}`, { token: LECTURER.token })).ok;

async function start() {
  console.log(`PXL Classroom live renamed account - START on ${ORG} (writes!)`);
  console.log("\n0. Preflight\n");
  await checkAccounts(ACCOUNTS, r);
  await checkOrg(ORG, LECTURER, r);
  const tpl = await api(`/repos/${ORG}/${TEMPLATE}`, { token: LECTURER.token });
  if (!tpl.ok) bad(`template ${ORG}/${TEMPLATE}: HTTP ${tpl.status}`);
  if (r.failures()) finish();

  const now = Date.now();
  const stamp = isoSeconds(now).replace(/[-:]/g, "").replace("T", "-").slice(0, 13).toLowerCase();
  const id = `drill-acct-${stamp}`;
  const pattern = `${id}-{github_login}`;
  const opensAt = new Date(now - 60_000).toISOString();
  const deadlineAt = new Date(Math.ceil((now + 35 * 60_000) / 60_000) * 60_000).toISOString();
  const doc = buildAssignmentDoc({
    id,
    title: `Renamed account ${isoSeconds(now).slice(0, 16).replace("T", " ")} UTC`,
    description: DRILL_DESCRIPTION,
    organization: ORG,
    template: `${ORG}/${TEMPLATE}`,
    repository_name_pattern: pattern,
    opens_at_local: utcToLocalInput(opensAt),
    _opens_at_original: opensAt,
    deadline_at_local: utcToLocalInput(deadlineAt),
    _deadline_at_original: deadlineAt,
    timezone: TIMEZONE,
    submission_ref: `refs/heads/${tpl.data.default_branch}`,
    student_permission: "push",
    acceptance_mode: "self-service",
    roster_mode: "open",
    max_acceptances: 10,
    late_policy: "block",
    lock_down_enabled: false,
    assignment_type: "individual",
    state: "published",
  }, { templateRepositoryId: tpl.data.id });
  const { valid, errors } = validateAgainst("assignment", structuredClone(doc));
  if (!valid) {
    bad(`schema refuses the document: ${JSON.stringify(errors)}`);
    finish();
  }
  if (!(await putControl(`assignments/${id}.yml`, stringify(doc), `Create assignment ${id}`))) {
    bad(`could not commit assignments/${id}.yml`);
    finish();
  }

  console.log("\n1. Publish, and A accepts\n");
  const disp = await api(`/repos/${HUB}/actions/workflows/publish-assignment.yml/dispatches`, {
    token: LECTURER.token,
    method: "POST",
    body: { ref: "main", inputs: { org: ORG, assignment_id: id, regenerate_invite: "false" } },
  });
  if (!disp.ok) {
    bad(`publish dispatch: HTTP ${disp.status}`);
    finish();
  }
  let secret = null;
  let storedDoc = null;
  for (let waited = 0; waited < 600_000 && !secret; waited += 10_000) {
    await sleep(10_000);
    const text = await readControl(`assignments/${id}.yml`);
    if (text === null) continue;
    storedDoc = parse(text);
    const broker = brokerRepoName({ assignment: storedDoc, assignmentId: id });
    const vars = await api(`/repos/${ORG}/${broker}/actions/variables/INVITE_PUBKEY`, { token: LECTURER.token });
    if (storedDoc?.state === "published" && vars.ok) secret = linkSecretFrom(parseInviteFields(text));
  }
  if (!secret) {
    bad("not published with an invitation within 10 minutes");
    finish();
  }
  const broker = brokerRepoName({ assignment: storedDoc, assignmentId: id });
  ok(`published; broker ${ORG}/${broker}`);
  await sleep(15_000);

  const first = await accept({ secret, id, broker, student: A });
  const repoToday = repositoryNameFor(pattern, { login: A.login });
  if (first && !first.refused && (await repoExists(repoToday))) ok(`${repoToday} exists`);
  else {
    bad("A's first acceptance did not make a repository");
    finish();
  }
  await acceptInvitation({ student: A, repoName: repoToday }, r);

  console.log("\n2. A renames, and presses Accept\n");
  const oldName = `pxl-gone-${stamp.replace(/[^a-z0-9]/g, "").slice(-12)}`;
  const repoOld = repositoryNameFor(pattern, { login: oldName });
  if ((await api(`/users/${oldName}`, { token: LECTURER.token })).status !== 404) {
    bad(`${oldName} is somebody's account: the staging would not be a rename`);
    finish();
  }
  const moved = await api(`/repos/${ORG}/${repoToday}`, { token: LECTURER.token, method: "PATCH", body: { name: repoOld } });
  if (!moved.ok) {
    bad(`could not rename the repository: HTTP ${moved.status}`);
    finish();
  }
  await stageRename({ id, student: A, oldName });
  ok(`staged: records under @${oldName}, repository ${repoOld}`);
  const again = await accept({ secret, id, broker, student: A });
  if (again && !again.refused) ok("A's second attempt was not refused");
  else bad("A's second attempt was refused");
  if (await repoExists(repoToday)) bad(`a second repository was made: ${repoToday}`);
  else ok("no second repository at the name today's login makes");
  const accepted = await readControlJson(`acceptances/${id}/${A.login}.json`);
  const recorded = await readControlJson(`repositories/${id}/${A.login}.json`);
  if (accepted?.github_id === A.id) ok("the acceptance record moved to the new name");
  else bad(`acceptance record under @${A.login}: ${JSON.stringify(accepted)}`);
  if (recorded?.repo_name === `${ORG}/${repoOld}`) ok(`the repository record still names ${repoOld}`);
  else bad(`repository record: ${JSON.stringify(recorded)}`);
  if ((await readControl(`acceptances/${id}/${oldName}.json`)) === null) ok("nothing is left under the old name");
  else bad("a record is still under the old name");
  const access = await api(`/repos/${ORG}/${repoOld}/collaborators/${A.login}/permission`, { token: LECTURER.token });
  if (access.data?.permission && access.data.permission !== "none") ok(`A still has ${access.data.permission}`);
  else bad(`A's access: ${JSON.stringify(access.data)}`);

  console.log("\n3. What the student's page sees\n");
  const reach = await api("/user/repos?affiliation=owner,collaborator&per_page=100&sort=full_name", { token: A.token });
  const found = await renamedRepoFor({
    api: (method, path) => api(path, { token: A.token, method }),
    repos: reach.data || [], org: ORG, assignment: storedDoc, assignmentId: id, login: A.login,
  });
  if (found?.name === repoOld) ok(`with their own token, GitHub says nobody holds @${oldName}, their attempt is listed, and ${repoOld} is theirs`);
  else bad(`renamedRepoFor found ${found?.name ?? "nothing"} among ${(reach.data || []).length}`);

  console.log("\n4. The nightly follows it\n");
  await stageRename({ id, student: A, oldName });
  ok("staged again");
  const dispatchedAt = Date.now() - 30_000;
  const nightly = await api(`/repos/${HUB}/actions/workflows/daily-activity.yml/dispatches`, {
    token: LECTURER.token, method: "POST", body: { ref: "main", inputs: { org: ORG } },
  });
  if (!nightly.ok) bad(`nightly dispatch: HTTP ${nightly.status}`);
  let leg = null;
  for (let waited = 0; waited < 900_000 && !leg; waited += 15_000) {
    await sleep(15_000);
    const q = new URLSearchParams({ created: `>=${isoSeconds(dispatchedAt)}`, event: "workflow_dispatch", per_page: "5" });
    const runs = await api(`/repos/${HUB}/actions/workflows/daily-activity.yml/runs?${q}`, { token: LECTURER.token });
    const run = (runs.data?.workflow_runs || [])[0];
    if (run?.status === "completed") leg = run;
  }
  if (!leg) bad("the nightly did not finish within 15 minutes");
  else if (leg.conclusion !== "success") bad(`the nightly ended ${leg.conclusion}: ${leg.html_url}`);
  else ok(`the nightly finished: ${leg.html_url}`);
  const afterNight = await readControlJson(`acceptances/${id}/${A.login}.json`);
  if (afterNight?.github_id === A.id && (await readControl(`acceptances/${id}/${oldName}.json`)) === null) ok("the nightly moved the records to the name GitHub says");
  else bad(`after the nightly, acceptances/${id}/${A.login}.json: ${JSON.stringify(afterNight)}`);
  const issues = await api(`/repos/${ORG}/${CONTROL_REPO}/issues?state=open&per_page=30`, { token: LECTURER.token });
  let noticed = false;
  for (const issue of issues.data || []) {
    if (String(issue.body || "").includes(oldName)) noticed = true;
    const comments = await api(`/repos/${ORG}/${CONTROL_REPO}/issues/${issue.number}/comments?per_page=100`, { token: LECTURER.token });
    if ((comments.data || []).some((c) => String(c.body).includes(`\`${oldName}\` is now`))) noticed = true;
  }
  if (noticed) ok("the tracking issue says who is now who");
  else bad("no notice on the tracking issue names the rename");

  console.log("\n5. A name that passed to another account\n");
  const path = `acceptances/${id}/${B.login}.json`;
  await putControl(path, JSON.stringify({ schema_version: 1, assignment_id: id, github_login: B.login, github_id: A.id, accepted_at: isoSeconds(now), status: "accepted" }, null, 2) + "\n", `Drill: a record under @${B.login} for another account`);
  const stranger = await accept({ secret, id, broker, student: B });
  if (stranger?.refused) ok("B was refused, and given nothing");
  else bad("B was not refused");
  await deleteControl(path, "Drill: remove the staged record");
  await deleteControl(renamesPath(A.id), "Drill: remove the staged ledger");

  note(`afterwards: node tests/live/drill.mjs cleanup ${id} (after ${deadlineAt})`);
  finish();
}

if (process.argv[2] === "start") await start();
else {
  console.log("Usage: node tests/live/account-rename.mjs start");
  process.exit(2);
}
