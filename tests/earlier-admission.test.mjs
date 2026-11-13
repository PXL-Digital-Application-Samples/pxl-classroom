// A lecturer's Retry for a student whose records were lost.
//
// 2026-09-25: a student accepted, every gate passed, his address was
// confirmed, his repository was created - and the push of his records lost a
// race five times and was dropped, the confirmation with it. He worked on no
// list for seven weeks. Retry, the remedy the nightly's notice offers, was
// refused `rejected:no-claim`: the assignment asks for a confirmed address and
// a lecturer's Retry carries none. lib/earlier-admission.mjs lets the hub see
// what it already decided; acceptance/accept.mjs acts on it in one place.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

import { ADMISSION_WINDOW_MS, invitedByApp, judgeEarlierAdmission } from "../lib/earlier-admission.mjs";
import { INVITED_LABEL, REJECTED_LABEL } from "../lib/acceptance-labels.mjs";
import { startRepoProbe } from "./fixtures/repo-probe.mjs";

const BOT = "pxl-classroom-provisioner[bot]";
const ID = 185624866;
const CREATED = "2026-09-25T13:34:30Z";
const LABELLED = "2026-09-25T13:34:32Z";

const labelled = (over = {}) => ({
  event: "labeled", created_at: LABELLED, label: { name: INVITED_LABEL }, actor: { login: BOT, type: "Bot" }, ...over,
});
const request = (over = {}, events = [labelled()]) => ({ issue: { number: 104, user: { id: ID }, ...over }, events });
const repo = (over = {}) => ({ id: 1387563052, created_at: CREATED, template_repository: { id: 1344980185, full_name: "Org/tpl" }, ...over });
const ask = (over = {}) =>
  judgeEarlierAdmission({
    assignmentType: "individual", githubId: ID, requests: [request()], appBotLogin: BOT,
    repo: repo(), templateId: 1344980185, templateFullName: "Org/tpl", permission: "admin", ...over,
  });

// -----------------------------------------------------------------------------
// The verdict
// -----------------------------------------------------------------------------

test("the real case: his request marked invited by the App, his repository made for it - admitted, with the time", () => {
  assert.deepEqual(ask(), {
    admitted: true, at: LABELLED, issue: 104, why: "the hub admitted this account and created this repository for it",
  });
});

test("the label counts only when the APP put it there", () => {
  // A label needs write access, so a student cannot; an owner can. Their hand
  // is not the hub's decision.
  assert.equal(ask({ requests: [request({}, [labelled({ actor: { login: "lecturer", type: "User" } })])] }).admitted, false);
  assert.equal(ask({ requests: [request({}, [labelled({ actor: { login: "other-app[bot]", type: "Bot" } })])] }).admitted, false);
  // Somebody registering the bot's name as a user is not the bot.
  assert.equal(ask({ requests: [request({}, [labelled({ actor: { login: BOT, type: "User" } })])] }).admitted, false);
  // The other outcome label is a refusal.
  assert.equal(ask({ requests: [request({}, [labelled({ label: { name: REJECTED_LABEL } })])] }).admitted, false);
  // The login's case is GitHub's to choose.
  assert.equal(ask({ requests: [request({}, [labelled({ actor: { login: BOT.toUpperCase(), type: "Bot" } })])] }).admitted, true);
});

test("events that could not be read are not evidence", () => {
  assert.equal(ask({ requests: [request({}, null)] }).admitted, false);
  assert.equal(ask({ requests: [] }).admitted, false);
  assert.equal(ask({ requests: null }).admitted, false);
});

test("a request by ANOTHER account is not this account's admission", () => {
  // A login can change hands; the issue's author id is the account.
  assert.equal(ask({ requests: [request({ user: { id: 5 } })] }).admitted, false);
  assert.equal(ask({ githubId: 5 }).admitted, false);
  assert.equal(ask({ githubId: NaN }).admitted, false);
});

test("the repository must be the one THAT admission made", () => {
  assert.equal(ask({ repo: null }).admitted, false, "absent or unread");
  // Made from something else: the student's own repository under that name.
  assert.equal(ask({ repo: repo({ template_repository: null }) }).admitted, false);
  assert.equal(ask({ repo: repo({ template_repository: { id: 7, full_name: "Org/tpl" } }) }).admitted, false, "a recreated template has another id");
  // Created AFTER the label: not what the hub labelled for.
  assert.equal(ask({ repo: repo({ created_at: "2026-09-25T13:35:00Z" }) }).admitted, false);
  // Created long before: last year's repository under the same name.
  assert.equal(ask({ repo: repo({ created_at: "2025-09-25T13:34:30Z" }) }).admitted, false);
  // The edge of the window is inside it.
  const edge = new Date(Date.parse(LABELLED) - ADMISSION_WINDOW_MS).toISOString();
  assert.equal(ask({ repo: repo({ created_at: edge }) }).admitted, true);
  assert.equal(ask({ repo: repo({ created_at: "nonsense" }) }).admitted, false);
});

