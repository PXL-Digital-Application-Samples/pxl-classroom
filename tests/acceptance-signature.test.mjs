// Proving an acceptance without publishing a credential.
//
// The bug this closes was measured, not theorised. On 2026-08-25:
//
//   curl -s https://api.github.com/repos/PXL-Systems-Expert/broker-2526-sysex-ek2-test2/events
//   -> HTTP 200, UNAUTHENTICATED, containing "pxl-accept:AQFQu79dno7AjwhnJix7..."
//
// A full, still-valid invitation token, on an issue that had already been
// deleted, for an assignment that was published with roster_mode: open. The
// redaction, deletion and sweep in ARCHITECTURE §4.3.3 are all after the fact -
// the `opened` event already carried the title, and GH Archive keeps the
// firehose forever.
//
// The old token was a BEARER credential. What these tests pin is that the new
// title is not one: it is a signature naming the account that made it, useless
// to anybody else, and the key that produced it never appears in an event.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  generateAcceptanceKeypair,
  signAcceptanceTitle,
  verifyAcceptanceTitle,
  signerMatchesAuthor,
  toBase64Url,
  fromBase64Url,
  TITLE_PREFIX,
  MAX_TITLE_LENGTH,
} from "../lib/acceptance-signature.mjs";

const SUBJECT = "wSbLd9k2Qn0aVjF3xRt7Zg";
const GITHUB_ID = 12345678;
const KID = "k1";

let keys;
async function keypair() {
  if (!keys) keys = await generateAcceptanceKeypair();
  return keys;
}

async function title(over = {}) {
  const { privateKey } = await keypair();
  return signAcceptanceTitle({
    privateKey,
    kid: KID,
    subject: SUBJECT,
    githubId: GITHUB_ID,
    nonce: "abc123",
    ...over,
  });
}

async function verify(t, over = {}) {
  const { publicKey } = await keypair();
  return verifyAcceptanceTitle({ title: t, publicKey, ...over });
}

// ======================================================= the round trip

test("a signed title verifies, and carries the signer's account", async () => {
  const res = await verify(await title());
  assert.equal(res.ok, true);
  assert.equal(res.kid, KID);
  assert.equal(res.payload.subject, SUBJECT);
  assert.equal(res.payload.githubId, GITHUB_ID);
});

test("the title keeps the pxl-accept: prefix the broker filters on", async () => {
  // The job-level `if` short-circuits on this BEFORE a runner is allocated.
  // Losing it would mean allocating a runner for every issue on a public repo
  // that holds the App key.
  assert.ok((await title()).startsWith(TITLE_PREFIX));
});

test("THE PRIVATE KEY NEVER APPEARS IN THE TITLE", async () => {
  // The whole point. The title goes into a permanent public archive.
  const { privateKey } = await keypair();
  const t = await title();
  assert.ok(!t.includes(privateKey));
  // Nor any substantial run of it - a truncated key is still a leak.
  for (let i = 0; i + 24 <= privateKey.length; i += 8) {
    assert.ok(!t.includes(privateKey.slice(i, i + 24)), `key fragment at ${i} leaked into the title`);
  }
});

test("the title fits inside GitHub's 256-character limit", async () => {
  const t = await title();
  assert.ok(t.length <= MAX_TITLE_LENGTH, `title was ${t.length} chars`);
});

test("an over-long title is refused at signing rather than by GitHub", async () => {
  await assert.rejects(
    () => title({ subject: "x".repeat(400) }),
    /over GitHub's 256/,
  );
});

// ======================================================= what a harvester gets

test("a harvested title cannot be reused by a different account", async () => {
  // This is the attack the exposure enabled, and the reason the payload names
  // the signer: replaying is authoring an issue as yourself, so the two
  // disagree.
  const res = await verify(await title());
  assert.equal(res.ok, true);
  assert.equal(signerMatchesAuthor(res.payload, GITHUB_ID), true);
  assert.equal(signerMatchesAuthor(res.payload, 99999999), false, "a replay by another account must not match");
});

test("signerMatchesAuthor tolerates a string id from a webhook payload", async () => {
  const res = await verify(await title());
  assert.equal(signerMatchesAuthor(res.payload, String(GITHUB_ID)), true);
});

