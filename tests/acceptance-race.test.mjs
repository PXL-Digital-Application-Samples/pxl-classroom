// End to end: many acceptances at once, against one control repository, with
// GitHub failing some of the time.
//
// On 2026-10-02 a per-team GitHub concurrency group was the only thing keeping
// a team at its size, and a single stuck run blocked a whole team. The group is
// gone (lib/acceptance-reservation.mjs). These run the REAL pipeline -
// acceptance/reserve.mjs around the real accept.mjs, real git, and
// scripts/record-acceptance.sh - as concurrent processes, then check the
// control repository against the invariants the group used to protect:
//
//   * no team holds more than max_team_size
//   * no student is in two teams
//   * every acceptance record's team lists that student, and vice versa
//   * every repository record names the repository of the student's team
//   * every admitted run's record reached the remote

import { test } from "node:test";
import assert from "node:assert/strict";
import { flaky, hubRun as runHub, lostAnswer, remoteDir, remoteJson, remoteWith, checkout } from "./fixtures/control-remote.mjs";
import { startRepoProbe } from "./fixtures/repo-probe.mjs";
import { encryptTeamCode, generateClaimKeypair } from "../lib/claim.mjs";
import { newJoinCode } from "../lib/team-join-code.mjs";

const probe = await startRepoProbe();
Object.assign(process.env, probe.env);

// GitHub, as far as accept.mjs can ask it: a repository exists once a run's
// provisioning stand-in has created it, and before its record names it - the
// window that hid a defect from the first version of these tests.
let created = {};
const hubRun = (args) =>
  runHub({
    ...args,
    onProvisioned: (repo) => {
      created = { ...created, [repo]: { rulesets: [] } };
      probe.setRepos(created);
    },
  });
// Every test starts with no repositories on "GitHub".
const fresh = () => {
  created = {};
  probe.setRepos({});
};

const ORG = "TestOrg";
const ID = "lab";
const MAX = 4;

const GROUP_YAML = `state: published
assignment_type: group
repository_name_pattern: grp-{team_slug}
group_config:
  max_team_size: ${MAX}
template:
  owner: ${ORG}
  repository: tpl
`;
const INDIVIDUAL_YAML = `state: published
repository_name_pattern: lab-{github_login}
template:
  owner: ${ORG}
  repository: tpl
`;

const STUDENTS = Array.from({ length: 16 }, (_, i) => `student${i + 1}`);
const ROSTER = {
  schema_version: 2,
  students: [...STUDENTS, "seed"].map((login, i) => ({ student_number: `S${i}`, full_name: login, github_login: login })),
};
const idOf = (login) => (login === "seed" ? 999 : STUDENTS.indexOf(login) + 1);

function team(slug, members) {
  return {
    schema_version: 1, assignment_id: ID, team_slug: slug, team_name: slug, members, max_members: MAX,
    repo_name: `${ORG}/grp-${slug}`,
  };
}
function seedAcceptance(login, slug) {
  return {
    schema_version: 1, assignment_id: ID, github_login: login, github_id: idOf(login), accepted_at: "2026-10-01T09:00:00Z",
    status: "provisioned", team_slug: slug, team_name: slug,
  };
}

/** Every invariant a team's queue used to protect, read off the remote. */
function assertConsistent(remote, { group = true } = {}) {
  const teams = remoteDir(remote, `teams/${ID}`);
  const acceptances = remoteDir(remote, `acceptances/${ID}`);
  const repositories = remoteDir(remote, `repositories/${ID}`);
  const seen = new Map();
  for (const [slug, t] of Object.entries(teams)) {
    assert.ok(t.members.length <= MAX, `team ${slug} has ${t.members.length} members: ${t.members.join(", ")}`);
    for (const m of t.members) {
      const key = m.toLowerCase();
      assert.ok(!seen.has(key), `${m} is in ${seen.get(key)} and ${slug}`);
      seen.set(key, slug);
    }
  }
  for (const [login, a] of Object.entries(acceptances)) {
    if (group) {
      assert.equal(seen.get(login.toLowerCase()), a.team_slug, `${login}'s acceptance says ${a.team_slug}, the manifests say ${seen.get(login.toLowerCase())}`);
    }
    assert.ok(a.status === "provisioned", `${login}'s acceptance is ${a.status} - its record step never landed`);
  }
  for (const login of seen.keys()) {
    assert.ok(Object.keys(acceptances).some((l) => l.toLowerCase() === login), `${login} is in a team with no acceptance record`);
  }
  for (const [login, r] of Object.entries(repositories)) {
    const a = acceptances[login];
    assert.ok(a, `${login} has a repository record and no acceptance`);
    if (group) {
      assert.equal(r.team_slug, a.team_slug, `${login}'s repository record is for ${r.team_slug}, their acceptance for ${a.team_slug}`);
      assert.equal(r.repo_name, teams[a.team_slug].repo_name, `${login}'s repository record names another team's repository`);
    }
  }
  return { teams, acceptances, repositories };
}

