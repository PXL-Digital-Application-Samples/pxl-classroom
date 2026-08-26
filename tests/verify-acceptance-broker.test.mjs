// The broker's verifier, across BOTH invitation formats.
//
// This script is the one piece of the system that every broker runs from
// `ref: main`, whatever workflow file it was published with. So it is the one
// place where a change breaks live acceptances instantly rather than on the
// next republish - and the reason the signed format was added ALONGSIDE the
// token path instead of replacing it.
//
// What is pinned here:
//   1. An old broker (sends TOKEN) keeps working, untouched.
//   2. A new broker (sends TITLE + INVITE_PUBKEY) verifies a signature.
//   3. A link minted before the change is named as OUT OF DATE, not as
//      malformed - otherwise a student hunts for a typo in a link that is
//      simply old.
//   4. Everything fails closed, and nothing exits non-zero: a hard failure here
//      would turn every forged title into a red run on a lecturer's broker.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  generateAcceptanceKeypair,
  signAcceptanceTitle,
} from "../lib/acceptance-signature.mjs";
import { signInviteToken, generateKeyPair } from "../lib/invite-token.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, "..", "scripts", "verify-invite-token.mjs");

const ORG = "PXL-Systems-Expert";
const ASSIGNMENT = "2526-sysex-ek2";
const GITHUB_ID = 71908551;

function run(env = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pxl-verify-"));
  const outputFile = join(dir, "out.env");
  const res = spawnSync(process.execPath, [SCRIPT], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      GITHUB_OUTPUT: outputFile,
      ...env,
    },
  });
  const outputs = {};
  try {
    for (const line of readFileSync(outputFile, "utf8").split("\n")) {
      if (!line) continue;
      const [k, ...v] = line.split("=");
      outputs[k] = v.join("=");
    }
  } catch { /* nothing written */ }
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, outputs, dir };
}

// --------------------------------------------------------------------------
// The new, signed path
// --------------------------------------------------------------------------

let signed;
async function signedFixture() {
  if (signed) return signed;
  const keys = await generateAcceptanceKeypair();
  const title = await signAcceptanceTitle({
    privateKey: keys.privateKey,
    kid: "k1",
    subject: "wSbLd9k2Qn0aVjF3xRt7Zg",
    githubId: GITHUB_ID,
    nonce: "n1",
  });
  signed = { keys, title };
  return signed;
}

test("a signed title from the right account is accepted", async () => {
  const { keys, title } = await signedFixture();
  const res = run({ TITLE: title, INVITE_PUBKEY: keys.publicKey, ISSUE_AUTHOR_ID: String(GITHUB_ID) });
  assert.equal(res.status, 0);
  assert.equal(res.outputs.valid, "true");
  assert.equal(res.outputs.reason, "signed");
  assert.equal(res.outputs.github_id, String(GITHUB_ID));
});

test("THE REPLAY IS REFUSED - a different author with the same title", async () => {
  // The attack the exposure enabled. A title lifted from the public archive
  // names the account that made it; replaying it means authoring the issue as
  // yourself, and the two disagree.
  const { keys, title } = await signedFixture();
  const res = run({ TITLE: title, INVITE_PUBKEY: keys.publicKey, ISSUE_AUTHOR_ID: "99999999" });
  assert.equal(res.status, 0);
  assert.equal(res.outputs.valid, "false");
  assert.equal(res.outputs.reason, "signer-mismatch");
});

test("a missing author id is a mismatch, not a pass", async () => {
  const { keys, title } = await signedFixture();
  const res = run({ TITLE: title, INVITE_PUBKEY: keys.publicKey });
  assert.equal(res.outputs.valid, "false");
  assert.equal(res.outputs.reason, "signer-mismatch");
});

test("an ABSENT INVITE_PUBKEY fails closed and names the deployment fault", async () => {
  // The INVITE_NONCE precedent: an absent value once accepted every token ever
  // issued. It must reject, and it must not read like a forged title.
  const { title } = await signedFixture();
  const res = run({ TITLE: title, ISSUE_AUTHOR_ID: String(GITHUB_ID) });
  assert.equal(res.status, 0);
  assert.equal(res.outputs.valid, "false");
  assert.equal(res.outputs.reason, "no-public-key");
  assert.match(res.stderr, /INVITE_PUBKEY is not set/);
  assert.match(res.stderr, /Republish/);
});

test("a signature from a rotated-away keypair is refused", async () => {
  const { title } = await signedFixture();
  const other = await generateAcceptanceKeypair();
  const res = run({ TITLE: title, INVITE_PUBKEY: other.publicKey, ISSUE_AUTHOR_ID: String(GITHUB_ID) });
  assert.equal(res.outputs.valid, "false");
  assert.equal(res.outputs.reason, "bad-signature");
});

