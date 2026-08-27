// The one canonical base64url, tested directly.
//
// lib/base64url.mjs sits under the acceptance signature, the invite token and
// the claim - every path where a string is compared byte-for-byte to decide
// whether a request is authorised. It had no test importing it: the round trips
// above it exercised the happy path, and nothing exercised the property the
// module exists for.
//
// That property is CANONICALITY. 26- and 64-byte payloads do not divide evenly
// into 6-bit groups, so the final character carries bits that are discarded on
// decode, and several spellings decode to the same bytes. Without the
// round-trip check, one invitation link had several valid spellings - and a
// filename derived from the string (the acceptance card is named
// sha256(secret)) would differ for each of them.
import { test } from "node:test";
import assert from "node:assert/strict";

import { toBase64Url, fromBase64Url } from "../lib/base64url.mjs";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function bytes(n, seed = 7) {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (i * 31 + seed * 17) & 0xff;
  return out;
}

test("round-trips the real payload sizes", () => {
  // 26 = the acceptance payload, 64 = a signature, 16/8 = the two subject sizes.
  for (const n of [1, 8, 16, 26, 32, 64, 184]) {
    const b = bytes(n);
    const text = toBase64Url(b);
    assert.match(text, /^[A-Za-z0-9_-]+$/, `${n} bytes must encode to base64url`);
    assert.ok(!text.includes("="), "unpadded");
    assert.deepEqual(Array.from(fromBase64Url(text)), Array.from(b), `${n} bytes must round-trip`);
  }
});

test("a non-canonical spelling of the SAME bytes is refused", () => {
  // 26 bytes = 208 bits. 208/6 = 34 whole groups + 4 bits, so the 35th character
  // carries 4 significant bits and 2 discarded ones: four characters decode to
  // an identical payload. Exactly one of them may be accepted.
  const b = bytes(26);
  const canonical = toBase64Url(b);
  assert.equal(canonical.length, 35, "the acceptance payload is 35 base64url characters");

  const lastIdx = ALPHABET.indexOf(canonical[canonical.length - 1]);
  assert.ok(lastIdx >= 0);

  let variants = 0;
  for (let k = 0; k < 4; k++) {
    const altIdx = (lastIdx & ~3) + k;
    if (altIdx === lastIdx) continue;
    const alt = canonical.slice(0, -1) + ALPHABET[altIdx];
    variants++;

    // It really does decode to the same bytes - that is what makes it dangerous.
    const padded = alt.replace(/-/g, "+").replace(/_/g, "/");
    const raw = Buffer.from(padded, "base64");
    assert.deepEqual(Array.from(raw), Array.from(b), `${alt} must decode to the same payload`);

    // And it must still be refused, because the callers compare the STRING.
    assert.throws(
      () => fromBase64Url(alt),
      /non-canonical/,
      `a second spelling of the same payload must be refused: ${alt}`,
    );
  }
  assert.equal(variants, 3, "there should be three rival spellings of the last character");
});

test("expectedBytes is enforced, and reported as a length", () => {
  const b = bytes(26);
  const text = toBase64Url(b);
  assert.doesNotThrow(() => fromBase64Url(text, { expectedBytes: 26 }));
  assert.throws(() => fromBase64Url(text, { expectedBytes: 16 }), /expected 16 bytes, got 26/);
});

test("standard base64 is not base64url, and neither is padding", () => {
  // `+` and `/` decode fine in base64 but must not be accepted here: the wire
  // format is URL-safe, and admitting both alphabets is a second spelling again.
  for (const bad of ["AA+A", "AA/A", "AAAA=", "AA A", "AA.A", "", "  "]) {
    assert.throws(() => fromBase64Url(bad), /not base64url|non-canonical/, `must refuse ${JSON.stringify(bad)}`);
  }
});

test("a non-string is refused rather than coerced", () => {
  for (const bad of [null, undefined, 42, {}, [], true]) {
    assert.throws(() => fromBase64Url(bad), /not base64url/, `must refuse ${JSON.stringify(bad)}`);
  }
});

test("encoding is stable, so a digest of it is stable", () => {
  // The acceptance card is named sha256(secret); an unstable encoding would
  // rename the file the student's link resolves to.
  const b = bytes(64, 3);
  assert.equal(toBase64Url(b), toBase64Url(b));
  assert.equal(toBase64Url(b), toBase64Url(Uint8Array.from(b)));
  assert.equal(toBase64Url(b), toBase64Url(b.buffer.slice(0)), "an ArrayBuffer encodes identically");
});
