#!/usr/bin/env node
// PXL Classroom - LIVE acceptance-deadline drill. Not part of `npm test`.
//
//   node tests/live/acceptance-deadline.mjs            (writes!)
//
// One fresh assignment on the drill org whose acceptance deadline
// (`accepts_until`, 2026-11-03) has already passed while its deadline is hours
// ahead, taken through the real broker and the real hub with the accounts in
// .env.test:
//
//   1. the published card carries accepts_until, so the student page can say
//      "Acceptance closed"; a student's acceptance is refused, the broker
//      issue carries the rejected label, and the tracking issue names the
//      refusal as rejected:acceptance-closed;
//   2. the lecturer moves the acceptance deadline later, the way Save writes
//      the document, and the same student is accepted;
//   3. moved back into the past: that student's Accept again is
//      already-accepted (NOBODY NEW), the other student is refused.
//
// The id and the description are the deadline drill's (drill.mjs), and the
// deadline is moved into the past at the end, so
//   node tests/live/drill.mjs cleanup <id>
// deletes it like any finished drill. Nothing here waits for a nightly.

import { parse, stringify } from "yaml";

import { buildAssignmentDoc, utcToLocalInput } from "../../lib/assignment-doc.mjs";
import { validateAgainst } from "../../lib/validate.mjs";
import { brokerRepoName } from "../../lib/broker-repo.mjs";
import { inviteFileFor } from "../../lib/invite-token.mjs";
import { linkSecretFrom, parseInviteFields } from "../../lib/invite-token-format.mjs";
import { normalizeLogin } from "../../lib/github-login.mjs";
import { INVITED_LABEL, REJECTED_LABEL } from "../../lib/acceptance-labels.mjs";
import { DEDUP_MARKER, TRACKING_LABEL, rejectionDedupKey } from "../../lib/rejection-notice.mjs";
import { acceptanceWindow } from "../../lib/acceptance-window.mjs";
import { CONTROL_REPO, HUB_OWNER, HUB_REPO_NAME, TIMEZONE } from "../../lib/deployment.mjs";
import {
  DRILL_DESCRIPTION, accounts, acceptInvitation, api, checkAccounts, checkOrg, controlRepo, die, hubRuns, isoSeconds,
  issueComments, loadEnv, openAcceptanceIssue, pendingInvitation, reporter, signAcceptance, sleep, waitForLabel,
} from "./live-kit.mjs";

const ORG = process.env.DRILL_ORG || "pxl-classroom-testbed";
const TEMPLATE = process.env.DRILL_TEMPLATE || "starter-template";
const HUB = `${HUB_OWNER}/${HUB_REPO_NAME}`;
const PAGES_BASE = process.env.LIVE_PAGES_BASE || `https://${HUB_OWNER.toLowerCase()}.github.io/${HUB_REPO_NAME}`;

const env = loadEnv();
const ACCOUNTS = accounts(env);
const LECTURER = ACCOUNTS.LECTURER;
const [STUDENT_A, STUDENT_B] = [ACCOUNTS.STUDENT_A, ACCOUNTS.STUDENT_B];
const r = reporter();
const { ok, bad, note } = r;
const { readControl, readControlJson } = controlRepo({ org: ORG, repo: CONTROL_REPO, token: LECTURER.token });
const { dispatchAndWait } = hubRuns({ hub: HUB, lecturer: LECTURER, r });
const labelled = (broker, issue, label, ms) => waitForLabel({ repo: `${ORG}/${broker}`, issue, label, token: LECTURER.token, ms });

const minutesAgo = (m) => new Date(Date.now() - m * 60_000).toISOString();
const minutesAhead = (m) => new Date(Date.now() + m * 60_000).toISOString();

// The drill assignment once it is committed, until its deadline has been put
// into the past. drill.mjs's cleanup refuses an assignment whose deadline is
// ahead, so a run that stopped half-way with a deadline six hours out left
// something nothing could remove until then (review 2026-11-03). Every exit
// after the commit - a failed check, a thrown error, Ctrl-C - moves it back
// first, and says how to do it by hand when that fails too (third review,
// 2026-11-04: Ctrl-C skipped it, and a network error inside it hid the note).
let createdId = null;

