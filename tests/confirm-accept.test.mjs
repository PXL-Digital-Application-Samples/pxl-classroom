// `kind: confirm` on the hub - the run that identifies somebody and does
// nothing else.
//
// A confirmation is `recordClaim` with `required` forced on, and that IS the
// implementation of it rather than a second copy with the acceptance taken out.
// It asks exactly the question `open` asks as an aside ("who is this
// account?") and writes exactly the record `open` writes; what differs is that
// there is no repository behind it to shrug and carry on to, so every branch
// that shrugs there must refuse here.
//
// The surprising design decision, tested rather than left in a comment: THE
// WINDOW IS NOT CHECKED. `opens_at`..`deadline_at` govern who gets a repository
// and when; a confirmation hands out nothing, so a deadline has nothing to
// protect - while the fortnight AFTER a deadline is exactly when a lecturer
// reads their roster and finds rows with a login and nothing else. The lifetime
// that does bound this is the broker's INVITE_ENABLED, flipped when the nightly
// finalizes, which is a layer this script never sees.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { generateClaimKeypair, encryptClaim } from "../lib/claim.mjs";
import { startRepoProbe } from "./fixtures/repo-probe.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const acceptScript = join(here, "..", "acceptance", "accept.mjs");

// accept.mjs step 7 asks GitHub whether the target repository name is taken.
// Answers 404 for everything here - and a `kind: confirm` run never reaches
// that question at all, which is itself worth the stand-in being present.
const probe = await startRepoProbe();

const ID = "cloud-lab-3";
const LOGIN = "alice";
const GITHUB_ID = 424242;

const assignment = (over = {}) => {
  const doc = {
    schema_version: 1,
    id: ID,
    title: "Cloud Lab 3",
    organization: "TestOrg",
    state: "published",
    assignment_type: "individual",
    // ENFORCED: the mode that collects no address at all on the acceptance
    // path, so the one where a confirmation has to work if it means anything.
    roster_mode: "enforced",
    opens_at: "2026-01-01T00:00:00Z",
    deadline_at: "2099-01-01T00:00:00Z",
    template: { owner: "TestOrg", repository: "tpl" },
    repository_name_pattern: `${ID}-{github_login}`,
    claim_domains: ["student.pxl.be"],
    ...over,
  };
  return Object.entries(doc)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join("\n") + "\n";
};