test("where no template id is pinned, the template's name decides - and only then", () => {
  assert.equal(ask({ templateId: null }).admitted, true);
  assert.equal(ask({ templateId: null, templateFullName: "ORG/TPL" }).admitted, true);
  assert.equal(ask({ templateId: null, templateFullName: "Org/other" }).admitted, false);
  assert.equal(ask({ templateId: null, templateFullName: null }).admitted, false);
  // Pinned: the id decides, a matching name does not rescue a wrong id.
  assert.equal(ask({ templateId: 99 }).admitted, false);
});

test("the account must still hold the repository", () => {
  for (const p of ["admin", "maintain", "write", "triage", "read"]) assert.equal(ask({ permission: p }).admitted, true, p);
  for (const p of ["none", null, undefined, ""]) assert.equal(ask({ permission: p }).admitted, false, String(p));
});

test("a team assignment is never answered", () => {
  assert.equal(ask({ assignmentType: "team" }).admitted, false);
});

test("several requests: the newest the App marked, inside the window", () => {
  const older = request({ number: 90 }, [labelled({ created_at: "2026-09-25T13:34:31Z" })]);
  const refusedLater = request({ number: 120 }, [labelled({ created_at: "2026-10-01T10:00:00Z", label: { name: REJECTED_LABEL } })]);
  const v = ask({ requests: [older, request(), refusedLater] });
  assert.equal(v.issue, 104);
  assert.equal(invitedByApp([labelled({ created_at: "2026-01-01T00:00:00Z" }), labelled()], BOT), LABELLED);
  assert.equal(invitedByApp(null, BOT), null);
});

// -----------------------------------------------------------------------------
// The hub acts on it in exactly one place
// -----------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const acceptScript = join(here, "..", "acceptance", "accept.mjs");
const probe = await startRepoProbe();

const AID = "labs";
const assignmentYaml = (over = {}) =>
  JSON.stringify({
    schema_version: 1, id: AID, title: "Labs", organization: "TestOrg", state: "published",
    assignment_type: "individual", roster_mode: "open", require_claim: true, max_acceptances: 50,
    opens_at: "2026-01-01T00:00:00Z", deadline_at: "2099-01-01T00:00:00Z",
    template: { owner: "TestOrg", repository: "tpl" }, repository_name_pattern: `${AID}-{github_login}`,
    claim_domains: ["student.pxl.be"], ...over,
  });