async function finish() {
  if (createdId) {
    const id = createdId;
    createdId = null;
    console.log("\nLeaving it cleanable: the deadline goes into the past\n");
    let moved = false;
    try {
      moved = Boolean(await saveFields(id, { deadline_at: minutesAgo(1) }));
      if (moved) await dispatchAndWait("regenerate-dashboard.yml", { org: ORG });
    } catch (err) {
      bad(`could not move the deadline: ${err?.message || err}`);
    }
    if (!moved) note(`move ${id}'s deadline into the past by hand (assignments/${id}.yml, deadline_at) before cleaning up`);
    note(`clean up with: node tests/live/drill.mjs cleanup ${id}`);
  }
  console.log(`\n${r.failures() === 0 ? "All checks passed." : `${r.failures()} check(s) failed.`}\n`);
  process.exit(r.failures() === 0 ? 0 : 1);
}

// Ctrl-C during one of the five-minute waits is the ordinary way a run dies
// (drill.mjs says the same of its cleanup). Once: a second Ctrl-C ends it at
// once, which is what someone pressing it twice means.
process.once("SIGINT", () => { bad("interrupted"); finish(); });

/** The refusal the hub wrote on the tracking issue for this student, within `ms`. */
async function waitForRefusal(id, login, outcome, ms) {
  // Compared lowercased: the notifier spells the login as the broker
  // dispatched it, and a login is compared lowercased everywhere else.
  const key = `${DEDUP_MARKER}${rejectionDedupKey({ assignmentId: id, login, outcome })}`.toLowerCase();
  for (let waited = 0; waited <= ms; waited += 15_000) {
    const issues = await api(`/repos/${ORG}/${CONTROL_REPO}/issues?labels=${TRACKING_LABEL}&state=open&per_page=10`, { token: LECTURER.token });
    for (const issue of issues.data || []) {
      // Every page: the tracking issue holds every refusal the org ever had.
      const { comments } = await issueComments({ repo: `${ORG}/${CONTROL_REPO}`, issue: issue.number, token: LECTURER.token });
      const hit = comments.find((c) => c.body?.toLowerCase().includes(key));
      if (hit) return hit;
    }
    await sleep(15_000);
  }
  return null;
}

/** The document as Save writes it: the stored one, these fields changed, nothing dropped. */
async function saveFields(id, changes) {
  const stored = await readControl(`assignments/${id}.yml`);
  if (!stored.ok) { bad(`assignments/${id}.yml: HTTP ${stored.status}`); return null; }
  const doc = { ...parse(stored.text), ...changes };
  for (const [k, v] of Object.entries(changes)) if (v === undefined) delete doc[k];
  const { valid, errors } = validateAgainst("assignment", structuredClone(doc));
  if (!valid) { bad(`schema refuses the save: ${JSON.stringify(errors)}`); return null; }
  const put = await api(`/repos/${ORG}/${CONTROL_REPO}/contents/assignments/${id}.yml`, {
    token: LECTURER.token, method: "PUT",
    body: { message: `Update assignment ${id}: ${Object.keys(changes).join(", ")}`, content: Buffer.from(stringify(doc)).toString("base64"), sha: stored.sha },
  });
  if (!put.ok) { bad(`could not save assignments/${id}.yml: HTTP ${put.status} ${put.data?.message ?? ""}`); return null; }
  ok(`saved ${Object.entries(changes).map(([k, v]) => `${k}=${v ?? "(removed)"}`).join(" ")}`);
  return doc;
}

/** The card students are served, from Pages; null until it is there. */
async function readCard(secret, { wantAcceptsUntil, ms = 300_000 }) {
  const url = `${PAGES_BASE}/data/${ORG}/i/${inviteFileFor(secret)}.json`;
  for (let waited = 0; waited <= ms; waited += 15_000) {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (res.ok) {
        const card = (await res.json())?.assignment ?? null;
        if (card && (wantAcceptsUntil === undefined || (card.accepts_until ?? null) === wantAcceptsUntil)) return card;
      }
    } catch { /* not there yet */ }
    await sleep(15_000);
  }
  return null;
}

// --- the acceptance outcomes, as the control repository shows them -----------------

async function expectRefused(id, broker, secret, student, outcome) {
  const title = await signAcceptance({ secret, assignmentId: id, student }, r);
  const issue = title ? await openAcceptanceIssue({ org: ORG, broker, title, student }, r) : null;
  if (!issue) return;
  if (await labelled(broker, issue, REJECTED_LABEL, 300_000)) ok(`#${issue} carries ${REJECTED_LABEL}`);
  else bad(`#${issue} has no ${REJECTED_LABEL} label after 300s - check the hub's acceptance-handler run`);
  const comment = await waitForRefusal(id, student.login, outcome, 120_000);
  if (comment) ok(`the tracking issue names the refusal: ${outcome}`);
  else bad(`no tracking-issue comment carrying ${outcome} for ${student.login} within 120s`);
  if (await readControlJson(`repositories/${id}/${normalizeLogin(student.login)}.json`)) bad(`${student.login} was provisioned a repository`);
  else ok(`${student.login} has no repository`);
}

