// The claim under `open` enrolment: observation, never a gate.
//
// `open` means anyone with the link and a seat inside the window gets a
// repository, and that does not change because they also told us an address.
// Every test here therefore asserts TWO things at once - what was recorded, and
// that the acceptance still succeeded - because the whole risk of this feature
// is that a review aid quietly turns into a refusal.
//
// It has to work that way rather than as a matter of taste: the claim is
// OPTIONAL under `open`. A link handed out earlier, a browser without
// WebCrypto, a dismissed prompt - all must still provision. So anyone who wants
// a second repository just omits the claim, which is why the uniqueness check
// here is ACCOUNTING and not prevention, and why the copy must never say
// otherwise.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { generateClaimKeypair, encryptClaim, buildClaimRecord } from "../lib/claim.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const acceptScript = join(here, "..", "acceptance", "accept.mjs");

const ID = "open-exam";
const LOGIN = "alice";
const GITHUB_ID = 424242;

const ASSIGNMENT = [
  "schema_version: 1",
  `id: ${ID}`,
  "title: Open Exam",
  "organization: TestOrg",
  "state: published",
  "assignment_type: individual",
  "roster_mode: open",
  "max_acceptances: 50",
  "opens_at: 2026-01-01T00:00:00Z",
  "deadline_at: 2099-01-01T00:00:00Z",
  "template:",
  "  owner: TestOrg",
  "  repository: tpl",
  `repository_name_pattern: ${ID}-{github_login}`,
  'claim_domains: ["student.pxl.be"]',
  "",
].join("\n");

