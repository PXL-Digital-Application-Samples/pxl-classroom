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

// ONE base64url, in lib/base64url.mjs.
//
// This module had its own `b64urlEncode`/`b64urlDecode` pair, and it was the
// last of the three the shared module was written to replace - the acceptance
// signature and the claim migrated, this did not. Both did the same job, but
// only one of them refused a non-canonical spelling, and canonicality is the
// whole point on a wire where the string itself is compared.
//
// Dependency-free, so importing it keeps the promise below: the broker runs
// this file's import graph with no `npm ci`, and a bare specifier anywhere in
// it is a total outage.
import { toBase64Url, fromBase64Url, B64URL_ERRORS } from "./base64url.mjs";

export const TOKEN_VERSION = 1;
export const PAYLOAD_BYTES = 26;
export const SUBJECT_BYTES = 16;
export const NONCE_BYTES = 4;
// Internal: parseToken checks it. Not exported - the wire shape is TOKEN_PATTERN.
const SIGNATURE_BYTES = 64;

export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{35}\.[A-Za-z0-9_-]{86}$/;

// The wire contract, re-exported: lib/invite-token.mjs signs through it, and
// the encoding is part of what this module defines.
export { toBase64Url as b64urlEncode };

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

  // 26 and 64 bytes do not divide into 6-bit groups, so the last character of
  // each part carries spare bits that decoding throws away. Without that check
  // several distinct strings decode to the same token - one link with many
  // spellings, and a character you can change with no effect. `fromBase64Url`
  // performs it (decode, re-encode, compare) and REFUSES rather than reporting,
  // which is right for its other callers and not for this one: a token with a
  // second valid spelling is a different answer from a token that is not a
  // token, and a student must be told the link is invalid rather than broken.
  // Hence the code, rather than a branch on the error's wording.
  let payloadBytes;
  let signatureBytes;
  try {
    payloadBytes = fromBase64Url(payloadPart, { expectedBytes: PAYLOAD_BYTES });
    signatureBytes = fromBase64Url(signaturePart, { expectedBytes: SIGNATURE_BYTES });
  } catch (err) {
    return err?.code === B64URL_ERRORS.NON_CANONICAL ? { canonical: false } : null;
  }

  let payload;
  try {
    payload = decodePayload(payloadBytes);
  } catch {
    return null;
  }
  return { canonical: true, payload, payloadBytes, signatureBytes };
}

// Public Pages filename for an assignment's student-facing metadata.
//
// Named by the DIGEST of the token, not the token: Pages serves no directory
// listing, but a filename that leaked from a log or a cache would otherwise be
// a working invitation. A digest cannot be replayed as one.
//
// Both halves supply their own sha256 - Node's createHash, the browser's
// WebCrypto - so only the naming rule lives here.
export function inviteFileName(digest) {
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Where that card lives in the control repo: `public/i/<digest>.json`.
 *
 * The naming rule and the directory belong together - a caller holding a digest
 * wants the path, and splitting them means the next caller composes the `public/i/`
 * half itself. That is how the broker name reached ten spellings.
 *
 * @param {ArrayBuffer|Uint8Array} digest
 */
export function invitePath(digest) {
  return `public/i/${inviteFileName(digest)}.json`;
}

// --- How an invitation is spelled in an assignment document ------------------
//
// The three fields below are written by scripts/set-assignment-invite.mjs (line
// edits, so lecturer comments and key order survive a republish) and read back
// by the hub, the SPA's Admin Panel and the assignment detail view. They are the
// same three fields on both sides, so the WRITER and the READER live here
// together: the link has now broken three times because one half changed and
// the other did not, and a reader that cannot read what the writer just wrote
// is a lecturer holding an empty box.
//
// Regex rather than a YAML parser on purpose. This module is imported by
// lib/invite-token.mjs, which the broker runs straight from a hub checkout with
// no `npm ci` - a dependency here would put npm on a credential-bearing public
// repository. It also means the reader is line-based exactly like the writer,
// so tests/invitation-link-surface.test.mjs exercises the real round trip
// instead of two parsers that happen to agree today.

// Every field the Admin Panel must carry through a save. buildDoc rebuilds an
// assignment field by field, so anything missing from this list is DELETED on
// the next edit - which is exactly how editing a published assignment used to
// wipe its invitation and silently retire every student's link. Adding a field
// to the document without adding it here repeats that bug.
//
// invite_key / invite_pubkey are the signed-acceptance keypair (ARCHITECTURE
// §4.3.2). The private half is the link secret; the public half is copied to
// the broker as INVITE_PUBKEY. invite_token is retained for assignments that
// have not migrated, and to keep an out-of-date link resolvable to a page that
// says so.
export const INVITE_FIELDS = [
  "invite_token",
  "invite_nonce",
  "invite_expires_at",
  "invite_key",
  "invite_pubkey",
];

/**
 * One `key: value` line out of an assignment document.
 *
 * Tolerates CRLF (a control repo edited on Windows) and surrounding quotes
 * (invite_nonce is written quoted - see quoteInviteValue).
 *
 * @returns the value, or "" when the key is absent.
 */
export function readInviteField(text, key) {
  if (typeof text !== "string") return "";
  const m = text.match(new RegExp(`^${key}:[ \t]*(.*)$`, "m"));
  if (!m) return "";
  return m[1].trim().replace(/^["']|["']$/g, "");
}

/**
 * The secret that goes in an invitation link.
 *
 * `invite_key` once the assignment has migrated to signed acceptance,
 * `invite_token` while it has not. One reader, because "which of these two is
 * the link" is a rule three surfaces need - InvitationShare, AdminView and the
 * Pages generator - and three copies of it would drift the first time a fourth
 * appeared.
 *
 * Takes either a parsed field bag or an assignment document; both carry the
 * same key names.
 */
export function linkSecretFrom(fields) {
  return fields?.invite_key || fields?.invite_token || "";
}

/** All the invitation fields, absent ones as "". */
export function parseInviteFields(text) {
  const out = {};
  for (const key of INVITE_FIELDS) out[key] = readInviteField(text, key);
  return out;
}

/**
 * How a value is written back.
 *
 * invite_nonce is 8 hex characters, so roughly one in forty is all digits - and
 * an all-digit nonce with a leading zero (`01234567`) round-trips through a
 * YAML parser as the integer 1234567, losing the zero. The hub then reads seven
 * characters, fails its `^[0-9a-f]{8}$` check, decides no usable nonce exists
 * and mints a fresh one - silently retiring every link already handed out, on a
 * republish whose whole contract is that it does not. Quoting costs two
 * characters and removes the class.
 */
export function quoteInviteValue(key, value) {
  const text = String(value ?? "");
  return key === "invite_nonce" ? `"${text}"` : text;
}