async function expectAccepted(id, broker, secret, student) {
  const title = await signAcceptance({ secret, assignmentId: id, student }, r);
  const issue = title ? await openAcceptanceIssue({ org: ORG, broker, title, student }, r) : null;
  if (!issue) return null;
  const recordPath = `repositories/${id}/${normalizeLogin(student.login)}.json`;
  let record = null;
  for (let waited = 0; waited < 300_000 && !record; waited += 8_000) {
    await sleep(8_000);
    record = await readControlJson(recordPath);
  }
  if (!record) { bad(`no ${recordPath} after 300s - check the hub's acceptance-handler run`); return null; }
  ok(`provisioned ${record.repo_url}`);
  // What the student page reads after the acceptance deadline to offer "Send
  // my invitation again" (broker-teams.js `invitedBefore`): this label, on an
  // issue of their own, put on only when GitHub sent an invitation - which is
  // asked of GitHub, the student's own pending invitation. The record says
  // `access_state: invited` for every acceptance whether or not one was sent
  // (lib/team-member-records.mjs), so it could not tell (third review).
  const repoName = record.repo_name?.split("/")?.[1] ?? "";
  if (await pendingInvitation({ student, repoName })) {
    if (await labelled(broker, issue, INVITED_LABEL, 60_000)) ok(`#${issue} carries ${INVITED_LABEL}: the page will offer to send it again`);
    else bad(`#${issue} has no ${INVITED_LABEL} label although GitHub sent ${student.login} an invitation`);
  } else {
    note(`${student.login} was sent no invitation (already had access), so no ${INVITED_LABEL} label is owed`);
  }
  await acceptInvitation({ student, repoName }, r);
  return { issue, record };
}

async function expectAlreadyAccepted(id, broker, secret, student) {
  const title = await signAcceptance({ secret, assignmentId: id, student }, r);
  const issue = title ? await openAcceptanceIssue({ org: ORG, broker, title, student }, r) : null;
  if (!issue) return;
  // already-accepted stamps the record with the attempt that decided (accept.mjs
  // step 6), so the issue number on the record is the evidence.
  const path = `acceptances/${id}/${normalizeLogin(student.login)}.json`;
  for (let waited = 0; waited < 300_000; waited += 8_000) {
    await sleep(8_000);
    const rec = await readControlJson(path);
    if (rec?.issue_number === issue) { ok(`#${issue}: already-accepted - the record was stamped with it, nothing new made`); return; }
  }
  bad(`${path} was not stamped with #${issue} within 300s: the acceptance deadline refused a student who had accepted`);
}

// --- the drill -----------------------------------------------------------------------

