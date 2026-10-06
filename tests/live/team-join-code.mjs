#!/usr/bin/env node
// PXL Classroom - LIVE team join codes. Not part of `npm test`.
//
// What tests/team-join-code-accept.test.mjs proves against a checkout on disk,
// proven against the real thing: the real broker, the real hub run, the real
// claim key, the published teams file on Pages.
//
//   node tests/live/team-join-code.mjs start
//       create and publish drill-code-<stamp> (group, max_team_size 3,
//       require_join_code, roster_mode open), then, as the students' pages do:
//         1. A creates alpha with a fresh code: alpha holds A and the code
//         2. B asks for alpha with no code, with another code, and with A's
//            own sealed code copied from A's public issue: all refused and
//            labelled, alpha untouched
//         3. B joins alpha with the code: both in, one repository
//         4. A switches to a new team beta (code 2), then B follows with it:
//            alpha is vacant, still holding code 1
//         5. A types "alpha" again with code 3: alpha is made again, holds A
//            and code 3 - not the code that left
//         6. the public teams file says which teams need a code and holds none
//         7. no hub run failed, no code reached a public run log
//
//   node tests/live/team-join-code.mjs check <drill-code-id> [code ...]
//       steps 6 and 7 again for an assignment already started - Pages can lag
//       by many minutes behind a burst of acceptances.
//
//   node tests/live/drill.mjs cleanup <drill-code-id>
//       delete it afterwards, like any drill (after its deadline).
//
// Writes to pxl-classroom-testbed. Point a worktree at the main checkout's
// credentials with LIVE_ENV_FILE.

import { parse, stringify } from "yaml";
import { buildAssignmentDoc, utcToLocalInput } from "../../lib/assignment-doc.mjs";
import { validateAgainst } from "../../lib/validate.mjs";
import { brokerRepoName } from "../../lib/broker-repo.mjs";
import { linkSecretFrom, parseInviteFields } from "../../lib/invite-token-format.mjs";
import { inviteFileFor } from "../../lib/invite-token.mjs";
import { normalizeLogin } from "../../lib/github-login.mjs";
import { REJECTED_LABEL } from "../../lib/acceptance-labels.mjs";
import { acceptanceRunName } from "../../lib/acceptance-run-name.mjs";
import { encryptTeamCode } from "../../lib/claim.mjs";
import { formatJoinCode, newJoinCode } from "../../lib/team-join-code.mjs";
import { CONTROL_REPO, HUB_OWNER, HUB_REPO_NAME, TIMEZONE } from "../../lib/deployment.mjs";
import {
  accounts, api, checkAccounts, checkOrg, decode, die, loadEnv, reporter, root, signAcceptance, sleep,
} from "./live-kit.mjs";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ORG = process.env.DRILL_ORG || "pxl-classroom-testbed";
const TEMPLATE = process.env.DRILL_TEMPLATE || "starter-template";
const HUB = `${HUB_OWNER}/${HUB_REPO_NAME}`;
const PAGES = process.env.PAGES_BASE || `https://${HUB_OWNER.toLowerCase()}.github.io/${HUB_REPO_NAME}/`;
// The same description drill.mjs writes, so `drill.mjs cleanup` deletes these.
const DRILL_DESCRIPTION = "Automated deadline drill (tests/live/drill.mjs). Safe to delete.";

const env = loadEnv();
const ACCOUNTS = accounts(env);
const LECTURER = ACCOUNTS.LECTURER;
const A = ACCOUNTS.STUDENT_A;
const B = ACCOUNTS.STUDENT_B;
const r = reporter();
const { ok, bad, note } = r;

// The hub's public claim key, as the page reads it (frontend/src/lib/claim.js).
const claimKeys = JSON.parse(readFileSync(join(root, "acceptance", "claim-keys.json"), "utf8"));
const HUB_KEY = claimKeys.keys[claimKeys.current];

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

/**
 * One attempt, as the page sends it: a signed title, and a body carrying the
 * team and - when given - a code sealed to the hub's key. `sealed` sends a
 * ciphertext as it is, for the replay case.
 */
