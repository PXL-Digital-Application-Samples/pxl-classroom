// Four independent things must agree before a student can accept: the
// assignment holds a signed invitation, the hub publishes the key it was signed
// with, the broker holds the nonce it carries, and acceptance is switched on.
//
// When any one drifts, the failure is silent - the broker skips or rejects,
// nothing is written to the control repo, and the lecturer sees a page that
// looks fine. System Health is the only place that can catch it, so these tests
// exist to prove each check FAILS when it should, not merely that it passes
// against a healthy assignment.

import { test } from "node:test";
import assert from "node:assert/strict";

import { runInvitationChecks } from "../lib/diagnostics.mjs";
import { signInviteToken, generateKeyPair } from "../lib/invite-token.mjs";

const ORG = "PXLAutomation";
const ID = "linux-processes-2026";
const BROKER = `broker-${ID}`;
const NONCE = "0badc0de";

const KEYPAIR = generateKeyPair();
const TOKEN = signInviteToken({
  org: ORG,
  assignmentId: ID,
  expiresAt: "2099-01-01T00:00:00.000Z",
  nonce: NONCE,
  kid: 1,
  privateKeyPem: KEYPAIR.privateKeyPem,
});

const b64 = (text) => Buffer.from(text, "utf8").toString("base64");

/**
 * Stubs only the two endpoints the invitation checks read: the hub's public key
 * file and the broker's Actions variables.
 */
function makeRequest({ keys = { 1: KEYPAIR.publicKeyBase64 }, vars = { INVITE_NONCE: NONCE, INVITE_ENABLED: "true" }, keysStatus = 200, varsStatus = 200 } = {}) {
  return async (_method, path) => {
    if (path.includes("invite-keys.json")) {
      if (keysStatus !== 200) return { ok: false, status: keysStatus, data: null };
      return { ok: true, status: 200, data: { content: b64(JSON.stringify({ keys })) } };
    }
    if (path.includes("/actions/variables")) {
      if (varsStatus !== 200) return { ok: false, status: varsStatus, data: null };
      return {
        ok: true,
        status: 200,
        data: { variables: Object.entries(vars).map(([name, value]) => ({ name, value })) },
      };
    }
    throw new Error(`unexpected request: ${path}`);
  };
}

async function run(doc, requestOpts) {
  const results = [];
  await runInvitationChecks({
    req: makeRequest(requestOpts),
    addCheck: (_tier, c) => results.push(c),
    check: (id, tierId, label, severity, message, detail = null, fixAction = null) => ({
      id,
      tierId,
      label,
      severity,
      message,
      detail,
      fixAction,
    }),
    doc,
    org: ORG,
    brokerName: BROKER,
    assignmentId: ID,
  });
  return Object.fromEntries(results.map((c) => [c.id, c]));
}

const healthy = { invite_token: TOKEN, invite_nonce: NONCE };

test("a healthy invitation reports every check green", async () => {
  const r = await run(healthy);
  for (const id of ["invite-token", "invite-key", "invite-nonce"]) {
    assert.equal(r[id]?.severity, "ok", `${id} should be ok: ${r[id]?.message}`);
  }
  assert.ok(!r["invite-enabled"], "no warning when acceptance is switched on");
});

test("an assignment with no invite_token is a failure with a republish fix", async () => {
  // The state every assignment published before signed invitations is in. Its
  // link cannot resolve, and nothing else in the panel would say so.
  const r = await run({ invite_nonce: NONCE });
  assert.equal(r["invite-token"].severity, "fail");
  assert.match(r["invite-token"].message, /no invite_token/);
  assert.equal(r["invite-token"].fixAction.type, "publish_broker");
  assert.ok(!r["invite-key"], "checking the key is pointless without a token");
});

test("a malformed invite_token is a failure", async () => {
  const r = await run({ invite_token: "not-a-token", invite_nonce: NONCE });
  assert.equal(r["invite-token"].severity, "fail");
  assert.match(r["invite-token"].message, /malformed/);
});

test("a token signed with a key the hub does not publish is a failure", async () => {
  // Rotating the signing key without committing the new public half rejects
  // every acceptance as unknown-key, with nothing written anywhere.
  const r = await run(healthy, { keys: { 2: generateKeyPair().publicKeyBase64 } });
  assert.equal(r["invite-key"].severity, "fail");
  assert.match(r["invite-key"].message, /key id 1/);
  assert.match(r["invite-key"].message, /unknown-key/);
});

test("a broker nonce that has drifted from the assignment is a failure", async () => {
  // A republish whose variable write failed leaves these out of step, and every
  // link already handed out reports superseded.
  const r = await run(healthy, { vars: { INVITE_NONCE: "deadbeef", INVITE_ENABLED: "true" } });
  assert.equal(r["invite-nonce"].severity, "fail");
  assert.match(r["invite-nonce"].message, /superseded/);
  assert.equal(r["invite-nonce"].fixAction.type, "publish_broker");
});

test("a broker with no nonce at all is a failure", async () => {
  const r = await run(healthy, { vars: { INVITE_ENABLED: "true" } });
  assert.equal(r["invite-nonce"].severity, "fail");
  assert.match(r["invite-nonce"].message, /no INVITE_NONCE/);
});

test("acceptance switched off is surfaced as a warning, not silence", async () => {
  // INVITE_ENABLED is read in the job-level `if`, so the run is skipped before a
  // runner is allocated - there is no failed run for anyone to notice.
  const r = await run(healthy, { vars: { INVITE_NONCE: NONCE, INVITE_ENABLED: "false" } });
  assert.equal(r["invite-enabled"].severity, "warn");
  assert.match(r["invite-enabled"].message, /switched off/);
});

test("unreadable inputs degrade to info, never a false alarm", async () => {
  // The engine's standing rule: a check that cannot see its input says so
  // rather than claiming a problem (ARCHITECTURE §12).
  const keyless = await run(healthy, { keysStatus: 404 });
  assert.equal(keyless["invite-key"].severity, "info");

  const varless = await run(healthy, { varsStatus: 403 });
  assert.equal(varless["invite-nonce"].severity, "info");
});