test("signerMatchesAuthor refuses a payload with no integer id", () => {
  assert.equal(signerMatchesAuthor({ githubId: "12345678" }, 12345678), false);
  assert.equal(signerMatchesAuthor(null, 1), false);
  assert.equal(signerMatchesAuthor({}, 1), false);
});

// ======================================================= tampering

test("a tampered payload fails", async () => {
  const t = await title();
  const [prefixKid, payload, sig] = t.slice(TITLE_PREFIX.length).split(".");
  const forged = await signAcceptanceTitle({
    privateKey: (await keypair()).privateKey,
    kid: KID,
    subject: SUBJECT,
    githubId: 99999999,
    nonce: "abc123",
  });
  const forgedPayload = forged.slice(TITLE_PREFIX.length).split(".")[1];
  // Someone else's payload, this signature.
  const res = await verify(`${TITLE_PREFIX}${prefixKid}.${forgedPayload}.${sig}`);
  assert.equal(res.ok, false);
  assert.equal(res.reason, "bad-signature");
  assert.notEqual(payload, forgedPayload);
});

test("a tampered signature fails", async () => {
  const t = await title();
  const parts = t.slice(TITLE_PREFIX.length).split(".");
  const sig = fromBase64Url(parts[2]);
  sig[0] ^= 0xff;
  const res = await verify(`${TITLE_PREFIX}${parts[0]}.${parts[1]}.${toBase64Url(sig)}`);
  assert.equal(res.ok, false);
  assert.equal(res.reason, "bad-signature");
});

test("a signature from a DIFFERENT keypair fails", async () => {
  // What a rotated-away key must do: regenerate_invite mints a new pair, and
  // every link handed out before it stops verifying.
  const other = await generateAcceptanceKeypair();
  const t = await signAcceptanceTitle({
    privateKey: other.privateKey,
    kid: KID,
    subject: SUBJECT,
    githubId: GITHUB_ID,
    nonce: "abc123",
  });
  const res = await verify(t);
  assert.equal(res.ok, false);
  assert.equal(res.reason, "bad-signature");
});

test("a wrong kid is refused before any crypto runs", async () => {
  const res = await verify(await title(), { expectedKid: "k2" });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "wrong-kid");
});

// ======================================================= failing closed

test("an ABSENT public key rejects - it never accepts everything", async () => {
  // verifyInviteToken once used `if (nonce && ...)`, so a broker with no
  // INVITE_NONCE accepted every token ever issued. An absent key is a
  // deployment fault, and it must fail closed and say so.
  for (const missing of [undefined, null, ""]) {
    const res = await verifyAcceptanceTitle({ title: await title(), publicKey: missing });
    assert.equal(res.ok, false);
    assert.equal(res.reason, "no-public-key");
  }
});

test("a garbage public key rejects rather than throwing", async () => {
  const res = await verifyAcceptanceTitle({ title: await title(), publicKey: "not-a-key" });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "no-public-key");
});

test("verification NEVER throws on attacker-supplied input", async () => {
  // Every value here comes off a public repo. The broker must answer "no",
  // not crash - a crash there is a workflow failure on a repo holding the App
  // key, and it would take the reject path with it.
  const nasty = [
    "", "pxl-accept:", "pxl-accept:a", "pxl-accept:a.b", "pxl-accept:a.b.c.d",
    "pxl-accept:..", "pxl-accept:a..c", `${TITLE_PREFIX}k1.!!!.$$$`,
    "totally unrelated issue title", "pxl-accept:" + "x".repeat(300),
    null, undefined, 42, {}, [],
  ];
  const { publicKey } = await keypair();
  for (const t of nasty) {
    const res = await verifyAcceptanceTitle({ title: t, publicKey });
    assert.equal(res.ok, false, `${JSON.stringify(t)} must not verify`);
    assert.ok(typeof res.reason === "string" && res.reason.length > 0);
  }
});

test("a title that is not an acceptance is named as such, not as malformed", async () => {
  // The broker sees every issue on a public repo. "Somebody opened an ordinary
  // issue" is not a security event and must not read like one.
  const res = await verify("Help, my repo is broken");
  assert.equal(res.reason, "not-an-acceptance-title");
});

