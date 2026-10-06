// acceptance/accept.mjs under group_config.require_join_code: every decision
// the hub makes about a team's join code, run as the real script against a
// control-repo checkout on disk.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { startRepoProbe } from "./fixtures/repo-probe.mjs";
import { encryptClaim, encryptTeamCode, generateClaimKeypair } from "../lib/claim.mjs";
import { newJoinCode } from "../lib/team-join-code.mjs";
import { rejectionReason } from "../lib/rejection-notice.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const acceptScript = join(here, "..", "acceptance", "accept.mjs");
const probe = await startRepoProbe();
const keys = await generateClaimKeypair();
const retired = await generateClaimKeypair();

const ASSIGNMENT = "lab";
const IDS = { ann: 101, bob: 102, cem: 103 };

const yaml = ({ codes = true, extra = "" } = {}) => `state: published
assignment_type: group
repository_name_pattern: "lab-{team_slug}"
group_config:
  max_team_size: 3
${codes === "absent" ? "" : `  require_join_code: ${codes}\n`}${extra}template:
  owner: TestOrg
  repository: tpl`;

const CODE = newJoinCode();
const OTHER_CODE = newJoinCode();

const team = (slug, members, more = {}) => ({
  schema_version: 1,
  assignment_id: ASSIGNMENT,
  team_slug: slug,
  team_name: slug,
  members,
  max_members: 3,
  created_at: "2026-10-06T10:00:00.000Z",
  created_by: members[0] || "lecturer",
  ...more,
});

const sealFor = (login, { code = CODE, slug = "alpha", assignmentId = ASSIGNMENT, githubId = IDS[login], publicKey = keys.publicKey } = {}) =>
  encryptTeamCode({ publicKey, code, githubId, assignmentId, teamSlug: slug });

/** One acceptance. `teams` and `acceptances` seed the checkout. */
function accept(login, { slug = "alpha", payload = "", assignmentYaml = yaml(), teams = {}, acceptances = {}, env = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pxl-team-code-"));
  mkdirSync(join(dir, "students"), { recursive: true });
  writeFileSync(join(dir, "students", "roster.yml"), JSON.stringify({
    schema_version: 2,
    students: Object.keys(IDS).map((l, i) => ({ student_number: `S${i}`, github_login: l })),
  }));
  mkdirSync(join(dir, "assignments"), { recursive: true });
  writeFileSync(join(dir, "assignments", `${ASSIGNMENT}.yml`), assignmentYaml);
  mkdirSync(join(dir, "teams", ASSIGNMENT), { recursive: true });
  for (const [s, doc] of Object.entries(teams)) {
    writeFileSync(join(dir, "teams", ASSIGNMENT, `${s}.json`), JSON.stringify(doc));
  }
  if (Object.keys(acceptances).length) mkdirSync(join(dir, "acceptances", ASSIGNMENT), { recursive: true });
  for (const [l, doc] of Object.entries(acceptances)) {
    writeFileSync(join(dir, "acceptances", ASSIGNMENT, `${l}.json`), JSON.stringify(doc));
  }
  const out = join(dir, "out.env");
  const res = spawnSync("node", [acceptScript], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...probe.env,
      DATA_DIR: dir,
      GITHUB_OUTPUT: out,
      ASSIGNMENT_ID: ASSIGNMENT,
      GITHUB_LOGIN: login,
      GITHUB_ID: String(IDS[login]),
      TEAM_SLUG: slug,
      TEAM_NAME: slug,
      TEAM_CODE_PAYLOAD: payload,
      CLAIM_PRIVATE_KEY: keys.privateKey,
      CLAIM_PRIVATE_KEYS_RETIRED: "",
      ...env,
    },
  });
  const outputs = Object.fromEntries(
    (existsSync(out) ? readFileSync(out, "utf8") : "").split("\n").filter(Boolean).map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i), l.slice(i + 1)];
    }),
  );
  const teamFile = (s) => {
    const p = join(dir, "teams", ASSIGNMENT, `${s}.json`);
    return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
  };
  return { status: res.status, outputs, teamFile, log: res.stdout + res.stderr };
}

const refusedForCode = (r) => {
  assert.equal(r.status, 0, r.log);
  assert.equal(r.outputs.outcome, "rejected:team-code", r.log);
};

// --- creating a team ---------------------------------------------------------

test("creating a team under codes stores the code the creator's page made", async () => {
  const r = accept("ann", { payload: await sealFor("ann") });
  assert.equal(r.outputs.outcome, "accepted", r.log);
  assert.equal(r.teamFile("alpha").join_code, CODE);
  assert.deepEqual(r.teamFile("alpha").members, ["ann"]);
});

