// The claim: binding a GitHub account to an institutional email address.
//
// Runs the REAL crypto - Node and the browser expose the same
// `globalThis.crypto.subtle`, which is the whole reason lib/claim.mjs is
// isomorphic - so a round trip here is the round trip the SPA and the hub
// actually perform, not a mock of one.
import { test } from "node:test";
import assert from "node:assert/strict";

import { CLAIM_DOMAINS as CLAIM_DEFAULT_DOMAINS } from "../lib/deployment.mjs";
import {
  CLAIM_PRIVATE_KEY_LENGTH,
  CLAIM_PUBLIC_KEY_LENGTH,
  MAX_CLAIM_ATTEMPTS,
  buildClaimRecord,
  claimAttemptsExhausted,
  claimAttemptsPath,
  claimPath,
  decryptClaim,
  domainAllowed,
  emailDomain,
  encryptClaim,
  generateClaimKeypair,
  normalizeEmail,
  recordFailedAttempt,
  resolveClaimDomains,
  rosterEntryForEmail,
} from "../lib/claim.mjs";

const ID = 12345678;
const ASSIGNMENT = "net-advanced-guts-2627";

let keys;
async function hubKeys() {
  if (!keys) keys = await generateClaimKeypair();
  return keys;
}

// --- addresses ---------------------------------------------------------------

test("normalizeEmail trims and lowercases, and nothing cleverer", () => {
  assert.equal(normalizeEmail("  Alice.Example@Student.PXL.be \n"), "alice.example@student.pxl.be");

  // Dots and +tags are NOT stripped. A PXL address is not a Gmail address, and
  // collapsing them would merge two distinct institutional mailboxes.
  assert.equal(normalizeEmail("a.b@student.pxl.be"), "a.b@student.pxl.be");
  assert.equal(normalizeEmail("a+x@student.pxl.be"), "a+x@student.pxl.be");
  assert.notEqual(normalizeEmail("a.b@student.pxl.be"), normalizeEmail("ab@student.pxl.be"));
});

test("normalizeEmail gives one falsy answer for anything unusable", () => {
  for (const junk of ["", "   ", "no-at-sign", "a@b", "a b@c.d", "@student.pxl.be", "a@", null, undefined, 42, {}]) {
    assert.equal(normalizeEmail(junk), "", `${JSON.stringify(junk)} must normalize to ""`);
  }
});

test("resolveClaimDomains: ABSENT and EMPTY are different answers", () => {
  // The distinction the signature exists for. A truthy check would turn a
  // deliberate opt-out back into the default and silently re-impose a rule the
  // lecturer removed.
  assert.deepEqual(resolveClaimDomains({}, CLAIM_DEFAULT_DOMAINS), [...CLAIM_DEFAULT_DOMAINS]);
  assert.deepEqual(resolveClaimDomains({ claim_domains: undefined }, CLAIM_DEFAULT_DOMAINS), [...CLAIM_DEFAULT_DOMAINS]);
  assert.deepEqual(resolveClaimDomains({ claim_domains: [] }, CLAIM_DEFAULT_DOMAINS), [], "explicit [] is the opt-out");

  assert.deepEqual(resolveClaimDomains({ claim_domains: [" Student.PXL.be ", "howest.be"] }, CLAIM_DEFAULT_DOMAINS),
    ["student.pxl.be", "howest.be"]);
});

test("the deployment default includes pxl.be so a lecturer can self-test", () => {
  // Dropping it would make it impossible to check a link works before handing
  // it to a cohort, on every domain-restricted assignment.
  assert.ok(CLAIM_DEFAULT_DOMAINS.includes("pxl.be"));
  // And the student domain is student.pxl.be, not the stud.pxl.be the repo
  // carried in seven placeholders for a long time.
  assert.ok(CLAIM_DEFAULT_DOMAINS.includes("student.pxl.be"));
  assert.ok(!CLAIM_DEFAULT_DOMAINS.includes("stud.pxl.be"));
});

