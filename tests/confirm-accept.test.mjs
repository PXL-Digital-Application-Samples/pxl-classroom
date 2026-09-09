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
  alice: await seal("alice@student.pxl.be"),
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
  assert.equal(rec.email, "alice@student.pxl.be");
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
  const dir = makeDir();
  assert.equal(run(dir, confirm({ CLAIM_PAYLOAD: SEALED.alice })).outputs.outcome, "confirmed");
  const again = run(dir, confirm({ CLAIM_PAYLOAD: SEALED.alice }));
  assert.equal(again.outputs.outcome, "already-confirmed");
  assert.equal(readdirSync(join(dir, "students", "claims")).length, 1);
});

test("the roster supplies a student number when it happens to know one", () => {
  const dir = makeDir({
    roster: {
      schema_version: 2,
      students: [{ student_number: "0123456", full_name: "Alice", email: "alice@student.pxl.be" }],
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

test("an off-domain address is RECORDED and flagged, not refused", () => {
  // Detection, not prevention - the same call `open` makes. Refusing on domain
  // would be a guessing oracle about which domains exist, and the lecturer's
  // roster shows the flag beside the address either way.
  const dir = makeDir();
  const res = run(dir, confirm({ CLAIM_PAYLOAD: SEALED.offDomain }));
  assert.equal(res.outputs.outcome, "confirmed");
  assert.equal(readClaim(dir).domain_allowed, false);
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
