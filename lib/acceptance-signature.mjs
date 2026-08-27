// PXL Classroom - proving an acceptance without publishing a credential.
//
// THE PROBLEM THIS EXISTS FOR, measured live on 2026-08-25:
//
//   curl -s https://api.github.com/repos/<org>/<broker>/events
//   -> HTTP 200, unauthenticated, and the response contained
//      "pxl-accept:AQFQu79dno7AjwhnJix7..." - a full, still-valid invitation
//      token, on an issue that had ALREADY BEEN DELETED.
//
// Every acceptance opens an issue on the public broker, GitHub emits an
// `IssuesEvent`, and that event carries the title and body. ARCHITECTURE §4.3.3
// answers this with redaction, deletion and a sweep - and all three are after
// the fact, because the `opened` event already went out. GH Archive mirrors the
// same firehose into a permanent public dataset, so rotation kills a token but
// can never unpublish it.
//
// Hiding the token is not available: every student-initiated trigger on a
// public repository emits a public event, and there is no private transport
// without self-hosting. So the fix is to make what lands in the event
// INSUFFICIENT ON ITS OWN.
//
// The old token was a BEARER credential - possession was enough. Here the link
// carries a PRIVATE KEY, and the student signs a fresh assertion naming their
// own account. What reaches the public event is a signature over "github_id 123
// accepted assignment X". Reusing it requires being account 123; forging one
// requires the key, which never appears in any event.
//
// ECDSA P-256, not Ed25519. Verified 2026-08-25: Ed25519 reached WebCrypto in
// Firefox 130, Safari 17 and Chrome 137 (May 2026) - roughly 79% of users, so
// one student in five would simply fail. P-256 is universal in browsers and in
// Node's crypto.subtle, which lets this one module serve the SPA, the broker
// and the hub. Ed25519 stays on the Node-only paths it already owns.

import { toBase64Url, fromBase64Url } from "./base64url.mjs";

// Re-exported: the broker, the SPA and the hub have imported these from here
// since before the shared module existed, and the encoding is part of this
// module's wire contract.
export { toBase64Url, fromBase64Url };

const SUBTLE = globalThis.crypto?.subtle;

/** GitHub caps an issue title at 256 characters (verified 2026-08-25). */
export const MAX_TITLE_LENGTH = 256;

/** The broker's job-level `if` matches this before a runner is allocated. */
export const TITLE_PREFIX = "pxl-accept:";

/**
 * Length of the base64url private key that rides in an invitation link.
 *
 * A PKCS#8 P-256 key is a fixed-size DER structure, so this is constant.
 * frontend/src/lib/invite.js matches on it, which is how a truncated link gets
 * told it is truncated instead of being sent to a page that can only report
 * "not found". generateAcceptanceKeypair asserts it.
 */
export const ACCEPTANCE_KEY_LENGTH = 184;

const ALG = { name: "ECDSA", namedCurve: "P-256" };
const SIGN_ALG = { name: "ECDSA", hash: "SHA-256" };

// --- canonical base64url ----------------------------------------------------
//
// A 32-byte scalar and a 64-byte signature do not divide into 6-bit groups, so
// the final character carries bits that decode to nothing and one key has
// several spellings. lib/invite-token.mjs learned this the hard way - a link
// that verified sometimes and not others - so the check is strict here from the
// start rather than added after the first support ticket.




/**
 * Whether this context can sign at all.
 *
 * `crypto.subtle` exists only in a secure context, and GitHub Pages is always
 * HTTPS - so in production this is always true and the check is for a local
 * `http://` dev server or a browser old enough to lack WebCrypto. It is worth
 * having anyway: without it the failure surfaces as a TypeError inside the card
 * fetch, which the student sees as "couldn't load the assignment data" -
 * pointing them at their connection when the cause is the page they are on.
 */
export function hasWebCrypto() {
  return Boolean(SUBTLE);
}

function requireSubtle() {
  if (!SUBTLE) {
    throw new Error(
      "Web Crypto is unavailable. The acceptance page needs it to sign; it requires a secure context (HTTPS).",
    );
  }
  return SUBTLE;
}

