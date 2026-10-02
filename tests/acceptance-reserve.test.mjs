// acceptance/reserve.mjs against real git: a bare "remote" stands in for the
// control repository, a clone for the runner's checkout, and other clones for
// the other runs that push in between.
//
// The race this exists for, 2026-10-02: joins to one team used to be
// serialised by a GitHub concurrency group, which held one waiting run and let
// a stuck one block the team for a day. With no group, two runs can decide
// against the same manifest. These prove the save is what keeps the team at its
// size - by running the real accept.mjs, the real git, and a real push that
// another push beat.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startRepoProbe } from "./fixtures/repo-probe.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const reserveScript = join(root, "acceptance", "reserve.mjs");
const probe = await startRepoProbe();

const ID = "groepsindeling";
const ORG = "TestOrg";

function git(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function configure(dir) {
  git(dir, "config", "user.name", "test");
  git(dir, "config", "user.email", "test@users.noreply.github.com");
  git(dir, "config", "commit.gpgsign", "false");
}

const GROUP_YAML = `state: published
assignment_type: group
repository_name_pattern: grp-{team_slug}
group_config:
  max_team_size: 4
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

function team(members) {
  return {
    schema_version: 1,
    assignment_id: ID,
    team_slug: "fullhouse",
    team_name: "fullhouse",
    members,
    max_members: 4,
    repo_name: `${ORG}/grp-fullhouse`,
  };
}

/** A bare remote holding a control repository with these files. */
function remoteWith(files) {
  const remote = mkdtempSync(join(tmpdir(), "pxl-remote-"));
  git(remote, "init", "-q", "--bare", "-b", "main");
  const seed = mkdtempSync(join(tmpdir(), "pxl-seed-"));
  git(seed, "clone", "-q", remote, ".");
  configure(seed);
  git(seed, "checkout", "-q", "-b", "main");
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(seed, path)), { recursive: true });
    writeFileSync(join(seed, path), typeof content === "string" ? content : JSON.stringify(content, null, 2) + "\n");
  }
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "seed");
  git(seed, "push", "-q", "origin", "main");
  return remote;
}

function checkout(remote) {
  const dir = mkdtempSync(join(tmpdir(), "pxl-checkout-"));
  git(dir, "clone", "-q", remote, ".");
  configure(dir);
  return dir;
}

/** Another run pushing in between: these files written on top of the remote. */
function pushFromElsewhere(remote, files) {
  const dir = checkout(remote);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), JSON.stringify(content, null, 2) + "\n");
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "elsewhere");
  git(dir, "push", "-q", "origin", "HEAD:main");
}

function remoteJson(remote, path) {
  const r = spawnSync("git", ["--git-dir", remote, "show", `main:${path}`], { encoding: "utf8" });
  return r.status === 0 ? JSON.parse(r.stdout) : null;
}

const remoteHead = (remote) => git(remote, "rev-parse", "main");

function reserve(dir, env) {
  const scratch = mkdtempSync(join(tmpdir(), "pxl-reserve-out-"));
  const out = join(scratch, "out.env");
  writeFileSync(out, "");
  const r = spawnSync("node", [reserveScript], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...probe.env,
      ORG,
      DATA_DIR: dir,
      ASSIGNMENT_ID: ID,
      GITHUB_OUTPUT: out,
      GITHUB_STEP_SUMMARY: join(scratch, "summary.md"),
      GITHUB_RUN_ID: "424242",
      ...env,
    },
  });
  const outputs = {};
  for (const line of readFileSync(out, "utf8").split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) outputs[line.slice(0, i)] = line.slice(i + 1);
  }
  return { status: r.status, log: r.stdout + r.stderr, outputs };
}

const ROSTER = {
  schema_version: 2,
  students: ["ThomasBasyn", "NichitaPoparceaPXL", "SabriKatogluPXL", "FarsAbdelrahmanMohamedWardaPXL", "eve", "alice", "bob"].map(
    (login, i) => ({ student_number: `S${i}`, full_name: login, github_login: login }),
  ),
};

test("the fourth seat goes to whoever saved first - the other run decides again and is refused", () => {
  const remote = remoteWith({
    "students/roster.yml": ROSTER,
    [`assignments/${ID}.yml`]: GROUP_YAML,
    [`teams/${ID}/fullhouse.json`]: team(["ThomasBasyn", "NichitaPoparceaPXL", "SabriKatogluPXL"]),
  });
  // This run's checkout says 3 of 4...
  const dir = checkout(remote);
  // ...and another run takes the last seat before this one saves.
  pushFromElsewhere(remote, {
    [`teams/${ID}/fullhouse.json`]: team(["ThomasBasyn", "NichitaPoparceaPXL", "SabriKatogluPXL", "FarsAbdelrahmanMohamedWardaPXL"]),
    [`acceptances/${ID}/FarsAbdelrahmanMohamedWardaPXL.json`]: {
      schema_version: 1, assignment_id: ID, github_login: "FarsAbdelrahmanMohamedWardaPXL", github_id: 4,
      accepted_at: "2026-10-02T10:35:00Z", status: "accepted", team_slug: "fullhouse", team_name: "fullhouse",
    },
  });

  const res = reserve(dir, { GITHUB_LOGIN: "eve", GITHUB_ID: "5", TEAM_SLUG: "fullhouse", TEAM_NAME: "fullhouse", TEAM_ACTION: "join" });
  assert.equal(res.status, 0, res.log);
  assert.equal(res.outputs.outcome, "rejected:team-full", res.log);
  assert.match(res.log, /deciding again/);
  const stored = remoteJson(remote, `teams/${ID}/fullhouse.json`);
  assert.equal(stored.members.length, 4);
  assert.ok(!stored.members.includes("eve"), "a fifth member was saved");
  assert.equal(remoteJson(remote, `acceptances/${ID}/eve.json`), null);
});

test("a change nothing read is replayed under, not decided again", () => {
  const remote = remoteWith({
    "students/roster.yml": ROSTER,
    [`assignments/${ID}.yml`]: GROUP_YAML,
    [`teams/${ID}/fullhouse.json`]: team(["ThomasBasyn"]),
  });
  const dir = checkout(remote);
  // Another student's repository record: no input of this decision.
  pushFromElsewhere(remote, {
    [`repositories/${ID}/bob.json`]: { note: "unrelated" },
  });

  const res = reserve(dir, {
    GITHUB_LOGIN: "eve", GITHUB_ID: "5", TEAM_SLUG: "fullhouse", TEAM_NAME: "fullhouse", TEAM_ACTION: "join",
    ISSUE_NUMBER: "66", ACTED_AT: "2026-10-02T10:22:06Z",
  });
  assert.equal(res.status, 0, res.log);
  assert.equal(res.outputs.outcome, "accepted", res.log);
  assert.doesNotMatch(res.log, /deciding again/);
  assert.deepEqual(remoteJson(remote, `teams/${ID}/fullhouse.json`).members, ["ThomasBasyn", "eve"]);
  assert.deepEqual(remoteJson(remote, `repositories/${ID}/bob.json`), { note: "unrelated" }, "the other run's write survived");
  const record = remoteJson(remote, `acceptances/${ID}/eve.json`);
  assert.equal(record.issue_number, 66, "the attempt that decided is stamped");
  assert.equal(record.decided_by_run_id, "424242", "the run that decided is stamped");
  assert.equal(record.accepted_at, "2026-10-02T10:22:06.000Z", "dated when the student asked");
});

test("an older attempt that GitHub starts late does nothing at all", () => {
  // Fars's join from 10:13 landing after a switch he made since.
  const remote = remoteWith({
    "students/roster.yml": ROSTER,
    [`assignments/${ID}.yml`]: GROUP_YAML,
    [`teams/${ID}/fullhouse.json`]: team(["ThomasBasyn"]),
    [`acceptances/${ID}/eve.json`]: {
      schema_version: 1, assignment_id: ID, github_login: "eve", github_id: 5, accepted_at: "2026-10-02T10:00:00Z",
      status: "provisioned", team_slug: "other", team_name: "other", issue_number: 70,
    },
  });
  const before = remoteHead(remote);
  const res = reserve(checkout(remote), {
    GITHUB_LOGIN: "eve", GITHUB_ID: "5", TEAM_SLUG: "fullhouse", TEAM_NAME: "fullhouse", TEAM_ACTION: "join", ISSUE_NUMBER: "60",
  });
  assert.equal(res.status, 0, res.log);
  assert.equal(res.outputs.outcome, "superseded", res.log);
  assert.equal(remoteHead(remote), before, "a superseded attempt wrote something");
});

test("a refused Retry leaves the remote exactly as it was", () => {
  const remote = remoteWith({
    "students/roster.yml": ROSTER,
    [`assignments/${ID}.yml`]: INDIVIDUAL_YAML.replace("state: published", "state: closed"),
    [`acceptances/${ID}/alice.json`]: {
      schema_version: 1, assignment_id: ID, github_login: "alice", github_id: 6, accepted_at: "2026-09-01T10:00:00Z", status: "provisioned",
    },
  });
  const before = remoteHead(remote);
  const dir = checkout(remote);
  const res = reserve(dir, { GITHUB_LOGIN: "alice", GITHUB_ID: "6", SET_ASIDE: "true", PERSIST_REFUSALS: "false", BYPASS_WINDOW: "true" });
  assert.equal(res.status, 0, res.log);
  assert.match(res.outputs.outcome, /^rejected:/, res.log);
  assert.equal(remoteHead(remote), before, "a refused Retry pushed something");
  assert.ok(remoteJson(remote, `acceptances/${ID}/alice.json`), "the record is still on the remote");
  assert.ok(!existsSync(join(dir, "acceptances", ID, "alice.json")), "it was set aside in the checkout, which is what made the gates run");
});

test("an admitted Retry replaces the record, keeping when the student first accepted", () => {
  const remote = remoteWith({
    "students/roster.yml": ROSTER,
    [`assignments/${ID}.yml`]: INDIVIDUAL_YAML,
    [`acceptances/${ID}/alice.json`]: {
      schema_version: 1, assignment_id: ID, github_login: "alice", github_id: 6, accepted_at: "2026-09-01T10:00:00Z",
      status: "failed", issue_number: 12,
    },
  });
  const dir = checkout(remote);
  const prior = join(mkdtempSync(join(tmpdir(), "pxl-prior-")), "prior.json");
  writeFileSync(prior, readFileSync(join(dir, "acceptances", ID, "alice.json")));
  const res = reserve(dir, {
    GITHUB_LOGIN: "alice", GITHUB_ID: "6", SET_ASIDE: "true", PERSIST_REFUSALS: "false", BYPASS_WINDOW: "true",
    PRIOR_ACCEPTANCE_FILE: prior,
  });
  assert.equal(res.status, 0, res.log);
  assert.equal(res.outputs.outcome, "accepted", res.log);
  const record = remoteJson(remote, `acceptances/${ID}/alice.json`);
  assert.equal(record.accepted_at, "2026-09-01T10:00:00Z");
  assert.equal(record.issue_number, 12, "a Retry keeps the attempt it redoes, so older stale runs stay superseded");
  assert.equal(record.decided_by_run_id, "424242");
});

test("a request made before the deadline is decided as of the request, until the lock has run", () => {
  const deadline = new Date(Date.now() - 10 * 60_000);
  const yaml = `${INDIVIDUAL_YAML}deadline_at: ${deadline.toISOString()}\n`;
  const actedBefore = new Date(deadline.getTime() - 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");

  const open = remoteWith({ "students/roster.yml": ROSTER, [`assignments/${ID}.yml`]: yaml });
  const late = reserve(checkout(open), { GITHUB_LOGIN: "bob", GITHUB_ID: "7", ISSUE_NUMBER: "3", ACTED_AT: actedBefore });
  assert.equal(late.outputs.outcome, "accepted", late.log);
  assert.equal(remoteJson(open, `acceptances/${ID}/bob.json`).accepted_at, new Date(actedBefore).toISOString());

  const afterTheDeadline = new Date(deadline.getTime() + 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const tooLate = reserve(checkout(open), { GITHUB_LOGIN: "alice", GITHUB_ID: "6", ISSUE_NUMBER: "4", ACTED_AT: afterTheDeadline });
  assert.equal(tooLate.outputs.outcome, "rejected:past-deadline", tooLate.log);

  const locked = remoteWith({
    "students/roster.yml": ROSTER,
    [`assignments/${ID}.yml`]: yaml,
    [`lockdowns/${ID}/lockdown-record.json`]: { locked: true },
  });
  const afterLock = reserve(checkout(locked), { GITHUB_LOGIN: "bob", GITHUB_ID: "7", ISSUE_NUMBER: "3", ACTED_AT: actedBefore });
  assert.equal(afterLock.outputs.outcome, "rejected:past-deadline", afterLock.log);
});

test("a duplicate of an accepted attempt is stamped as the one that decided", () => {
  const remote = remoteWith({
    "students/roster.yml": ROSTER,
    [`assignments/${ID}.yml`]: INDIVIDUAL_YAML,
    [`acceptances/${ID}/alice.json`]: {
      schema_version: 1, assignment_id: ID, github_login: "alice", github_id: 6, accepted_at: "2026-09-01T10:00:00Z",
      status: "provisioned", issue_number: 12, decided_by_run_id: "1",
    },
  });
  const res = reserve(checkout(remote), { GITHUB_LOGIN: "alice", GITHUB_ID: "6", ISSUE_NUMBER: "15" });
  assert.equal(res.outputs.outcome, "already-accepted", res.log);
  const record = remoteJson(remote, `acceptances/${ID}/alice.json`);
  assert.equal(record.issue_number, 15);
  assert.equal(record.decided_by_run_id, "424242");
  assert.equal(record.accepted_at, "2026-09-01T10:00:00Z");
  assert.equal(record.status, "provisioned");
});

test("a refusal made on an out-of-date checkout is decided again, though it saves nothing", () => {
  // The interleaving tests/acceptance-race.test.mjs met 1 run in 4 under load:
  // two students create one new team at once. This run checked out before the
  // other saved its decision, so it finds no team and creates one - and asks
  // GitHub whether the name is free AFTER the other run made the repository.
  // With no decision in its checkout to say whose that repository is, it is
  // "a previous team's" and refused. A refusal writes nothing, so nothing was
  // pushed, so the refused push that makes every other decision look again
  // never came - and the refusal was final.
  const remote = remoteWith({
    "students/roster.yml": ROSTER,
    [`assignments/${ID}.yml`]: GROUP_YAML,
  });
  const dir = checkout(remote);
  pushFromElsewhere(remote, {
    [`teams/${ID}/alpha.json`]: { ...team(["alice"]), team_slug: "alpha", team_name: "alpha", repo_name: `${ORG}/grp-alpha` },
    [`acceptances/${ID}/alice.json`]: {
      schema_version: 1, assignment_id: ID, github_login: "alice", github_id: 6,
      accepted_at: "2026-10-02T10:35:00Z", status: "accepted", team_slug: "alpha", team_name: "alpha",
    },
  });
  probe.setRepos({ "grp-alpha": { rulesets: [] } });
  try {
    const res = reserve(dir, { GITHUB_LOGIN: "bob", GITHUB_ID: "7", TEAM_SLUG: "alpha", TEAM_NAME: "alpha", TEAM_ACTION: "create" });
    assert.equal(res.status, 0, res.log);
    assert.equal(res.outputs.outcome, "accepted", res.log);
    assert.match(res.log, /another run saved what this decision read; deciding again/);
    assert.deepEqual([...remoteJson(remote, `teams/${ID}/alpha.json`).members].sort(), ["alice", "bob"]);
  } finally {
    probe.setRepos({});
  }
});

test("a refusal nobody else's save could change stands without deciding again", () => {
  // The look-again is for what this decision READ. Another student's
  // unrelated acceptance moving the branch is not a reason to decide twice.
  const remote = remoteWith({
    "students/roster.yml": ROSTER,
    [`assignments/${ID}.yml`]: INDIVIDUAL_YAML,
  });
  const dir = checkout(remote);
  pushFromElsewhere(remote, {
    [`acceptances/${ID}/alice.json`]: {
      schema_version: 1, assignment_id: ID, github_login: "alice", github_id: 6,
      accepted_at: "2026-10-02T10:35:00Z", status: "accepted",
    },
  });
  const res = reserve(dir, { GITHUB_LOGIN: "stranger", GITHUB_ID: "99" });
  assert.equal(res.status, 0, res.log);
  assert.match(res.outputs.outcome, /^rejected:/, res.log);
  assert.doesNotMatch(res.log, /deciding again/);
});