test("garbage titles fail closed and never exit non-zero", async () => {
  // A hard failure here turns every forged title into a red run on a
  // lecturer's public broker, which is how people learn to ignore red runs.
  const { keys } = await signedFixture();
  for (const title of ["pxl-accept:", "pxl-accept:a.b", "pxl-accept:a.b.c.d", "pxl-accept:!!!.???.***"]) {
    const res = run({ TITLE: title, INVITE_PUBKEY: keys.publicKey, ISSUE_AUTHOR_ID: String(GITHUB_ID) });
    assert.equal(res.status, 0, `${title} must exit 0`);
    assert.equal(res.outputs.valid, "false", `${title} must not verify`);
  }
});

// --------------------------------------------------------------------------
// The migration
// --------------------------------------------------------------------------

test("an OLD-FORMAT link is named as out of date, not as malformed", async () => {
  // Otherwise a student hunts for a typo in a link that is simply old, and the
  // lecturer has no idea a republish is what fixes it.
  const { keys } = await signedFixture();
  const legacyToken = "A".repeat(35) + "." + "B".repeat(86);
  const res = run({
    TITLE: `pxl-accept:${legacyToken}`,
    INVITE_PUBKEY: keys.publicKey,
    ISSUE_AUTHOR_ID: String(GITHUB_ID),
  });
  assert.equal(res.status, 0);
  assert.equal(res.outputs.valid, "false");
  assert.equal(res.outputs.reason, "legacy-link");
  assert.match(res.stderr, /predates the signed-acceptance change/);
  assert.match(res.stderr, /Republish the assignment/);
});

test("an old-format link with a team hint is still recognised as legacy", async () => {
  const { keys } = await signedFixture();
  const legacyToken = "A".repeat(35) + "." + "B".repeat(86);
  const res = run({
    TITLE: `pxl-accept:${legacyToken} team:alpha`,
    INVITE_PUBKEY: keys.publicKey,
    ISSUE_AUTHOR_ID: String(GITHUB_ID),
  });
  assert.equal(res.outputs.reason, "legacy-link");
});

// --------------------------------------------------------------------------
// The old path, which must keep working until every broker is republished
// --------------------------------------------------------------------------

function legacyFixture() {
  const pair = generateKeyPair();
  const token = signInviteToken({
    org: ORG,
    assignmentId: ASSIGNMENT,
    expiresAt: "2099-01-01T00:00:00.000Z",
    nonce: "0badc0de",
    privateKeyPem: pair.privateKeyPem,
  });
  const dir = mkdtempSync(join(tmpdir(), "pxl-legacy-keys-"));
  const keysFile = join(dir, "invite-keys.json");
  // Keyed by `kid`, which signInviteToken defaults to 1 - not by a name. And
  // the export is `publicKeyBase64`.
  writeFileSync(keysFile, JSON.stringify({ keys: { 1: pair.publicKeyBase64 } }));
  return { token, keysFile };
}

test("BACKWARD COMPATIBLE - a broker still sending TOKEN keeps working", async () => {
  // Every broker checks the hub out at ref: main, so an un-republished broker
  // runs this exact file. If the token path stopped working the moment this
  // merged, every live acceptance would break before anybody republished.
  const { token, keysFile } = legacyFixture();
  const res = run({
    TOKEN: token,
    ORG,
    ASSIGNMENT_ID: ASSIGNMENT,
    INVITE_NONCE: "0badc0de",
    KEYS_FILE: keysFile,
  });
  assert.equal(res.status, 0);
  assert.equal(res.outputs.valid, "true");
});

test("the old path still refuses a retired nonce", async () => {
  const { token, keysFile } = legacyFixture();
  const res = run({
    TOKEN: token,
    ORG,
    ASSIGNMENT_ID: ASSIGNMENT,
    INVITE_NONCE: "deadbeef",
    KEYS_FILE: keysFile,
  });
  assert.equal(res.outputs.valid, "false");
});

test("the old path still fails closed with no nonce at all", async () => {
  // verifyInviteToken once used `if (nonce && ...)`, so an unset variable
  // accepted every token ever issued for that assignment.
  const { token, keysFile } = legacyFixture();
  const res = run({ TOKEN: token, ORG, ASSIGNMENT_ID: ASSIGNMENT, KEYS_FILE: keysFile });
  assert.equal(res.outputs.valid, "false");
  assert.match(res.stderr, /INVITE_NONCE is not set/);
});

test("TITLE takes precedence over TOKEN when a broker sends both", async () => {
  // A republished broker sends TITLE. If a stale TOKEN were also present, the
  // signed path must win rather than silently falling back to the format this
  // change exists to retire.
  const { keys, title } = await signedFixture();
  const { token, keysFile } = legacyFixture();
  const res = run({
    TITLE: title,
    INVITE_PUBKEY: keys.publicKey,
    ISSUE_AUTHOR_ID: String(GITHUB_ID),
    TOKEN: token,
    ORG,
    ASSIGNMENT_ID: ASSIGNMENT,
    INVITE_NONCE: "0badc0de",
    KEYS_FILE: keysFile,
  });
  assert.equal(res.outputs.reason, "signed");
});