// --- keys -------------------------------------------------------------------

/**
 * Mint an assignment's acceptance keypair.
 *
 * The PRIVATE half goes into the invitation link and the control repo; the
 * PUBLIC half goes onto the broker as `INVITE_PUBKEY`, where it is not a secret
 * at all. Long links are fine - they are copied, never typed.
 */
export async function generateAcceptanceKeypair() {
  const subtle = requireSubtle();
  const pair = await subtle.generateKey(ALG, true, ["sign", "verify"]);
  const [pkcs8, spki] = await Promise.all([
    subtle.exportKey("pkcs8", pair.privateKey),
    subtle.exportKey("spki", pair.publicKey),
  ]);
  const privateKey = toBase64Url(pkcs8);
  const publicKey = toBase64Url(spki);

  // The link parser accepts exactly this length, so that a TRUNCATED link - an
  // email client wrapping a URL, a student copying half of it - is refused as
  // malformed rather than sent on to a page that can only say "not found".
  // Asserting it here is what stops the two drifting: if a platform ever
  // exports a different DER length, this throws at mint time instead of
  // silently minting links the parser will reject.
  if (privateKey.length !== ACCEPTANCE_KEY_LENGTH) {
    throw new Error(
      `acceptance private key is ${privateKey.length} base64url chars, expected ${ACCEPTANCE_KEY_LENGTH}`,
    );
  }
  return { privateKey, publicKey };
}

async function importPrivate(privateKeyB64) {
  return requireSubtle().importKey("pkcs8", fromBase64Url(privateKeyB64), ALG, false, ["sign"]);
}

async function importPublic(publicKeyB64) {
  return requireSubtle().importKey("spki", fromBase64Url(publicKeyB64), ALG, false, ["verify"]);
}

// --- payload ----------------------------------------------------------------
//
//   [0]       version
//   [1..8]    subject: the first 8 bytes of sha256(assignment id)
//   [9..14]   github id of the accepting account, 48-bit big-endian
//   [15..18]  nonce, so two acceptances by the same account differ
//
// 19 bytes -> 26 base64url chars, which makes the whole title 127 characters
// for a two-character kid, and 196 with the longest possible team hint.
//
// BINARY, AND MEASURED, because the JSON version did not fit. It carried the
// assignment id verbatim plus a full ISO-8601 `issuedAt`, and a realistic id -
// `2526-automation-scripting-practicum-exam-2` is a real one - produced a
// 253-character title before any team hint was appended. Adding one threw, so a
// group assignment was unacceptable for reasons the lecturer chose months
// earlier when naming it. `issuedAt` was the worst of it: 32 characters of a
// field verifyAcceptanceTitle documents as never enforced. It is gone.
//
// Hashing the subject is what removes the id-length dependency altogether. The
// digest is truncated to 8 bytes because it is not a security boundary - the
// keypair is per assignment, so a signature for another assignment cannot
// verify at all - it exists so a misconfigured broker gets `wrong-assignment`
// instead of `bad-signature` (RUNBOOK §1.3.2 makes a mismatched INVITE_PUBKEY a
// real deployment fault, and telling the two apart is the whole value).

export const PAYLOAD_VERSION = 1;
const PAYLOAD_BYTES = 19;
const SUBJECT_BYTES = 8;
/** GitHub's largest account id is ~2e8; 48 bits holds 2.8e14. */
const GITHUB_ID_BYTES = 6;
const NONCE_BYTES = 4;

/** The subject digest for an assignment id. Both halves must agree on this. */
export async function subjectDigest(subject) {
  if (typeof subject !== "string" || !subject) throw new Error("subject must be a non-empty string");
  const full = await requireSubtle().digest("SHA-256", new TextEncoder().encode(subject));
  return new Uint8Array(full).slice(0, SUBJECT_BYTES);
}