async function main() {
  console.log(`PXL Classroom live acceptance-deadline drill on ${ORG} (writes!)`);

  console.log("\n1. Preflight\n");
  await checkAccounts(ACCOUNTS, r);
  await checkOrg(ORG, LECTURER, r);
  if (r.failures() > 0) return finish();
  const roster = await readControl("students/roster.yml");
  const rosterLogins = new Set(roster.ok ? (parse(roster.text)?.students || []).map((s) => normalizeLogin(s.github_login || "")) : []);
  for (const s of [STUDENT_A, STUDENT_B]) {
    if (rosterLogins.has(normalizeLogin(s.login))) ok(`${s.login} is on the roster`);
    else bad(`${s.login} is not on ${ORG}'s roster`);
  }
  const tpl = await api(`/repos/${ORG}/${TEMPLATE}`, { token: LECTURER.token });
  if (!tpl.ok) bad(`template ${ORG}/${TEMPLATE}: HTTP ${tpl.status}`);
  if (r.failures() > 0) return finish();

  console.log("\n2. The assignment: opened an hour ago, acceptance closed ten minutes ago, due in six hours\n");
  const now = Date.now();
  const stamp = isoSeconds(now).replace(/[-:]/g, "").replace("T", "-").slice(0, 13).toLowerCase();
  const id = `drill-${stamp}`;
  const opensAt = minutesAgo(60);
  const acceptsUntil = minutesAgo(10);
  // Six hours: outside the sentinel's arming window, so no sentinel waits on it.
  const deadlineAt = minutesAhead(6 * 60);
  if ((await readControl(`assignments/${id}.yml`)).ok) die(`assignments/${id}.yml already exists - wait a minute and start again`);
  const form = {
    id,
    title: `Acceptance deadline drill ${isoSeconds(now).slice(0, 16).replace("T", " ")} UTC`,
    description: DRILL_DESCRIPTION,
    organization: ORG,
    template: `${ORG}/${TEMPLATE}`,
    repository_name_pattern: `${id}-{github_login}`,
    opens_at_local: utcToLocalInput(opensAt),
    _opens_at_original: opensAt,
    accepts_until_local: utcToLocalInput(acceptsUntil),
    _accepts_until_original: acceptsUntil,
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
  };
  const doc = buildAssignmentDoc(form, { templateRepositoryId: tpl.data.id });
  const { valid, errors } = validateAgainst("assignment", structuredClone(doc));
  if (!valid) { bad(`schema refuses the document: ${JSON.stringify(errors)}`); return finish(); }
  if (doc.accepts_until !== acceptsUntil) bad(`the builder wrote accepts_until ${doc.accepts_until}, not ${acceptsUntil}`);
  else ok(`the document carries accepts_until ${acceptsUntil}`);
  const phase = acceptanceWindow(doc).phase;
  if (phase === "acceptance-closed") ok(`the judge says acceptance-closed before anything is published`);
  else bad(`the judge says ${phase}`);
  const put = await api(`/repos/${ORG}/${CONTROL_REPO}/contents/assignments/${id}.yml`, {
    token: LECTURER.token, method: "PUT",
    body: { message: `Create assignment ${id}`, content: Buffer.from(stringify(doc)).toString("base64") },
  });
  if (!put.ok) { bad(`could not commit assignments/${id}.yml: HTTP ${put.status} ${put.data?.message ?? ""}`); return finish(); }
  ok(`committed assignments/${id}.yml as ${LECTURER.login}`);
  createdId = id;

  console.log("\n3. Publish\n");
  if ((await dispatchAndWait("publish-assignment.yml", { org: ORG, assignment_id: id, regenerate_invite: "false" })) !== "success") return finish();
  const stored = await readControl(`assignments/${id}.yml`);
  const storedDoc = stored.ok ? parse(stored.text) : null;
  const secret = stored.ok ? linkSecretFrom(parseInviteFields(stored.text)) : null;
  if (storedDoc?.state !== "published") bad(`state after publish is "${storedDoc?.state}"`);
  if (storedDoc?.accepts_until !== acceptsUntil) bad(`publish changed accepts_until to ${storedDoc?.accepts_until}`);
  else ok("publish kept accepts_until");
  if (!secret) bad("no invitation secret after publish");
  const broker = brokerRepoName({ assignment: storedDoc, assignmentId: id });
  if (r.failures() > 0) return finish();

  console.log("\n4. The card students are served\n");
  const card = await readCard(secret, { wantAcceptsUntil: acceptsUntil });
  if (card) ok(`the published card carries accepts_until ${card.accepts_until}: the page says Acceptance closed`);
  else bad("the published card does not carry accepts_until within 5 minutes of the publish");

  console.log(`\n5. ${STUDENT_A.login} accepts after the acceptance deadline: refused\n`);
  await expectRefused(id, broker, secret, STUDENT_A, "rejected:acceptance-closed");

  console.log("\n6. The lecturer moves the acceptance deadline an hour ahead, and the student is accepted\n");
  const later = minutesAhead(60);
  if (!(await saveFields(id, { accepts_until: later }))) return finish();
  // What the editor's save dispatches for a card change: the pages regenerate.
  await dispatchAndWait("regenerate-dashboard.yml", { org: ORG });
  const reopened = await readCard(secret, { wantAcceptsUntil: later });
  if (reopened) ok("the card now carries the later acceptance deadline: the page offers Accept again");
  else bad("the card did not pick up the moved acceptance deadline within 5 minutes");
  const accepted = await expectAccepted(id, broker, secret, STUDENT_A);

  console.log("\n7. Moved back into the past: Accept again is already-accepted, a newcomer is refused\n");
  if (!(await saveFields(id, { accepts_until: minutesAgo(5) }))) return finish();
  if (accepted) await expectAlreadyAccepted(id, broker, secret, STUDENT_A);
  await expectRefused(id, broker, secret, STUDENT_B, "rejected:acceptance-closed");

  // 8. finish() puts the deadline into the past so cleanup can take it.
  return finish();
}

main().catch(async (err) => { bad(`unexpected: ${err?.stack || err}`); await finish(); });