test("creating a team under codes without one is refused, and no team is written", () => {
  const r = accept("ann");
  refusedForCode(r);
  assert.equal(r.teamFile("alpha"), null);
});

test("a creation is refused when the sealed code was made for anyone or anything else", async () => {
  for (const [why, payload] of [
    ["another account", await sealFor("ann", { githubId: IDS.bob })],
    ["another team", await sealFor("ann", { slug: "beta" })],
    ["another assignment", await sealFor("ann", { assignmentId: "other-lab" })],
    ["another hub's key", await sealFor("ann", { publicKey: (await generateClaimKeypair()).publicKey })],
    ["a code that fails its own check", await sealFor("ann", { code: CODE.slice(0, 5) + (CODE[5] === "2" ? "3" : "2") })],
    ["a claim in the code's place", await encryptClaim({ publicKey: keys.publicKey, email: "ann.peeters@student.pxl.be", githubId: IDS.ann, assignmentId: ASSIGNMENT })],
    ["junk", "t1.not.a.code"],
  ]) {
    const r = accept("ann", { payload });
    assert.equal(r.outputs.outcome, "rejected:team-code", `${why}: ${r.log}`);
    assert.equal(r.teamFile("alpha"), null, why);
  }
});

test("without codes a team is made with none, even if a page sent one", async () => {
  for (const assignmentYaml of [yaml({ codes: "absent" }), yaml({ codes: false })]) {
    const r = accept("ann", { payload: await sealFor("ann"), assignmentYaml });
    assert.equal(r.outputs.outcome, "accepted", r.log);
    assert.equal(r.teamFile("alpha").join_code, undefined);
  }
});

test("a code sealed to a retired key still creates the team", async () => {
  const r = accept("ann", {
    payload: await sealFor("ann", { publicKey: retired.publicKey }),
    env: { CLAIM_PRIVATE_KEYS_RETIRED: retired.privateKey },
  });
  assert.equal(r.outputs.outcome, "accepted", r.log);
  assert.equal(r.teamFile("alpha").join_code, CODE);
});

test("a code the hub has no key to read is the deployment's fault, not the student's", async () => {
  const r = accept("ann", { payload: await sealFor("ann"), env: { CLAIM_PRIVATE_KEY: "" } });
  assert.equal(r.status, 1, r.log);
  assert.equal(r.outputs.outcome, "fail:config");
});

// --- joining one -------------------------------------------------------------

const alpha = (more = {}) => ({ alpha: team("alpha", ["ann"], { join_code: CODE, ...more }) });

test("joining a team with its code: admitted, and the code is unchanged", async () => {
  const r = accept("bob", { teams: alpha(), payload: await sealFor("bob") });
  assert.equal(r.outputs.outcome, "accepted", r.log);
  assert.deepEqual(r.teamFile("alpha").members, ["ann", "bob"]);
  assert.equal(r.teamFile("alpha").join_code, CODE);
});

test("joining without the code, with another team's, or with ann's copied ciphertext is refused - and the team is untouched", async () => {
  for (const [why, payload] of [
    ["no code", ""],
    ["another team's code", await sealFor("bob", { code: OTHER_CODE })],
    ["ann's sealed code, copied from the public archive", await sealFor("ann")],
  ]) {
    const r = accept("bob", { teams: alpha(), payload });
    assert.equal(r.outputs.outcome, "rejected:team-code", `${why}: ${r.log}`);
    assert.deepEqual(r.teamFile("alpha").members, ["ann"], why);
  }
});

test("a team with no code is open: made before the setting, seeded, or the lecturer's", () => {
  for (const doc of [
    team("alpha", ["ann"]),
    team("alpha", ["ann"], { seeded_from: { source: "roster", seeded_at: "2026-10-01T00:00:00Z" } }),
    team("alpha", [], { created_by: "lecturer" }),
  ]) {
    const r = accept("bob", { teams: { alpha: doc } });
    assert.equal(r.outputs.outcome, "accepted", r.log);
    assert.ok(r.teamFile("alpha").members.includes("bob"));
    assert.equal(r.teamFile("alpha").join_code, undefined, "a lecturer's empty team is not given a code by whoever joins first");
  }
});

test("unticking the setting opens every team; ticking it again closes the ones with a code", () => {
  const off = accept("bob", { teams: alpha(), assignmentYaml: yaml({ codes: false }) });
  assert.equal(off.outputs.outcome, "accepted", off.log);
  const on = accept("bob", { teams: alpha() });
  refusedForCode(on);
});