function encodePayload({ subjectBytes, githubId, nonceBytes }) {
  const id = Number(githubId);
  // A missing id used to sail through as `Number(undefined)` -> NaN -> JSON
  // `null`, minting a title that every broker rejects with a generic "this link
  // is not valid" - pointing the student at their link when the cause was their
  // session. Fail here, where the cause is still visible.
  if (!Number.isInteger(id) || id <= 0 || id > 2 ** (8 * GITHUB_ID_BYTES) - 1) {
    throw new Error(`github id ${JSON.stringify(githubId)} is not a usable GitHub account id`);
  }
  const out = new Uint8Array(PAYLOAD_BYTES);
  out[0] = PAYLOAD_VERSION;
  out.set(subjectBytes, 1);
  // No setUint48, so the high 16 bits and the low 32 are written separately.
  new DataView(out.buffer).setUint16(9, Math.floor(id / 2 ** 32), false);
  new DataView(out.buffer).setUint32(11, id >>> 0, false);
  out.set(nonceBytes, 15);
  return toBase64Url(out);
}

function decodePayload(encoded) {
  const bytes = fromBase64Url(encoded, { expectedBytes: PAYLOAD_BYTES });
  if (bytes[0] !== PAYLOAD_VERSION) throw new Error(`payload version ${bytes[0]} is not supported`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const githubId = view.getUint16(9, false) * 2 ** 32 + view.getUint32(11, false);
  if (!Number.isInteger(githubId) || githubId <= 0) throw new Error("payload has no usable github_id");
  return {
    version: bytes[0],
    subjectBytes: bytes.slice(1, 1 + SUBJECT_BYTES),
    githubId,
    nonce: Array.from(bytes.slice(15), (b) => b.toString(16).padStart(2, "0")).join(""),
  };
}

/** Two subject digests, compared without leaking a length difference. */
function subjectsMatch(a, b) {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array)) return false;
  if (a.length !== SUBJECT_BYTES || b.length !== SUBJECT_BYTES) return false;
  return a.every((byte, i) => byte === b[i]);
}

/**
 * Sign an acceptance. Returns the issue TITLE the SPA opens.
 *
 * `pxl-accept:<kid>.<payload>.<signature>` - the prefix is unchanged so the
 * broker's job-level `if` still short-circuits before a runner is allocated,
 * and the broker still never has to read the issue body.
 */
export async function signAcceptanceTitle({ privateKey, kid, subject, githubId, nonce }) {
  if (!kid || !/^[A-Za-z0-9_-]{1,32}$/.test(kid)) throw new Error("kid must be a short base64url token");
  if (typeof nonce !== "string" || !/^[0-9a-f]{8}$/i.test(nonce)) {
    throw new Error(`nonce must be ${NONCE_BYTES * 2} hex characters, got ${JSON.stringify(nonce)}`);
  }
  const nonceBytes = new Uint8Array(
    nonce.match(/../g).map((pair) => parseInt(pair, 16)),
  );
  const key = await importPrivate(privateKey);
  const payload = encodePayload({
    subjectBytes: await subjectDigest(subject),
    githubId,
    nonceBytes,
  });
  const signed = `${kid}.${payload}`;
  const signature = await requireSubtle().sign(
    SIGN_ALG,
    key,
    new TextEncoder().encode(signed),
  );
  const title = `${TITLE_PREFIX}${signed}.${toBase64Url(signature)}`;
  if (title.length > MAX_TITLE_LENGTH) {
    throw new Error(`acceptance title is ${title.length} chars, over the ${MAX_TITLE_LENGTH}-character budget`);
  }
  return title;
}

/**
 * Verify a title against the assignment's public key.
 *
 * Returns `{ ok: true, payload }` or `{ ok: false, reason }` - never throws for
 * a malformed title, because every value here is attacker-supplied and the
 * broker must answer "no" rather than crash on any of it.
 *
 * `issuedAt` is deliberately NOT enforced. A signature is already bound to one
 * account, so a stale one only lets that student accept again - which is
 * idempotent. Rejecting on time would add a clock-skew failure mode for no
 * security gain.
 */
