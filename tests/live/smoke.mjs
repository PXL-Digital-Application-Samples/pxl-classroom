#!/usr/bin/env node
// PXL Classroom - LIVE smoke test. Not part of `npm test`.
//
// `npm test` globs tests/*.test.mjs, so nothing here runs in CI. This drives the
// REAL deployment with the real accounts in .env.test, which is the only way to
// exercise what mocks cannot: that the broker dispatches, that the hub's
// acceptance handler runs, and that a repository actually appears.
//
//   node tests/live/smoke.mjs              preflight + signing, NO writes
//   node tests/live/smoke.mjs --accept     also submits a real acceptance
//
// WITHOUT --accept nothing is created. With it, the student account opens an
// issue on the public broker, which is exactly what the SPA does - and that
// provisions a real repository and consumes a cap slot. Use a test assignment.
//
// The accounts, the preflight and the acceptance itself are in live-kit.mjs,
// shared with drill.mjs - including why there are three accounts and not four,
// and the base-permission trap preflight refuses to be reassuring about.

import { linkSecretFrom, parseInviteFields } from "../../lib/invite-token-format.mjs";
import { normalizeLogin } from "../../lib/github-login.mjs";
import {
  accounts, acceptInvitation, api, checkAccounts, checkOrg, decode, die, loadEnv,
  openAcceptanceIssue, reporter, signAcceptance, sleep,
} from "./live-kit.mjs";

const ACCEPT = process.argv.includes("--accept");

const env = loadEnv();
const ORG = env.TEST_ORG;
const ASSIGNMENT = env.TEST_ASSIGNMENT_ID;
const r = reporter();
const { ok, bad, note } = r;
const ACCOUNTS = accounts(env);

// --- 1. preflight ------------------------------------------------------------

async function preflight() {
  console.log("\n1. Preflight - can these accounts do anything at all?\n");
  if (!ORG || !ASSIGNMENT) die("TEST_ORG and TEST_ASSIGNMENT_ID must be set in .env.test");
  await checkAccounts(ACCOUNTS, r);
  await checkOrg(ORG, ACCOUNTS.LECTURER, r);
}

// --- 2. the assignment, as the lecturer sees it ------------------------------

async function readAssignment() {
  console.log("\n2. The assignment, read from the control repo\n");
  const res = await api(
    `/repos/${ORG}/pxl-classroom-control/contents/assignments/${ASSIGNMENT}.yml`,
    { token: ACCOUNTS.LECTURER.token },
  );
  if (!res.ok) { bad(`assignments/${ASSIGNMENT}.yml: HTTP ${res.status}`); return null; }
  const yaml = decode(res.data.content);

  const fields = parseInviteFields(yaml);
  const secret = linkSecretFrom(fields);
  const state = (yaml.match(/^state:\s*(\S+)/m) || [])[1];
  const type = (yaml.match(/^assignment_type:\s*(\S+)/m) || [])[1] || "individual";

  if (state === "published") ok(`state: published`);
  else bad(`state is "${state}" - a student cannot accept anything that is not published`);
  ok(`assignment_type: ${type}`);

  if (!secret) bad("no invitation secret in the YAML - publish the assignment to mint one");
  else ok(`invitation secret present (${secret.length} chars)`);

  return { yaml, secret, type, state };
}

// --- 3. the signing path, without submitting ---------------------------------

async function signOnly(assignment, student) {
  console.log(`\n3. Signing an acceptance as ${student.login} (nothing is submitted)\n`);
  return signAcceptance({ secret: assignment?.secret, assignmentId: ASSIGNMENT, student }, r);
}

// --- 4. the real thing -------------------------------------------------------

