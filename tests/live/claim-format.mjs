#!/usr/bin/env node
// PXL Classroom - LIVE check of the claim ADDRESS FORM and re-identification,
// through the real broker and hub, as a real student account. Not part of
// `npm test`.
//
//   node tests/live/claim-format.mjs
//   node tests/live/drill.mjs cleanup <the assignment id it prints>
//
// 2026-09-26: deployment.yml asks for `firstname.lastname@` (claim_address_format),
// and a binding confirmed before that rule - `<number>@student.pxl.be`, 16 real
// students - is no longer final. On pxl-classroom-testbed:
//
//   1 a claim-mode assignment is published, the roster holds the student's
//     NAME-form address, and the student already has a NUMBER-form binding
//   2 accepting with the number form  -> refused, reason rejected:claim-format,
//     no repository, the old binding untouched
//   2b the confirm link with a well-formed address NOT on the roster -> bound;
//     then accepting -> refused, no repository (the reused binding used to
//     skip the roster: review 2026-09-26)
//   3 the confirm-email link with the name form -> the binding is replaced and
//     records what it replaces
//   4 accepting again -> the (now valid) binding is reused, not asked again, and
//     the student gets a repository
//
// The student's original binding and the roster are restored at the end, even
// on failure. The assignment is a drill-* one: delete it with drill.mjs cleanup.

import { parse, stringify } from "yaml";
import { readFileSync } from "node:fs";
import { buildAssignmentDoc, utcToLocalInput } from "../../lib/assignment-doc.mjs";
import { validateAgainst } from "../../lib/validate.mjs";
import { brokerRepoName } from "../../lib/broker-repo.mjs";
import { commitWithRebase } from "../../lib/gittree.mjs";
import { linkSecretFrom, parseInviteFields } from "../../lib/invite-token-format.mjs";
import { REJECTED_LABEL } from "../../lib/acceptance-labels.mjs";
import { CONTROL_REPO, HUB_OWNER, HUB_REPO_NAME, TIMEZONE } from "../../lib/deployment.mjs";
import { signAcceptanceTitle, PURPOSE } from "../../lib/acceptance-signature.mjs";
import { encryptClaim, claimPath, claimAttemptsPath } from "../../lib/claim.mjs";
import { rejectionDedupKey, TRACKING_LABEL } from "../../lib/rejection-notice.mjs";
import { accounts, api, checkAccounts, decode, die, loadEnv, reporter, sleep } from "./live-kit.mjs";

const env = loadEnv();
const ORG = process.env.DRILL_ORG || "pxl-classroom-testbed";
const TEMPLATE = process.env.DRILL_TEMPLATE || "starter-template";
const HUB = `${HUB_OWNER}/${HUB_REPO_NAME}`;
const DRILL_DESCRIPTION = "Automated deadline drill (tests/live/drill.mjs). Safe to delete.";
const { LECTURER, STUDENT_A } = accounts(env);
const r = reporter();

const NUMBER = "99999999@student.pxl.be";
const NAMED = "probe.student-one@student.pxl.be";
// Well-formed, inside the domains, and on nobody's roster.
const OFF_ROSTER = "probe.not-registered@student.pxl.be";
const claimKeys = JSON.parse(readFileSync(new URL("../../acceptance/claim-keys.json", import.meta.url), "utf8"));
const PUBLIC_KEY = claimKeys.keys[claimKeys.current];

const lect = (path, opts = {}) => api(path, { token: LECTURER.token, ...opts });
async function readControl(path) {
  const res = await lect(`/repos/${ORG}/${CONTROL_REPO}/contents/${path}`);
  return res.ok ? { ok: true, text: decode(res.data.content), sha: res.data.sha } : { ok: false, status: res.status };
}
const readControlJson = async (path) => {
  const got = await readControl(path);
  return got.ok ? JSON.parse(got.text) : null;
};
const write = (message, changes) => commitWithRebase({ token: LECTURER.token, owner: ORG, repo: CONTROL_REPO, branch: "main", message, changes });