async function attempt({ secret, id, broker, student, slug, action, code = null, sealed = null }) {
  const title = await signAcceptance({ secret, assignmentId: id, student }, r);
  if (!title) return null;
  const teamCode = sealed ?? (code
    ? await encryptTeamCode({ publicKey: HUB_KEY, code, githubId: student.id, assignmentId: id, teamSlug: slug })
    : null);
  const body = { team_slug: slug, team_name: slug, team_action: action, ...(teamCode ? { team_code: teamCode } : {}) };
  const res = await api(`/repos/${ORG}/${broker}/issues`, {
    token: student.token,
    method: "POST",
    body: { title: `${title} team:${slug}`, body: JSON.stringify(body) },
  });
  if (!res.ok) {
    bad(`${student.login} could not open an attempt: HTTP ${res.status}`);
    return null;
  }
  ok(`${student.login} -> ${slug} (${action}${code ? `, code ${formatJoinCode(code)}` : sealed ? ", a copied ciphertext" : ", no code"}) as #${res.data.number}`);
  return { issue: res.data.number, teamCode };
}

/** Wait for the run, and say whether it was refused. */
async function decided(broker, sent, since, who) {
  if (!sent) return null;
  const run = await runFor(broker, sent.issue, since);
  if (!run) {
    bad(`no completed hub run for #${sent.issue} (${who}) within 6 minutes`);
    return null;
  }
  if (run.conclusion !== "success") bad(`the hub run for #${sent.issue} ended ${run.conclusion}: ${run.html_url}`);
  const refused = (await labelsOf(broker, sent.issue)).includes(REJECTED_LABEL);
  return { run, refused };
}

