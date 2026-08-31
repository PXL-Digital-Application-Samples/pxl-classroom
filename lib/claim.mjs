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

import { toBase64Url, fromBase64Url } from "./base64url.mjs";

// Re-exported: callers have imported these from here since before the shared
// module existed, and the encoding is part of this module's wire contract.
export { toBase64Url, fromBase64Url };

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
export function resolveClaimDomains(assignment, defaults) {
  if (!Array.isArray(defaults)) {
    throw new Error("resolveClaimDomains needs the deployment default - read it from lib/deployment.mjs (Node) or frontend/src/lib/deployment.js (SPA)");
  }
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

/**
 * Mint the hub's claim keypair.
 *
 * Do not call this to "set up" anything - run `node
 * scripts/generate-claim-keypair.mjs [kid]`, which prints the private half once
 * and writes it nowhere, and tells you which of the two places each half goes:
 * the private key to the `provisioning` ENVIRONMENT secret PXL_CLAIM_PRIVATE_KEY
 * (main branch only, no repository-level copy), the public key to
 * acceptance/claim-keys.json. See RUNBOOK §1.3.2.
 */
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

/**
 * The hub's claim private keys, current first.
 *
 * ROTATION WAS IMPOSSIBLE UNTIL THIS EXISTED, and that is the actual defect -
 * not the absence of forward secrecy, which a static page sealing to a
 * long-lived recipient key can never have.
 *
 * The shape of the problem: `acceptance/claim-keys.json` already carries a
 * `current` kid and a `keys` map, and the SPA already seals to whichever is
 * current - but the KID NEVER TRAVELS WITH THE CIPHERTEXT (the wire format is
 * `c1.<ephemeral SPKI>.<iv>.<ciphertext>`) and the hub held exactly one
 * `PXL_CLAIM_PRIVATE_KEY`. So minting a new keypair would have broken every
 * claim sealed to the old one: acceptances already posted, plus every browser
 * still running a cached bundle. Worse than a plain failure - a decrypt failure
 * sits *after* the counter in the gate, so a rotation would have spent real
 * students' attempts and locked them out of a mode that is supposed to let them in.
 *
 * Holding several keys and trying each fixes it with NO wire change and NO SPA
 * change, which is why it is done this way rather than by adding a kid to the
 * format: new claims seal to the new key, old ciphertexts still open with the
 * retired one, and nothing in flight notices. Retire a key by dropping it from
 * this list once no cached bundle can still be sealing to it.
 *
 * Order matters only for speed - the current key opens the overwhelming
 * majority, so it is tried first. Blank entries are dropped rather than
 * attempted: an unset secret is "" and would otherwise throw on every claim.
 *
 * @param {string} current the active key (PXL_CLAIM_PRIVATE_KEY)
 * @param {string} retired newline- or comma-separated keys being phased out
 */
export function claimPrivateKeys(current, retired = "") {
  const seen = new Set();
  return [current, ...String(retired ?? "").split(/[\s,]+/)]
    .map((k) => String(k ?? "").trim())
    .filter((k) => {
      if (!k || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
}

/**
 * Decrypt a claim against every key the hub holds.
 *
 * Throws the SAME single error whatever went wrong, exactly as `decryptClaim`
 * does: a wrong key, a forged tag, a truncated ciphertext and a malformed wire
 * format are one indistinguishable failure, because telling them apart
 * describes the crypto to whoever is probing it. In particular this must never
 * report "no key matched" separately from "the ciphertext is bad" - that would
 * leak whether a rotation had happened.
 */
export async function decryptClaimWithAnyKey({ privateKeys, payload }) {
  const keys = Array.isArray(privateKeys) ? privateKeys.filter(Boolean) : [];
  if (keys.length === 0) throw new Error("no claim private key is configured");
  for (const privateKey of keys) {
    try {
      return await decryptClaim({ privateKey, payload });
    } catch {
      // Try the next one. The last failure is not more informative than the
      // first, so nothing is accumulated.
    }
  }
  throw new Error("claim payload could not be decrypted");
}

// --- the issue body ----------------------------------------------------------

/**
 * The claim half of the acceptance issue body.
 *
 * One body, two readers: `lib/team-payload.mjs` owns the team fields and this
 * owns the claim fields, so neither has to know about the other and the claim
 * rule stays in one module. The body is UNTRUSTED - a public issue anyone can
 * open by hand - so everything here is shape-checked and nothing is believed.
 *
 * `claim_verified` is the student's browser saying "this address came from
 * their own GitHub-verified list". It is EVIDENCE, not a control, and it is
 * forgeable by anyone writing the issue themselves: the hub cannot check it,
 * because an installation token cannot read a user's email addresses - the
 * same wall that killed org_member. What it buys is that the ordinary path
 * records it truthfully, so a cohort review can see which bindings GitHub had
 * already vouched for.
 */
export function parseClaimFields({ body } = {}) {
  const empty = { claim_payload: "", claim_verified: false };
  if (typeof body !== "string" || !body.trim()) return empty;

  let parsed = null;
  try {
    parsed = JSON.parse(body);
  } catch {
    return empty;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return empty;

  const payload = typeof parsed.claim === "string" ? parsed.claim.trim() : "";
  // Shape-checked here so a body full of junk never reaches the crypto, and so
  // an oversized field cannot be used to make the hub do work. The wire format
  // is four base64url parts joined by dots; a P-256 exchange lands near 300
  // characters, and 1024 is comfortable headroom without being unbounded.
  const shaped = /^[A-Za-z0-9_.-]{1,1024}$/.test(payload) && payload.split(".").length === 4;

  return {
    claim_payload: shaped ? payload : "",
    // Strictly `true`, never truthy: the string "false" is truthy, and this
    // field arrives from a JSON body a student can write by hand.
    claim_verified: parsed.claim_verified === true,
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
  domainAllowed: domainOk = true,
}) {
  return {
    schema_version: 1,
    github_login: githubLogin,
    github_id: githubId,
    email: normalizeEmail(email),
    // Whether the address was inside `claim_domains`. Always true under
    // `claim`, where a failing domain is refused before a record is written -
    // it exists for `open`, where NOTHING about the claim refuses and the
    // answer has to be recorded instead of enforced. Recorded on both so a
    // consumer never has to know which mode wrote the file.
    domain_allowed: Boolean(domainOk),
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
