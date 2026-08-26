// The publish gate's last line of defence is a regex, and a regex that misses
// some of what it is aimed at is worse than one that misses all of it: it
// passes, so nobody looks again.
//
// `pages/scan.mjs` fails an org's Pages build if a signed invitation appears in
// a world-readable artifact. The rule lives in lib/public-text.mjs and is
// shared with AdminView and pages/generate.mjs, so all three agree on what an
// invitation looks like.
//
// A signed invitation is base64url, whose alphabet includes `-`. `-` is NOT a
// word character, so `\b` at the end of the pattern asserts a boundary that
// does not exist when the token ends in `-` and is followed by a quote - which
// is exactly how it would appear in generated JSON. Roughly one token in
// sixty-four ends that way.

import { test } from "node:test";
import assert from "node:assert/strict";

import { PUBLIC_TEXT_RULES, findPublicTextViolation } from "../lib/public-text.mjs";
import { signInviteToken, generateKeyPair } from "../lib/invite-token.mjs";
import {
  generateAcceptanceKeypair,
  ACCEPTANCE_KEY_LENGTH,
} from "../lib/acceptance-signature.mjs";

const KEYPAIR = generateKeyPair();

/** A real token, as publish-assignment.yml would mint it. */
const mint = (i) =>
  signInviteToken({
    org: "PXL-CSMobile",
    assignmentId: `hw-${i}`,
    expiresAt: "2099-01-01T00:00:00.000Z",
    nonce: (i % 16).toString(16).repeat(8).slice(0, 8),
    privateKeyPem: KEYPAIR.privateKeyPem,
  });

const tokenRule = () => PUBLIC_TEXT_RULES.find((r) => r.name === "invitation-token");

test("the rule still describes the token this system actually mints", () => {
  // If the wire format ever changes length, the gate stops matching and says
  // nothing. Pin the shape against a real token rather than against the
  // comment that describes it.
  const t = mint(1);
  const [payload, signature] = t.split(".");
  assert.equal(payload.length, 35, "26-byte payload -> 35 base64url chars");
  assert.equal(signature.length, 86, "64-byte Ed25519 signature -> 86 chars");
  assert.equal(t.length, 122);

  const rule = tokenRule();
  assert.ok(rule, "the invitation-token rule must exist");
  rule.re.lastIndex = 0;
  assert.ok(rule.re.test(t), "a bare token must match");
});

test("every token is caught inside generated JSON", () => {
  // The real shape: the scanner walks generated Pages artifacts, so a leaked
  // token is a JSON string value - quote, token, quote.
  const missed = [];
  for (let i = 0; i < 400; i++) {
    const t = mint(i);
    if (!findPublicTextViolation(`{"invite_token":"${t}"}`)) {
      missed.push({ i, tail: t.slice(-1) });
    }
  }
  assert.deepEqual(missed, [], `${missed.length} of 400 invitations passed the publish gate unnoticed`);
});

test("the rule's `\\b` is safe only because the signature cannot end in a dash", () => {
  // Worth pinning, because it is a coincidence of the key size rather than a
  // property of the pattern.
  //
  // `\b` asserts a WORD boundary, and base64url's alphabet contains `-`, which
  // is not a word character. A token ending in `-` followed by `"` therefore
  // has no boundary to assert and the rule does not fire - demonstrated below.
  //
  // It cannot happen today: an Ed25519 signature is 64 bytes = 512 bits, and 85
  // base64url characters carry 510 of them, so the 86th encodes just 2
  // significant bits. Only four characters can appear there - A, Q, g and w -
  // and `-` is index 62. The same argument covers the 35-character payload.
  //
  // Change the payload size, the key type, or the encoding, and that stops
  // being true. This test is the tripwire: it fails, and whoever changed the
  // format learns that lib/public-text.mjs depends on the old one.
  const tails = new Set();
  for (let i = 0; i < 400; i++) tails.add(mint(i).slice(-1));

  assert.deepEqual(
    [...tails].sort(),
    ["A", "Q", "g", "w"],
    "the final character is no longer constrained to the four values that make " +
      "`\\b` safe - switch the rule to explicit lookarounds before shipping this",
  );

  // And this is what it would cost. Synthetic, because a real one cannot end
  // this way - the shape is right, only the terminal character differs.
  const shaped = `${"A".repeat(35)}.${"A".repeat(85)}-`;
  assert.equal(shaped.split(".")[0].length, 35);
  assert.equal(shaped.split(".")[1].length, 86);
  assert.equal(
    findPublicTextViolation(`{"invite_token":"${shaped}"}`),
    null,
    "if this starts being caught the boundary problem is gone and this test " +
      "and its warning can go with it",
  );
});

test("a token adjacent to non-word characters on both sides is still caught", () => {
  // Every realistic surrounding: JSON value, URL path, query string, markdown.
  const t = mint(7);
  for (const wrap of [
    (x) => `{"t":"${x}"}`,
    (x) => `https://example.test/PXL/i/${x}`,
    (x) => `?token=${x}&next=1`,
    (x) => `(${x})`,
    (x) => `\n${x}\n`,
    (x) => x,
  ]) {
    assert.ok(
      findPublicTextViolation(wrap(t)),
      `not caught when wrapped as: ${wrap("<token>")}`,
    );
  }
});