function makeDir({ over = {}, claim = null, roster = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pxl-earlier-"));
  mkdirSync(join(dir, "assignments"), { recursive: true });
  writeFileSync(join(dir, "assignments", `${AID}.yml`), assignmentYaml(over));
  if (claim) {
    mkdirSync(join(dir, "students", "claims"), { recursive: true });
    writeFileSync(join(dir, "students", "claims", `${ID}.json`), JSON.stringify(claim));
  }
  if (roster) {
    mkdirSync(join(dir, "students"), { recursive: true });
    writeFileSync(join(dir, "students", "roster.yml"), JSON.stringify(roster));
  }
  return dir;
}

function accept(dir, env = {}) {
  const outFile = join(dir, "out.env");
  writeFileSync(outFile, "");
  const res = spawnSync("node", [acceptScript], {
    encoding: "utf8",
    env: {
      ...process.env, ...probe.env, ASSIGNMENT_ID: AID, GITHUB_LOGIN: "muhammed", GITHUB_ID: String(ID),
      ORG: "TestOrg", DATA_DIR: dir, GITHUB_OUTPUT: outFile, GITHUB_STEP_SUMMARY: join(dir, "summary.md"),
      EARLIER_ADMISSION_AT: "", CLAIM_PAYLOAD: "", ...env,
    },
  });
  const outcome = readFileSync(outFile, "utf8").match(/^outcome=(.*)$/m)?.[1] ?? null;
  return { status: res.status, log: (res.stdout ?? "") + (res.stderr ?? ""), outcome };
}

test("WITHOUT the proof, a Retry that carries no address is refused, as it always was", () => {
  const res = accept(makeDir());
  assert.equal(res.outcome, "rejected:no-claim", res.log);
});

test("WITH the proof, the lost student is admitted and no address is invented for him", () => {
  const dir = makeDir();
  const res = accept(dir, { EARLIER_ADMISSION_AT: LABELLED });
  assert.equal(res.outcome, "accepted", res.log);
  assert.match(res.log, /no address asked again - the hub admitted @muhammed on 2026-09-25T13:34:32Z and their records were lost/);
  assert.equal(existsSync(join(dir, "students", "claims", `${ID}.json`)), false, "nothing confirmed, nothing written");
  const record = JSON.parse(readFileSync(join(dir, "acceptances", AID, "muhammed.json"), "utf8"));
  assert.equal("claimed_email" in record && record.claimed_email ? record.claimed_email : null, null);
});

test("a value that is not a time proves nothing", () => {
  for (const v of ["true", "yes", "not-a-date", " "]) {
    assert.equal(accept(makeDir(), { EARLIER_ADMISSION_AT: v }).outcome, "rejected:no-claim", v);
  }
});

test("a student who HAS a binding that no longer counts corrects it himself - the proof does not wave that through", () => {
  // The number form, where the name form is asked for: his to fix on the
  // page. The proof is for a confirmation that was LOST, not one outgrown.
  const dir = makeDir({
    over: { claim_address_format: { pattern: "^[a-z]+\\.[a-z]+@", example: "firstname.lastname" } },
    claim: { schema_version: 1, github_id: ID, github_login: "muhammed", email: "12400189@student.pxl.be", claimed_at: "2026-09-25T13:34:24Z", assignment_id: AID, claim_verified: true, domain_allowed: true },
  });
  const res = accept(dir, { EARLIER_ADMISSION_AT: LABELLED });
  assert.equal(res.outcome, "rejected:no-claim", res.log);
  assert.match(res.log, /no longer counts/);
});

test("under roster_mode claim the address IS the identity, and the proof does not replace it", () => {
  const dir = makeDir({
    over: { roster_mode: "claim", require_claim: undefined },
    roster: { schema_version: 2, students: [{ student_number: "0123456", full_name: "M", email: "m.y@student.pxl.be" }] },
  });
  const res = accept(dir, { EARLIER_ADMISSION_AT: LABELLED });
  assert.equal(res.outcome, "rejected:no-claim", res.log);
});

// -----------------------------------------------------------------------------
// Only Retry can say it, and it says it from the check's own output
// -----------------------------------------------------------------------------

const yml = (p) => parseYaml(readFileSync(join(here, "..", p), "utf8"));

test("the proof reaches the hub from Retry's own step, through the action's input, and from nowhere else", () => {
  const retry = yml(".github/workflows/retry-acceptance.yml").jobs.retry.steps;
  const proof = retry.find((s) => /prove-earlier-admission\.mjs/.test(s.run || ""));
  assert.ok(proof?.id, "the check is a step with an id");
  const script = readFileSync(join(here, "..", "scripts", "prove-earlier-admission.mjs"), "utf8");
  const written = script.match(/appendFileSync\(process\.env\.GITHUB_OUTPUT, `(\w+)=/)?.[1];
  assert.ok(written, "the script writes one output");
  const acceptStep = retry.find((s) => s.uses === "./acceptance");
  assert.equal(acceptStep.with["earlier-admission-at"], `\${{ steps.${proof.id}.outputs.${written} }}`);
  assert.ok(retry.indexOf(proof) < retry.indexOf(acceptStep));
  // Its token reads and nothing else.
  const token = retry.find((s) => s.id === proof.env.GITHUB_TOKEN.match(/steps\.(\w+)\.outputs\.token/)[1]);
  const perms = Object.entries(token.with).filter(([k]) => k.startsWith("permission-"));
  assert.ok(perms.length > 0 && perms.every(([, v]) => v === "read"), JSON.stringify(perms));

  // The action hands it to accept.mjs under the name accept.mjs reads.
  const action = yml("acceptance/action.yml");
  assert.equal(action.inputs["earlier-admission-at"].default, "");
  const env = action.runs.steps.find((s) => s.id === "accept").env;
  const name = Object.entries(env).find(([, v]) => v === "${{ inputs.earlier-admission-at }}")?.[0];
  assert.ok(name, "the input reaches the step's environment");
  assert.match(readFileSync(acceptScript, "utf8"), new RegExp(`env\\("${name}"`));

  // No workflow a student's request starts may pass it.
  for (const wf of ["acceptance-handler.yml"]) {
    assert.doesNotMatch(readFileSync(join(here, "..", ".github", "workflows", wf), "utf8"), /earlier-admission-at/, wf);
  }
});