const manifest = (id, slug) => readControlJson(`teams/${id}/${slug}.json`);
const members = (t) => (t?.members || []).map(normalizeLogin).sort();
const logins = (...s) => s.map((x) => normalizeLogin(x.login)).sort();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function start() {
  console.log(`PXL Classroom live team join codes - START on ${ORG} (writes!)`);
  console.log("\n0. Preflight\n");
  await checkAccounts(ACCOUNTS, r);
  await checkOrg(ORG, LECTURER, r);
  const tpl = await api(`/repos/${ORG}/${TEMPLATE}`, { token: LECTURER.token });
  if (!tpl.ok) bad(`template ${ORG}/${TEMPLATE}: HTTP ${tpl.status}`);
  if (!HUB_KEY) bad("acceptance/claim-keys.json has no current key - join codes cannot be sealed");
  if (r.failures()) finish();

  const now = Date.now();
  const startedAt = now - 60_000;
  const stamp = isoSeconds(now).replace(/[-:]/g, "").replace("T", "-").slice(0, 13).toLowerCase();
  const id = `drill-code-${stamp}`;
  const opensAt = new Date(now - 60_000).toISOString();
  const deadlineAt = new Date(Math.ceil((now + 40 * 60_000) / 60_000) * 60_000).toISOString();
  const form = {
    id,
    title: `Join codes ${isoSeconds(now).slice(0, 16).replace("T", " ")} UTC`,
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
    // Open, so the lecturer can also walk the student page in a browser.
    roster_mode: "open",
    max_acceptances: 10,
    late_policy: "block",
    lock_down_enabled: false,
    assignment_type: "group",
    group_config: { max_team_size: 3, formation_mode: "self-service", allow_team_creation: true, require_join_code: true },
    state: "published",
  };
  const doc = buildAssignmentDoc(form, { templateRepositoryId: tpl.data.id });
  if (doc.group_config?.require_join_code !== true) bad("buildAssignmentDoc dropped require_join_code");
  const { valid, errors } = validateAgainst("assignment", structuredClone(doc));
  if (!valid) {
    bad(`schema refuses the document: ${JSON.stringify(errors)}`);
    finish();
  }
  if (!(await putControl(`assignments/${id}.yml`, stringify(doc), `Create assignment ${id}`))) {
    bad(`could not commit assignments/${id}.yml`);
    finish();
  }
  ok(`${id} committed (group, max 3, join codes on, open)`);

  console.log("\n1. Publish\n");
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
    bad("not published with an invitation within 10 minutes");
    finish();
  }
  const broker = brokerRepoName({ assignment: storedDoc, assignmentId: id });
  ok(`published; broker ${ORG}/${broker}`);
  if (storedDoc.group_config?.require_join_code === true) ok("the stored assignment asks for join codes");
  else bad(`the stored assignment's group_config: ${JSON.stringify(storedDoc.group_config)}`);
  note(`invitation link: ${PAGES}${ORG}/i/${secret}`);
  await sleep(15_000);

  const code1 = newJoinCode();
  const code2 = newJoinCode();
  const code3 = newJoinCode();

  console.log("\n2. A creates alpha with a fresh code\n");
  let since = Date.now() - 10_000;
  const a1 = await attempt({ secret, id, broker, student: A, slug: "alpha", action: "create", code: code1 });
  const d1 = await decided(broker, a1, since, A.login);
  let alpha = await manifest(id, "alpha");
  if (d1 && !d1.refused && same(members(alpha), logins(A))) ok(`alpha holds ${A.login}`);
  else bad(`alpha: ${JSON.stringify(alpha?.members)}, refused ${d1?.refused}`);
  if (alpha?.join_code === code1) ok(`alpha's stored code is the one A's page made (${formatJoinCode(code1)})`);
  else bad(`alpha's stored code is ${JSON.stringify(alpha?.join_code)}, expected ${code1}`);

  console.log("\n3. B tries alpha without the code, with another, and with A's copied ciphertext\n");
  for (const [why, args] of [
    ["no code", {}],
    ["another team's code", { code: code2 }],
    ["A's own sealed code, copied from A's issue", { sealed: a1?.teamCode }],
  ]) {
    since = Date.now() - 10_000;
    const sent = await attempt({ secret, id, broker, student: B, slug: "alpha", action: "join", ...args });
    const d = await decided(broker, sent, since, B.login);
    if (d?.refused) ok(`${why}: refused, labelled ${REJECTED_LABEL}`);
    else bad(`${why}: NOT refused`);
  }
  alpha = await manifest(id, "alpha");
  if (same(members(alpha), logins(A)) && alpha?.join_code === code1) ok("alpha is untouched");
  else bad(`alpha changed: ${JSON.stringify(alpha)}`);

  console.log("\n4. B joins alpha with the code\n");
  since = Date.now() - 10_000;
  const b1 = await attempt({ secret, id, broker, student: B, slug: "alpha", action: "join", code: code1 });
  const db1 = await decided(broker, b1, since, B.login);
  alpha = await manifest(id, "alpha");
  if (db1 && !db1.refused && same(members(alpha), logins(A, B))) ok(`alpha holds both: ${alpha.members.join(", ")}`);
  else bad(`alpha holds ${JSON.stringify(alpha?.members)}, refused ${db1?.refused}`);
  if (alpha?.join_code === code1) ok("alpha keeps its code");
  else bad(`alpha's code is now ${alpha?.join_code}`);

  console.log("\n5. A makes beta, B follows with its code: alpha is left empty\n");
  since = Date.now() - 10_000;
  const a2 = await attempt({ secret, id, broker, student: A, slug: "beta", action: "switch", code: code2 });
  await decided(broker, a2, since, A.login);
  since = Date.now() - 10_000;
  const b2 = await attempt({ secret, id, broker, student: B, slug: "beta", action: "switch", code: code2 });
  await decided(broker, b2, since, B.login);
  const beta = await manifest(id, "beta");
  alpha = await manifest(id, "alpha");
  if (same(members(beta), logins(A, B)) && beta?.join_code === code2) ok(`beta holds both, with code ${formatJoinCode(code2)}`);
  else bad(`beta: ${JSON.stringify(beta)}`);
  if (alpha?.vacant === true && (alpha?.members || []).length === 0) ok(`alpha is vacant, still holding ${formatJoinCode(code1)} that nobody can give out`);
  else bad(`alpha: ${JSON.stringify(alpha)}`);

  console.log("\n6. A types \"alpha\" again with a new code: it is made again\n");
  since = Date.now() - 10_000;
  const a3 = await attempt({ secret, id, broker, student: A, slug: "alpha", action: "switch", code: code3 });
  const d3 = await decided(broker, a3, since, A.login);
  alpha = await manifest(id, "alpha");
  if (d3 && !d3.refused && same(members(alpha), logins(A))) ok(`alpha holds ${A.login} again`);
  else bad(`alpha: ${JSON.stringify(alpha?.members)}, refused ${d3?.refused}`);
  if (alpha?.join_code === code3) ok(`alpha's code is the new one (${formatJoinCode(code3)}), not the one that left`);
  else bad(`alpha's code is ${alpha?.join_code}`);

  await publicAndLogs({ secret, broker, since: startedAt, codes: [code1, code2, code3] });
  note(`walk the student page as another account: ${PAGES}${ORG}/i/${secret}`);
  note(`clean up after ${deadlineAt} with: node tests/live/drill.mjs cleanup ${id}`);
  finish();
}

/**
 * Steps 7 and 8, which wait on things this script does not control: Pages
 * (every acceptance regenerates, and in a burst each deploy cancels the one
 * before, so the file lags by minutes), and the logs of finished runs.
 */