// ======================================================= canonical encoding

test("non-canonical base64url is refused - one key, one spelling", () => {
  // 32- and 64-byte values do not divide into 6-bit groups, so the last
  // character carries discardable bits. Without this check a single key has
  // several spellings and a link verifies only sometimes.
  const bytes = new Uint8Array(64).fill(7);
  const canonical = toBase64Url(bytes);
  assert.deepEqual(fromBase64Url(canonical, { expectedBytes: 64 }), bytes);

  const last = canonical[canonical.length - 1];
  const alt = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
    .split("")
    .find((c) => c !== last && toBase64Url(fromBase64UrlLoose(canonical.slice(0, -1) + c)) !== canonical.slice(0, -1) + c);
  assert.ok(alt, "expected an alternative spelling to exist");
  assert.throws(() => fromBase64Url(canonical.slice(0, -1) + alt), /non-canonical/);
});

// Decoder without the canonical check, so the test can build the bad input it
// is asserting against.
function fromBase64UrlLoose(text) {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(Buffer.from(b64, "base64"));
}

test("a signature of the wrong length is refused", async () => {
  const t = await title();
  const parts = t.slice(TITLE_PREFIX.length).split(".");
  const short = toBase64Url(fromBase64Url(parts[2]).slice(0, 32));
  const res = await verify(`${TITLE_PREFIX}${parts[0]}.${parts[1]}.${short}`);
  assert.equal(res.ok, false);
  assert.match(res.reason, /malformed/);
});

test("base64url rejects characters outside the alphabet", () => {
  for (const bad of ["a+b", "a/b", "a=b", "a b", "a.b", ""]) {
    assert.throws(() => fromBase64Url(bad), /not base64url|non-canonical/);
  }
});

// ======================================================= keys

test("a fresh keypair is different every time", async () => {
  const a = await generateAcceptanceKeypair();
  const b = await generateAcceptanceKeypair();
  assert.notEqual(a.privateKey, b.privateKey);
  assert.notEqual(a.publicKey, b.publicKey);
});

test("both halves of the keypair are canonical base64url", async () => {
  const { privateKey, publicKey } = await generateAcceptanceKeypair();
  assert.doesNotThrow(() => fromBase64Url(privateKey));
  assert.doesNotThrow(() => fromBase64Url(publicKey));
});

test("the public half cannot sign", async () => {
  const { publicKey } = await keypair();
  await assert.rejects(() =>
    signAcceptanceTitle({ privateKey: publicKey, kid: KID, subject: SUBJECT, githubId: GITHUB_ID, nonce: "n" }),
  );
});

test("a kid must be short and URL-safe", async () => {
  for (const bad of ["", "has spaces", "x".repeat(40), "a.b", "a/b"]) {
    await assert.rejects(() => title({ kid: bad }), /kid must be/);
  }
});

// ======================================================= issued_at is advisory

test("issued_at is carried but NEVER enforced", async () => {
  // A signature is already bound to one account, so a stale one only lets that
  // student accept again - which is idempotent. Rejecting on time would add a
  // clock-skew failure mode for no security gain: a student with a wrong
  // system clock would simply be unable to accept.
  const ancient = await title({ issuedAt: "2001-01-01T00:00:00.000Z" });
  const future = await title({ issuedAt: "2099-01-01T00:00:00.000Z" });
  assert.equal((await verify(ancient)).ok, true);
  assert.equal((await verify(future)).ok, true);
});

test("a payload with no issued_at still verifies", async () => {
  // `null`, not `undefined`: a default parameter fires on an explicit
  // undefined, so that spelling silently tests the DEFAULT timestamp and never
  // reaches the absent case at all.
  const res = await verify(await title({ issuedAt: null }));
  assert.equal(res.ok, true);
  assert.equal(res.payload.issuedAt, null);
});

// ======================================================= the nonce

test("two acceptances by the same account produce different titles", async () => {
  const a = await title({ nonce: "one" });
  const b = await title({ nonce: "two" });
  assert.notEqual(a, b);
  assert.equal((await verify(a)).ok, true);
  assert.equal((await verify(b)).ok, true);
});