test("the rule does not fire on ordinary published text", () => {
  // The gate blocks a lecturer's save and fails a Pages build, so a false
  // positive is expensive. Nothing here is 35.86 base64url characters.
  for (const ok of [
    "Linux Processes 2026",
    "Implement a TCP server. See chapter 4.2 of the handbook.",
    "Deadline 2027-01-30. Submit on main.",
    "See https://github.com/PXL-2TIN-NetAdv-26-27/Guts-DotNetAdvanced-2627",
    "commit 3f2a9c1e8b7d6a5f4e3c2b1a0987654321fedcba",
  ]) {
    assert.equal(findPublicTextViolation(ok), null, `false positive on: ${ok}`);
  }
});

// --- the invitation is a private key now ------------------------------------
//
// CLAIM_PLAN Phase A replaced the bearer token with a keypair: the link carries
// the PRIVATE half, and the student's browser signs with it. The rule above is
// keyed on the token's `<35>.<86>` shape and cannot see a key at all - so for
// the length of that migration the publish gate would have waved a leaked
// invitation straight through, silently, which is the failure mode the top of
// this file is about.

const keyRule = () => PUBLIC_TEXT_RULES.find((r) => r.name === "invitation-key");

test("the key rule is anchored on something every minted key actually contains", async () => {
  // The rule matches a DER header rather than a length, and that only works
  // because a PKCS#8 P-256 key is a fixed structure. Pin it against real mints:
  // change the curve or the export format and this goes red, instead of the
  // gate quietly matching nothing.
  const prefixes = new Set();
  for (let i = 0; i < 25; i++) {
    const { privateKey } = await generateAcceptanceKeypair();
    assert.equal(privateKey.length, ACCEPTANCE_KEY_LENGTH);
    prefixes.add(privateKey.slice(0, 36));
  }
  assert.equal(prefixes.size, 1, "the anchored prefix is no longer constant across mints");

  const rule = keyRule();
  assert.ok(rule, "the invitation-key rule must exist");
  assert.ok(
    rule.re.source.includes([...prefixes][0]),
    `the rule anchors on a prefix keys no longer have (they start ${[...prefixes][0]})`,
  );
});

test("every key is caught inside generated JSON", async () => {
  // The real shape: a leak reaches the scanner as a JSON string value in a
  // published artifact.
  const missed = [];
  for (let i = 0; i < 50; i++) {
    const { privateKey } = await generateAcceptanceKeypair();
    if (!findPublicTextViolation(`{"invite_key":"${privateKey}"}`)) missed.push(i);
  }
  assert.deepEqual(missed, [], `${missed.length} of 50 invitation keys passed the publish gate`);
});

test("the OLD rule could not see a key - which is why this one exists", async () => {
  // The mutation, made permanent: if the token rule ever starts matching a key,
  // the two rules overlap and one of them is redundant. Until then this records
  // that adding the second rule was not defence in depth, it was the whole
  // check.
  const { privateKey } = await generateAcceptanceKeypair();
  const token = mint(1);
  const tokenOnly = new RegExp(tokenRule().re.source, tokenRule().re.flags);
  assert.equal(tokenOnly.test(privateKey), false, "the token rule now matches a key too");

  // And the reverse, so a future edit cannot collapse them into one.
  const keyOnly = new RegExp(keyRule().re.source, keyRule().re.flags);
  assert.equal(keyOnly.test(token), false, "the key rule now matches a token too");
});

test("a truncated key is still caught", async () => {
  // A partial paste is still a leak, and a length-based rule would have missed
  // it. Anything carrying the header is reported.
  const { privateKey } = await generateAcceptanceKeypair();
  for (const cut of [60, 100, 150, 183]) {
    assert.ok(
      findPublicTextViolation(`{"k":"${privateKey.slice(0, cut)}"}`),
      `a key truncated to ${cut} characters passed the gate`,
    );
  }
});

test("the PUBLIC half is deliberately not flagged", async () => {
  // It lives on a public broker as INVITE_PUBKEY and publishing it costs
  // nothing. Flagging it would put a permanent false positive beside the real
  // findings, which is how a gate stops being read.
  for (let i = 0; i < 10; i++) {
    const { publicKey } = await generateAcceptanceKeypair();
    assert.equal(
      findPublicTextViolation(`{"invite_pubkey":"${publicKey}"}`),
      null,
      "the public key must not trip the gate",
    );
  }
});

test("the key rule does not fire on ordinary published text", () => {
  for (const ok of [
    "Linux Processes 2026",
    "Use MIGHTY_FLAG=1 to enable verbose output.",
    "Base64 is not a cipher. MIGHAgEA is not a key on its own either.",
    "See https://github.com/PXL-2TIN-NetAdv-26-27/Guts-DotNetAdvanced-2627",
  ]) {
    assert.equal(findPublicTextViolation(ok), null, `false positive on: ${ok}`);
  }
});
