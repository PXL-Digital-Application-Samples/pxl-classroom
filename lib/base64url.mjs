// PXL Classroom - canonical base64url, in one place.
//
// Three modules in lib/ had their own encoder. Two of them - the acceptance
// signature and the claim - encode the same kind of thing (raw bytes on a
// public wire, compared for equality), and they had already drifted: the
// signature guards `typeof btoa === "function"` with a Buffer fallback, the
// claim called btoa directly and would throw wherever it is absent.
//
// CANONICALITY IS THE POINT, not convenience. A base64url string is compared
// byte-for-byte on both of these paths, and 26- and 64-byte payloads do not
// divide evenly into 6-bit groups - so the final character carries bits that
// are discarded on decode, and several spellings decode to the same value.
// Without the round-trip check below one invitation link had several valid
// spellings. Anything that reaches a signature check, a digest, or a filename
// must therefore have exactly one encoding.
//
// Isomorphic and dependency-free: Node and the browser both reach it, and
// lib/invite-token-format.mjs must stay importable by a broker running without
// `npm ci`.

const B64URL_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Why a decode failed, machine-readable.
 *
 * `fromBase64Url` throws for three different reasons and some callers have to
 * tell them apart. `lib/invite-token-format.mjs` is the one that made this
 * necessary: an invitation token that is not base64url at all is `null`
 * ("malformed"), while one that decodes but is spelled non-canonically is
 * `{ canonical: false }` - a DIFFERENT answer, because it means the link has a
 * second valid spelling and the student should be told it is not valid rather
 * than that it is broken.
 *
 * A code rather than matching on the message: the message is for a human, and a
 * branch keyed on its wording breaks the first time anyone improves it.
 */
export const B64URL_ERRORS = Object.freeze({
  MALFORMED: "base64url:malformed",
  LENGTH: "base64url:length",
  NON_CANONICAL: "base64url:non-canonical",
});

function decodeError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/** Bytes -> canonical base64url, unpadded. */
export function toBase64Url(bytes) {
  let binary = "";
  for (const b of new Uint8Array(bytes)) binary += String.fromCharCode(b);
  const b64 =
    typeof btoa === "function" ? btoa(binary) : Buffer.from(binary, "binary").toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Canonical base64url -> bytes.
 *
 * Rejects a non-canonical spelling rather than accepting it, because the
 * callers compare the STRING: a value with two valid encodings breaks equality
 * on a path where equality is the whole check.
 *
 * @param {string} text
 * @param {{ expectedBytes?: number|null }} opts
 */
export function fromBase64Url(text, { expectedBytes = null } = {}) {
  if (typeof text !== "string" || !text || !B64URL_RE.test(text)) {
    throw decodeError("not base64url", B64URL_ERRORS.MALFORMED);
  }
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  let binary;
  try {
    binary =
      typeof atob === "function"
        ? atob(padded + "=".repeat((4 - (padded.length % 4)) % 4))
        : Buffer.from(padded, "base64").toString("binary");
  } catch {
    // `atob` throws on a length the alphabet cannot produce (n % 4 === 1);
    // Buffer is lenient and returns fewer bytes, which the round-trip below
    // catches instead. Normalised so both runtimes report the same thing.
    throw decodeError("not base64url", B64URL_ERRORS.MALFORMED);
  }
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));

  if (expectedBytes !== null && bytes.length !== expectedBytes) {
    throw decodeError(`expected ${expectedBytes} bytes, got ${bytes.length}`, B64URL_ERRORS.LENGTH);
  }
  if (toBase64Url(bytes) !== text) {
    throw decodeError("non-canonical base64url", B64URL_ERRORS.NON_CANONICAL);
  }
  return bytes;
}
