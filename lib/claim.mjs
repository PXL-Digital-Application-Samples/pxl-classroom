// PXL Classroom - binding a GitHub account to an institutional email address.
//
// The problem this exists for: a lecturer holds student EMAIL ADDRESSES and not
// GitHub usernames, and the two can never be matched by the hub on its own. An
// installation token cannot read a user's email addresses (`GET /user/emails`
// is user-to-server), and anything the browser sends is a claim rather than a
// credential. `roster_mode: org_member` solved that by making GitHub do the
// binding through organization membership, and was withdrawn: membership is a
// heavy, permanent thing to require for one semester's assignment. The claim
// binds the address directly and puts nobody in the organization.
//
// Pure and dependency-free apart from WebCrypto, which Node and the browser
// both expose as `globalThis.crypto.subtle` - so the SPA encrypts with the same
// module the hub decrypts with, and neither can drift from the other. No fs, no
// fetch: the caller owns storage and transport.
//
// WHY ENCRYPTED AND NOT HASHED. An HMAC would let the hub match an address
// against a roster without ever learning it, which is stronger on paper. It
// also makes the address unreadable to the LECTURER, who is the person who
// actually needs it - to contact the student, to reconcile a cohort, to put a
// real identity in a report. Encryption keeps the public event archive inert
// (only ciphertext travels) while giving the hub plaintext it is entitled to.
//
// CLAUDE.md rejects encryption for the invite token, and that reasoning does
// not transfer: there the verifier is a PUBLIC broker that cannot hold a
// decryption key. Here decryption happens at the hub, which already holds
// secrets, and the broker never sees plaintext at all.

const SUBTLE = globalThis.crypto?.subtle;

/** ECDH on the same curve the acceptance signature uses. */
const ECDH = { name: "ECDH", namedCurve: "P-256" };

/**
 * P-256 key lengths as base64url, with no padding.
 *
 * SPKI public is 91 bytes -> 122 chars; PKCS8 private is 138 bytes -> 184,
 * which is the same 184 `lib/acceptance-signature.mjs` pins for the invitation
 * key. Same curve, same encoding, so a mismatch here means somebody pasted the
 * wrong kind of key rather than a corrupt one.
 */
export const CLAIM_PUBLIC_KEY_LENGTH = 122;
export const CLAIM_PRIVATE_KEY_LENGTH = 184;

/**
 * The default allowed domains for this deployment.
 *
 * THIS IS THE LINE ANOTHER INSTITUTION EDITS ON A FORK. A per-deployment
 * configuration mechanism was considered and rejected as more machinery than
 * the problem needs.
 *
 * `pxl.be` is here on purpose, not by accident: it lets a lecturer accept their
 * own assignment, which is how anybody checks a link actually works before
 * handing it to a cohort. Dropping it would make self-testing impossible on
 * every domain-restricted assignment.
 *
 * The student domain is `student.pxl.be`, NOT `stud.pxl.be`. The repo carried
 * both spellings for a long time - seven placeholders and the shipped roster
 * template said `stud.pxl.be` - and the wrong one reached the first draft of
 * the plan that specified this.
 */
export const CLAIM_DEFAULT_DOMAINS = Object.freeze(["student.pxl.be", "pxl.be"]);

/**
 * Failed claims tolerated per account before the answer stops being useful.
 *
 * Under `claim` the step is a GUESSING ORACLE: whoever holds the link can
 * submit addresses, and `firstname.lastname@student.pxl.be` is enumerable.
 * Unbounded, somebody iterates until one matches a roster entry.
 *
 * Two costs, and the second bites first. Identity: a successful guess binds
 * somebody else's roster entry. Minutes: every attempt is an issue and a hub
 * workflow run, on a system whose design goal is billing zero when idle. A
 * bored student with a loop is a bigger bill than a security incident.
 *
 * Five is generous for a typo and useless for enumeration. The counter ships
 * WITH the gate - an unbounded oracle is not a follow-up.
 */
export const MAX_CLAIM_ATTEMPTS = 5;

