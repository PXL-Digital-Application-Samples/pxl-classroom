// Two wire formats share one vocabulary, at two incompatible sizes.
//
// `lib/acceptance-signature.mjs` (the signed acceptance, §4.3.2) and
// `lib/invite-token-format.mjs` (the legacy invite token) each declare
// SUBJECT_BYTES, each define `subjectsMatch`, and each carry an
// encodePayload/decodePayload pair. The names are identical, the modules sit
// side by side in lib/, and NOTHING pinned the difference - a sweep looking for
// duplicated logic finds two byte-identical-looking `subjectsMatch` bodies and
// merges them, which silently destroys one of the two formats.
//
// What makes it dangerous rather than merely untidy: both truncate the SAME
// sha256 of the SAME input, so the 8-byte digest is an exact PREFIX of the
// 16-byte one (measured, and asserted below). A merged implementation would
// therefore agree on every byte it compared. The LENGTH CHECK is the only thing
// holding the two formats apart, which is precisely the assertion a
// value-equality test would not make.
//
// Neither size is free to move. 8 bytes is what keeps a signed acceptance title
// inside the 256-character budget for a real assignment id (§4.3.2 - the JSON
// payload it replaced reached 253 characters before a team hint was appended);
// 16 is baked into invite-token-format's PAYLOAD_BYTES = 26 and into the
// 35-character token half of TOKEN_PATTERN.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { subjectDigest } from "../lib/acceptance-signature.mjs";
import {
  PAYLOAD_BYTES,
  SUBJECT_BYTES as TOKEN_SUBJECT_BYTES,
  subjectFromDigest,
  subjectInput,
  subjectsMatch as tokenSubjectsMatch,
} from "../lib/invite-token-format.mjs";

const ORG = "PXL-Automation-II";
const ID = "2526-examen-aut2-ek2";

async function fullDigest(text) {
  const bytes = new TextEncoder().encode(text);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

test("the two subject sizes are different ON PURPOSE", async () => {
  const subject = subjectInput(ORG, ID);
  const acceptance = await subjectDigest(subject);
  const token = subjectFromDigest(await fullDigest(subject));

  assert.equal(acceptance.length, 8, "a signed acceptance truncates to 8 bytes");
  assert.equal(token.length, 16, "an invite token truncates to 16");
  assert.equal(TOKEN_SUBJECT_BYTES, 16);
  assert.notEqual(
    acceptance.length,
    token.length,
    "if these ever become one number, one of the two wire formats has been broken",
  );

  // 16 bytes of subject is what makes the invite payload 26 bytes, which is what
  // makes the token's first half 35 base64url characters in TOKEN_PATTERN.
  assert.equal(PAYLOAD_BYTES, 26);
});

test("the short digest is a PREFIX of the long one, so only LENGTH separates them", async () => {
  const subject = subjectInput(ORG, ID);
  const acceptance = await subjectDigest(subject);
  const token = subjectFromDigest(await fullDigest(subject));

  // Same hash of the same input; the formats differ only in where they cut.
  assert.deepEqual(
    Array.from(token.slice(0, acceptance.length)),
    Array.from(acceptance),
    "both truncate the same sha256 - a merged comparison would agree on every byte it looked at",
  );
});

test("the token's subjectsMatch refuses a digest sized for the other format", async () => {
  const subject = subjectInput(ORG, ID);
  const acceptance = await subjectDigest(subject);
  const token = subjectFromDigest(await fullDigest(subject));

  assert.ok(tokenSubjectsMatch(token, token), "a real 16-byte subject still matches itself");

  // The whole point: an 8-byte prefix of the very same digest must NOT pass.
  assert.ok(
    !tokenSubjectsMatch(acceptance, token),
    "an acceptance-sized digest must never satisfy the token comparison",
  );
  assert.ok(!tokenSubjectsMatch(token, acceptance));
  assert.ok(!tokenSubjectsMatch(token.slice(0, 15), token), "a short subject is refused");
});

test("each module keeps its own SUBJECT_BYTES, and neither imports the other's", () => {
  // The merge this file exists to prevent would most likely arrive as one
  // module importing the other's constant or comparison. `acceptance-signature`
  // deliberately holds a private 8-byte copy.
  const sig = readSource("lib/acceptance-signature.mjs");
  const fmt = readSource("lib/invite-token-format.mjs");

  assert.match(sig, /const SUBJECT_BYTES = 8;/, "acceptance-signature declares its own 8");
  assert.match(fmt, /export const SUBJECT_BYTES = 16;/, "invite-token-format declares its own 16");

  assert.ok(
    !/from\s+["']\.\/invite-token-format\.mjs["']/.test(sig),
    "acceptance-signature must not take its subject vocabulary from the token format - the sizes differ",
  );
  assert.ok(
    !/from\s+["']\.\/acceptance-signature\.mjs["']/.test(fmt),
    "invite-token-format must not take its subject vocabulary from the acceptance format",
  );
});

function readSource(rel) {
  return readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", rel), "utf8");
}