function groupRemote(teams) {
  // A seeded team has its repository already, and the manifest names it.
  fresh();
  for (const slug of Object.keys(teams)) created[`grp-${slug}`] = { rulesets: [] };
  probe.setRepos(created);
  return remoteWith({
    "students/roster.yml": ROSTER,
    [`assignments/${ID}.yml`]: GROUP_YAML,
    ...Object.fromEntries(Object.entries(teams).map(([slug, members]) => [`teams/${ID}/${slug}.json`, team(slug, members)])),
    ...Object.fromEntries(
      Object.entries(teams).flatMap(([slug, members]) => members.map((m) => [`acceptances/${ID}/${m}.json`, seedAcceptance(m, slug)])),
    ),
  });
}

test("two students create one new team at the same moment: both are in it", { timeout: 300_000 }, async () => {
  // Measured live on pxl-classroom-testbed, 2026-10-02: the second run decided
  // again after the first saved, met the repository the first had just
  // created, and - with no record naming it yet - refused it as a stranger's.
  for (let round = 0; round < 3; round++) {
    const remote = groupRemote({});
    const results = await Promise.all(
      ["student1", "student2"].map((login, i) =>
        hubRun({ remote, org: ORG, assignmentId: ID, login, githubId: idOf(login), issue: 900 + i, team: "alpha", action: "create" }),
      ),
    );
    assert.deepEqual(
      results.map((r) => r.outcome),
      ["accepted", "accepted"],
      results.map((r) => r.log).join("\n---\n"),
    );
    const { teams } = assertConsistent(remote);
    assert.deepEqual([...teams.alpha.members].sort(), ["student1", "student2"]);
  }
});

test("under join codes, two students creating one name at once: one team, one code, the other refused", { timeout: 300_000 }, async () => {
  // Without codes both are in the team (above). With them, the second run's
  // page made its OWN code, which opens nothing in a team the first one saved:
  // the second is refused, and their Back shows the name as taken.
  const keys = await generateClaimKeypair();
  const codes = { student1: newJoinCode(), student2: newJoinCode() };
  for (let round = 0; round < 3; round++) {
    fresh();
    const remote = remoteWith({
      "students/roster.yml": ROSTER,
      [`assignments/${ID}.yml`]: GROUP_YAML.replace(`max_team_size: ${MAX}`, `max_team_size: ${MAX}\n  require_join_code: true`),
    });
    const results = await Promise.all(
      ["student1", "student2"].map(async (login, i) =>
        hubRun({
          remote, org: ORG, assignmentId: ID, login, githubId: idOf(login), issue: 900 + i, team: "alpha", action: "create",
          env: {
            CLAIM_PRIVATE_KEY: keys.privateKey,
            TEAM_CODE_PAYLOAD: await encryptTeamCode({
              publicKey: keys.publicKey, code: codes[login], githubId: idOf(login), assignmentId: ID, teamSlug: "alpha",
            }),
          },
        }),
      ),
    );
    const outcomes = results.map((r) => r.outcome).sort();
    assert.deepEqual(outcomes, ["accepted", "rejected:team-code"], results.map((r) => r.log).join("\n---\n"));
    const { teams } = assertConsistent(remote);
    const winner = ["student1", "student2"][results.findIndex((r) => r.outcome === "accepted")];
    assert.deepEqual(teams.alpha.members, [winner]);
    assert.equal(teams.alpha.join_code, codes[winner], "the team keeps the code of the student who made it");
  }
});