async function publicAndLogs({ secret, broker, since, codes }) {
  console.log("\n7. The public teams file\n");
  // The FINAL state, both teams as step 6 left them: alpha alone would also
  // match the file as it stood after step 2.
  const url = `${PAGES}data/${ORG}/i/${inviteFileFor(secret)}.teams.json`;
  let teams = null;
  for (let waited = 0; waited < 900_000; waited += 20_000) {
    const res = await fetch(`${url}?_t=${Date.now()}`, { cache: "no-store" });
    if (res.ok) {
      const text = await res.text();
      for (const code of codes) {
        if (text.includes(code)) bad(`the public teams file contains a join code (${formatJoinCode(code)})`);
      }
      const data = JSON.parse(text);
      const pub = (slug) => (data.teams || []).find((t) => t.team_slug === slug);
      if (same(members(pub("alpha")), logins(A)) && same(members(pub("beta")), logins(B))) {
        teams = data.teams;
        break;
      }
    }
    await sleep(20_000);
  }
  if (!teams) bad(`the public teams file did not reach the final state within 15 minutes: ${url}`);
  else {
    const flags = Object.fromEntries(teams.map((t) => [t.team_slug, t.needs_code === true]));
    if (flags.alpha && flags.beta) ok(`alpha and beta are published as needing a code: ${JSON.stringify(flags)}`);
    else bad(`needs_code flags: ${JSON.stringify(flags)}`);
    if (!teams.some((t) => "join_code" in t)) ok("no join_code field, and no code, in the public file");
    else bad("a join_code field is in the public file");
  }

  console.log("\n8. No code in any public run log\n");
  // `created` bounds the list: without it GitHub does not hand back the newest
  // runs first, and the filter below found none of these. Each JOB's log is
  // plain text; the run's log is a zip, which a search cannot see into.
  const q = new URLSearchParams({ created: `>=${isoSeconds(since)}`, per_page: "100", event: "repository_dispatch" });
  const runs = await api(`/repos/${HUB}/actions/workflows/acceptance-handler.yml/runs?${q}`, { token: LECTURER.token });
  const mine = (runs.data?.workflow_runs || []).filter((x) => String(x.display_title || "").includes(broker));
  if (mine.length === 0) bad(`no hub run for ${broker} found since ${isoSeconds(since)}`);
  let read = 0;
  for (const run of mine) {
    const jobs = await api(`/repos/${HUB}/actions/runs/${run.id}/jobs?per_page=100`, { token: LECTURER.token });
    for (const job of jobs.data?.jobs || []) {
      const res = await fetch(`https://api.github.com/repos/${HUB}/actions/jobs/${job.id}/logs`, {
        headers: { Authorization: `Bearer ${LECTURER.token}` },
        redirect: "follow",
      });
      if (!res.ok) {
        bad(`run ${run.id} job ${job.name}: log not readable (HTTP ${res.status})`);
        continue;
      }
      const text = await res.text();
      read++;
      const leaked = codes.filter((c) => text.includes(c) || text.includes(formatJoinCode(c)));
      if (leaked.length) bad(`${run.display_title} (${job.name}) logs ${leaked.map(formatJoinCode).join(", ")}`);
    }
  }
  if (read && !r.failures()) ok(`${read} job log(s) across ${mine.length} hub run(s): no join code in any`);
  else if (read) note(`${read} job log(s) read across ${mine.length} hub run(s)`);
}

/** Steps 7 and 8 again, for an assignment `start` already ran. */
async function check(id, extraCodes) {
  console.log(`PXL Classroom live team join codes - CHECK ${id} on ${ORG} (reads only)`);
  await checkAccounts(ACCOUNTS, r);
  const res = await api(`/repos/${ORG}/${CONTROL_REPO}/contents/assignments/${id}.yml`, { token: LECTURER.token });
  if (!res.ok) die(`assignments/${id}.yml: HTTP ${res.status}`);
  const text = decode(res.data.content);
  const secret = linkSecretFrom(parseInviteFields(text));
  const broker = brokerRepoName({ assignment: parse(text), assignmentId: id });
  const stored = [await manifest(id, "alpha"), await manifest(id, "beta")].map((t) => t?.join_code).filter(Boolean);
  const codes = [...new Set([...stored, ...extraCodes.map((c) => c.replace(/-/g, "").toUpperCase())])];
  // A drill lives for under an hour; six hours back covers every run it had.
  await publicAndLogs({ secret, broker, since: Date.now() - 6 * 3600_000, codes });
  finish();
}

const [command, ...rest] = process.argv.slice(2);
if (command === "start") await start();
else if (command === "check" && rest[0]) await check(rest[0], rest.slice(1));
else die("usage: node tests/live/team-join-code.mjs start | check <drill-code-id> [code ...]");
