// The invitation token travels in the acceptance issue's TITLE, on a repository
// that is public by construction. Closing and locking an issue hides nothing -
// a closed, locked issue on a public repo is still readable, still listed, and
// still returned by GitHub's issue search - so the first student to accept was
// publishing the assignment's token to anyone who cared to look.
//
// That is not the "someone forwards the link to a friend" residual ARCHITECTURE
// §4.3.2 accepts. It defeats the property outright, and because the acceptance
// card is named sha256(token), it takes §4.3.3 with it: a public token is a
// public card, and for a group assignment a public list of member logins.
//
// Two things close it, and this file pins both - plus the third that never
// worked and has been removed:
//   1. the broker redacts the title within seconds, using no extra credential
//   2. System Health flags any title that was never redacted
//   3. the hub used to try to DELETE the issue. It cannot: an installation
//      token gets FORBIDDEN "Viewer not authorized to delete", measured live in
//      two orgs that both grant the App administration: write. See below.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

import { runInvitationChecks } from "../lib/diagnostics.mjs";
import { signInviteToken, generateKeyPair } from "../lib/invite-token.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const BROKER = parse(readFileSync(join(root, "acceptance", "broker-workflow.yml"), "utf8"));
const HANDLER = parse(readFileSync(join(root, ".github", "workflows", "acceptance-handler.yml"), "utf8"));
const brokerSteps = Object.values(BROKER.jobs).flatMap((j) => j.steps || []);
const handlerSteps = Object.values(HANDLER.jobs).flatMap((j) => j.steps || []);

// --- 1. The broker redacts, and does not try to delete ----------------------

test("the broker redacts the title on the success path", () => {
  const step = brokerSteps.find((s) => s.name === "Redact and close trigger issue");
  assert.ok(step, "the broker must clean up after a valid invitation");
  assert.match(step.run, /gh issue edit .* --title/, "it must rename the issue, not only close it");

  const edit = step.run.indexOf("gh issue edit");
  const close = step.run.indexOf("gh issue close");
  assert.ok(edit > -1 && close > -1 && edit < close, "redact before closing");
});

test("the broker redacts the title on the reject path too", () => {
  // `wrong-assignment` means a LIVE token for another assignment was posted
  // here. The rejection is correct and costs no credential - but the token in
  // the title is real, and this repository is public.
  const step = brokerSteps.find((s) => s.name === "Reject invalid invitation");
  assert.ok(step, "there must be a reject path");
  assert.match(step.run, /gh issue edit .* --title/, "a rejected title must be redacted too");
  assert.ok(
    !/create-github-app-token/.test(JSON.stringify(step)),
    "and must still reach no credential - that is the §4.3.2 floor"
  );
});

test("the broker never mints a credential for cleanup", () => {
  // Deleting needs admin, which github.token cannot have. Minting an App token
  // on the broker to get it would add a second credential to a public
  // repository for a job the hub can do with one it already holds.
  const mints = brokerSteps.filter((s) => String(s.uses || "").includes("create-github-app-token"));
  assert.equal(mints.length, 1, "exactly one mint on the broker: the dispatcher token");
  assert.equal(mints[0].name, "Mint dispatcher token");
});

test("nothing on the broker deletes the issue, which would race the hub's read", () => {
  // Group acceptance needs the issue BODY, and the hub reads it a minute or two
  // after the dispatch. Deleting on the broker takes every group join down.
  const runs = brokerSteps.map((s) => s.run || "").join("\n");
  assert.ok(!/deleteIssue/.test(runs), "the broker must not delete the trigger issue");
});

// --- 2. NOBODY deletes, because nobody can ----------------------------------
//
// The hub ran `deleteIssue` here for months and it had never once worked.
// Measured live 2026-08-26, twice, in two organizations:
//
//   {"type":"FORBIDDEN","path":["deleteIssue"],
//    "message":"Viewer not authorized to delete"}
//
// Not a missing permission, which is what the step's own warning claimed while
// discarding the error: both orgs grant the App `administration: write`, the
// same token had just read the issue, and the same token creates repositories
// and writes their secrets. A USER token with repository admin deletes it
// immediately. An installation token cannot, and the system holds no PAT by
// design (§4.3.4).
//
// So the control does not exist, and a step that warns on every acceptance
// forever - naming a permission the org already has - costs more than the gap
// it pretends to close. Redaction is the mitigation, and since §4.3.2 the title
// is a signature rather than a credential.