/** Every reason a claim can be refused. Kept together so copy can be reviewed. */
export const CLAIM_REJECTIONS = Object.freeze({
  NO_CLAIM: "rejected:no-claim",
  DOMAIN: "rejected:claim-domain",
  NO_MATCH: "rejected:no-claim-match",
  TAKEN: "rejected:claim-taken",
  BLOCKED: "rejected:claim-blocked",
});

// --- canonical base64url -----------------------------------------------------
// Same rule as lib/acceptance-signature.mjs: one value has exactly one
// spelling. Without the round-trip check a payload has several valid-looking
// encodings, and equality checks over it stop meaning anything.
const B64URL_RE = /^[A-Za-z0-9_-]+$/;

export function toBase64Url(bytes) {
  let binary = "";
  for (const b of new Uint8Array(bytes)) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(text, { expectedBytes = null } = {}) {
  if (typeof text !== "string" || !text || !B64URL_RE.test(text)) {
    throw new Error("not base64url");
  }
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  if (expectedBytes !== null && bytes.length !== expectedBytes) {
    throw new Error(`expected ${expectedBytes} bytes, got ${bytes.length}`);
  }
  if (toBase64Url(bytes) !== text) throw new Error("non-canonical base64url");
  return bytes;
}

/** `crypto.subtle` exists only in a secure context; say so rather than fail oddly. */
export function hasWebCrypto() {
  return Boolean(SUBTLE);
}

function requireSubtle() {
  if (!SUBTLE) {
    throw new Error(
      "WebCrypto is unavailable - claim encryption needs crypto.subtle, which browsers expose only in a secure context (https or localhost)",
    );
  }
  return SUBTLE;
}

// --- addresses ---------------------------------------------------------------

/**
 * The one normalisation, applied everywhere an address is compared or stored.
 *
 * Trim and lowercase, and nothing cleverer. A PXL address is not a Gmail
 * address: stripping dots or `+tags` would silently merge two distinct
 * institutional mailboxes, and the roster is the authority on which addresses
 * exist. Returns "" for anything that is not shaped like an address at all, so
 * callers get one falsy answer rather than three.
 */
export function normalizeEmail(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim().toLowerCase();
  // Deliberately loose: one @, something either side, a dot in the domain, no
  // whitespace. Real validation is the roster match (under `claim`) or the
  // domain list (under `open`) - this only rejects input that cannot be an
  // address at all.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return "";
  return trimmed;
}

/** The domain half of a normalized address, or "" when there isn't one. */
export function emailDomain(value) {
  const email = normalizeEmail(value);
  if (!email) return "";
  return email.slice(email.lastIndexOf("@") + 1);
}

/**
 * The domains in force for an assignment.
 *
 * ABSENT AND EMPTY ARE DIFFERENT ANSWERS, and conflating them is the bug this
 * signature exists to prevent. An assignment with no `claim_domains` key gets
 * the deployment default; one that explicitly sets `claim_domains: []` has
 * deliberately opted out of the restriction. A truthy check would turn the
 * opt-out back into the default and silently re-impose a rule a lecturer
 * removed on purpose.
 */
export function resolveClaimDomains(assignment, defaults = CLAIM_DEFAULT_DOMAINS) {
  const declared = assignment?.claim_domains;
  if (!Array.isArray(declared)) return [...defaults];
  return declared
    .filter((d) => typeof d === "string")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Is this address inside the allowed domains?
 *
 * An empty list is no restriction, per resolveClaimDomains. Matching is exact
 * on the domain label, case-insensitively - NOT a suffix test, because
 * `notstudent.pxl.be` ends with `student.pxl.be` and a suffix check would
 * admit any domain an attacker can register that ends in the right characters.
 */
export function domainAllowed(email, domains) {
  const domain = emailDomain(email);
  if (!domain) return false;
  if (!Array.isArray(domains) || domains.length === 0) return true;
  return domains.some((d) => String(d).trim().toLowerCase() === domain);
}

// --- the encrypted payload ---------------------------------------------------
//
// ECDH P-256 -> HKDF-SHA256 -> AES-256-GCM, on the wire as
//
//   c1.<ephemeral SPKI>.<iv>.<ciphertext>
//
// all base64url. The ephemeral public key is fresh per claim, so two claims of
// the same address by the same account produce different ciphertext and the
// public archive leaks nothing by comparison.

const WIRE_VERSION = "c1";
const HKDF_INFO = "pxl-classroom/claim/v1";
const IV_BYTES = 12;

const utf8 = (s) => new TextEncoder().encode(s);

async function deriveAesKey(subtle, privateKey, publicKey, salt) {
  const shared = await subtle.deriveBits({ name: "ECDH", public: publicKey }, privateKey, 256);
  const hkdf = await subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  return subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: utf8(HKDF_INFO) },
    hkdf,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Mint the hub's claim keypair. Private half is a hub secret; public half ships. */
export async function generateClaimKeypair() {
  const subtle = requireSubtle();
  const pair = await subtle.generateKey(ECDH, true, ["deriveBits"]);
  const [pkcs8, spki] = await Promise.all([
    subtle.exportKey("pkcs8", pair.privateKey),
    subtle.exportKey("spki", pair.publicKey),
  ]);
  return { privateKey: toBase64Url(pkcs8), publicKey: toBase64Url(spki) };
}

/**
 * Encrypt a claim to the hub's public key. Runs in the student's browser.
 *
 * BOUND TO THE CLAIMANT. `githubId` is inside the sealed payload, and the hub
 * refuses it when it does not match the issue author - otherwise a ciphertext
 * copied straight out of the public event archive would replay for anyone.
 */
export async function encryptClaim({ publicKey, email, githubId, assignmentId, nonce }) {
  const subtle = requireSubtle();

  const address = normalizeEmail(email);
  if (!address) throw new Error("email is not a valid address");
  if (!Number.isInteger(githubId) || githubId <= 0) {
    throw new Error("githubId must be a positive integer");
  }
  if (!assignmentId) throw new Error("assignmentId is required");

  const hubKey = await subtle.importKey(
    "spki",
    fromBase64Url(publicKey, { expectedBytes: 91 }),
    ECDH,
    false,
    [],
  );
  const ephemeral = await subtle.generateKey(ECDH, true, ["deriveBits"]);
  const ephemeralSpki = new Uint8Array(await subtle.exportKey("spki", ephemeral.publicKey));

  // The ephemeral public key doubles as the KDF salt: both sides hold it, it is
  // fresh per claim, and it binds the derived key to this exchange.
  const aes = await deriveAesKey(subtle, ephemeral.privateKey, hubKey, ephemeralSpki);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const plaintext = utf8(
    JSON.stringify({
      email: address,
      github_id: githubId,
      assignment_id: String(assignmentId),
      nonce: nonce ?? toBase64Url(crypto.getRandomValues(new Uint8Array(8))),
    }),
  );
  const sealed = await subtle.encrypt({ name: "AES-GCM", iv }, aes, plaintext);

  return [WIRE_VERSION, toBase64Url(ephemeralSpki), toBase64Url(iv), toBase64Url(sealed)].join(".");
}

/**
 * Decrypt a claim at the hub. Returns the payload, or throws.
 *
 * Every failure is one failure: a malformed wire format, an unknown version, a
 * bad key, a forged tag and a truncated ciphertext all throw, and the caller
 * maps them to a single `rejected:no-claim`. Distinguishing them for the
 * student would describe the crypto to whoever is probing it, and none of the
 * distinctions is actionable by a student who simply mistyped.
 */
export async function decryptClaim({ privateKey, payload }) {
  const subtle = requireSubtle();

  if (typeof payload !== "string") throw new Error("claim payload is not a string");
  const parts = payload.trim().split(".");
  if (parts.length !== 4) throw new Error("claim payload is malformed");
  const [version, ephemeralB64, ivB64, sealedB64] = parts;
  if (version !== WIRE_VERSION) throw new Error(`unknown claim payload version "${version}"`);

  const hubPrivate = await subtle.importKey(
    "pkcs8",
    fromBase64Url(privateKey, { expectedBytes: 138 }),
    ECDH,
    false,
    ["deriveBits"],
  );
  const ephemeralSpki = fromBase64Url(ephemeralB64, { expectedBytes: 91 });
  const ephemeralKey = await subtle.importKey("spki", ephemeralSpki, ECDH, false, []);

  const aes = await deriveAesKey(subtle, hubPrivate, ephemeralKey, ephemeralSpki);
  const opened = await subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64Url(ivB64, { expectedBytes: IV_BYTES }) },
    aes,
    fromBase64Url(sealedB64),
  );

  const claim = JSON.parse(new TextDecoder().decode(opened));
  const email = normalizeEmail(claim?.email);
  if (!email) throw new Error("claim payload carries no usable address");
  if (!Number.isInteger(claim?.github_id) || claim.github_id <= 0) {
    throw new Error("claim payload carries no usable github_id");
  }
  return {
    email,
    githubId: claim.github_id,
    assignmentId: String(claim.assignment_id ?? ""),
    nonce: claim.nonce ?? null,
  };
}

