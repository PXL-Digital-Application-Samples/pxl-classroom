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
// THREE ACCOUNTS, NOT FOUR. tomcoolpxl-student2 is flagged by GitHub: its own
// token authenticates, but `GET /users/tomcoolpxl-student2` is 404 to everyone
// else, so it cannot be added as a collaborator and cannot be provisioned for.
// lecturer2 stands in as the second student instead - a role here is org
// membership plus a roster line, nothing intrinsic to the account.
//
// ONE TRAP, and it is the reason this file says so out loud: if the second
// student is an ORG MEMBER and the org's `default_repository_permission` is
// anything above `none`, they already have access to every repository in the
// org. A broken collaborator grant would then be invisible and this smoke test
// would pass over it. Preflight checks that value and refuses to be reassuring
// about it - see lib/audit.mjs's baseRepositoryPermissionFinding.

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { signAcceptanceTitle } from "../../lib/acceptance-signature.mjs";
import { linkSecretFrom, parseInviteFields } from "../../lib/invite-token-format.mjs";
import { normalizeLogin } from "../../lib/github-login.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ACCEPT = process.argv.includes("--accept");

// --- env ---------------------------------------------------------------------

function loadEnv() {
  const path = join(root, ".env.test");
  if (!existsSync(path)) die(`.env.test not found at ${path}`);
  const env = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return env;
}

const env = loadEnv();
const ORG = env.TEST_ORG;
const ASSIGNMENT = env.TEST_ASSIGNMENT_ID;

let failures = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const bad = (m) => { failures++; console.log(`  FAIL  ${m}`); };
const note = (m) => console.log(`        ${m}`);
function die(m) { console.error(`\n${m}\n`); process.exit(2); }

async function api(path, { token, method = "GET", body } = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "pxl-classroom-live-smoke",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  const text = await res.text();
  if (text) { try { data = JSON.parse(text); } catch { data = { raw: text }; } }
  return { status: res.status, ok: res.ok, data };
}

const decode = (b64) => Buffer.from(b64, "base64").toString("utf8");

// --- accounts ----------------------------------------------------------------
//
// LECTURER is the lecturer. STUDENT_A is the student. STUDENT_B is lecturer2
// doing duty as the second student, which is what makes the group scenarios
// possible with three accounts.
const ACCOUNTS = {
  LECTURER: { login: env.TEST_LECTURER_LOGIN, token: env.TEST_LECTURER_TOKEN, email: env.TEST_LECTURER_EMAIL },
  STUDENT_A: { login: env.TEST_STUDENT1_LOGIN, token: env.TEST_STUDENT1_TOKEN, email: env.TEST_STUDENT1_EMAIL },
  STUDENT_B: { login: env.TEST_LECTURER2_LOGIN, token: env.TEST_LECTURER2_TOKEN, email: env.TEST_LECTURER2_EMAIL },
};

// --- 1. preflight ------------------------------------------------------------

async function preflight() {
  console.log("\n1. Preflight - can these accounts do anything at all?\n");
  if (!ORG || !ASSIGNMENT) die("TEST_ORG and TEST_ASSIGNMENT_ID must be set in .env.test");

  for (const [role, a] of Object.entries(ACCOUNTS)) {
    if (!a.token) { bad(`${role}: no token in .env.test`); continue; }
    const me = await api("/user", { token: a.token });
    if (!me.ok) { bad(`${role} (${a.login}): token rejected, HTTP ${me.status}`); continue; }
    a.id = me.data.id;

    // Visible to OTHERS, not just to itself. A flagged account authenticates
    // fine and is 404 to everyone else - which is what makes it unusable as a
    // collaborator, and what made this check necessary.
    const seen = await fetch(`https://api.github.com/users/${a.login}`);
    if (!seen.ok) {
      bad(`${role} (${a.login}): authenticates, but GET /users/${a.login} is ${seen.status} to anonymous - the account is flagged and cannot be provisioned for`);
      continue;
    }
    ok(`${role}: ${a.login} #${a.id}, visible publicly`);
  }

  const ctl = await api(`/repos/${ORG}/pxl-classroom-control`, { token: ACCOUNTS.LECTURER.token });
  if (!ctl.ok) bad(`lecturer cannot read ${ORG}/pxl-classroom-control (HTTP ${ctl.status}) - add the account to the org`);
  else ok(`lecturer can read ${ORG}/pxl-classroom-control`);

  // The trap in the header, checked rather than assumed.
  const org = await api(`/orgs/${ORG}`, { token: ACCOUNTS.LECTURER.token });
  const base = org.data?.default_repository_permission;
  if (base === undefined || base === null) {
    note(`could not read ${ORG}'s default_repository_permission (needs org admin) - verify it is "none" by hand`);
  } else if (base !== "none") {
    bad(`${ORG} default_repository_permission is "${base}", not "none": an org MEMBER already has repository access, so a failed collaborator grant would be invisible to this test`);
  } else {
    ok(`${ORG} default_repository_permission is "none" - a collaborator grant is the only way in, so provisioning is actually being tested`);
  }
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
  if (!assignment?.secret) { bad("no secret to sign with"); return null; }
  try {
    const title = await signAcceptanceTitle({
      privateKey: assignment.secret,
      assignmentId: ASSIGNMENT,
      githubId: student.id,
    });
    ok(`signed title: ${title.slice(0, 48)}…  (${title.length} chars)`);
    // The broker refuses a title over MAX_TITLE_LENGTH, so a signature that
    // cannot fit is a failure worth catching here rather than on a student's
    // screen.
    if (title.length > 256) bad(`title is ${title.length} chars - the broker's limit is 256`);
    return title;
  } catch (err) {
    bad(`could not sign: ${err.message}`);
    return null;
  }
}

// --- 4. the real thing -------------------------------------------------------

async function submitAcceptance(title, student) {
  console.log(`\n4. Submitting a REAL acceptance as ${student.login}\n`);
  const broker = `broker-${ASSIGNMENT}`;
  const res = await api(`/repos/${ORG}/${broker}/issues`, {
    token: student.token,
    method: "POST",
    body: { title, body: JSON.stringify({ schema_version: 1 }) },
  });
  if (!res.ok) { bad(`could not open the broker issue: HTTP ${res.status} ${res.data?.message ?? ""}`); return; }
  ok(`opened ${ORG}/${broker}#${res.data.number}`);

  // Provisioning is synchronous but not instant. The SPA waits the same way.
  const repoGuess = `${ASSIGNMENT}-${normalizeLogin(student.login)}`;
  note(`polling for ${ORG}/${repoGuess} …`);
  for (let i = 1; i <= 20; i++) {
    await new Promise((r) => setTimeout(r, 6000));
    const repo = await api(`/repos/${ORG}/${repoGuess}`, { token: student.token });
    if (repo.ok) { ok(`repository exists after ~${i * 6}s: ${repo.data.html_url}`); return; }
  }
  bad(`no repository after 120s - check the hub's acceptance-handler run`);
}

// --- run ---------------------------------------------------------------------

console.log(`PXL Classroom live smoke - org=${ORG} assignment=${ASSIGNMENT} mode=${ACCEPT ? "ACCEPT (writes!)" : "read-only"}`);

await preflight();
const assignment = failures === 0 ? await readAssignment() : null;
if (assignment) {
  const title = await signOnly(assignment, ACCOUNTS.STUDENT_A);
  if (title && ACCEPT) await submitAcceptance(title, ACCOUNTS.STUDENT_A);
  else if (title) note("re-run with --accept to submit it and watch the repository appear");
}

console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) failed.`}\n`);
process.exit(failures === 0 ? 0 : 1);
