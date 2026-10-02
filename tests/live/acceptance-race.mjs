#!/usr/bin/env node
// PXL Classroom - LIVE acceptance race. Not part of `npm test`.
//
// What tests/acceptance-race.test.mjs proves against a local git remote, proven
// against the real thing: real GitHub Actions starting real hub runs at the same
// moment, with nothing serialising them (lib/acceptance-reservation.mjs).
//
//   node tests/live/acceptance-race.mjs start
//       create and publish drill-race-<stamp> (group, max_team_size 2, a fresh
//       broker on the current template), then:
//         1. both students join one NEW team at the same instant - both get in,
//            one repository, no hub run cancelled
//         2. a team with one free seat (seeded with a placeholder), both
//            students ask for it at the same instant - exactly one gets it, the
//            other is refused `team-full` and labelled
//         3. one student sends two attempts back to back (another team, then
//            back) - whatever order GitHub runs them in, the newer one stands
//         4. every hub run is findable by its run name, as the page finds it
//         5. the nightly's unanswered-attempt check finds nothing to report
//
//   node tests/live/drill.mjs cleanup <drill-race-id>
//       delete it afterwards, like any drill.
//
// Writes to pxl-classroom-testbed. Point a worktree at the main checkout's
// credentials with LIVE_ENV_FILE.

