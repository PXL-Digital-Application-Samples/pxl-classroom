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

const SUBTLE = globalThis.crypto?.subtle;

/** GitHub caps an issue title at 256 characters (verified 2026-08-25). */
export const MAX_TITLE_LENGTH = 256;

/** The broker's job-level `if` matches this before a runner is allocated. */
export const TITLE_PREFIX = "pxl-accept:";

const ALG = { name: "ECDSA", namedCurve: "P-256" };
const SIGN_ALG = { name: "ECDSA", hash: "SHA-256" };

// --- canonical base64url ----------------------------------------------------
//
// A 32-byte scalar and a 64-byte signature do not divide into 6-bit groups, so
// the final character carries bits that decode to nothing and one key has
// several spellings. lib/invite-token.mjs learned this the hard way - a link
// that verified sometimes and not others - so the check is strict here from the
// start rather than added after the first support ticket.

const B64URL_RE = /^[A-Za-z0-9_-]+$/;

export function toBase64Url(bytes) {
  let binary = "";
  for (const b of new Uint8Array(bytes)) binary += String.fromCharCode(b);
  const b64 = typeof btoa === "function" ? btoa(binary) : Buffer.from(binary, "binary").toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(text, { expectedBytes = null } = {}) {
  if (typeof text !== "string" || !B64URL_RE.test(text)) {
    throw new Error("not base64url");
  }
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = typeof atob === "function"
    ? atob(b64)
    : Buffer.from(b64, "base64").toString("binary");
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));

  // Canonical check: re-encoding must reproduce the input exactly. Anything
  // else is a second spelling of the same bytes.
  if (toBase64Url(bytes) !== text) throw new Error("non-canonical base64url");
  if (expectedBytes !== null && bytes.length !== expectedBytes) {
    throw new Error(`expected ${expectedBytes} bytes, got ${bytes.length}`);
  }
  return bytes;
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
  return { privateKey: toBase64Url(pkcs8), publicKey: toBase64Url(spki) };
}

async function importPrivate(privateKeyB64) {
  return requireSubtle().importKey("pkcs8", fromBase64Url(privateKeyB64), ALG, false, ["sign"]);
}

async function importPublic(publicKeyB64) {
  return requireSubtle().importKey("spki", fromBase64Url(publicKeyB64), ALG, false, ["verify"]);
}

// --- payload ----------------------------------------------------------------
//
// Short keys, because this rides in a 256-character title:
//   s = subject (which assignment, as the invitation's opaque subject)
//   g = github_id of the account doing the accepting
//   t = issued_at, ADVISORY ONLY - see verifyAcceptanceTitle
//   n = nonce, so two acceptances by the same account differ

function encodePayload({ subject, githubId, issuedAt, nonce }) {
  const json = JSON.stringify({ s: subject, g: Number(githubId), t: issuedAt, n: nonce });
  return toBase64Url(new TextEncoder().encode(json));
}

function decodePayload(encoded) {
  const json = new TextDecoder().decode(fromBase64Url(encoded));
  const raw = JSON.parse(json);
  if (!raw || typeof raw !== "object") throw new Error("payload is not an object");
  if (typeof raw.s !== "string" || !raw.s) throw new Error("payload has no subject");
  if (!Number.isInteger(raw.g)) throw new Error("payload has no integer github_id");
  return { subject: raw.s, githubId: raw.g, issuedAt: raw.t ?? null, nonce: raw.n ?? null };
}

/**
 * Sign an acceptance. Returns the issue TITLE the SPA opens.
 *
 * `pxl-accept:<kid>.<payload>.<signature>` - the prefix is unchanged so the
 * broker's job-level `if` still short-circuits before a runner is allocated,
 * and the broker still never has to read the issue body.
 */
export async function signAcceptanceTitle({
  privateKey,
  kid,
  subject,
  githubId,
  issuedAt = new Date().toISOString(),
  nonce,
}) {
  if (!kid || !/^[A-Za-z0-9_-]{1,32}$/.test(kid)) throw new Error("kid must be a short base64url token");
  const key = await importPrivate(privateKey);
  const payload = encodePayload({ subject, githubId, issuedAt, nonce });
  const signed = `${kid}.${payload}`;
  const signature = await requireSubtle().sign(
    SIGN_ALG,
    key,
    new TextEncoder().encode(signed),
  );
  const title = `${TITLE_PREFIX}${signed}.${toBase64Url(signature)}`;
  if (title.length > MAX_TITLE_LENGTH) {
    throw new Error(`acceptance title is ${title.length} chars, over GitHub's ${MAX_TITLE_LENGTH} limit`);
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
export async function verifyAcceptanceTitle({ title, publicKey, expectedKid = null }) {
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

  const parts = title.slice(TITLE_PREFIX.length).split(".");
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

  return { ok: true, kid, payload };
}

/**
 * The anti-replay check, kept beside the verification it belongs to.
 *
 * A signature lifted from the public event names the account that made it.
 * Anyone replaying it is authoring the issue as themselves, so the two
 * disagree. The broker can apply this before dispatching, and the hub applies
 * it again - one of them being skipped must not open the hole.
 */
export function signerMatchesAuthor(payload, authorGithubId) {
  return Number.isInteger(payload?.githubId) && payload.githubId === Number(authorGithubId);
}