async function dispatch(workflow, inputs) {
  const res = await lect(`/repos/${HUB}/actions/workflows/${workflow}/dispatches`, { method: "POST", body: { ref: "main", inputs, return_run_details: true } });
  if (!res.ok || !res.data?.workflow_run_id) die(`dispatch ${workflow}: HTTP ${res.status}`);
  return res.data.workflow_run_id;
}
async function waitForRun(id, minutes = 10) {
  for (let waited = 0; waited < minutes * 60_000; waited += 10_000) {
    await sleep(10_000);
    const run = (await lect(`/repos/${HUB}/actions/runs/${id}`)).data;
    if (run?.status === "completed") return run;
  }
  return null;
}
async function waitFor(what, fn, ms = 300_000) {
  for (let waited = 0; waited <= ms; waited += 8_000) {
    const v = await fn();
    if (v) return v;
    await sleep(8_000);
  }
  r.bad(`${what}: not seen after ${ms / 1000}s`);
  return null;
}

async function signed(purpose, secret, assignmentId) {
  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(4))).toString("hex");
  return signAcceptanceTitle({ privateKey: secret, kid: "a1", subject: assignmentId, githubId: STUDENT_A.id, nonce, purpose });
}
async function sealedBody(email, assignmentId) {
  const payload = await encryptClaim({ publicKey: PUBLIC_KEY, email, githubId: STUDENT_A.id, assignmentId });
  // What buildAcceptanceBody (frontend/src/lib/claim.js) writes.
  return JSON.stringify({ claim: payload, claim_verified: true });
}
async function openIssue(broker, title, body) {
  const res = await api(`/repos/${ORG}/${broker}/issues`, { token: STUDENT_A.token, method: "POST", body: { title, body } });
  if (!res.ok) die(`opening the broker issue as ${STUDENT_A.login}: HTTP ${res.status} ${res.data?.message ?? ""}`);
  return res.data.number;
}