/** A control dir with the assignment and, optionally, a roster and prior claims. */
function makeDir({ roster = null, claims = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pxl-open-claim-"));
  mkdirSync(join(dir, "assignments"), { recursive: true });
  writeFileSync(join(dir, "assignments", `${ID}.yml`), ASSIGNMENT);
  if (roster) {
    mkdirSync(join(dir, "students"), { recursive: true });
    writeFileSync(join(dir, "students", "roster.yml"), JSON.stringify(roster));
  }
  if (claims.length) {
    mkdirSync(join(dir, "students", "claims"), { recursive: true });
    for (const c of claims) {
      writeFileSync(join(dir, "students", "claims", `${c.github_id}.json`), JSON.stringify(c, null, 2));
    }
  }
  return dir;
}

function runAccept(dir, env = {}) {
  const outFile = join(dir, "out.env");
  writeFileSync(outFile, "");
  const res = spawnSync("node", [acceptScript], {
    encoding: "utf8",
    env: {
      ...process.env,
      ASSIGNMENT_ID: ID,
      GITHUB_LOGIN: LOGIN,
      GITHUB_ID: String(GITHUB_ID),
      ORG: "TestOrg",
      DATA_DIR: dir,
      GITHUB_OUTPUT: outFile,
      GITHUB_STEP_SUMMARY: join(dir, "summary.md"),
      ...env,
    },
  });
  return {
    status: res.status,
    stdout: res.stdout ?? "",
    outputs: existsSync(outFile) ? readFileSync(outFile, "utf8") : "",
  };
}

const claimFileFor = (dir, id) => join(dir, "students", "claims", `${id}.json`);
const readClaim = (dir, id) => JSON.parse(readFileSync(claimFileFor(dir, id), "utf8"));

const keys = await generateClaimKeypair();

// encryptClaim is async. Sealed at module level with top-level await so a test
// body cannot accidentally hand a PROMISE to the env, where it stringifies to
// "[object Promise]" - which decrypts as garbage and quietly turns a
// domain-check test into an unreadable-payload test that still passes.
const seal = async (email, githubId = GITHUB_ID) =>
  encryptClaim({ publicKey: keys.publicKey, email, githubId, assignmentId: ID });

const SEALED = {
  alice: await seal("alice@student.pxl.be"),
  stranger: await seal("stranger@student.pxl.be"),
  offDomain: await seal("someone@gmail.com"),
  replayed: await seal("victim@student.pxl.be", 111111),
  someoneElse: await seal("someone-else@student.pxl.be"),
  offDomain2: await seal("x@gmail.com"),
  wrongAccount: await seal("y@student.pxl.be", 5),
};

const withKey = (extra = {}) => ({ CLAIM_PRIVATE_KEY: keys.privateKey, ...extra });

const ROSTER = {
  schema_version: 2,
  students: [{ student_number: "0123456", full_name: "Alice", email: "alice@student.pxl.be" }],
};

// --- the acceptance still succeeds, always ----------------------------------

test("no address confirmed still provisions - the claim is optional here", () => {
  // A link handed out before the assignment moved to open, or a client that
  // never showed the prompt. Under `claim` this is rejected:claim-none; here it
  // is simply an acceptance with nothing recorded.
  const dir = makeDir();
  const res = runAccept(dir, withKey());

  assert.equal(res.status, 0, res.stdout);
  assert.doesNotMatch(res.outputs, /outcome=rejected/);
  assert.ok(!existsSync(join(dir, "students", "claims")), "nothing to record, so nothing written");
});

test("a confirmed address is recorded, and the roster supplies the student number", () => {
  const dir = makeDir({ roster: ROSTER });
  const res = runAccept(dir, withKey({ CLAIM_PAYLOAD: SEALED.alice, CLAIM_VERIFIED: "true" }));

  assert.equal(res.status, 0, res.stdout);
  const rec = readClaim(dir, GITHUB_ID);
  assert.equal(rec.email, "alice@student.pxl.be");
  assert.equal(rec.claim_verified, true);
  assert.equal(rec.domain_allowed, true);
  assert.equal(rec.student_number, "0123456", "a roster is optional under open, but used when present");
});

test("an address on NO roster entry is still recorded - open does not require one", () => {
  // The roster stops deciding who may accept; it does not stop being useful.
  // An address it has never seen is the ordinary case here.
  const dir = makeDir();
  const res = runAccept(dir, withKey({ CLAIM_PAYLOAD: SEALED.stranger }));

  assert.equal(res.status, 0, res.stdout);
  const rec = readClaim(dir, GITHUB_ID);
  assert.equal(rec.email, "stranger@student.pxl.be");
  assert.equal(rec.student_number, null, "invented from nothing would be worse than absent");
});

// --- detection, not prevention ----------------------------------------------

test("an address OUTSIDE the allowed domains is recorded and NOT refused", () => {
  // The whole point of phase F. Under `claim` this is rejected:claim-domain;
  // here it is a flag on a record, and the acceptance proceeds.
  const dir = makeDir();
  const res = runAccept(dir, withKey({ CLAIM_PAYLOAD: SEALED.offDomain }));

  assert.equal(res.status, 0, res.stdout);
  assert.doesNotMatch(res.outputs, /outcome=rejected/, "open enrolment must not refuse on a domain");
  const rec = readClaim(dir, GITHUB_ID);
  assert.equal(rec.email, "someone@gmail.com");
  assert.equal(rec.domain_allowed, false, "recorded so a lecturer can see it");
  assert.match(res.stdout, /OUTSIDE the allowed domains/);
});

test("an address already held by another account is recorded too, as accounting", () => {
  // Refusing would be a gate, and a bypassable one - the student need only omit
  // the claim. Both records survive, keyed by their own github_id, so
  // lib/claim-bindings.mjs reports the duplicate.
  const prior = buildClaimRecord({
    githubLogin: "bob", githubId: 999, email: "alice@student.pxl.be",
    claimVerified: true, assignmentId: "earlier", now: "2026-08-01T00:00:00.000Z",
  });
  const dir = makeDir({ roster: ROSTER, claims: [prior] });
  const res = runAccept(dir, withKey({ CLAIM_PAYLOAD: SEALED.alice }));

  assert.equal(res.status, 0, res.stdout);
  assert.doesNotMatch(res.outputs, /outcome=rejected/);
  assert.equal(readClaim(dir, GITHUB_ID).email, "alice@student.pxl.be");
  assert.equal(readClaim(dir, 999).github_login, "bob", "the earlier binding is untouched");
  assert.match(res.stdout, /ALSO held by @bob/);
});

// --- what is NOT recorded ----------------------------------------------------

test("a payload naming another account binds nobody, and still provisions", () => {
  // The anti-replay check survives even though nothing is gated: the output is
  // a record saying "this account is this person", and a false record is worse
  // than no record.
  const dir = makeDir();
  const res = runAccept(dir, withKey({ CLAIM_PAYLOAD: SEALED.replayed }));

  assert.equal(res.status, 0, res.stdout);
  assert.doesNotMatch(res.outputs, /outcome=rejected/);
  assert.ok(!existsSync(claimFileFor(dir, GITHUB_ID)), "an unsigned-for address must not be bound");
  assert.match(res.stdout, /names another account/);
});

test("an unreadable payload records nothing and still provisions", () => {
  const dir = makeDir();
  const res = runAccept(dir, withKey({ CLAIM_PAYLOAD: "not-a-sealed-payload" }));

  assert.equal(res.status, 0, res.stdout);
  assert.ok(!existsSync(claimFileFor(dir, GITHUB_ID)));
});

test("a missing hub key does NOT fail the run under open", () => {
  // Under `claim` this is fail:config, because without the key nobody can claim
  // at all. Here the claim is a review aid, and losing it is not worth refusing
  // a student their repository.
  const dir = makeDir();
  const res = runAccept(dir, { CLAIM_PAYLOAD: SEALED.alice });

  assert.equal(res.status, 0, res.stdout);
  assert.doesNotMatch(res.outputs, /outcome=fail/);
  assert.match(res.stdout, /PXL_CLAIM_PRIVATE_KEY is not set/);
});

// --- no oracle, so no counter ------------------------------------------------

test("nothing under open ever spends an attempt", () => {
  // The counter exists because under `claim` a refusal tells a guesser whether
  // an address is on the roster. Nothing is refused here, so nothing is
  // revealed, so there is nothing to ration - and a counter that filled up
  // would eventually lock a student out of a mode that never refuses anyone.
  const dir = makeDir({ roster: ROSTER });
  for (const payload of ["garbage", SEALED.offDomain2, SEALED.wrongAccount]) {
    runAccept(dir, withKey({ CLAIM_PAYLOAD: payload }));
  }
  const attemptsDir = join(dir, "students", "claim-attempts");
  const files = existsSync(attemptsDir) ? readdirSync(attemptsDir) : [];
  assert.deepEqual(files, [], "open enrolment refuses nothing, so it rations nothing");
});

// --- idempotence -------------------------------------------------------------

test("a student already bound is not re-prompted or rewritten", () => {
  // Claims are org-scoped: a second assignment in the same org recognises them.
  const prior = buildClaimRecord({
    githubLogin: LOGIN, githubId: GITHUB_ID, email: "alice@student.pxl.be",
    claimVerified: true, studentNumber: "0123456", assignmentId: "earlier",
    now: "2026-08-01T00:00:00.000Z",
  });
  const dir = makeDir({ roster: ROSTER, claims: [prior] });
  const res = runAccept(dir, withKey({ CLAIM_PAYLOAD: SEALED.someoneElse }));

  assert.equal(res.status, 0, res.stdout);
  const rec = readClaim(dir, GITHUB_ID);
  assert.equal(rec.email, "alice@student.pxl.be", "the existing binding wins");
  assert.equal(rec.claimed_via, "earlier", "and is not rewritten by a later assignment");
});
