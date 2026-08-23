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
// Three things close it, and this file pins all three:
//   1. the broker redacts the title within seconds, using no extra credential
//   2. the hub deletes the issue, after reading the body group acceptance needs
//   3. System Health flags any that survived, because deletion needs admin

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

// --- 2. The hub deletes, after the read -------------------------------------

test("the hub deletes the trigger issue after reading the team payload", () => {
  const names = handlerSteps.map((s) => s.name);
  const readAt = names.indexOf("Read team payload from broker issue");
  const deleteAt = names.indexOf("Delete the trigger issue");
  assert.ok(readAt > -1, "the hub must read the payload");
  assert.ok(deleteAt > -1, "the hub must delete the issue");
  assert.ok(readAt < deleteAt, "the read must come first, or group acceptance breaks");
});

test("the delete runs whatever the acceptance outcome was", () => {
  // A rejection leaves the same token in the same public title. Gating deletion
  // on `accepted` would leave every rejected attempt's invitation on display.
  const step = handlerSteps.find((s) => s.name === "Delete the trigger issue");
  assert.match(step.if, /always\(\)/, "cleanup must not depend on the outcome");
  assert.match(
    step.if,
    /steps\.team\.outputs\.issue_node_id != ''/,
    "and must only run when there is an issue to delete"
  );
});

test("the delete uses the App token and passes event data through env", () => {
  const step = handlerSteps.find((s) => s.name === "Delete the trigger issue");
  assert.match(step.env.GH_TOKEN, /steps\.token\.outputs\.token/, "deleteIssue needs admin, so the App token");
  assert.ok(
    !/\$\{\{/.test(step.run),
    "no interpolation into the script body - client_payload reaches it via env: (§4.3.1)"
  );
  assert.match(step.run, /deleteIssue/, "it must actually delete");
});

test("a failed delete warns rather than failing the acceptance", () => {
  // The student is already provisioned by this point. Failing the run would
  // undo nothing and hide the real problem, which is a missing permission.
  const step = handlerSteps.find((s) => s.name === "Delete the trigger issue");
  assert.match(step.run, /::warning::/, "it must say something a lecturer can act on");
  assert.ok(!/exit 1/.test(step.run), "but must not fail a completed acceptance");
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
