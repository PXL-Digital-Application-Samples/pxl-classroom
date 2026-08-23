// The nonce is the only revocation the invitation system has. `regenerate_invite`
// mints a new one, publish writes it to the broker's INVITE_NONCE variable, and
// every link issued before that reports `superseded`.
//
// It used to fail OPEN. The check read `if (nonce && payload.nonce !== ...)`, so
// a broker with no INVITE_NONCE variable accepted every token ever issued for
// that assignment - including the ones a regenerate had just retired. A publish
// that died between creating the repo and setting its variables, or a broker
// recreated by hand, produced exactly that state. "Absent" must not mean
// "accept anything" for the one mechanism whose entire job is refusal.
//
// The mirror image also bit: the value comes from a repository variable a human
// can edit, and a trailing newline rejected every live link behind the
// deliberately generic "not valid, or no longer current" message.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { signInviteToken, verifyInviteToken, generateKeyPair } from "../lib/invite-token.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const KEYPAIR = generateKeyPair();
const KEYS = { 1: KEYPAIR.publicKeyBase64 };
const ORG = "PXLAutomation";
const ID = "linux-processes-2026";
const NONCE = "0badc0de";

const token = signInviteToken({
  org: ORG,
  assignmentId: ID,
  expiresAt: "2099-01-01T00:00:00.000Z",
  nonce: NONCE,
  privateKeyPem: KEYPAIR.privateKeyPem,
});

const verify = (nonce) => verifyInviteToken(token, { org: ORG, assignmentId: ID, nonce, publicKeys: KEYS });

test("the matching nonce accepts", () => {
  assert.deepEqual(
    { ok: verify(NONCE).ok, reason: verify(NONCE).reason },
    { ok: true, reason: "valid" }
  );
});

test("a rotated nonce retires the link", () => {
  const v = verify("feedface");
  assert.equal(v.ok, false);
  assert.equal(v.reason, "superseded");
});

// --- Fails closed -----------------------------------------------------------

test("a missing nonce refuses instead of accepting everything", () => {
  for (const absent of [undefined, null, "", "   ", "\n", 0, false, {}, []]) {
    const v = verify(absent);
    assert.equal(v.ok, false, `nonce=${JSON.stringify(absent)} must not verify`);
    assert.equal(v.reason, "no-nonce", `nonce=${JSON.stringify(absent)} must say why`);
  }
});

test("a broker that lost its variables cannot be talked into accepting a retired link", () => {
  // The concrete regression: regenerate the invitation, then wipe the variable.
  // Under the old rule the OLD token verified again.
  const retired = signInviteToken({
    org: ORG,
    assignmentId: ID,
    expiresAt: "2099-01-01T00:00:00.000Z",
    nonce: "deadbeef",
    privateKeyPem: KEYPAIR.privateKeyPem,
  });
  const v = verifyInviteToken(retired, { org: ORG, assignmentId: ID, nonce: "", publicKeys: KEYS });
  assert.equal(v.ok, false);
  assert.equal(v.reason, "no-nonce");
});

// --- Whitespace and casing --------------------------------------------------

test("a nonce pasted with stray whitespace still accepts", () => {
  // gh variable set writes the value verbatim, and a human editing it in the
  // web UI can leave a trailing newline. Rejecting every live link for that,
  // behind a message that deliberately says nothing, is close to undiagnosable.
  for (const spelling of [` ${NONCE}`, `${NONCE} `, `${NONCE}\n`, `\t${NONCE}\r\n`, ` ${NONCE} `]) {
    const v = verify(spelling);
    assert.equal(v.ok, true, `nonce=${JSON.stringify(spelling)} must still verify`);
  }
});

test("nonce comparison is case-insensitive, because hex is", () => {
  assert.equal(verify(NONCE.toUpperCase()).ok, true);
  assert.equal(verify("0BadC0De").ok, true);
});

test("whitespace is trimmed, not stripped throughout", () => {
  // "0bad c0de" is a different value, not a spaced spelling of the same one.
  assert.equal(verify("0bad c0de").ok, false);
});

// --- Ordering: the signature is still checked first -------------------------

test("an unsigned token is refused before the nonce is even considered", () => {
  // The nonce check leaks whether a guess was right. An unsigned claim set has
  // earned no answers, so it must never get that far.
  const forged = token.slice(0, 36) + "A".repeat(86);
  const v = verifyInviteToken(forged, { org: ORG, assignmentId: ID, nonce: NONCE, publicKeys: KEYS });
  assert.equal(v.ok, false);
  assert.ok(["bad-signature", "non-canonical", "malformed"].includes(v.reason), `got ${v.reason}`);
});

test("an expired token is refused whatever the nonce says", () => {
  const stale = signInviteToken({
    org: ORG,
    assignmentId: ID,
    expiresAt: "2020-01-01T00:00:00.000Z",
    nonce: NONCE,
    privateKeyPem: KEYPAIR.privateKeyPem,
  });
  assert.equal(
    verifyInviteToken(stale, { org: ORG, assignmentId: ID, nonce: NONCE, publicKeys: KEYS }).reason,
    "expired"
  );
});

// --- The broker script says which fault this is -----------------------------

test("the broker script distinguishes a missing nonce from a bad token", () => {
  // A forged token and a broker missing its configuration are different
  // problems with different fixes, and the run log is the only place a lecturer
  // can tell them apart.
  const src = readFileSync(join(root, "scripts", "verify-invite-token.mjs"), "utf8");
  assert.match(src, /INVITE_NONCE is not set on this broker/, "it must name the deployment fault");
  assert.ok(
    !/INVITE_NONCE \|\| null/.test(src),
    "and must not paper over an absent nonce on the way into the verifier"
  );
});