test("a teammate joining with the code while the creator's own request is still waiting: both are in", { timeout: 300_000 }, async () => {
  // The page shows the creator the code at once, so in a classroom it is read
  // aloud before the team exists. Whichever run lands first makes the team
  // with that code; the other meets it and the code opens it.
  const keys = await generateClaimKeypair();
  const code = newJoinCode();
  for (let round = 0; round < 3; round++) {
    fresh();
    const remote = remoteWith({
      "students/roster.yml": ROSTER,
      [`assignments/${ID}.yml`]: GROUP_YAML.replace(`max_team_size: ${MAX}`, `max_team_size: ${MAX}\n  require_join_code: true`),
    });
    const results = await Promise.all(
      [["student1", "create"], ["student2", "join"]].map(async ([login, action], i) =>
        hubRun({
          remote, org: ORG, assignmentId: ID, login, githubId: idOf(login), issue: 900 + i, team: "alpha", action,
          env: {
            CLAIM_PRIVATE_KEY: keys.privateKey,
            TEAM_CODE_PAYLOAD: await encryptTeamCode({ publicKey: keys.publicKey, code, githubId: idOf(login), assignmentId: ID, teamSlug: "alpha" }),
          },
        }),
      ),
    );
    assert.deepEqual(results.map((r) => r.outcome), ["accepted", "accepted"], results.map((r) => r.log).join("\n---\n"));
    const { teams } = assertConsistent(remote);
    assert.deepEqual([...teams.alpha.members].sort(), ["student1", "student2"]);
    assert.equal(teams.alpha.join_code, code);
  }
});

test("a seeded team's first joiner still refuses a stranger's repository at its name", { timeout: 120_000 }, async () => {
  // The case the refusal exists for, which the teammate rule must not open:
  // a previous year's `grp-legacy`, and a team seeded with members nobody has
  // accepted as yet.
  const remote = remoteWith({
    "students/roster.yml": ROSTER,
    [`assignments/${ID}.yml`]: GROUP_YAML,
    [`teams/${ID}/legacy.json`]: { schema_version: 1, assignment_id: ID, team_slug: "legacy", team_name: "legacy", members: ["student5", "student6"], max_members: MAX },
  });
  fresh();
  probe.setRepos({ "grp-legacy": { rulesets: [] } });
  const r = await hubRun({ remote, org: ORG, assignmentId: ID, login: "student5", githubId: idOf("student5"), issue: 950, team: "legacy" });
  assert.equal(r.outcome, "rejected:repo-exists", r.log);
});

test("eight students join one team at the same moment: exactly the free seats are taken", { timeout: 300_000 }, async () => {
  const remote = groupRemote({ fullhouse: ["seed"] });
  const joiners = STUDENTS.slice(0, 8);
  const results = await Promise.all(
    joiners.map((login, i) => hubRun({ remote, org: ORG, assignmentId: ID, login, githubId: idOf(login), issue: 100 + i, team: "fullhouse" })),
  );
  for (const r of results) assert.equal(r.status, 0, `${r.login}: ${r.log}`);
  const admitted = results.filter((r) => r.outcome === "accepted");
  const full = results.filter((r) => r.outcome === "rejected:team-full");
  assert.equal(admitted.length, MAX - 1, `admitted: ${admitted.map((r) => r.login)}`);
  assert.equal(full.length, joiners.length - (MAX - 1), `outcomes: ${results.map((r) => r.outcome)}`);
  assert.ok(admitted.every((r) => r.recorded), "an admitted student's record did not land");
  const { teams } = assertConsistent(remote);
  assert.equal(teams.fullhouse.members.length, MAX);
});

test("a class joins five teams at once: nobody is refused for anything but a full team", { timeout: 300_000 }, async () => {
  const slugs = ["red", "blue", "green", "gold", "teal"];
  const remote = groupRemote({ red: ["seed"] });
  // Three per team, so every team has room for everyone who asks.
  const plan = STUDENTS.slice(0, 15).map((login, i) => ({ login, team: slugs[i % slugs.length], action: "join", issue: 200 + i }));
  // Teams other than red do not exist yet: their first joiner creates them.
  const results = await Promise.all(
    plan.map((p) => hubRun({ remote, org: ORG, assignmentId: ID, login: p.login, githubId: idOf(p.login), issue: p.issue, team: p.team, action: p.action })),
  );
  const bad = results.filter((r) => r.outcome !== "accepted");
  assert.deepEqual(bad.map((r) => `${r.login}: ${r.outcome}`), [], bad.map((r) => r.log).join("\n---\n"));
  const { teams } = assertConsistent(remote);
  assert.deepEqual(Object.keys(teams).sort(), [...slugs].sort());
});

test("GitHub refusing every other push changes nothing about the outcome", { timeout: 300_000 }, async () => {
  const remote = groupRemote({ fullhouse: ["seed"] });
  flaky(remote, { every: 2 });
  const joiners = STUDENTS.slice(0, 6);
  const results = await Promise.all(
    joiners.map((login, i) => hubRun({ remote, org: ORG, assignmentId: ID, login, githubId: idOf(login), issue: 300 + i, team: "fullhouse" })),
  );
  for (const r of results) assert.notEqual(r.outcome, "fail:reserve", `${r.login} ran out of attempts: ${r.log}`);
  assert.equal(results.filter((r) => r.outcome === "accepted").length, MAX - 1);
  assert.ok(results.filter((r) => r.outcome === "accepted").every((r) => r.recorded));
  assertConsistent(remote);
});