async function main() {
  console.log(`\nClaim address form + re-identification - ${ORG}, hub ${HUB}\n`);
  await checkAccounts({ LECTURER, STUDENT_A }, r);
  if (r.failures()) die("accounts not usable");

  const claimFile = claimPath(STUDENT_A.id);
  // The ATTEMPT COUNTER too: the refusals this probe provokes are counted
  // (review 2026-09-26), and left behind they would block the test student
  // after a few runs.
  const attemptsFile = claimAttemptsPath(STUDENT_A.id);
  const original = { claim: await readControl(claimFile), roster: await readControl("students/roster.yml"), attempts: await readControl(attemptsFile) };
  if (!original.roster.ok) die("the testbed has no roster to extend");
  const tpl = await lect(`/repos/${ORG}/${TEMPLATE}`);
  if (!tpl.ok) die(`template ${ORG}/${TEMPLATE}: HTTP ${tpl.status}`);

  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 13).toLowerCase();
  const id = `drill-cf-${stamp}`;
  try {
    // --- 1 setup -------------------------------------------------------------
    const roster = parse(original.roster.text);
    roster.students = [...(roster.students || []), { student_number: "PROBE-CF-1", full_name: "Probe Student One", email: NAMED, active: true }];
    const stale = {
      schema_version: 1, github_login: STUDENT_A.login, github_id: STUDENT_A.id, email: NUMBER,
      domain_allowed: true, claim_verified: true, student_number: null,
      claimed_at: "2026-09-10T08:00:00.000Z", claimed_via: "before-the-rule",
    };
    if (!validateAgainst("claim", structuredClone(stale)).valid) die("the stale binding fixture fails its schema");
    const now = Date.now();
    const opensAt = new Date(now - 60_000).toISOString();
    const deadlineAt = new Date(now + 7 * 86400_000).toISOString();
    const doc = buildAssignmentDoc({
      id, title: `Claim format probe ${stamp}`, description: DRILL_DESCRIPTION, organization: ORG,
      template: `${ORG}/${TEMPLATE}`, repository_name_pattern: `${id}-{github_login}`,
      opens_at_local: utcToLocalInput(opensAt), _opens_at_original: opensAt,
      deadline_at_local: utcToLocalInput(deadlineAt), _deadline_at_original: deadlineAt,
      timezone: TIMEZONE, submission_ref: `refs/heads/${tpl.data.default_branch}`,
      student_permission: "maintain", acceptance_mode: "self-service", roster_mode: "claim",
      late_policy: "report", lock_down_enabled: false, assignment_type: "individual", state: "published",
      claim_domains: ["student.pxl.be"],
    }, { templateRepositoryId: tpl.data.id });
    const v = validateAgainst("assignment", structuredClone(doc));
    if (!v.valid) die(`assignment fixture fails its schema: ${JSON.stringify(v.errors)}`);
    await write(`Live test fixture: ${id}`, [
      { path: `assignments/${id}.yml`, content: stringify(doc) },
      { path: "students/roster.yml", content: stringify(roster) },
      { path: claimFile, content: JSON.stringify(stale, null, 2) + "\n" },
    ]);
    r.ok(`1 ${id}: claim mode; roster row ${NAMED}; ${STUDENT_A.login} bound to ${NUMBER} (before the rule)`);
    const pub = await waitForRun(await dispatch("publish-assignment.yml", { org: ORG, assignment_id: id, regenerate_invite: "false" }));
    if (pub?.conclusion !== "success") die(`publish: ${pub?.conclusion ?? "did not finish"} ${pub?.html_url ?? ""}`);
    const stored = await readControl(`assignments/${id}.yml`);
    const secret = linkSecretFrom(parseInviteFields(stored.text));
    const broker = brokerRepoName({ assignment: parse(stored.text), assignmentId: id });
    if (!secret) die("no invitation secret after publish");
    r.ok(`1 published, broker ${ORG}/${broker}`);

    // --- 2 the number form is refused, with its own reason ----------------------
    const refused = await openIssue(broker, await signed(PURPOSE.ACCEPT, secret, id), await sealedBody(NUMBER, id));
    r.ok(`2 ${STUDENT_A.login} accepts with ${NUMBER}: #${refused}`);
    const labelled = await waitFor(`2 #${refused} ${REJECTED_LABEL}`, async () =>
      ((await lect(`/repos/${ORG}/${broker}/issues/${refused}/labels`)).data || []).some?.((l) => l.name === REJECTED_LABEL));
    if (labelled) r.ok(`2 #${refused} carries ${REJECTED_LABEL}`);
    const key = rejectionDedupKey({ assignmentId: id, login: STUDENT_A.login, outcome: "rejected:claim-format" });
    const reason = await waitFor("2 the tracking issue names rejected:claim-format", async () => {
      const issues = (await lect(`/repos/${ORG}/${CONTROL_REPO}/issues?labels=${TRACKING_LABEL}&state=all`)).data || [];
      for (const i of issues) {
        const comments = (await lect(`/repos/${ORG}/${CONTROL_REPO}/issues/${i.number}/comments?per_page=100`)).data || [];
        const hit = comments.find((c) => (c.body || "").includes(key));
        if (hit) return hit;
      }
      return null;
    }, 120_000);
    if (reason) r.ok("2 the lecturer's tracking issue says rejected:claim-format - not a wrong domain");
    const afterRefusal = await readControlJson(claimFile);
    if (afterRefusal?.email === NUMBER && !afterRefusal.replaces) r.ok("2 the old binding is untouched");
    else r.bad(`2 the binding changed on a refusal: ${JSON.stringify(afterRefusal)}`);
    if (await readControlJson(`repositories/${id}/${STUDENT_A.login.toLowerCase()}.json`)) r.bad("2 a repository was provisioned");
    else r.ok("2 no repository");

    // --- 2b THE BYPASS (review 2026-09-26): confirm an address the roster does
    //     not hold, then accept. The reused binding skipped the roster check,
    //     so this provisioned a repository; it must be asked again instead.
    const offRosterIssue = await openIssue(broker, await signed(PURPOSE.CONFIRM, secret, id), await sealedBody(OFF_ROSTER, id));
    r.ok(`2b ${STUDENT_A.login} confirms ${OFF_ROSTER} (not on the roster) through the link: #${offRosterIssue}`);
    const offBound = await waitFor("2b bound to the off-roster address", async () => {
      const c = await readControlJson(claimFile);
      return c?.email === OFF_ROSTER ? c : null;
    });
    if (offBound?.replaces?.email === NUMBER) r.ok(`2b the confirmation replaced ${NUMBER} - a correction, not "already confirmed"`);
    const bypass = await openIssue(broker, await signed(PURPOSE.ACCEPT, secret, id), await sealedBody(NUMBER, id));
    r.ok(`2b ${STUDENT_A.login} accepts, bound to an address the roster does not hold: #${bypass}`);
    const bypassRefused = await waitFor(`2b #${bypass} ${REJECTED_LABEL}`, async () =>
      ((await lect(`/repos/${ORG}/${broker}/issues/${bypass}/labels`)).data || []).some?.((l) => l.name === REJECTED_LABEL));
    if (bypassRefused) r.ok("2b refused - the binding was not reused past the roster");
    if (await readControlJson(`repositories/${id}/${STUDENT_A.login.toLowerCase()}.json`)) r.bad("2b A REPOSITORY WAS PROVISIONED - the roster was bypassed");
    else r.ok("2b no repository");

    // --- 3 the confirm-email link replaces the stale binding -------------------
    const confirmIssue = await openIssue(broker, await signed(PURPOSE.CONFIRM, secret, id), await sealedBody(NAMED, id));
    r.ok(`3 ${STUDENT_A.login} confirms ${NAMED} through the confirm-email link: #${confirmIssue}`);
    const replaced = await waitFor("3 the binding replaced", async () => {
      const c = await readControlJson(claimFile);
      return c?.email === NAMED ? c : null;
    });
    if (replaced) {
      if (replaced.replaces?.email === OFF_ROSTER) r.ok(`3 bound to ${NAMED}, and it records that it replaces ${OFF_ROSTER}`);
      else r.bad(`3 replaced, but replaces = ${JSON.stringify(replaced.replaces)}`);
      if (validateAgainst("claim", structuredClone(replaced)).valid) r.ok("3 the new binding validates");
      else r.bad("3 the new binding fails its schema");
    }

    // --- 4 accepting again reuses the valid binding ------------------------------
    const accepted = await openIssue(broker, await signed(PURPOSE.ACCEPT, secret, id), await sealedBody(NUMBER, id));
    r.ok(`4 ${STUDENT_A.login} accepts again (sending the number form, which a valid binding must make irrelevant): #${accepted}`);
    const record = await waitFor("4 a repository", () => readControlJson(`repositories/${id}/${STUDENT_A.login.toLowerCase()}.json`), 300_000);
    if (record) r.ok(`4 provisioned ${record.repo_url} - the valid binding was reused, not asked again`);
    const finalClaim = await readControlJson(claimFile);
    if (finalClaim?.email === NAMED) r.ok("4 the binding is still the name form");
    else r.bad(`4 the binding became ${finalClaim?.email}`);
  } finally {
    // Always put the student's own binding and the roster back.
    const restore = [{ path: "students/roster.yml", content: original.roster.text }];
    restore.push({ path: claimFile, content: original.claim.ok ? original.claim.text : null });
    restore.push({ path: attemptsFile, content: original.attempts.ok ? original.attempts.text : null });
    // Closed, with its deadline behind it, so `drill.mjs cleanup` - which
    // refuses a live drill on purpose - deletes it.
    const current = await readControl(`assignments/${id}.yml`);
    if (current.ok) {
      const closed = { ...parse(current.text), state: "closed", deadline_at: new Date(Date.now() - 60_000).toISOString() };
      restore.push({ path: `assignments/${id}.yml`, content: stringify(closed) });
    }
    try {
      await write(`Live test cleanup: ${id} (restore roster and ${STUDENT_A.login}'s binding)`, restore);
      r.ok("restored the roster and the original binding");
    } catch (e) {
      r.bad(`could not restore: ${e.message} - restore students/roster.yml and ${claimFile} by hand`);
    }
    console.log(`\nDelete the assignment: node tests/live/drill.mjs cleanup ${id}`);
  }
  console.log(`\n${r.failures() ? `${r.failures()} FAILED` : "all good"}\n`);
  process.exit(r.failures() ? 1 : 0);
}

main().catch((e) => die(e.stack || String(e)));