function makeDir({ over = {}, roster = null, claims = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pxl-confirm-"));
  mkdirSync(join(dir, "assignments"), { recursive: true });
  writeFileSync(join(dir, "assignments", `${ID}.yml`), assignment(over));
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

function run(dir, env = {}) {
  const outFile = join(dir, "out.env");
  writeFileSync(outFile, "");
  const res = spawnSync("node", [acceptScript], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...probe.env,
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
  const raw = existsSync(outFile) ? readFileSync(outFile, "utf8") : "";
  const outputs = Object.fromEntries(
    raw.split("\n").filter(Boolean).map((l) => {
      const [k, ...v] = l.split("=");
      return [k, v.join("=")];
    }),
  );
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "", outputs, raw };
}

const readClaim = (dir, id = GITHUB_ID) =>
  JSON.parse(readFileSync(join(dir, "students", "claims", `${id}.json`), "utf8"));

const keys = await generateClaimKeypair();
const seal = async (email, githubId = GITHUB_ID) =>
  encryptClaim({ publicKey: keys.publicKey, email, githubId, assignmentId: ID });

const SEALED = {
  alice: await seal("alice.janssens@student.pxl.be"),
  // The form deployment.yml asks for; `alice@` above has no dot, so it is the
  // NUMBER-FORM stand-in for the re-identification tests at the end.
  aliceNamed: await seal("alice.peeters@student.pxl.be"),
  aliceNumber: await seal("12345678@student.pxl.be"),
  offDomain: await seal("alice@gmail.com"),
  replayed: await seal("victim@student.pxl.be", 111111),
};

const confirm = (extra = {}) => ({ KIND: "confirm", CLAIM_PRIVATE_KEY: keys.privateKey, ...extra });

// ------------------------------------------------------------- the happy path

test("THE FLOW: a confirmation records the binding and provisions nothing", () => {
  const dir = makeDir();
  const res = run(dir, confirm({ CLAIM_PAYLOAD: SEALED.alice, CLAIM_VERIFIED: "true" }));

  assert.equal(res.status, 0);
  assert.equal(res.outputs.outcome, "confirmed");
  const rec = readClaim(dir);
  assert.equal(rec.email, "alice.janssens@student.pxl.be");
  assert.equal(rec.github_login, LOGIN);
  assert.equal(rec.claim_verified, true);

  // NOTHING ELSE HAPPENED. The provisioning step gates on `accepted`
  // explicitly, and these are the outputs that would carry a repository.
  assert.equal(res.outputs.target_repo, undefined);
  assert.equal(res.outputs.template_owner, undefined);
  assert.ok(!existsSync(join(dir, "acceptances")), "no acceptance record was written");
});

test("a second confirmation is idempotent, and SAYS which it was", () => {
  // Org-scoped, exactly as under `claim`: a student bound on an earlier
  // assignment is not asked again. `already-confirmed` mirrors
  // `already-accepted` so a lecturer reading a run log does not have to guess.
  // A binding that MEETS the rules; one that does not is asked again (below).
  const dir = makeDir();
  assert.equal(run(dir, confirm({ CLAIM_PAYLOAD: SEALED.aliceNamed })).outputs.outcome, "confirmed");
  const again = run(dir, confirm({ CLAIM_PAYLOAD: SEALED.aliceNamed }));
  assert.equal(again.outputs.outcome, "already-confirmed");
  assert.equal(readdirSync(join(dir, "students", "claims")).length, 1);
});

test("the roster supplies a student number when it happens to know one", () => {
  const dir = makeDir({
    roster: {
      schema_version: 2,
      students: [{ student_number: "0123456", full_name: "Alice", email: "alice.janssens@student.pxl.be" }],
    },
  });
  run(dir, confirm({ CLAIM_PAYLOAD: SEALED.alice }));
  assert.equal(readClaim(dir).student_number, "0123456");
});

test("an UNREADABLE roster does not refuse somebody telling us who they are", () => {
  // The roster is a convenience here, not a gate. Failing on it would refuse a
  // confirmation over a file that has nothing to do with the question.
  const dir = makeDir();
  mkdirSync(join(dir, "students"), { recursive: true });
  writeFileSync(join(dir, "students", "roster.yml"), "{{{ not yaml");
  const res = run(dir, confirm({ CLAIM_PAYLOAD: SEALED.alice }));
  assert.equal(res.outputs.outcome, "confirmed");
  assert.equal(readClaim(dir).student_number, null);
});

// -------------------------------------------------- what it deliberately skips

test("THE WINDOW IS NOT CHECKED - the weeks after a deadline are when this is needed", () => {
  // A confirmation hands out nothing, so `past-deadline` has nothing to
  // protect - and the fortnight after a deadline is exactly when a lecturer
  // reads their roster and finds rows with a login and nothing else.
  const dir = makeDir({ over: { deadline_at: "2020-01-01T00:00:00Z", opens_at: "2019-01-01T00:00:00Z" } });
  assert.equal(run(dir, confirm({ CLAIM_PAYLOAD: SEALED.alice })).outputs.outcome, "confirmed");
});

test("…nor is opens_at, so a cohort can be identified before an exam starts", () => {
  const dir = makeDir({ over: { opens_at: "2099-01-01T00:00:00Z" } });
  assert.equal(run(dir, confirm({ CLAIM_PAYLOAD: SEALED.alice })).outputs.outcome, "confirmed");
});

test("…nor max_acceptances, which counts repositories and hands out none here", () => {
  const dir = makeDir({ over: { roster_mode: "open", max_acceptances: 0 } });
  assert.equal(run(dir, confirm({ CLAIM_PAYLOAD: SEALED.alice })).outputs.outcome, "confirmed");
});

test("…nor the roster gate, in the mode where the roster IS the gate", () => {
  // A login that is on no roster at all. Under `enforced` this is
  // rejected:not-on-roster for an acceptance; a confirmation is how somebody
  // gets ONTO the roster, so gating it there would be a closed loop.
  const dir = makeDir({ roster: { schema_version: 2, students: [] } });
  assert.equal(run(dir, confirm({ CLAIM_PAYLOAD: SEALED.alice })).outputs.outcome, "confirmed");
});

test("BUT a draft assignment is still refused - a draft has no live link of any kind", () => {
  const dir = makeDir({ over: { state: "draft" } });
  const res = run(dir, confirm({ CLAIM_PAYLOAD: SEALED.alice }));
  assert.equal(res.outputs.outcome, "rejected:not-published");
});

test("…and so is an assignment that does not exist", () => {
  const dir = mkdtempSync(join(tmpdir(), "pxl-confirm-empty-"));
  assert.equal(run(dir, confirm({ CLAIM_PAYLOAD: SEALED.alice })).outputs.outcome, "rejected:no-assignment");
});

// -------------------------------------------- every shrug becomes a refusal

test("NO PAYLOAD IS A REFUSAL here, where under open it is a shrug", () => {
  // The address is the entire outcome. Reporting success with nothing recorded
  // would be the UI-lies-about-the-system failure at the other end of the wire.
  const dir = makeDir();
  const res = run(dir, confirm());
  assert.match(res.outputs.outcome, /^rejected:/);
  assert.match(res.outputs.reject_reason, /nothing to confirm/i);
});

test("an UNREADABLE payload is refused, not silently dropped", () => {
  const dir = makeDir();
  const res = run(dir, confirm({ CLAIM_PAYLOAD: "not-ciphertext" }));
  assert.match(res.outputs.outcome, /^rejected:/);
});

test("A PAYLOAD NAMING ANOTHER ACCOUNT binds nobody", () => {
  // The anti-replay check, kept even though nothing is being gated: the output
  // is a record asserting who somebody IS, and a false one is worse than none.
  const dir = makeDir();
  const res = run(dir, confirm({ CLAIM_PAYLOAD: SEALED.replayed }));
  assert.match(res.outputs.outcome, /^rejected:/);
  assert.ok(!existsSync(join(dir, "students", "claims")), "no record was written for anyone");
});

test("a MISSING HUB KEY fails red rather than reporting a confirmation nobody made", () => {
  const dir = makeDir();
  const res = run(dir, { KIND: "confirm", CLAIM_PAYLOAD: SEALED.alice });
  assert.equal(res.status, 1);
  assert.match(res.outputs.outcome, /^fail:/);
});

test("an off-domain or number-form address is REFUSED by a confirmation, not recorded as confirmed - and not counted", () => {
  // A confirmation has no repository behind it: the address is the whole
  // outcome. Recording one outside the rules reported "confirmed" over a
  // binding the next acceptance asks again for. The allowed domains are
  // public on the student's page, so refusing reveals nothing. Reviewed
  // 2026-09-26: a stale page or a hand-made issue got a success outcome.
  const dir = makeDir();
  const off = run(dir, confirm({ CLAIM_PAYLOAD: SEALED.offDomain }));
  assert.equal(off.outputs.outcome, "rejected:claim-domain");
  const num = run(dir, confirm({ CLAIM_PAYLOAD: SEALED.aliceNumber }));
  assert.equal(num.outputs.outcome, "rejected:claim-format");
  assert.equal(existsSync(join(dir, "students", "claims", `${GITHUB_ID}.json`)), false, "nothing written");
  assert.equal(existsSync(join(dir, "students", "claim-attempts", `${GITHUB_ID}.json`)), false, "nothing counted");
});

test("no attempt counter is touched - nothing is refused on roster grounds", () => {
  // The counter exists because under `claim` a refusal tells a guesser whether
  // an address is on the roster. A confirmation refuses nothing on those
  // grounds, so it reveals nothing, so it counts nothing. Burning attempts here
  // would lock a student out of the very door that identifies them.
  const dir = makeDir();
  for (let i = 0; i < 8; i++) run(dir, confirm({ CLAIM_PAYLOAD: "garbage" }));
  assert.ok(!existsSync(join(dir, "students", "claim-attempts")), "no counter directory");
  assert.equal(run(dir, confirm({ CLAIM_PAYLOAD: SEALED.alice })).outputs.outcome, "confirmed");
});

// ------------------------------------------------------------------ the kind

test("AN ABSENT KIND IS ACCEPT, and must be", () => {
  // Every dispatch made before confirmation existed carries no kind, and a
  // broker published before it never sends one. Reading absent as anything else
  // stops provisioning for every live assignment at once.
  const dir = makeDir({
    roster: { schema_version: 2, students: [{ student_number: "1", full_name: "Alice", github_login: LOGIN }] },
  });
  const res = run(dir, { CLAIM_PRIVATE_KEY: keys.privateKey });
  assert.equal(res.outputs.outcome, "accepted");
  assert.ok(res.outputs.target_repo, "an acceptance provisions");
});

test("AN UNKNOWN KIND FAILS rather than guessing either way", () => {
  // Guessing accept would provision off a purpose nobody established; guessing
  // confirm would silently stop provisioning a whole cohort. Neither is
  // survivable, so it refuses and names the value it got.
  for (const bad of ["Confirm", "accepts", "reject", "true"]) {
    const dir = makeDir();
    const res = run(dir, { KIND: bad, CLAIM_PRIVATE_KEY: keys.privateKey });
    assert.equal(res.status, 1, `expected a hard failure for ${bad}`);
    assert.equal(res.outputs.outcome, "fail:validation");
    assert.match(res.stderr + res.stdout, /unknown kind/i);
  }
});

test("`accept` spelled out behaves exactly like an absent kind", () => {
  const dir = makeDir({
    roster: { schema_version: 2, students: [{ student_number: "1", full_name: "Alice", github_login: LOGIN }] },
  });
  const res = run(dir, { KIND: "accept", CLAIM_PRIVATE_KEY: keys.privateKey });
  assert.equal(res.outputs.outcome, "accepted");
});

test("a confirmation never produces an outcome the provisioning step fires on", () => {
  // acceptance-handler.yml gates on `accepted` / `already-accepted`. This is
  // the assertion that keeps the two confirm outcomes from ever colliding with
  // them - a rename that broke it would otherwise provision off a confirmation.
  const dir = makeDir();
  for (const payload of [SEALED.alice, SEALED.alice]) {
    const outcome = run(dir, confirm({ CLAIM_PAYLOAD: payload })).outputs.outcome;
    assert.ok(
      !["accepted", "already-accepted"].includes(outcome),
      `confirm produced ${outcome}, which provisions`,
    );
  }
});

// ------------------------------------------------ re-identification (2026-09-26)
//
// 16 of 111 students of .NET Advanced had confirmed `<number>@student.pxl.be`,
// which does not tell a lecturer who they are. Before this, a binding was
// final: every later link and acceptance said "already confirmed" and ignored
// what the student sent. A binding that fails TODAY's rules (the
// firstname.lastname form deployment.yml asks for) is now asked again.

const numberBinding = () => ({
  schema_version: 1, github_login: LOGIN, github_id: GITHUB_ID, email: "12345678@student.pxl.be",
  domain_allowed: true, claim_verified: true, student_number: null,
  claimed_at: "2026-09-10T08:00:00.000Z", claimed_via: "earlier",
});

test("THE CASE: a number-form binding is REPLACED by a name-form confirmation, and what it replaced is kept", () => {
  const dir = makeDir({ claims: [numberBinding()] });
  const res = run(dir, confirm({ CLAIM_PAYLOAD: SEALED.aliceNamed, CLAIM_VERIFIED: "true" }));
  assert.equal(res.status, 0, res.stdout);
  assert.equal(res.outputs.outcome, "confirmed", "not already-confirmed: the old one no longer counts");
  const rec = readClaim(dir);
  assert.equal(rec.email, "alice.peeters@student.pxl.be");
  assert.deepEqual(rec.replaces, { email: "12345678@student.pxl.be", claimed_at: "2026-09-10T08:00:00.000Z" });
  assert.match(res.stdout, /no longer meets the rules/);
});

test("a name-form binding is NOT asked again - nobody is re-asked for a rule they already meet", () => {
  const dir = makeDir({ claims: [{ ...numberBinding(), email: "alice.peeters@student.pxl.be" }] });
  // Sending a WORSE address to the link is refused for its form - never
  // recorded - and the valid binding stands.
  const worse = run(dir, confirm({ CLAIM_PAYLOAD: SEALED.aliceNumber }));
  assert.equal(worse.outputs.outcome, "rejected:claim-format");
  assert.equal(readClaim(dir).email, "alice.peeters@student.pxl.be", "a valid binding is not overwritten by a worse one");
  assert.equal(readClaim(dir).replaces, undefined);
  // The SAME address again is idempotent.
  assert.equal(run(dir, confirm({ CLAIM_PAYLOAD: SEALED.aliceNamed })).outputs.outcome, "already-confirmed");
  assert.equal(readClaim(dir).replaces, undefined);
});

test("a confirmation of a DIFFERENT valid address CORRECTS the binding - the link could never fix a wrong one", () => {
  // Review 2026-09-26: bound to a well-formed address the roster does not
  // hold, the link answered "already confirmed" to every correction.
  const dir = makeDir({ claims: [{ ...numberBinding(), email: "alice.wrong@student.pxl.be" }] });
  const res = run(dir, confirm({ CLAIM_PAYLOAD: SEALED.aliceNamed }));
  assert.equal(res.outputs.outcome, "confirmed");
  assert.equal(readClaim(dir).email, "alice.peeters@student.pxl.be");
  assert.equal(readClaim(dir).replaces.email, "alice.wrong@student.pxl.be");
});

test("a confirm link opened with NOTHING sent still refuses - and names the address that no longer counts", () => {
  const dir = makeDir({ claims: [numberBinding()] });
  const res = run(dir, confirm());
  assert.equal(res.outputs.outcome, "rejected:no-claim");
  assert.match(res.stdout + res.stderr, /12345678@student\.pxl\.be, which no longer counts - the firstname\.lastname@ form is required/);
  assert.equal(readClaim(dir).email, "12345678@student.pxl.be", "nothing was lost");
});

// Under `roster_mode: claim` the address IS the gate, so the form refuses.
const claimMode = { roster_mode: "claim", max_acceptances: 50 };
const namedRoster = { schema_version: 2, students: [{ student_number: "0999", full_name: "Alice Peeters", email: "alice.peeters@student.pxl.be" }] };

test("CLAIM MODE: a number-form address is refused with its OWN reason, not as a wrong domain", () => {
  const dir = makeDir({ over: claimMode, roster: namedRoster });
  const res = run(dir, { CLAIM_PRIVATE_KEY: keys.privateKey, CLAIM_PAYLOAD: SEALED.aliceNumber });
  assert.equal(res.outputs.outcome, "rejected:claim-format");
  assert.match(res.stdout + res.stderr, /does not say who you are\. Use the firstname\.lastname@ form/);
  assert.ok(!existsSync(join(dir, "students", "claims", `${GITHUB_ID}.json`)), "nothing bound");
  // The form is public, so this refusal reveals nothing about the roster -
  // and under `claim` the page offers every address, so it must not cost one.
  assert.ok(!existsSync(join(dir, "students", "claim-attempts", `${GITHUB_ID}.json`)), "not counted");
});

test("CLAIM MODE: a stale number-form binding is asked again, and the name form replaces it", () => {
  const dir = makeDir({ over: claimMode, roster: namedRoster, claims: [numberBinding()] });
  const res = run(dir, { CLAIM_PRIVATE_KEY: keys.privateKey, CLAIM_PAYLOAD: SEALED.aliceNamed, CLAIM_VERIFIED: "true" });
  assert.equal(res.outputs.outcome, "accepted", res.stdout + res.stderr);
  const rec = readClaim(dir);
  assert.equal(rec.email, "alice.peeters@student.pxl.be");
  assert.equal(rec.student_number, "0999");
  assert.equal(rec.replaces.email, "12345678@student.pxl.be");
});

test("CLAIM MODE: sending the number form again after being asked is refused, and the old binding stays", () => {
  const dir = makeDir({ over: claimMode, roster: namedRoster, claims: [numberBinding()] });
  const res = run(dir, { CLAIM_PRIVATE_KEY: keys.privateKey, CLAIM_PAYLOAD: SEALED.aliceNumber });
  assert.equal(res.outputs.outcome, "rejected:claim-format");
  assert.equal(readClaim(dir).email, "12345678@student.pxl.be");
});

// --- a REUSED binding passes the same gates a new claim does (review 2026-09-26)
//
// The binding is org-wide and written by three paths - the claim gate, open
// enrolment and the confirm link - and only the claim gate checked the roster
// and the cohort. Reusing one unchecked admitted, measured by the review:
// a student outside the cohort, anybody who had confirmed any address by the
// link, and a second account holding somebody else's address.

const namedBinding = (over = {}) => ({ ...numberBinding(), email: "alice.peeters@student.pxl.be", ...over });

test("REUSE: bound and in the cohort is accepted without asking again (the ordinary case)", () => {
  const dir = makeDir({ over: claimMode, roster: namedRoster, claims: [namedBinding()] });
  const res = run(dir, { CLAIM_PRIVATE_KEY: keys.privateKey });
  assert.equal(res.outputs.outcome, "accepted", res.stdout + res.stderr);
});

test("REUSE: bound, on the roster, NOT in this assignment's cohort is refused - and nothing counted", () => {
  const dir = makeDir({ over: { ...claimMode, cohort: ["num:0888"] }, roster: namedRoster, claims: [namedBinding()] });
  const res = run(dir, { CLAIM_PRIVATE_KEY: keys.privateKey });
  assert.equal(res.outputs.outcome, "rejected:not-in-cohort");
  assert.ok(!existsSync(join(dir, "students", "claim-attempts")), "not a guess, so not counted");
});

test("REUSE: bound by the confirm link to an address NOT on the roster is asked again, never admitted", () => {
  const dir = makeDir({ over: claimMode, roster: namedRoster, claims: [namedBinding({ email: "mal.lory@student.pxl.be" })] });
  const res = run(dir, { CLAIM_PRIVATE_KEY: keys.privateKey });
  assert.equal(res.outputs.outcome, "rejected:no-claim");
  assert.ok(!existsSync(join(dir, "acceptances")), "no acceptance");
});

test("REUSE: a binding to an address an EARLIER binding holds is refused as taken", () => {
  const first = { ...namedBinding(), github_login: "the-real-alice", github_id: 1, claimed_at: "2026-09-01T00:00:00.000Z" };
  const dir = makeDir({ over: claimMode, roster: namedRoster, claims: [first, namedBinding({ claimed_at: "2026-09-20T00:00:00.000Z" })] });
  const res = run(dir, { CLAIM_PRIVATE_KEY: keys.privateKey });
  assert.equal(res.outputs.outcome, "rejected:claim-taken");
});

test("REUSE: ...and the EARLIER holder of a duplicated address is still admitted", () => {
  const later = { ...namedBinding(), github_login: "mallory", github_id: 2, claimed_at: "2026-09-20T00:00:00.000Z" };
  const dir = makeDir({ over: claimMode, roster: namedRoster, claims: [later, namedBinding({ claimed_at: "2026-09-01T00:00:00.000Z" })] });
  const res = run(dir, { CLAIM_PRIVATE_KEY: keys.privateKey });
  assert.equal(res.outputs.outcome, "accepted", res.stdout + res.stderr);
});

// A roster that REGISTERS the number form: the name form is not on it, so
// refusing the number form left the student with no address that could get in.
const numberRoster = { schema_version: 2, students: [{ student_number: "0999", full_name: "Alice Peeters", email: "12345678@student.pxl.be" }] };

test("CLAIM MODE: a number-form address the ROSTER registers is admitted - new claim and reused binding", () => {
  const fresh = makeDir({ over: claimMode, roster: numberRoster });
  const res = run(fresh, { CLAIM_PRIVATE_KEY: keys.privateKey, CLAIM_PAYLOAD: SEALED.aliceNumber });
  assert.equal(res.outputs.outcome, "accepted", res.stdout + res.stderr);
  assert.equal(readClaim(fresh).student_number, "0999");
  const bound = makeDir({ over: claimMode, roster: numberRoster, claims: [numberBinding()] });
  assert.equal(run(bound, { CLAIM_PRIVATE_KEY: keys.privateKey }).outputs.outcome, "accepted");
});

test("a DOMAIN-only stale binding is told about the domain, not the form", () => {
  const dir = makeDir({ over: { roster_mode: "open", max_acceptances: 50, require_claim: true }, claims: [namedBinding({ email: "alice.peeters@gmail.com" })] });
  const res = run(dir, { CLAIM_PRIVATE_KEY: keys.privateKey });
  assert.equal(res.outputs.outcome, "rejected:no-claim");
  assert.match(res.stdout + res.stderr, /alice\.peeters@gmail\.com, which is not an accepted address here/);
  assert.doesNotMatch(res.stdout + res.stderr, /form is required/);
});

test("an assignment that switched the form OFF keeps treating the number form as done - it is not asked again", () => {
  // The ACCEPTANCE path, where "asked again" happens: an open assignment that
  // requires an address reuses the number-form binding without a payload.
  const dir = makeDir({ over: { claim_address_format: false, roster_mode: "open", max_acceptances: 50, require_claim: true }, claims: [numberBinding()] });
  const res = run(dir, { CLAIM_PRIVATE_KEY: keys.privateKey });
  assert.equal(res.outputs.outcome, "accepted", res.stdout + res.stderr);
  assert.equal(readClaim(dir).email, "12345678@student.pxl.be");
});