test("a student's attempts racing each other: the newest one decided is what stands", { timeout: 300_000 }, async () => {
  const remote = groupRemote({ red: ["seed"], blue: [] });
  // student1 asks for red, then changes their mind to blue, then blue again
  // (a second tab) - all three running at once, in any order.
  const results = await Promise.all([
    hubRun({ remote, org: ORG, assignmentId: ID, login: "student1", githubId: 1, issue: 401, team: "red" }),
    hubRun({ remote, org: ORG, assignmentId: ID, login: "student1", githubId: 1, issue: 402, team: "blue", action: "switch" }),
    hubRun({ remote, org: ORG, assignmentId: ID, login: "student1", githubId: 1, issue: 403, team: "blue", action: "switch" }),
  ]);
  for (const r of results) assert.equal(r.status, 0, r.log);
  const { acceptances } = assertConsistent(remote);
  assert.equal(acceptances.student1.team_slug, "blue", `outcomes: ${results.map((r) => `#${r.issue} ${r.outcome}`)}`);
  assert.equal(acceptances.student1.issue_number, 403);
});

test("a run GitHub starts an hour late cannot undo what the student did since", { timeout: 300_000 }, async () => {
  const remote = groupRemote({ red: ["seed"], blue: [] });
  const now = await hubRun({ remote, org: ORG, assignmentId: ID, login: "student2", githubId: 2, issue: 502, team: "blue" });
  assert.equal(now.outcome, "accepted", now.log);
  // Fars's 10:13 join, finally given a runner.
  const late = await hubRun({ remote, org: ORG, assignmentId: ID, login: "student2", githubId: 2, issue: 501, team: "red" });
  assert.equal(late.outcome, "superseded", late.log);
  const { acceptances, teams } = assertConsistent(remote);
  assert.equal(acceptances.student2.team_slug, "blue");
  assert.ok(!teams.red.members.includes("student2"));
});

test("a push that lands with its answer lost is recognised, not decided twice", { timeout: 120_000 }, async () => {
  const remote = groupRemote({ red: ["seed"] });
  const r = await hubRun({
    remote, org: ORG, assignmentId: ID, login: "student3", githubId: 3, issue: 601, team: "red",
    prepare: (dir) => lostAnswer(dir),
  });
  assert.equal(r.outcome, "accepted", r.log);
  assert.match(r.log, /reported a failure but the decision is on the branch/);
  assert.doesNotMatch(r.log, /deciding again/);
  assertConsistent(remote);
});

test("an individual burst: nobody decides again because somebody else accepted", { timeout: 300_000 }, async () => {
  fresh();
  const remote = remoteWith({ "students/roster.yml": ROSTER, [`assignments/${ID}.yml`]: INDIVIDUAL_YAML });
  const results = await Promise.all(
    STUDENTS.slice(0, 10).map((login, i) => hubRun({ remote, org: ORG, assignmentId: ID, login, githubId: idOf(login), issue: 700 + i })),
  );
  for (const r of results) assert.equal(r.outcome, "accepted", r.log);
  for (const r of results) assert.doesNotMatch(r.log, /deciding again/, `${r.login} re-decided over another student's acceptance`);
  const { acceptances, repositories } = assertConsistent(remote, { group: false });
  assert.equal(Object.keys(acceptances).length, 10);
  assert.equal(Object.keys(repositories).length, 10);
});

test("a lecturer's Retry and the student's own join at once leave one consistent record", { timeout: 120_000 }, async () => {
  const remote = groupRemote({ red: ["seed", "student4"] });
  const results = await Promise.all([
    hubRun({ remote, org: ORG, assignmentId: ID, login: "student4", githubId: 4, issue: 801, team: "red" }),
    hubRun({
      remote, org: ORG, assignmentId: ID, login: "student4", githubId: 4,
      env: { SET_ASIDE: "true", PERSIST_REFUSALS: "false", BYPASS_WINDOW: "true" },
    }),
  ]);
  for (const r of results) assert.equal(r.status, 0, r.log);
  const { acceptances } = assertConsistent(remote);
  assert.equal(acceptances.student4.team_slug, "red");
  assert.equal(acceptances.student4.issue_number, 801, "the attempt order survives a Retry");
  assert.ok(checkout(remote));
  assert.equal(remoteJson(remote, `teams/${ID}/red.json`).members.filter((m) => m === "student4").length, 1);
});