// --- records -----------------------------------------------------------------
//
// One file per student, never an edit to roster.yml. Acceptance is concurrent
// and serialized only per login, so two claims at once would collide on a
// single roster write - which is why every existing acceptance artefact is
// one-file-per-student too. Keyed by github_id because it is immutable and
// survives a username change.

/** Where a student's binding lives. Private; must never reach Pages. */
export function claimPath(githubId) {
  return `students/claims/${githubId}.json`;
}

/** Where a student's failed-attempt counter lives. */
export function claimAttemptsPath(githubId) {
  return `students/claim-attempts/${githubId}.json`;
}

export function buildClaimRecord({
  githubLogin,
  githubId,
  email,
  claimVerified,
  studentNumber = null,
  assignmentId,
  now,
}) {
  return {
    schema_version: 1,
    github_login: githubLogin,
    github_id: githubId,
    email: normalizeEmail(email),
    // Evidence, never enforcement. The page shows a student their own
    // GitHub-VERIFIED addresses and asks them to confirm one, but that runs in
    // the browser and the hub cannot check it - the same wall that killed
    // org_member. Someone with a shared link and a made-up address is always
    // `false`, which is a far sharper cohort review than "does this address
    // look like one of my students".
    claim_verified: Boolean(claimVerified),
    student_number: studentNumber,
    claimed_at: now,
    claimed_via: assignmentId,
  };
}