test("domainAllowed matches the whole label, never a suffix", () => {
  const domains = ["student.pxl.be"];
  assert.ok(domainAllowed("a@student.pxl.be", domains));
  assert.ok(domainAllowed("A@STUDENT.PXL.BE", domains), "case-insensitive");

  // The attack a suffix test would admit: anyone can register this.
  assert.ok(!domainAllowed("a@notstudent.pxl.be", domains));
  assert.ok(!domainAllowed("a@student.pxl.be.evil.com", domains));
  assert.ok(!domainAllowed("a@pxl.be", domains));
});

test("an empty domain list is no restriction, and junk is still refused", () => {
  assert.ok(domainAllowed("a@anywhere.com", []));
  assert.ok(!domainAllowed("not-an-address", []), "an unusable address is never allowed");
  assert.ok(!domainAllowed("", []));
});

test("a two-@ address is refused outright, not parsed into a domain", () => {
  // `a@b@student.pxl.be` is not a valid unquoted address, and normalizeEmail
  // rejects it before emailDomain ever sees it - so it cannot be smuggled past
  // the domain check by hiding a second @ in the local part. emailDomain's
  // lastIndexOf is defence in depth behind that, not the thing doing the work.
  assert.equal(normalizeEmail("a@b@student.pxl.be"), "");
  assert.equal(emailDomain("a@b@student.pxl.be"), "");
  assert.ok(!domainAllowed("a@b@student.pxl.be", ["student.pxl.be"]));

  assert.equal(emailDomain("junk"), "");
  assert.equal(emailDomain("a@student.pxl.be"), "student.pxl.be");
});

// --- the sealed payload ------------------------------------------------------

test("a claim round-trips through the real crypto", async () => {
  const { publicKey, privateKey } = await hubKeys();
  assert.equal(publicKey.length, CLAIM_PUBLIC_KEY_LENGTH);
  assert.equal(privateKey.length, CLAIM_PRIVATE_KEY_LENGTH);

  const payload = await encryptClaim({
    publicKey, email: " Alice.Example@Student.PXL.be ", githubId: ID, assignmentId: ASSIGNMENT,
  });
  const opened = await decryptClaim({ privateKey, payload });

  assert.equal(opened.email, "alice.example@student.pxl.be", "stored normalized");
  assert.equal(opened.githubId, ID);
  assert.equal(opened.assignmentId, ASSIGNMENT);
});

test("the wire format leaks nothing by comparison", async () => {
  const { publicKey, privateKey } = await hubKeys();
  const args = { publicKey, email: "a@student.pxl.be", githubId: ID, assignmentId: ASSIGNMENT };

  const one = await encryptClaim(args);
  const two = await encryptClaim(args);
  assert.notEqual(one, two, "a fresh ephemeral key per claim, or the archive is a lookup table");

  // Both still open to the same address.
  assert.equal((await decryptClaim({ privateKey, payload: one })).email, "a@student.pxl.be");
  assert.equal((await decryptClaim({ privateKey, payload: two })).email, "a@student.pxl.be");

  // And the address is not sitting in the ciphertext in any readable form.
  assert.ok(!one.includes("student"), "the domain must not be recoverable by eye");
  assert.ok(!one.toLowerCase().includes("a@"));
});

test("the payload is bound to the claimant, which is the anti-replay property", async () => {
  const { publicKey, privateKey } = await hubKeys();
  const payload = await encryptClaim({
    publicKey, email: "victim@student.pxl.be", githubId: ID, assignmentId: ASSIGNMENT,
  });

  // A ciphertext lifted straight out of the public event archive still decrypts
  // - it has to, the hub holds the key - but it names the account it was minted
  // for. The hub compares that to the issue author and refuses a mismatch.
  const opened = await decryptClaim({ privateKey, payload });
  assert.equal(opened.githubId, ID);
  assert.notEqual(opened.githubId, 99999999);
});