import { parse, stringify } from "yaml";
import { buildAssignmentDoc, utcToLocalInput } from "../../lib/assignment-doc.mjs";
import { validateAgainst } from "../../lib/validate.mjs";
import { brokerRepoName } from "../../lib/broker-repo.mjs";
import { linkSecretFrom, parseInviteFields } from "../../lib/invite-token-format.mjs";
import { normalizeLogin } from "../../lib/github-login.mjs";
import { REJECTED_LABEL } from "../../lib/acceptance-labels.mjs";
import { acceptanceRunName } from "../../lib/acceptance-run-name.mjs";
import { unansweredAttempts } from "../../lib/unanswered-attempts.mjs";
import { CONTROL_REPO, HUB_OWNER, HUB_REPO_NAME, TIMEZONE } from "../../lib/deployment.mjs";
import {
  accounts, api, checkAccounts, checkOrg, decode, die, loadEnv, reporter, signAcceptance, sleep,
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

async function readControlJson(path) {
  const res = await api(`/repos/${ORG}/${CONTROL_REPO}/contents/${path}`, { token: LECTURER.token });
  if (!res.ok) return null;
  try {
    return JSON.parse(decode(res.data.content));
  } catch {
    return null;
  }
}

async function putControl(path, content, message) {
  const prior = await api(`/repos/${ORG}/${CONTROL_REPO}/contents/${path}`, { token: LECTURER.token });
  const res = await api(`/repos/${ORG}/${CONTROL_REPO}/contents/${path}`, {
    token: LECTURER.token,
    method: "PUT",
    body: { message, content: Buffer.from(content).toString("base64"), ...(prior.ok ? { sha: prior.data.sha } : {}) },
  });
  return res.ok;
}

/** The hub run for one attempt, found by name exactly as the student's page finds it. */
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

async function labelsOf(broker, issue) {
  const res = await api(`/repos/${ORG}/${broker}/issues/${issue}/labels`, { token: LECTURER.token });
  return (res.data || []).map((l) => l.name);
}

async function attempt(secret, id, broker, student, teamSlug, action = "join") {
  const title = await signAcceptance({ secret, assignmentId: id, student }, r);
  if (!title) return null;
  const fullTitle = `${title} team:${teamSlug}`;
  const res = await api(`/repos/${ORG}/${broker}/issues`, {
    token: student.token,
    method: "POST",
    body: { title: fullTitle, body: JSON.stringify({ team_slug: teamSlug, team_name: teamSlug, team_action: action }) },
  });
  if (!res.ok) {
    bad(`${student.login} could not open an attempt: HTTP ${res.status}`);
    return null;
  }
  ok(`${student.login} -> ${teamSlug} as #${res.data.number}`);
  return res.data.number;
}

async function settle(broker, attempts, since) {
  const runs = [];
  for (const { issue, who } of attempts) {
    const run = await runFor(broker, issue, since);
    if (!run) {
      bad(`no completed hub run named for #${issue} (${who}) within 6 minutes`);
      continue;
    }
    if (run.conclusion === "cancelled") bad(`the hub run for #${issue} was CANCELLED - something is queueing acceptances again: ${run.html_url}`);
    else if (run.conclusion !== "success") bad(`the hub run for #${issue} ended ${run.conclusion}: ${run.html_url}`);
    else ok(`#${issue} (${who}): hub run found by name, ${run.conclusion}`);
    runs.push(run);
  }
  return runs;
}

const manifest = (id, slug) => readControlJson(`teams/${id}/${slug}.json`);
const acceptanceOf = (id, s) => readControlJson(`acceptances/${id}/${normalizeLogin(s.login)}.json`);

async function start() {
  console.log(`PXL Classroom live acceptance race - START on ${ORG} (writes!)`);
  console.log("\n0. Preflight\n");
  await checkAccounts(ACCOUNTS, r);
  await checkOrg(ORG, LECTURER, r);
  const tpl = await api(`/repos/${ORG}/${TEMPLATE}`, { token: LECTURER.token });
  if (!tpl.ok) bad(`template ${ORG}/${TEMPLATE}: HTTP ${tpl.status}`);
  if (r.failures()) finish();

  const now = Date.now();
  const stamp = isoSeconds(now).replace(/[-:]/g, "").replace("T", "-").slice(0, 13).toLowerCase();
  const id = `drill-race-${stamp}`;
  const opensAt = new Date(now - 60_000).toISOString();
  // Long enough for the race (about five minutes), short enough that
  // `drill.mjs cleanup` - which deletes only a drill whose deadline has passed -
  // can remove it the same half hour.
  const deadlineAt = new Date(Math.ceil((now + 25 * 60_000) / 60_000) * 60_000).toISOString();
  const form = {
    id,
    title: `Acceptance race ${isoSeconds(now).slice(0, 16).replace("T", " ")} UTC`,
    description: DRILL_DESCRIPTION,
    organization: ORG,
    template: `${ORG}/${TEMPLATE}`,
    repository_name_pattern: `${id}-{team_slug}`,
    opens_at_local: utcToLocalInput(opensAt),
    _opens_at_original: opensAt,
    deadline_at_local: utcToLocalInput(deadlineAt),
    _deadline_at_original: deadlineAt,
    timezone: TIMEZONE,
    submission_ref: `refs/heads/${tpl.data.default_branch}`,
    student_permission: "push",
    acceptance_mode: "self-service",
    roster_mode: "enforced",
    late_policy: "block",
    lock_down_enabled: false,
    assignment_type: "group",
    group_config: { max_team_size: 2, formation_mode: "self-service", allow_team_creation: true },
    state: "published",
  };
  const doc = buildAssignmentDoc(form, { templateRepositoryId: tpl.data.id });
  const { valid, errors } = validateAgainst("assignment", structuredClone(doc));
  if (!valid) {
    bad(`schema refuses the race document: ${JSON.stringify(errors)}`);
    finish();
  }
  if (!(await putControl(`assignments/${id}.yml`, stringify(doc), `Create assignment ${id}`))) {
    bad(`could not commit assignments/${id}.yml`);
    finish();
  }
  ok(`${id} committed (group, max_team_size 2)`);

  console.log("\n1. Publish (a fresh broker, on the current template)\n");
  const pubAt = Date.now() - 5_000;
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
    const res = await api(`/repos/${ORG}/${CONTROL_REPO}/contents/assignments/${id}.yml`, { token: LECTURER.token });
    if (!res.ok) continue;
    const text = decode(res.data.content);
    storedDoc = parse(text);
    const broker = brokerRepoName({ assignment: storedDoc, assignmentId: id });
    const vars = await api(`/repos/${ORG}/${broker}/actions/variables/INVITE_PUBKEY`, { token: LECTURER.token });
    if (storedDoc?.state === "published" && vars.ok) secret = linkSecretFrom(parseInviteFields(text));
  }
  if (!secret) {
    bad(`not published with an invitation within 10 minutes (dispatched ${isoSeconds(pubAt)})`);
    finish();
  }
  const broker = brokerRepoName({ assignment: storedDoc, assignmentId: id });
  ok(`published; broker ${ORG}/${broker}`);
  const wf = await api(`/repos/${ORG}/${broker}/contents/.github/workflows/acceptance-trigger.yml`, { token: LECTURER.token });
  const trigger = wf.ok ? decode(wf.data.content) : "";
  if (/^concurrency:/m.test(trigger)) bad("the broker's workflow still has a concurrency group - published from an old template?");
  else ok("the broker's workflow has no concurrency group");
  if (!trigger.includes("(not delivered)")) bad("the broker's workflow cannot title an issue '(not delivered)' - old template?");
  await sleep(15_000);

  console.log("\n2. Both students join one NEW team at the same instant\n");
  let since = Date.now() - 10_000;
  const [a1, b1] = await Promise.all([attempt(secret, id, broker, A, "alpha"), attempt(secret, id, broker, B, "alpha")]);
  await settle(broker, [{ issue: a1, who: A.login }, { issue: b1, who: B.login }], since);
  const alpha = await manifest(id, "alpha");
  const members = (alpha?.members || []).map(normalizeLogin).sort();
  if (JSON.stringify(members) === JSON.stringify([A.login, B.login].map(normalizeLogin).sort())) ok(`alpha: ${alpha.members.join(", ")}`);
  else bad(`alpha holds ${JSON.stringify(alpha?.members)} - expected both students`);
  const recA = await readControlJson(`repositories/${id}/${normalizeLogin(A.login)}.json`);
  const recB = await readControlJson(`repositories/${id}/${normalizeLogin(B.login)}.json`);
  if (recA && recB && recA.repo_id === recB.repo_id && recA.repo_id === alpha?.repo_id) ok(`one repository for both: ${recA.repo_name}`);
  else bad(`repository records disagree: ${recA?.repo_name} / ${recB?.repo_name} / manifest ${alpha?.repo_name}`);
  for (const [s, n] of [[A, a1], [B, b1]]) {
    const acc = await acceptanceOf(id, s);
    if (acc?.issue_number === n && acc?.decided_by_run_id) ok(`${s.login}'s record names attempt #${n} and run ${acc.decided_by_run_id}`);
    else bad(`${s.login}'s record: issue_number ${acc?.issue_number}, decided_by_run_id ${acc?.decided_by_run_id}`);
  }

  console.log("\n3. One free seat, both students ask for it at the same instant\n");
  const seeded = await putControl(
    `teams/${id}/beta.json`,
    JSON.stringify({ schema_version: 1, assignment_id: id, team_slug: "beta", team_name: "beta", members: ["race-placeholder"], max_members: 2 }, null, 2) + "\n",
    `Seed team beta for ${id}`,
  );
  if (!seeded) bad("could not seed team beta");
  since = Date.now() - 10_000;
  const [a2, b2] = await Promise.all([
    attempt(secret, id, broker, A, "beta", "switch"),
    attempt(secret, id, broker, B, "beta", "switch"),
  ]);
  await settle(broker, [{ issue: a2, who: A.login }, { issue: b2, who: B.login }], since);
  const beta = await manifest(id, "beta");
  if (beta?.members?.length === 2) ok(`beta is full and not over: ${beta.members.join(", ")}`);
  else bad(`beta holds ${JSON.stringify(beta?.members)} - expected exactly 2`);
  const winner = [A, B].find((s) => beta?.members?.map(normalizeLogin).includes(normalizeLogin(s.login)));
  const loser = winner === A ? B : A;
  const loserIssue = loser === A ? a2 : b2;
  if (winner) ok(`${winner.login} got the seat`);
  if ((await labelsOf(broker, loserIssue)).includes(REJECTED_LABEL)) ok(`${loser.login}'s #${loserIssue} is labelled ${REJECTED_LABEL}`);
  else bad(`${loser.login}'s #${loserIssue} carries no ${REJECTED_LABEL} label`);
  const loserAcc = await acceptanceOf(id, loser);
  if (loserAcc?.team_slug === "alpha") ok(`${loser.login} is still in alpha`);
  else bad(`${loser.login}'s record says ${loserAcc?.team_slug}`);

  console.log(`\n4. ${loser.login} sends two attempts back to back - the newer must stand\n`);
  since = Date.now() - 10_000;
  const first = await attempt(secret, id, broker, loser, "gamma", "switch");
  const second = await attempt(secret, id, broker, loser, "alpha", "switch");
  await settle(broker, [{ issue: first, who: loser.login }, { issue: second, who: loser.login }], since);
  const final = await acceptanceOf(id, loser);
  if (final?.team_slug === "alpha" && final?.issue_number === second) ok(`${loser.login} ends in alpha, decided by #${second}`);
  else bad(`${loser.login} ends in ${final?.team_slug} decided by #${final?.issue_number} - expected alpha by #${second}`);

  console.log("\n5. The nightly's unanswered-attempt check, an hour from now\n");
  const issues = await api(`/repos/${ORG}/${broker}/issues?state=all&per_page=100`, { token: LECTURER.token });
  const records = new Map();
  for (const s of [A, B]) records.set(normalizeLogin(s.login), await acceptanceOf(id, s));
  const unanswered = unansweredAttempts({
    issues: issues.data || [],
    acceptanceOf: (login) => records.get(normalizeLogin(login)) ?? null,
    now: new Date(Date.now() + 3600_000),
  });
  if (unanswered.length === 0) ok("nothing to report");
  else bad(`would report: ${JSON.stringify(unanswered)}`);

  note(`clean up after ${deadlineAt} with: node tests/live/drill.mjs cleanup ${id}`);
  finish();
}

const [command] = process.argv.slice(2);
if (command === "start") await start();
else die("usage: node tests/live/acceptance-race.mjs start");