/**
 * The counter after a failed attempt.
 *
 * Serialized for free: the acceptance concurrency group is already keyed per
 * login, so a student cannot race their own counter.
 */
export function recordFailedAttempt(existing, now) {
  const failures = Number.isInteger(existing?.failures) ? existing.failures : 0;
  return {
    schema_version: 1,
    failures: failures + 1,
    first_at: existing?.first_at ?? now,
    last_at: now,
  };
}

/**
 * Has this account spent its attempts?
 *
 * The student is told to contact their lecturer, and NOT how many attempts
 * remain - a countdown is a progress bar for whoever is enumerating.
 */
export function claimAttemptsExhausted(existing, max = MAX_CLAIM_ATTEMPTS) {
  const failures = Number.isInteger(existing?.failures) ? existing.failures : 0;
  return failures >= max;
}

/**
 * Which roster entry does this address belong to?
 *
 * Case-insensitive, exactly as accept.mjs's login gate is. A roster entry with
 * no email can never be claimed - that is surfaced at import and by a
 * diagnostic, never discovered by a student at the accept button.
 */
export function rosterEntryForEmail(roster, email) {
  const address = normalizeEmail(email);
  if (!address) return null;
  const students = Array.isArray(roster?.students) ? roster.students : [];
  return students.find((s) => normalizeEmail(s?.email) === address) ?? null;
}