async function submitAcceptance(title, student, { teamSlug = null, teamName = null } = {}) {
  console.log(`\n4. Submitting a REAL acceptance as ${student.login}${teamSlug ? ` (team ${teamSlug})` : ""}\n`);
  const opened = await openAcceptanceIssue(
    { org: ORG, broker: `broker-${ASSIGNMENT}`, title, student, teamSlug, teamName },
    r,
  );
  if (!opened) return;

  // Provisioning is synchronous but not instant. The SPA waits the same way.
  // A group repository is named for the TEAM, an individual one for the
  // student - repository_name_pattern decides, and this mirrors it.
  const repoGuess = teamSlug
    ? `${ASSIGNMENT}-${teamSlug}`
    : `${ASSIGNMENT}-${normalizeLogin(student.login)}`;
  // Polled with the LECTURER's token, not the student's. A student repository
  // is PRIVATE and provisioning adds the student as a collaborator, which is an
  // INVITATION they have not accepted yet - so `GET /repos/...` as the student
  // is 404 even though the repository exists. Polling as the student reported
  // "no repository after 120s" over a repository that had been created 30
  // seconds earlier, which is the `invited` state the SPA renders as "Accept
  // invitation", not a provisioning failure.
  note(`polling for ${ORG}/${repoGuess} …`);
  for (let i = 1; i <= 20; i++) {
    await sleep(6000);
    const repo = await api(`/repos/${ORG}/${repoGuess}`, { token: ACCOUNTS.LECTURER.token });
    if (repo.ok) { ok(`repository exists after ~${i * 6}s: ${repo.data.html_url}`); break; }
    if (i === 20) { bad(`no repository after 120s - check the hub's acceptance-handler run`); return; }
  }

  await acceptInvitation({ student, repoName: repoGuess }, r);
}

// --- run ---------------------------------------------------------------------

console.log(`PXL Classroom live smoke - org=${ORG} assignment=${ASSIGNMENT} mode=${ACCEPT ? "ACCEPT (writes!)" : "read-only"}`);

await preflight();
const assignment = r.failures() === 0 ? await readAssignment() : null;
const isGroup = assignment?.type === "group";
const TEAM = process.env.TEST_TEAM_SLUG || "smoke-team";

if (assignment) {
  const titleA = await signOnly(assignment, ACCOUNTS.STUDENT_A);
  if (titleA && ACCEPT) {
    await submitAcceptance(titleA, ACCOUNTS.STUDENT_A, isGroup ? { teamSlug: TEAM, teamName: "Smoke Team" } : {});

    // The second member is the scenario three accounts exist for: the first
    // acceptance CREATES the team and provisions the repository, the second
    // JOINS it and must be added to the same one rather than getting a second.
    if (isGroup) {
      const titleB = await signOnly(assignment, ACCOUNTS.STUDENT_B);
      if (titleB) await submitAcceptance(titleB, ACCOUNTS.STUDENT_B, { teamSlug: TEAM, teamName: "Smoke Team" });
      await verifyTeam();
    }
  } else if (titleA) {
    note("re-run with --accept to submit it and watch the repository appear");
  }
}

// --- 5. did the team actually end up with both members? ----------------------

async function verifyTeam() {
  console.log("\n5. The team manifest and the repository's collaborators\n");
  const res = await api(
    `/repos/${ORG}/pxl-classroom-control/contents/teams/${ASSIGNMENT}/${TEAM}.json`,
    { token: ACCOUNTS.LECTURER.token },
  );
  if (!res.ok) { bad(`teams/${ASSIGNMENT}/${TEAM}.json: HTTP ${res.status}`); return; }
  const doc = JSON.parse(decode(res.data.content));
  const members = (doc.members || []).map(normalizeLogin);
  for (const who of [ACCOUNTS.STUDENT_A, ACCOUNTS.STUDENT_B]) {
    if (members.includes(normalizeLogin(who.login))) ok(`${who.login} is on the team manifest`);
    else bad(`${who.login} is NOT on the manifest (members: ${members.join(", ") || "none"})`);
  }

  // The manifest saying so is not the same as GitHub saying so. With the org's
  // base permission at "none", a collaborator grant is the only way in - so
  // this is the check that provisioning actually worked.
  const repo = `${ASSIGNMENT}-${TEAM}`;
  for (const who of [ACCOUNTS.STUDENT_A, ACCOUNTS.STUDENT_B]) {
    const c = await api(`/repos/${ORG}/${repo}/collaborators/${who.login}`, { token: ACCOUNTS.LECTURER.token });
    if (c.status === 204) ok(`${who.login} has repository access on ${repo}`);
    else bad(`${who.login} is NOT a collaborator on ${repo} (HTTP ${c.status})`);
  }
}

console.log(`\n${r.failures() === 0 ? "All checks passed." : `${r.failures()} check(s) failed.`}\n`);
process.exit(r.failures() === 0 ? 0 : 1);