test("every kind of tampering is one indistinguishable failure", async () => {
  const { publicKey, privateKey } = await hubKeys();
  const good = await encryptClaim({
    publicKey, email: "a@student.pxl.be", githubId: ID, assignmentId: ASSIGNMENT,
  });
  const [v, eph, iv, sealed] = good.split(".");

  const bad = [
    ["not a payload at all", "nonsense"],
    ["wrong part count", `${v}.${eph}.${iv}`],
    ["unknown version", `c2.${eph}.${iv}.${sealed}`],
    ["flipped ciphertext", `${v}.${eph}.${iv}.${sealed.slice(0, -2)}AA`],
    ["truncated ciphertext", `${v}.${eph}.${iv}.${sealed.slice(0, 8)}`],
    ["swapped iv", `${v}.${eph}.${"A".repeat(16)}.${sealed}`],
    ["non-base64url", `${v}.${eph}.${iv}.not+valid/url`],
    ["empty", ""],
  ];
  for (const [name, payload] of bad) {
    await assert.rejects(
      () => decryptClaim({ privateKey, payload }),
      (e) => e instanceof Error,
      `${name} must be refused`,
    );
  }
  await assert.rejects(() => decryptClaim({ privateKey, payload: null }));
});

test("another hub's key cannot open a claim", async () => {
  const mine = await hubKeys();
  const theirs = await generateClaimKeypair();
  const payload = await encryptClaim({
    publicKey: mine.publicKey, email: "a@student.pxl.be", githubId: ID, assignmentId: ASSIGNMENT,
  });
  await assert.rejects(() => decryptClaim({ privateKey: theirs.privateKey, payload }));
});

test("encryptClaim refuses input the hub would have to reject later", async () => {
  const { publicKey } = await hubKeys();
  const base = { publicKey, email: "a@student.pxl.be", githubId: ID, assignmentId: ASSIGNMENT };

  await assert.rejects(() => encryptClaim({ ...base, email: "nonsense" }), /valid address/);
  await assert.rejects(() => encryptClaim({ ...base, githubId: 0 }), /positive integer/);
  await assert.rejects(() => encryptClaim({ ...base, githubId: "12345678" }), /positive integer/);
  await assert.rejects(() => encryptClaim({ ...base, assignmentId: "" }), /assignmentId/);
  // A public key of the wrong kind is caught by its length, not by a crypto error.
  await assert.rejects(() => encryptClaim({ ...base, publicKey: "AAAA" }));
});

// --- records -----------------------------------------------------------------

test("records are one file per student, keyed by the immutable id", () => {
  assert.equal(claimPath(ID), `students/claims/${ID}.json`);
  assert.equal(claimAttemptsPath(ID), `students/claim-attempts/${ID}.json`);
  // Keyed by github_id, never by login: a student who renames on GitHub keeps
  // their binding.
  assert.ok(!claimPath(ID).includes("alice"));
});

test("a claim record stores the normalized address and the verification flag", () => {
  const rec = buildClaimRecord({
    githubLogin: "Alice-PXL", githubId: ID, email: "  Alice@Student.PXL.be ",
    claimVerified: true, studentNumber: "0123456", assignmentId: ASSIGNMENT,
    now: "2026-09-01T10:00:00.000Z",
  });
  assert.equal(rec.email, "alice@student.pxl.be");
  assert.equal(rec.github_id, ID);
  assert.equal(rec.claim_verified, true);
  assert.equal(rec.student_number, "0123456");
  assert.equal(rec.claimed_via, ASSIGNMENT);

  // claim_verified is evidence, not enforcement - and it must be a real boolean,
  // because the lecturer's cohort review keys on it.
  const typed = buildClaimRecord({ githubId: ID, email: "a@b.co", claimVerified: undefined, assignmentId: ASSIGNMENT, now: "x" });
  assert.equal(typed.claim_verified, false);
  assert.equal(typeof typed.claim_verified, "boolean");
});

