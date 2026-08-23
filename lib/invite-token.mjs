// PXL Classroom - signed invitation tokens (Node half).
//
// Acceptance is triggered by a public event on a public repository, so anyone
// can ring the doorbell. A signed token is what makes ringing it cost nothing:
// the broker verifies the signature BEFORE it mints an App token, so a caller
// without a valid token never reaches a credential, a hub run, or a clone of
// the private control repo.
//
// The verifier is a PUBLIC repository, which is why this is asymmetric. An HMAC
// would put the minting secret on every broker; Ed25519 puts only the public
// half there, and a public key is public by definition. Encryption would be the
// wrong primitive - the broker cannot hold a decryption key either, and on a
// public channel ciphertext replays exactly as well as plaintext.
//
// The token is NOT a secret in the sharing sense. Anyone the link reaches can
// accept, which is an accepted risk bounded by max_acceptances and closing the
// assignment (ARCHITECTURE §15). What it prevents is an outsider who never had
// the link causing work to happen.
//
// Node builtins only: the broker runs this straight from a hub checkout with no
// `npm ci`, which keeps the supply-chain surface on a credential-bearing public
// repository at zero. The wire format lives in invite-token-format.mjs so the
// SPA can share it without bundling node:crypto.

import { createHash, createPublicKey, createPrivateKey, sign, verify, generateKeyPairSync, randomBytes } from "node:crypto";

import {
  TOKEN_VERSION,
  NONCE_BYTES,
  b64urlEncode,
  subjectInput,
  subjectFromDigest,
  subjectsMatch,
  encodePayload,
  parseToken,
  inviteFileName,
} from "./invite-token-format.mjs";

export {
  TOKEN_VERSION,
  TOKEN_PATTERN,
  encodePayload,
  decodePayload,
  parseToken,
  inviteFileName,
} from "./invite-token-format.mjs";

/** Pages filename carrying this token's assignment metadata. */
export function inviteFileFor(token) {
  return inviteFileName(createHash("sha256").update(String(token)).digest());
}

export function subjectFor(org, assignmentId) {
  return subjectFromDigest(createHash("sha256").update(subjectInput(org, assignmentId)).digest());
}

export function newNonce() {
  return randomBytes(NONCE_BYTES).toString("hex");
}

export function generateKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    publicKeyBase64: publicKey.export({ format: "jwk" }).x,
  };
}

function publicKeyFrom(base64url) {
  return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: base64url }, format: "jwk" });
}

export function signInviteToken({ org, assignmentId, expiresAt, nonce, kid = 1, privateKeyPem }) {
  const payload = encodePayload({ kid, subject: subjectFor(org, assignmentId), expiresAt, nonce });
  const signature = sign(null, payload, createPrivateKey(privateKeyPem));
  return `${b64urlEncode(payload)}.${b64urlEncode(signature)}`;
}

// Returns { ok, reason } rather than throwing: the broker turns a failure into
// a clean exit, and the reason is what tells a lecturer whether a student hit
// an expired link or a regenerated one.
export function verifyInviteToken(token, { org, assignmentId, nonce, publicKeys, now = new Date() } = {}) {
  const parsed = parseToken(token);
  if (!parsed) return { ok: false, reason: "malformed" };
  if (!parsed.canonical) return { ok: false, reason: "non-canonical" };

  const { payload, payloadBytes, signatureBytes } = parsed;
  if (payload.version !== TOKEN_VERSION) return { ok: false, reason: "unsupported-version" };

  const keyMaterial = publicKeys?.[String(payload.kid)];
  if (!keyMaterial) return { ok: false, reason: "unknown-key" };

  // Signature first: everything below leaks a little about the claim set, and
  // an unsigned claim set has earned no answers.
  let signatureValid = false;
  try {
    signatureValid = verify(null, payloadBytes, publicKeyFrom(keyMaterial), signatureBytes);
  } catch {
    return { ok: false, reason: "bad-signature" };
  }
  if (!signatureValid) return { ok: false, reason: "bad-signature" };

  if (!subjectsMatch(payload.subject, subjectFor(org, assignmentId))) {
    return { ok: false, reason: "wrong-assignment" };
  }

  if (payload.expiresAt.getTime() <= new Date(now).getTime()) {
    return { ok: false, reason: "expired" };
  }

  // A regenerated link rotates the broker's nonce, which retires every token
  // issued before it without touching the signing key.
  //
  // Fails CLOSED. This used to be `if (nonce && ...)`, so a broker whose
  // INVITE_NONCE variable was missing - a publish that died between creating the
  // repo and setting its variables, or a repo recreated by hand - accepted every
  // token ever issued for that assignment, including the ones a
  // regenerate_invite had just retired. Revocation is the only thing the nonce
  // is for; "absent" must not mean "accept anything".
  //
  // Trimmed because the value arrives from a repository variable that a human
  // can edit. A trailing newline there rejected every live link with the
  // deliberately generic "not valid, or no longer current" message, which is
  // unusually hard to diagnose from the student's side.
  const expected = typeof nonce === "string" ? nonce.trim().toLowerCase() : "";
  if (!expected) return { ok: false, reason: "no-nonce" };
  if (payload.nonce !== expected) return { ok: false, reason: "superseded" };

  return { ok: true, reason: "valid", payload };
}
