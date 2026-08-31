// Rotating the hub's claim key, which was impossible until 2026-08-31.
//
// THE SHAPE OF THE PROBLEM. `acceptance/claim-keys.json` has carried a
// `current` kid and a `keys` map since the claim flow shipped, and the SPA
// seals to whichever is current - so it LOOKS rotatable. It is not: the kid
// never travels with the ciphertext (the wire format is
// `c1.<ephemeral SPKI>.<iv>.<ciphertext>`) and the hub held exactly one
// PXL_CLAIM_PRIVATE_KEY. Minting a new keypair would therefore have failed
// every claim already sealed to the old one - acceptances already posted, plus
// every browser still running a cached bundle.
//
// And it would have failed them in the worst available way. In the gate the
// order is bound -> counter -> payload -> DECRYPT -> author -> domain -> roster,
// so a decrypt failure sits AFTER the attempt counter: a rotation would have
// spent real students' attempts and locked them out of a mode whose entire
// purpose is letting them in.
//
// Why this is the fix rather than adding a kid to the wire format: holding
// several keys and trying each needs no wire change and no SPA change, so
// nothing in flight notices. A kid would have needed a v2 format, a transition
// window where both are accepted, and a matching SPA deploy - a much larger
// change to the one path that must not break.
//
// Everything here uses the REAL crypto. `encryptClaim` is async, so payloads
// are sealed with top-level await: a CLAIM_PAYLOAD holding a Promise
// stringifies to "[object Promise]", decrypts as garbage, and would quietly
// turn a rotation test into an unreadable-payload test that still passes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  claimPrivateKeys,
  decryptClaim,
  decryptClaimWithAnyKey,
  encryptClaim,
  generateClaimKeypair,
} from "../lib/claim.mjs";

const OLD = await generateClaimKeypair();
const NEW = await generateClaimKeypair();

const sealedToOld = await encryptClaim({
  publicKey: OLD.publicKey,
  email: "student.one@student.pxl.be",
  githubId: 71908551,
  assignmentId: "2526-demo",
});
const sealedToNew = await encryptClaim({
  publicKey: NEW.publicKey,
  email: "student.two@student.pxl.be",
  githubId: 71908552,
  assignmentId: "2526-demo",
});

test("the key list is current-first, de-duplicated, and drops blanks", () => {
  // An unset secret is "", and attempting it would throw on every single claim.
  assert.deepEqual(claimPrivateKeys("A", "B\nC"), ["A", "B", "C"]);
  assert.deepEqual(claimPrivateKeys("A", "A"), ["A"], "a key listed twice is tried once");
  assert.deepEqual(claimPrivateKeys("", ""), [], "nothing configured is an empty list, not ['']");
  assert.deepEqual(claimPrivateKeys("  A  ", " , B ,, "), ["A", "B"], "commas and whitespace both separate");
  assert.deepEqual(claimPrivateKeys(undefined, undefined), [], "absent env vars must not throw");
});

test("a rotation keeps opening claims sealed to the OLD key", async () => {
  // The whole point. New key is current, old key is retired but still held.
  const keys = claimPrivateKeys(NEW.privateKey, OLD.privateKey);

  const old = await decryptClaimWithAnyKey({ privateKeys: keys, payload: sealedToOld });
  assert.equal(old.email, "student.one@student.pxl.be");
  assert.equal(old.githubId, 71908551);

  const fresh = await decryptClaimWithAnyKey({ privateKeys: keys, payload: sealedToNew });
  assert.equal(fresh.email, "student.two@student.pxl.be");
});

test("without the retired key, the pre-rotation claim is lost - which is what this prevents", async () => {
  // Proves the test above is testing something. This is exactly the state a
  // rotation would have produced before `claim-private-keys-retired` existed,
  // and the student would have paid an attempt for it.
  await assert.rejects(
    () => decryptClaimWithAnyKey({ privateKeys: [NEW.privateKey], payload: sealedToOld }),
    /could not be decrypted/,
  );
  await assert.rejects(
    () => decryptClaim({ privateKey: NEW.privateKey, payload: sealedToOld }),
    "the single-key path must fail too, or the rotation hazard would not be real",
  );
});

test("no configured key is refused, and is not reported as a bad ciphertext", async () => {
  await assert.rejects(
    () => decryptClaimWithAnyKey({ privateKeys: [], payload: sealedToNew }),
    /no claim private key is configured/,
    "a deployment fault must be distinguishable IN THE LOG from a student's bad payload",
  );
});

test("every failure a student can cause is ONE failure", async () => {
  // Naming the distinctions describes the crypto to whoever is probing it, and
  // none of them is actionable by a student who simply mistyped. In particular
  // "none of the keys matched" must not be tellable from "this ciphertext is
  // broken" - that would leak whether a rotation had happened.
  const keys = [NEW.privateKey, OLD.privateKey];

  // The tamper has to actually CHANGE something. This was
  // `sealedToOld.replace(/.$/, "A")`, a no-op whenever the ciphertext already
  // ends in "A" - which is not the rare accident it looks like. The sealed
  // length leaves four spare bits in the final base64url character, so only
  // FOUR canonical last characters are possible and "A" is one of them:
  // measured, 83 of 300 fresh ciphertexts, about one in four. The test passed
  // locally and reported SUCCEEDED in CI for a payload nobody had modified.
  //
  // Same family as the canonical-base64url rule this repo keeps rediscovering -
  // the last character carries bits that decode to nothing, so reasoning about
  // it as if every character were significant is wrong in both directions.
  // Flipping to a character that is definitely different removes the coin toss.
  const flipLast = (s) => s.slice(0, -1) + (s.endsWith("A") ? "B" : "A");
  const tampered = flipLast(sealedToOld);
  assert.notEqual(tampered, sealedToOld, "the tamper must modify the payload, or this proves nothing");

  const messages = [];
  for (const payload of [
    tampered,
    "c1.not.base64url.at-all",
    "c9." + sealedToNew.slice(3), // unknown version
    "garbage",
    "", // absent
  ]) {
    try {
      await decryptClaimWithAnyKey({ privateKeys: keys, payload });
      messages.push("SUCCEEDED");
    } catch (err) {
      messages.push(err.message);
    }
  }
  assert.deepEqual(
    [...new Set(messages)],
    ["claim payload could not be decrypted"],
    `every tampering must be indistinguishable, got: ${JSON.stringify(messages)}`,
  );
});

test("accept.mjs reads both keys, and neither surface was left on the single-key call", () => {
  // There are two claim paths - the `claim` gate and the `open` observation -
  // and they are 150 lines apart. Updating one and not the other would leave
  // rotation half-working: enforced cohorts fine, open cohorts silently losing
  // the address they exist to record.
  const src = readFileSync(new URL("../acceptance/accept.mjs", import.meta.url), "utf8").replace(
    /\/\/[^\n]*/g,
    "",
  );
  const calls = [...src.matchAll(/decryptClaim(WithAnyKey)?\(/g)].map((m) => m[0]);
  assert.equal(calls.length, 2, `expected both claim paths, found ${calls.length}`);
  assert.ok(
    calls.every((c) => c.startsWith("decryptClaimWithAnyKey")),
    "both paths must use the multi-key call, or a rotation breaks one of them",
  );
  assert.equal(
    [...src.matchAll(/CLAIM_PRIVATE_KEYS_RETIRED/g)].length,
    2,
    "both paths must read the retired keys",
  );
});

