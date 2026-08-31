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
import { readFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { parse } from "yaml";

import { validateAgainst } from "../lib/validate.mjs";
import { signInviteToken, generateKeyPair } from "../lib/invite-token.mjs";
import { signedAcceptanceIssueTitle } from "../frontend/src/lib/invite.js";

import {
  generateAcceptanceKeypair,
  signAcceptanceTitle,
  verifyAcceptanceTitle,
  signerMatchesAuthor,
  subjectDigest,
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
    nonce: "0badc0de",
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
  assert.equal(res.payload.githubId, GITHUB_ID);
  // The subject is a truncated digest now, not the id itself - that is what
  // makes the title's length independent of what a lecturer named the
  // assignment. Compared, never read back.
  assert.deepEqual(res.payload.subjectBytes, await subjectDigest(SUBJECT));
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

test("the title fits inside the 256-character budget", async () => {
  const t = await title();
  assert.ok(t.length <= MAX_TITLE_LENGTH, `title was ${t.length} chars`);
});

// ======================================================= the budget
//
// The JSON payload blew it, and the failure landed on the STUDENT at accept
// time for a reason the lecturer chose months earlier when naming the
// assignment. Measured 2026-08-26 against GitHub: an issue title of 1024
// characters is accepted and 1025 is refused, while GitHub's own 422 message
// says "maximum is 256". We keep 256, because building on the undocumented
// 1024 means building on something GitHub's own validator calls invalid - but
// the title must then FIT in 256 with room for the longest team hint.

test("the title length does not depend on how the assignment was named", async () => {
  // This is the property, not the number. Hashing the subject is what buys it.
  const lengths = new Set();
  for (const subject of [
    "a",
    "hw-1",
    "linux-processes-2026",
    "2526-automation-scripting-practicum-exam-2",
    "x".repeat(200),
  ]) {
    lengths.add((await title({ subject })).length);
  }
  assert.equal(lengths.size, 1, `title length varied with the assignment id: ${[...lengths]}`);
});

test("the longest possible group title still fits", async () => {
  // A team slug is `[a-z0-9][a-z0-9-]{0,63}`, so 64 characters, and the hint is
  // appended AFTER signing - signAcceptanceTitle's own check never sees it.
  const t = await title({ subject: "2526-automation-scripting-practicum-exam-2" });
  const worst = `${t} team:${"a".repeat(64)}`;
  assert.ok(
    worst.length <= MAX_TITLE_LENGTH,
    `worst-case group title is ${worst.length} chars, over the ${MAX_TITLE_LENGTH} budget`,
  );
});

test("a kid at its maximum width still fits", async () => {
  const t = await title({ kid: "k".repeat(32) });
  const worst = `${t} team:${"a".repeat(64)}`;
  assert.ok(worst.length <= MAX_TITLE_LENGTH, `worst case with a 32-char kid was ${worst.length}`);
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
    nonce: "0badc0de",
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
    nonce: "0badc0de",
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

// ======================================================= issued_at is GONE
//
// It was carried and, by its own documentation, never enforced - a signature is
// already bound to one account, so a stale one only lets that student accept
// again, which is idempotent. Enforcing it would have added a clock-skew
// failure mode for no security gain.
//
// Unenforced is one thing; free is another. A full ISO-8601 string cost 32
// characters of a 256-character title, and the title did not fit. Removing dead
// data is what made room for the team hint.

test("issued_at is not part of the payload at all", async () => {
  const res = await verify(await title());
  assert.equal(res.ok, true);
  assert.equal("issuedAt" in res.payload, false, "issued_at came back - it should be gone");
});

test("passing an issuedAt is ignored rather than silently signed", async () => {
  // A caller still sending it must not change the bytes.
  //
  // The PAYLOAD, not the title: ECDSA is randomised, so signing identical bytes
  // twice gives two different signatures. That is also why the nonce is not
  // what makes two acceptances differ - it makes the signed PAYLOAD differ,
  // which is the part anything downstream could dedupe on.
  const payloadOf = (t) => t.slice(TITLE_PREFIX.length).split(".")[1];
  const a = await title({ nonce: "0badc0de" });
  const b = await title({ nonce: "0badc0de", issuedAt: "2001-01-01T00:00:00.000Z" });
  assert.equal(payloadOf(a), payloadOf(b));
  assert.notEqual(a, b, "two ECDSA signatures over the same bytes should still differ");
});

// ======================================================= the nonce

test("a minted keypair is storable in an assignment document", async () => {
  // assignment.schema.json is additionalProperties: false, so a field the
  // schema does not know about makes the whole document invalid and the Admin
  // Panel refuses to save it. The keypair is written by
  // scripts/set-assignment-invite.mjs, so its shape has to be legal there -
  // and the pattern has to match what generateAcceptanceKeypair actually emits,
  // not what it was assumed to emit.
  const { privateKey, publicKey } = await generateAcceptanceKeypair();
  const base = parse(readFileSync(new URL("./fixtures/valid-assignment.yml", import.meta.url), "utf8"));

  const withKeys = { ...base, invite_key: privateKey, invite_pubkey: publicKey };
  const { valid, errors } = validateAgainst("assignment", withKeys);
  assert.equal(valid, true, JSON.stringify(errors));

  // And an assignment without them is still valid - migration is per
  // assignment, so most documents will not have a keypair for a while.
  assert.equal(validateAgainst("assignment", { ...base }).valid, true);
});

test("two acceptances by the same account produce different titles", async () => {
  const a = await title({ nonce: "00000001" });
  const b = await title({ nonce: "00000002" });
  assert.notEqual(a, b);
  assert.equal((await verify(a)).ok, true);
  assert.equal((await verify(b)).ok, true);
});

test("a nonce that is not four bytes of hex is refused at signing", async () => {
  // It rides in a fixed-width binary field, so a wrong width would either
  // truncate silently or throw somewhere less obvious. The SPA generates it, so
  // this is a contract between two halves of our own code, not user input.
  for (const bad of ["abc123", "", null, undefined, "0badc0d", "0badc0de0", "zzzzzzzz"]) {
    await assert.rejects(() => title({ nonce: bad }), /nonce must be 8 hex/, `accepted ${JSON.stringify(bad)}`);
  }
});

// --- the migration, from the accept button's side ---------------------------
//
// Signing is per assignment, and on the day it ships NO assignment has a
// keypair - every live link is still a 122-character bearer token. The SPA
// builds its title from whatever secret the URL carries, so an unbranched
// `signAcceptanceTitle` is handed a token, `fromBase64Url` rejects the `.`
// separator, and the accept button renders **"not base64url"** to the student.
// That is every live cohort, on the deploy, at once.
//
// The old brokers those links point at still verify the old way, so the old
// title is not a fallback - it is the correct output until a republish migrates
// the broker and the assignment together.

const LEGACY_SIGNING = generateKeyPair();
const legacySecret = (id = "hw-1") =>
  signInviteToken({
    org: "PXLAutomation",
    assignmentId: id,
    expiresAt: "2099-01-01T00:00:00.000Z",
    nonce: "0badc0de",
    privateKeyPem: LEGACY_SIGNING.privateKeyPem,
  });

test("a pre-migration link still produces the title its broker understands", async () => {
  const token = legacySecret();
  const out = await signedAcceptanceIssueTitle({
    inviteSecret: token,
    assignmentId: "hw-1",
    githubId: GITHUB_ID,
  });

  assert.equal(out, `${TITLE_PREFIX}${token}`);
});

test("a pre-migration link does not throw at the accept button", async () => {
  // The specific regression: the student sees the exception text.
  await assert.doesNotReject(() =>
    signedAcceptanceIssueTitle({
      inviteSecret: legacySecret(),
      assignmentId: "hw-1",
      githubId: GITHUB_ID,
    }),
  );
});

test("the team hint survives the legacy branch", async () => {
  // It is the acceptance concurrency key, and per-team serialization is the
  // only thing guarding max_team_size - dropping it on this path would let two
  // joins read the same count.
  const token = legacySecret("group-1");
  const out = await signedAcceptanceIssueTitle({
    inviteSecret: token,
    assignmentId: "group-1",
    githubId: GITHUB_ID,
    teamSlug: "alpha",
  });

  assert.equal(out, `${TITLE_PREFIX}${token} team:alpha`);
});

test("a migrated link signs, and does not fall back to pasting the secret", async () => {
  const { privateKey } = await keypair();
  const out = await signedAcceptanceIssueTitle({
    inviteSecret: privateKey,
    assignmentId: SUBJECT,
    githubId: GITHUB_ID,
  });

  assert.ok(out.startsWith(TITLE_PREFIX));
  assert.ok(
    !out.includes(privateKey),
    "the key must never reach the title - that is the whole point of the change",
  );
  assert.equal((await verifyAcceptanceTitle({ title: out, publicKey: (await keypair()).publicKey })).ok, true);
});

// ======================================================= P-256 interop
//
// The module signs and verifies with WebCrypto, because it has to run in a
// browser. The e2e fixture mints its keypairs with node:crypto instead, since
// inviteToken() is called inline at dozens of sites and keygen there cannot be
// async. Two implementations of the same curve, and the whole suite rests on
// them producing interchangeable keys - so prove it rather than assume it.

test("a node:crypto keypair is usable by the WebCrypto path, and vice versa", async () => {
  const b64url = (buf) =>
    Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const nodeKeys = {
    privateKey: b64url(pair.privateKey.export({ type: "pkcs8", format: "der" })),
    publicKey: b64url(pair.publicKey.export({ type: "spki", format: "der" })),
  };

  // Same wire length, or the link parser would reject what the fixture mints.
  assert.equal(nodeKeys.privateKey.length, (await keypair()).privateKey.length);

  const t = await signAcceptanceTitle({
    privateKey: nodeKeys.privateKey,
    kid: KID,
    subject: SUBJECT,
    githubId: GITHUB_ID,
    nonce: "0badc0de",
  });
  const res = await verifyAcceptanceTitle({ title: t, publicKey: nodeKeys.publicKey });
  assert.equal(res.ok, true, `node-minted keypair did not round-trip: ${res.reason}`);
  assert.equal(res.payload.githubId, GITHUB_ID);

  // And the halves are not interchangeable between keypairs, which is what
  // makes "a signature from a rotated-away keypair" fail.
  const other = await verifyAcceptanceTitle({ title: t, publicKey: (await keypair()).publicKey });
  assert.equal(other.ok, false);
});

// ======================================================= THE TEAM HINT
//
// The broker is handed `github.event.issue.title` VERBATIM, and the hint is
// appended AFTER signing. verifyAcceptanceTitle split the whole title on ".",
// so the signature part came out as `<signature> team:alpha` - not base64url -
// and EVERY group acceptance was rejected as `malformed`, on every group
// assignment, forever. Individual acceptance worked perfectly, which is why it
// went unnoticed: not one test had ever verified a title carrying a hint.
//
// These run the real signer and the real verifier over the real title the SPA
// builds, because that is the only arrangement that would have caught it.

test("a group acceptance verifies with the team hint still attached", async () => {
  const { privateKey, publicKey } = await keypair();
  const withHint = await signedAcceptanceIssueTitle({
    inviteSecret: privateKey,
    assignmentId: SUBJECT,
    githubId: GITHUB_ID,
    teamSlug: "alpha",
  });

  assert.match(withHint, / team:alpha$/, "the SPA must still emit the hint");
  const res = await verifyAcceptanceTitle({ title: withHint, publicKey });
  assert.equal(res.ok, true, `group acceptance rejected: ${res.reason}`);
  assert.equal(res.payload.githubId, GITHUB_ID);
});

test("the hint is not signed, and changing it does not break verification", async () => {
  // Deliberate: the hint is a concurrency key, never an authoritative value
  // (§5.6). The hub re-derives the real team from the issue body and
  // teamHintMatches refuses one that disagrees - so signing it here would add a
  // second place for the same rule to live.
  const { privateKey, publicKey } = await keypair();
  const base = await title();
  for (const suffix of [" team:alpha", " team:a-very-long-team-slug", " team:x", "  team:alpha"]) {
    const res = await verifyAcceptanceTitle({ title: base + suffix, publicKey });
    assert.equal(res.ok, true, `rejected with suffix ${JSON.stringify(suffix)}: ${res.reason}`);
  }
  assert.ok(privateKey);
});

test("trailing junk does not let a title through that would otherwise fail", async () => {
  // The cut has to happen before the signature check, never instead of it.
  const { publicKey } = await keypair();
  const other = await generateAcceptanceKeypair();
  const foreign = await signAcceptanceTitle({
    privateKey: other.privateKey,
    kid: KID,
    subject: SUBJECT,
    githubId: GITHUB_ID,
    nonce: "0badc0de",
  });
  const res = await verifyAcceptanceTitle({ title: `${foreign} team:alpha`, publicKey });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "bad-signature");
});

test("a title that is only a hint is refused", async () => {
  const { publicKey } = await keypair();
  const res = await verifyAcceptanceTitle({ title: `${TITLE_PREFIX} team:alpha`, publicKey });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "malformed");
});

// ======================================================= wrong assignment

test("a signature for another assignment is named, not called a bad signature", async () => {
  // With a per-assignment keypair this cannot happen by attack - a foreign
  // signature does not verify at all. It happens when a broker holds the wrong
  // INVITE_PUBKEY, which RUNBOOK §1.3.2a calls out as a real deployment fault,
  // and the two need different messages.
  const { privateKey, publicKey } = await keypair();
  const t = await signAcceptanceTitle({
    privateKey,
    kid: KID,
    subject: "some-other-assignment",
    githubId: GITHUB_ID,
    nonce: "0badc0de",
  });

  const res = await verifyAcceptanceTitle({ title: t, publicKey, expectedSubject: SUBJECT });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "wrong-assignment");

  // And the matching one passes, so the check is not simply always-fail.
  const good = await verifyAcceptanceTitle({ title: await title(), publicKey, expectedSubject: SUBJECT });
  assert.equal(good.ok, true);
});

test("the subject check runs after the signature, never instead of it", async () => {
  // Ordering matters: an unsigned caller must not be able to probe which
  // assignment a broker serves by watching the reason change.
  const other = await generateAcceptanceKeypair();
  const foreign = await signAcceptanceTitle({
    privateKey: other.privateKey,
    kid: KID,
    subject: "some-other-assignment",
    githubId: GITHUB_ID,
    nonce: "0badc0de",
  });
  const res = await verifyAcceptanceTitle({
    title: foreign,
    publicKey: (await keypair()).publicKey,
    expectedSubject: SUBJECT,
  });
  assert.equal(res.reason, "bad-signature", "a forged title must not reveal the subject mismatch");
});

// ======================================================= a missing account id

test("a missing github id fails at signing, where the cause is still visible", async () => {
  // It used to become `Number(undefined)` -> NaN -> JSON null, minting a title
  // every broker rejects with a deliberately generic "this link is not valid" -
  // sending the student to hunt for a problem with their link when the cause
  // was their session.
  for (const bad of [undefined, null, "", 0, -1, "abc", 1.5, NaN]) {
    await assert.rejects(
      () => title({ githubId: bad }),
      /not a usable GitHub account id/,
      `accepted githubId ${JSON.stringify(bad)}`,
    );
  }
});

test("a large github id round-trips", async () => {
  // 48 bits. GitHub is at ~2e8; this is the headroom, and getting the split
  // between the high 16 and low 32 bits wrong would corrupt exactly the large
  // ids nobody tests with.
  const { publicKey } = await keypair();
  for (const id of [1, 71908551, 4294967295, 4294967296, 281474976710655]) {
    const t = await title({ githubId: id });
    const res = await verifyAcceptanceTitle({ title: t, publicKey });
    assert.equal(res.ok, true, `id ${id} did not verify`);
    assert.equal(res.payload.githubId, id, `id ${id} came back as ${res.payload.githubId}`);
    assert.equal(signerMatchesAuthor(res.payload, String(id)), true);
  }
});

test("an id past 48 bits is refused rather than silently truncated", async () => {
  await assert.rejects(() => title({ githubId: 281474976710656 }), /not a usable GitHub account id/);
});

test("signerMatchesAuthor refuses an empty author id against a zero payload", async () => {
  // Number("") and Number(null) are both 0, so without a lower bound an absent
  // ISSUE_AUTHOR_ID matched a payload claiming account 0.
  assert.equal(signerMatchesAuthor({ githubId: 0 }, ""), false);
  assert.equal(signerMatchesAuthor({ githubId: 0 }, null), false);
  assert.equal(signerMatchesAuthor({ githubId: 0 }, 0), false);
  assert.equal(signerMatchesAuthor({ githubId: 1 }, ""), false);
  assert.equal(signerMatchesAuthor({ githubId: 1 }, undefined), false);
});
