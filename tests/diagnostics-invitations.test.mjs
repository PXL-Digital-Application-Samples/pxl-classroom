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
function makeRequest({ keys = { 1: KEYPAIR.publicKeyBase64 }, vars = { INVITE_NONCE: NONCE, INVITE_ENABLED: "true" }, keysStatus = 200, varsStatus = 200, exposedIssues = [] } = {}) {
  return async (_method, path) => {
    if (path.includes("invite-keys.json")) {
      if (keysStatus !== 200) return { ok: false, status: keysStatus, data: null };
      return { ok: true, status: 200, data: { content: b64(JSON.stringify({ keys })) } };
    }
    // Tier 4 exposure sweep: no leftover acceptance issue on the broker.
    if (path.includes("/issues?state=all")) {
      return { ok: true, status: 200, data: exposedIssues };
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

// --- a MIGRATED assignment --------------------------------------------------
//
// Signed acceptance changed what the four things are, and the engine was still
// checking the old four. `linkSecretFrom` was swapped in without teaching the
// parse about the new shape, so `parseToken` saw a 184-character key, returned
// null, and the engine reported "invite_token is malformed. Republish to mint a
// valid one." over a perfectly good link - then RETURNED, taking the nonce, the
// pubkey and the acceptance switch with it. Every test here passed throughout,
// because none of them had ever built a migrated assignment.
//
// The agreement that actually matters now is INVITE_PUBKEY, and nothing checked
// it at all. A republished broker sends no legacy token, so a missing public key
// does not fall back to the old behaviour - it rejects every student in silence.

const KEY = {
  private: "M".padEnd(184, "x"),
  public: "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE-e2e-public-half",
};

const migrated = {
  ...healthy,
  invite_key: KEY.private,
  invite_pubkey: KEY.public,
};

const migratedVars = (over = {}) => ({
  vars: { INVITE_NONCE: NONCE, INVITE_ENABLED: "true", INVITE_PUBKEY: KEY.public, ...over },
});

test("a migrated assignment is not reported as malformed", async () => {
  const r = await run(migrated, migratedVars());
  assert.equal(r["invite-token"].severity, "ok");
  assert.match(r["invite-token"].message, /keypair/i);
});

test("and the checks below it still run", async () => {
  // The regression was not only the false fail - it was the early return. An
  // assignment with acceptance switched off would have gone unreported.
  const r = await run(migrated, migratedVars({ INVITE_ENABLED: "false" }));
  assert.equal(r["invite-enabled"].severity, "warn");
});

test("a missing INVITE_PUBKEY fails - it does not degrade to the old path", async () => {
  const r = await run(migrated, { vars: { INVITE_NONCE: NONCE, INVITE_ENABLED: "true" } });
  assert.equal(r["invite-pubkey"].severity, "fail");
  assert.match(r["invite-pubkey"].message, /cannot verify a single acceptance/);
});

test("a broker holding somebody else's key fails", async () => {
  // What a half-finished republish leaves behind: the assignment's link was
  // minted from one keypair and the broker verifies against another.
  const r = await run(migrated, migratedVars({ INVITE_PUBKEY: "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE-a-different-key" }));
  assert.equal(r["invite-pubkey"].severity, "fail");
  assert.match(r["invite-pubkey"].message, /different acceptance key/);
});

test("a healthy migrated assignment is quiet, and says nothing about the nonce", async () => {
  const r = await run(migrated, migratedVars());
  assert.equal(r["invite-pubkey"].severity, "ok");
  // The signed path never reads INVITE_NONCE. Judging it here would report a
  // failure the system does not have - the same rule that keeps a missing
  // permission from being reported as org drift.
  assert.equal(r["invite-nonce"], undefined);
  // And the hub's key file governs the legacy token only.
  assert.equal(r["invite-key"], undefined);
});

test("a leftover title on an UNMIGRATED assignment is an exposed link", async () => {
  const r = await run(healthy, {
    exposedIssues: [{ number: 7, title: `pxl-accept:${TOKEN}`, state: "closed" }],
  });
  assert.equal(r["invite-exposure"].severity, "fail");
  assert.match(r["invite-exposure"].message, /effectively public/);
  assert.match(r["invite-exposure"].message, /regenerate/i);
});

test("the same leftover on a MIGRATED assignment is a failed cleanup, not an exposed link", async () => {
  // The title is a signature naming one account there - useless to anyone else.
  // Calling it an exposed invitation would be false, and the advice would be
  // actively harmful: regenerating retires every student's link to fix nothing.
  const r = await run(migrated, {
    ...migratedVars(),
    exposedIssues: [{ number: 7, title: "pxl-accept:a1.abc.def", state: "closed" }],
  });
  assert.equal(r["invite-exposure"].severity, "warn");
  assert.match(r["invite-exposure"].message, /signatures, not links/i);
  assert.match(r["invite-exposure"].message, /Do NOT regenerate/);

  // And it must not name a cause it does not know. "The App lacks
  // Administration: write" was measured false on 2026-08-26 - the org grants
  // it - so the message points at the run that has GitHub's own reason instead.
  assert.doesNotMatch(
    r["invite-exposure"].message,
    /Administration: write/,
    "the sweep must not diagnose a permission it cannot see",
  );
  assert.match(r["invite-exposure"].message, /acceptance-handler/i);
});

test("A BROKER SIGNING FOR AN ASSIGNMENT THAT HAS NO KEYPAIR is caught", async () => {
  // The inverse, and the more dangerous half, because everything else looks
  // healthy: the token, the key id and the nonce all still check out.
  //
  // publish-assignment.yml sets INVITE_PUBKEY and pushes the broker workflow in
  // one step, then commits the assignment. A failure in between - an org
  // ruleset rejecting the push - leaves a broker verifying signatures for an
  // assignment whose keypair was never committed, and republishing an
  // already-published assignment does not revert. Every student's link is then
  // the older kind and every acceptance is refused as out of date.
  const r = await run(healthy, {
    vars: { INVITE_NONCE: NONCE, INVITE_ENABLED: "true", INVITE_PUBKEY: KEY.public },
  });
  assert.equal(r["invite-pubkey"].severity, "fail");
  assert.match(r["invite-pubkey"].message, /no keypair/);
  assert.equal(r["invite-pubkey"].fixAction?.type, "publish_broker");
});

test("an unmigrated assignment on a broker with no pubkey stays quiet about it", async () => {
  // The ordinary state of every assignment today. It must raise nothing.
  const r = await run(healthy);
  assert.equal(r["invite-pubkey"], undefined);
  assert.equal(r["invite-nonce"].severity, "ok");
});

test("a truncated invite_key is still caught", async () => {
  // The check that replaces parseToken for this shape. An email client wrapping
  // a URL, or a hand-edited YAML.
  const r = await run({ ...migrated, invite_key: KEY.private.slice(0, 100) }, migratedVars());
  assert.equal(r["invite-token"].severity, "fail");
  assert.match(r["invite-token"].message, /expected 184/);
});