test("the record buildClaimRecord produces validates against its schema", async () => {
  // The claim binding shipped without a schema at all, while every other
  // artefact in the control repo has one - found by sweeping the strict
  // schemas against their producers, 2026-08-27.
  //
  // Pinned here rather than validated inside accept.mjs: buildClaimRecord is
  // pure and deterministic, so a unit test catches producer/schema drift just
  // as well and does not put Ajv on the acceptance hot path, which currently
  // makes zero API calls and carries almost no imports.
  const { validateAgainst } = await import("../lib/validate.mjs");

  const full = buildClaimRecord({
    githubLogin: "alice-pxl", githubId: ID, email: "alice@student.pxl.be",
    claimVerified: true, studentNumber: "0123456", assignmentId: ASSIGNMENT,
    now: "2026-09-01T10:00:00.000Z",
  });
  const a = validateAgainst("claim", full);
  assert.equal(a.valid, true, JSON.stringify(a.errors));

  // And the shape `open` produces: no roster, so no student number.
  const open = buildClaimRecord({
    githubLogin: "someone", githubId: ID, email: "someone@student.pxl.be",
    claimVerified: false, studentNumber: null, assignmentId: ASSIGNMENT,
    now: "2026-09-01T10:00:00.000Z",
  });
  const b = validateAgainst("claim", open);
  assert.equal(b.valid, true, JSON.stringify(b.errors));

  // The schema is additionalProperties:false, so a field the producer starts
  // writing without declaring is a failure rather than silent drift - which is
  // exactly how claimed_email sat forbidden by acceptance.schema.json for
  // months while accept.mjs wrote it.
  const c = validateAgainst("claim", { ...full, surprise: true });
  assert.equal(c.valid, false, "an undeclared field must be refused");
});

test("the attempt counter counts up, keeps first_at, and blocks at the ceiling", () => {
  let state = null;
  for (let i = 1; i <= MAX_CLAIM_ATTEMPTS; i++) {
    state = recordFailedAttempt(state, `t${i}`);
    assert.equal(state.failures, i);
    assert.equal(state.first_at, "t1", "the first attempt's timestamp survives");
    assert.equal(state.last_at, `t${i}`);
    assert.equal(claimAttemptsExhausted(state), i >= MAX_CLAIM_ATTEMPTS);
  }
  assert.ok(claimAttemptsExhausted(recordFailedAttempt(state, "t6")), "and stays blocked");
});

test("a missing or corrupt counter reads as zero, not as blocked", () => {
  // A student must never be locked out because a file failed to parse.
  for (const junk of [null, undefined, {}, { failures: "many" }, { failures: -3 }]) {
    assert.equal(claimAttemptsExhausted(junk), false, `${JSON.stringify(junk)} must not block`);
  }
  assert.equal(recordFailedAttempt(undefined, "t").failures, 1);
  assert.equal(recordFailedAttempt({ failures: "many" }, "t").failures, 1);
});

test("roster matching is by address, case-insensitively", () => {
  const roster = {
    students: [
      { github_login: "bob", email: "Bob@Student.PXL.be", student_number: "1" },
      { github_login: "carol", student_number: "2" },
    ],
  };
  assert.equal(rosterEntryForEmail(roster, "bob@student.pxl.be")?.student_number, "1");
  assert.equal(rosterEntryForEmail(roster, "  BOB@STUDENT.PXL.BE ")?.student_number, "1");

  // A roster entry with no email can never be claimed - surfaced at import and
  // by a diagnostic, never discovered by a student at the accept button.
  assert.equal(rosterEntryForEmail(roster, "carol@student.pxl.be"), null);
  assert.equal(rosterEntryForEmail(roster, "nobody@student.pxl.be"), null);

  // A junk address must not match an entry whose email is also missing.
  assert.equal(rosterEntryForEmail(roster, "nonsense"), null);
  assert.equal(rosterEntryForEmail({ students: null }, "a@b.co"), null);
  assert.equal(rosterEntryForEmail(null, "a@b.co"), null);
});
