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

import { toBase64Url, fromBase64Url, B64URL_ERRORS } from "../lib/base64url.mjs";
import { parseToken, TOKEN_PATTERN } from "../lib/invite-token-format.mjs";

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

// --- why the failures are told apart -----------------------------------------
//
// lib/invite-token-format.mjs was the last of the three modules that had its own
// base64url pair; the acceptance signature and the claim had already migrated.
// Merging it needed one thing this module did not offer: parseToken answers
// `null` for "not a token" and `{ canonical: false }` for "a token with a second
// valid spelling", and those are different things to tell a student - the link
// is invalid, not broken. A branch keyed on the error MESSAGE would break the
// first time anyone improved the wording, so the reason is a code.

test("a decode failure says which kind it was", () => {
  const canonical = toBase64Url(bytes(26, 9));

  // Not base64url at all.
  assert.equal(tryCode(() => fromBase64Url("AA+A")), B64URL_ERRORS.MALFORMED);
  assert.equal(tryCode(() => fromBase64Url(null)), B64URL_ERRORS.MALFORMED);
  // A length the alphabet cannot produce - atob throws, Buffer is lenient, and
  // both runtimes must report the same thing.
  assert.equal(tryCode(() => fromBase64Url("A")), B64URL_ERRORS.MALFORMED);

  // Decodes, but not to the size the caller demanded.
  assert.equal(tryCode(() => fromBase64Url(canonical, { expectedBytes: 64 })), B64URL_ERRORS.LENGTH);

  // Decodes to the right size, spelled a second way.
  const dirty = secondSpelling(canonical);
  assert.notEqual(dirty, canonical);
  assert.equal(tryCode(() => fromBase64Url(dirty, { expectedBytes: 26 })), B64URL_ERRORS.NON_CANONICAL);
});

test("parseToken still separates a bad token from a second spelling of a good one", () => {
  // The behaviour the merge had to preserve, asserted here rather than only
  // through the token suite - this file owns the decoder those answers rest on.
  const payload = toBase64Url(bytes(26, 4));
  const signature = toBase64Url(bytes(64, 5));
  const token = `${payload}.${signature}`;
  assert.ok(TOKEN_PATTERN.test(token), "fixture must look like a token");

  const good = parseToken(token);
  assert.equal(good?.canonical, true);

  assert.deepEqual(
    parseToken(`${secondSpelling(payload)}.${signature}`),
    { canonical: false },
    "a second spelling of the payload is reported, not rejected",
  );
  assert.deepEqual(
    parseToken(`${payload}.${secondSpelling(signature)}`),
    { canonical: false },
    "and of the signature",
  );

  assert.equal(parseToken("not-a-token"), null);
  assert.equal(parseToken(`${payload}.${signature.slice(0, 40)}`), null, "wrong shape is null, not canonical:false");
});

function tryCode(fn) {
  try { fn(); } catch (err) { return err.code ?? `NO CODE: ${err.message}`; }
  throw new Error("expected a throw");
}

/**
 * The same bytes, spelled differently.
 *
 * The trailing character carries bits the decode discards, and HOW MANY depends
 * on the length: 26 bytes in 35 chars leaves 2 spare bits, 64 bytes in 86 chars
 * leaves 4. So "change the last character" is not a mutation - it usually
 * produces a different, perfectly canonical value, which is how the first draft
 * of this test asserted the wrong thing. Incrementing WITHIN the group of
 * alphabet indices that share the significant bits is the actual second
 * spelling.
 */
const B64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
function secondSpelling(encoded) {
  const bits = encoded.length * 6 - Math.floor((encoded.length * 6) / 8) * 8;
  assert.ok(bits > 0, `${encoded.length} chars leaves no spare bits to vary`);
  const group = 2 ** bits; // indices sharing the significant bits
  const last = B64URL_ALPHABET.indexOf(encoded.at(-1));
  const sibling = Math.floor(last / group) * group + ((last % group) + 1) % group;
  return encoded.slice(0, -1) + B64URL_ALPHABET[sibling];
}

test("encoding is stable, so a digest of it is stable", () => {
  // The acceptance card is named sha256(secret); an unstable encoding would
  // rename the file the student's link resolves to.
  const b = bytes(64, 3);
  assert.equal(toBase64Url(b), toBase64Url(b));
  assert.equal(toBase64Url(b), toBase64Url(Uint8Array.from(b)));
  assert.equal(toBase64Url(b), toBase64Url(b.buffer.slice(0)), "an ArrayBuffer encodes identically");
});