test("a code that is there but unreadable locks the team rather than opening it", async () => {
  const r = accept("bob", { teams: alpha({ join_code: "hand-edited" }), payload: await sealFor("bob") });
  refusedForCode(r);
});

test("a member coming back needs no code", () => {
  const r = accept("ann", { teams: alpha() });
  assert.notEqual(r.outputs.outcome, "rejected:team-code", r.log);
});

test("the code is asked before the size, so a full team says so only to someone who has the code", async () => {
  const full = { alpha: team("alpha", ["ann", "cem", "dirk"], { join_code: CODE }) };
  refusedForCode(accept("bob", { teams: full }));
  const r = accept("bob", { teams: full, payload: await sealFor("bob") });
  assert.equal(r.outputs.outcome, "rejected:team-full", r.log);
});

test("a creation that meets a team made a moment earlier under the same name is refused, not merged", async () => {
  // Two students typed "alpha" at once; ann's was saved first. bob's page
  // made its own fresh code, which opens nothing here.
  const r = accept("bob", { teams: alpha(), payload: await sealFor("bob", { code: OTHER_CODE }), env: { TEAM_ACTION: "create" } });
  refusedForCode(r);
  assert.deepEqual(r.teamFile("alpha").members, ["ann"]);
});

// --- switching ---------------------------------------------------------------

const switching = (more = {}) => ({
  ...alpha(),
  beta: team("beta", ["bob"], { join_code: OTHER_CODE }),
  ...more,
});
const bobAccepted = { bob: { github_login: "bob", github_id: IDS.bob, assignment_id: ASSIGNMENT, team_slug: "beta", target_repo: "lab-beta", accepted_at: "2026-10-06T10:00:00Z" } };

test("switching into a team with a code needs that code", async () => {
  const refused = accept("bob", { teams: switching(), acceptances: bobAccepted, env: { TEAM_ACTION: "switch" } });
  refusedForCode(refused);
  const r = accept("bob", { teams: switching(), acceptances: bobAccepted, payload: await sealFor("bob"), env: { TEAM_ACTION: "switch" } });
  assert.equal(r.outputs.outcome, "accepted", r.log);
  assert.deepEqual(r.teamFile("alpha").members, ["ann", "bob"]);
  assert.equal(r.teamFile("beta").vacant, true);
  assert.equal(r.teamFile("beta").join_code, OTHER_CODE, "a team being left keeps its code until someone makes it again");
});

// --- a team everybody left ---------------------------------------------------

const vacantAlpha = () => ({ alpha: team("alpha", [], { join_code: OTHER_CODE, vacant: true, created_by: "ann" }) });

test("a team everybody left is made again by whoever enters it, with their new code", async () => {
  // ann made alpha, then switched to bob's team. cem types "alpha" - the page
  // does not list a vacant team - and must not need a code nobody can give.
  const r = accept("cem", { teams: vacantAlpha(), payload: await sealFor("cem") });
  assert.equal(r.outputs.outcome, "accepted", r.log);
  assert.deepEqual(r.teamFile("alpha").members, ["cem"]);
  assert.equal(r.teamFile("alpha").join_code, CODE, "the new code, not the one that left with ann");
  assert.notEqual(r.teamFile("alpha").vacant, true);
  // And the next student needs the NEW code.
  const next = accept("bob", { teams: { alpha: r.teamFile("alpha") }, payload: await sealFor("bob", { code: OTHER_CODE }) });
  refusedForCode(next);
});

test("entering a team everybody left needs a fresh code under codes, and drops the old one without", async () => {
  refusedForCode(accept("cem", { teams: vacantAlpha() }));
  const off = accept("cem", { teams: vacantAlpha(), assignmentYaml: yaml({ codes: false }) });
  assert.equal(off.outputs.outcome, "accepted", off.log);
  assert.equal(off.teamFile("alpha").join_code, undefined, "an old code must not come back into force if codes are switched on");
});

// --- what the lecturer reads -------------------------------------------------

test("the refusal has words for the lecturer, and no code is ever written to the log or a notice", async () => {
  assert.equal(rejectionReason("rejected:team-code"), "did not have the team's join code");
  const r = accept("bob", { teams: alpha(), payload: await sealFor("bob", { code: OTHER_CODE }) });
  refusedForCode(r);
  for (const code of [CODE, OTHER_CODE]) {
    assert.ok(!r.log.includes(code), "the log is public");
    assert.ok(!(r.outputs.reject_reason || "").includes(code), "the reason reaches a notice");
  }
});
