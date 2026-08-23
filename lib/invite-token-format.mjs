// PXL Classroom - invitation token wire format.
//
// Isomorphic and crypto-free, so the SPA can bundle it. lib/invite-token.mjs
// adds Node's crypto for signing and verification; the browser supplies its own
// digest via WebCrypto. Everything they must AGREE on lives here - the byte
// layout, the base64url spelling, and above all the subject rule. A second copy
// of "first 16 bytes of sha256(<org lowercased>/<id>)" anywhere else is a token
// format that silently forks in half.
//
//   [0]      version
//   [1]      key id
//   [2..17]  subject
//   [18..21] expiry, minutes since the Unix epoch, big-endian
//   [22..25] nonce, matched against the broker's INVITE_NONCE variable
//
// 26 bytes -> 35 base64url chars, plus a 64-byte signature -> 86, plus the
// separator = 122. That fits in a GitHub issue title (256), which is what lets
// the broker read the token without ever touching the issue body.

export const TOKEN_VERSION = 1;
export const PAYLOAD_BYTES = 26;
export const SUBJECT_BYTES = 16;
export const NONCE_BYTES = 4;
export const SIGNATURE_BYTES = 64;

export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{35}\.[A-Za-z0-9_-]{86}$/;

// Buffer in Node, atob/btoa in the browser - the same trick lib/gittree.mjs
// uses to stay carrier-agnostic.
export function b64urlEncode(bytes) {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64url");
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(text) {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(padded, "base64"));
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

// Case is normalised because GitHub org names are case-insensitive: a lecturer
// typing PXLautomation must not mint a token no broker accepts.
export function subjectInput(org, assignmentId) {
  return `${String(org).toLowerCase()}/${String(assignmentId)}`;
}

export function subjectFromDigest(digest) {
  return new Uint8Array(digest).slice(0, SUBJECT_BYTES);
}

export function subjectsMatch(a, b) {
  if (!a || !b || a.length !== SUBJECT_BYTES || b.length !== SUBJECT_BYTES) return false;
  return a.every((byte, i) => byte === b[i]);
}

export function encodePayload({ version = TOKEN_VERSION, kid, subject, expiresAt, nonce }) {
  if (!Number.isInteger(kid) || kid < 1 || kid > 255) throw new Error("kid must be 1..255");
  if (!(subject instanceof Uint8Array) || subject.length !== SUBJECT_BYTES) {
    throw new Error(`subject must be ${SUBJECT_BYTES} bytes`);
  }
  // Round up: minute granularity must never retire a link before the instant
  // the lecturer asked for.
  const expMinutes = Math.ceil(new Date(expiresAt).getTime() / 60000);
  if (!Number.isFinite(expMinutes) || expMinutes < 0 || expMinutes > 0xffffffff) {
    throw new Error(`expiresAt "${expiresAt}" is out of range`);
  }
  if (typeof nonce !== "string" || !/^[0-9a-f]{8}$/i.test(nonce)) {
    throw new Error(`nonce must be 8 hex characters, got "${nonce}"`);
  }
  const out = new Uint8Array(PAYLOAD_BYTES);
  out[0] = version;
  out[1] = kid;
  out.set(subject, 2);
  new DataView(out.buffer).setUint32(18, expMinutes, false);
  for (let i = 0; i < NONCE_BYTES; i++) {
    out[22 + i] = parseInt(nonce.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function decodePayload(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== PAYLOAD_BYTES) {
    throw new Error("payload is not the expected length");
  }
  let nonce = "";
  for (let i = 22; i < 26; i++) nonce += bytes[i].toString(16).padStart(2, "0");
  return {
    version: bytes[0],
    kid: bytes[1],
    subject: bytes.slice(2, 18),
    expiresAt: new Date(
      new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(18, false) * 60000
    ),
    nonce,
  };
}

// Splits and decodes without verifying anything. Returns null for input that is
// not a token at all, so callers do not have to re-implement the shape check.
export function parseToken(token) {
  if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) return null;
  const [payloadPart, signaturePart] = token.split(".");
  let payloadBytes;
  let signatureBytes;
  try {
    payloadBytes = b64urlDecode(payloadPart);
    signatureBytes = b64urlDecode(signaturePart);
  } catch {
    return null;
  }
  if (payloadBytes.length !== PAYLOAD_BYTES || signatureBytes.length !== SIGNATURE_BYTES) return null;

  // 26 and 64 bytes do not divide into 6-bit groups, so the last character of
  // each part carries spare bits that decoding throws away. Without this check
  // several distinct strings decode to the same token - one link with many
  // spellings, and a character you can change with no effect.
  if (b64urlEncode(payloadBytes) !== payloadPart || b64urlEncode(signatureBytes) !== signaturePart) {
    return { canonical: false };
  }

  let payload;
  try {
    payload = decodePayload(payloadBytes);
  } catch {
    return null;
  }
  return { canonical: true, payload, payloadBytes, signatureBytes };
}