export async function verifyAcceptanceTitle({ title, publicKey, expectedKid = null, expectedSubject = null }) {
  if (typeof title !== "string" || !title.startsWith(TITLE_PREFIX)) {
    return { ok: false, reason: "not-an-acceptance-title" };
  }
  if (title.length > MAX_TITLE_LENGTH) return { ok: false, reason: "title-too-long" };
  if (!publicKey) {
    // The INVITE_NONCE precedent: an absent value once meant "accept every
    // token ever issued". Absent here means reject, and say it is a deployment
    // fault rather than a forged title.
    return { ok: false, reason: "no-public-key" };
  }

  // THE TEAM HINT IS APPENDED AFTER SIGNING, and the broker hands this function
  // `github.event.issue.title` verbatim. Splitting the whole title on "." made
  // the signature part `<signature> team:alpha`, which is not base64url - so
  // EVERY group acceptance was rejected as malformed, on every group
  // assignment, while individual acceptance worked perfectly. Nothing caught it
  // because no test had ever verified a title carrying a hint.
  //
  // Taking the first whitespace-delimited token is the same cut the broker's
  // own bash regex makes. Trailing content is deliberately ignored rather than
  // rejected: the hint is a concurrency key, never an authoritative value
  // (§5.8), the hub re-derives the real team from the issue body, and
  // teamHintMatches refuses a hint that disagrees with it.
  const signedPart = title.slice(TITLE_PREFIX.length).split(/\s/)[0];

  const parts = signedPart.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [kid, payloadPart, signaturePart] = parts;

  if (expectedKid !== null && kid !== expectedKid) return { ok: false, reason: "wrong-kid" };

  let payload;
  let signature;
  try {
    payload = decodePayload(payloadPart);
    signature = fromBase64Url(signaturePart, { expectedBytes: 64 });
  } catch (err) {
    return { ok: false, reason: `malformed: ${err.message}` };
  }

  let key;
  try {
    key = await importPublic(publicKey);
  } catch {
    return { ok: false, reason: "no-public-key" };
  }

  let valid = false;
  try {
    valid = await requireSubtle().verify(
      SIGN_ALG,
      key,
      signature,
      new TextEncoder().encode(`${kid}.${payloadPart}`),
    );
  } catch {
    return { ok: false, reason: "bad-signature" };
  }
  if (!valid) return { ok: false, reason: "bad-signature" };

  // Checked AFTER the signature, so an unsigned caller learns nothing about
  // which assignment a broker serves, and only when the caller supplies an
  // expectation. With a per-assignment keypair a foreign signature cannot
  // verify at all, so this never fires on an attack - it fires on a broker
  // holding the wrong INVITE_PUBKEY, which RUNBOOK §1.3.2 names as a real
  // deployment fault. Telling that apart from `bad-signature` is the point.
  if (expectedSubject !== null) {
    let want;
    try {
      want = await subjectDigest(expectedSubject);
    } catch {
      return { ok: false, reason: "no-expected-subject" };
    }
    if (!subjectsMatch(payload.subjectBytes, want)) {
      return { ok: false, reason: "wrong-assignment" };
    }
  }

  return { ok: true, kid, payload };
}

/**
 * The anti-replay check, kept beside the verification it belongs to.
 *
 * A signature lifted from the public event names the account that made it.
 * Anyone replaying it is authoring the issue as themselves, so the two
 * disagree.
 *
 * Applied by the broker before it mints anything. The hub does NOT re-apply it,
 * and cannot: the dispatch carries a login and an id, never the title, so there
 * is no signature there to check. A comment here used to claim otherwise, which
 * is worse than the gap - it invites the broker's check to be relaxed on the
 * strength of a second one that does not exist.
 *
 * Both ids must be real account ids. `Number("")` and `Number(null)` are 0, so
 * without the lower bound an empty ISSUE_AUTHOR_ID would match a payload
 * claiming id 0.
 */
export function signerMatchesAuthor(payload, authorGithubId) {
  const author = Number(authorGithubId);
  if (!Number.isInteger(author) || author <= 0) return false;
  return Number.isInteger(payload?.githubId) && payload.githubId > 0 && payload.githubId === author;
}