test("nothing attempts a deletion that cannot succeed", () => {
  const attempts = [...handlerSteps, ...brokerSteps]
    .filter((s) => typeof s.run === "string" && /deleteIssue/.test(s.run))
    .map((s) => s.name);
  assert.deepEqual(
    attempts,
    [],
    "deleteIssue is FORBIDDEN for an installation token - a step calling it warns on every acceptance and fixes nothing",
  );
});

test("the reasoning is recorded where somebody would add it back", () => {
  // The measurement is the only thing stopping this being re-added as an
  // obvious omission. It has to live next to the hole it explains.
  const raw = readFileSync(join(root, ".github", "workflows", "acceptance-handler.yml"), "utf8");
  assert.match(raw, /Viewer not authorized to delete/, "the measured error must be quoted in the workflow");
  assert.match(raw, /administration: write/, "and why a permission grant is not the answer");
});

test("the body is still read before anything else touches the issue", () => {
  // Unchanged and still load-bearing: group acceptance reads the issue body in
  // the hub, minutes after the dispatch, so nothing on the broker may remove
  // the issue first.
  const names = handlerSteps.map((s) => s.name);
  assert.ok(names.includes("Read team payload from broker issue"), "the hub must read the payload");
});

// --- 3. System Health catches the ones that survived ------------------------

function harness({ issues, vars = [{ name: "INVITE_NONCE", value: "0badc0de" }] }) {
  const checks = [];
  const req = async (method, path) => {
    if (path.includes("/actions/variables")) return { ok: true, status: 200, data: { variables: vars } };
    if (path.includes("/issues?")) {
      return issues === null
        ? { ok: false, status: 403, data: null }
        : { ok: true, status: 200, data: issues };
    }
    if (path.includes("invite-keys.json")) {
      return { ok: true, status: 200, data: { content: Buffer.from(JSON.stringify({ keys: { 1: "x" } })).toString("base64") } };
    }
    return { ok: false, status: 404, data: null };
  };
  return { checks, req, addCheck: (_tier, c) => checks.push(c) };
}

const KEYPAIR = generateKeyPair();
const TOKEN = signInviteToken({
  org: "PXLAutomation",
  assignmentId: "linux-2026",
  expiresAt: "2099-01-01T00:00:00.000Z",
  nonce: "0badc0de",
  privateKeyPem: KEYPAIR.privateKeyPem,
});
const DOC = { invite_token: TOKEN, invite_nonce: "0badc0de", state: "published" };

async function run(issues) {
  const h = harness({ issues });
  await runInvitationChecks({
    req: h.req,
    addCheck: h.addCheck,
    check: (id, tierId, label, severity, message) => ({ id, tierId, label, severity, message }),
    doc: DOC,
    org: "PXLAutomation",
    brokerName: "broker-linux-2026",
    assignmentId: "linux-2026",
  });
  return h.checks.find((c) => c.id === "invite-exposure");
}

test("a leftover pxl-accept issue is reported as a failure", async () => {
  const found = await run([
    { number: 7, title: `pxl-accept:${DOC.invite_token}` },
    { number: 8, title: "Acceptance (processed)" },
  ]);
  assert.ok(found, "the exposure check must run");
  assert.equal(found.severity, "fail");
  assert.match(found.message, /#7/, "it must name the issue to delete");
  assert.ok(!found.message.includes(DOC.invite_token), "and must not repeat the token back");
  assert.match(found.message, /regenerate/i, "redacting is not enough - the exposed link must be retired");
});

test("a broker with nothing left over passes", async () => {
  const found = await run([
    { number: 8, title: "Acceptance (processed)" },
    { number: 9, title: "Acceptance attempt (rejected)" },
  ]);
  assert.equal(found.severity, "ok");
});

test("an empty broker passes", async () => {
  assert.equal((await run([])).severity, "ok");
});

test("an unreadable issue list is skipped, never reported as clean", async () => {
  // A 403 here means we do not know. Saying "ok" would be a false all-clear on
  // the one check whose whole job is to find a published credential.
  const found = await run(null);
  assert.equal(found.severity, "info");
  assert.match(found.message, /Skipped/);
});
