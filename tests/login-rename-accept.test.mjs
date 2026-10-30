// A renamed student pressing Accept, through the real acceptance/reserve.mjs and
// accept.mjs against real git: a bare remote for the control repository and a
// clone for the runner's checkout. Without the id, this is a stranger: a second
// repository, a second seat. With another id under a known name, it is one: the
// shortcut would hand them that student's repository.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startRepoProbe } from "./fixtures/repo-probe.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const reserveScript = join(root, "acceptance", "reserve.mjs");
const probe = await startRepoProbe();

const ORG = "TestOrg";
const ID = "lab";
const OLD = "Old-Name";
const NEW = "NewNamePXL";

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

function writeAll(dir, files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), typeof content === "string" ? content : JSON.stringify(content, null, 2) + "\n");
  }
}

function remoteWith(files) {
  const remote = mkdtempSync(join(tmpdir(), "pxl-remote-"));
  git(remote, "init", "-q", "--bare", "-b", "main");
  const seed = mkdtempSync(join(tmpdir(), "pxl-seed-"));
  git(seed, "clone", "-q", remote, ".");
  configure(seed);
  git(seed, "checkout", "-q", "-b", "main");
  writeAll(seed, files);
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

function pushFromElsewhere(remote, files) {
  const dir = checkout(remote);
  writeAll(dir, files);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "elsewhere");
  git(dir, "push", "-q", "origin", "HEAD:main");
}

const remoteJson = (remote, path) => {
  const r = spawnSync("git", ["--git-dir", remote, "show", `main:${path}`], { encoding: "utf8" });
  return r.status === 0 ? JSON.parse(r.stdout) : null;
};
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

const INDIVIDUAL = `state: published
repository_name_pattern: lab-{github_login}
roster_mode: open
max_acceptances: 100
template:
  owner: ${ORG}
  repository: tpl
`;

const GROUP = `state: published
assignment_type: group
roster_mode: open
max_acceptances: 100
repository_name_pattern: grp-{team_slug}
group_config:
  max_team_size: 2
template:
  owner: ${ORG}
  repository: tpl
`;

const acceptance = (login, id, extra = {}) => ({
  schema_version: 1, assignment_id: ID, github_login: login, github_id: id, accepted_at: "2026-10-01T09:00:00Z", status: "accepted", ...extra,
});

const individual = (extra = {}) => ({
  "students/roster.yml": "schema_version: 2\nstudents: []\n",
  [`assignments/${ID}.yml`]: INDIVIDUAL,
  [`acceptances/${ID}/${OLD}.json`]: acceptance(OLD, 77),
  [`repositories/${ID}/${OLD}.json`]: { schema_version: 1, assignment_id: ID, github_login: OLD, repo_name: `${ORG}/lab-${OLD}`, repo_id: 5 },
  [`observations/${ID}/${OLD}/2026-10-01T09-00-00-000Z.json`]: { github_login: OLD },
  ...extra,
});

// As the records stand once they have moved: the repository keeps its old name.
const moved = (extra = {}) => ({
  "students/roster.yml": "schema_version: 2\nstudents: []\n",
  [`assignments/${ID}.yml`]: INDIVIDUAL,
  [`acceptances/${ID}/${NEW}.json`]: acceptance(NEW, 77),
  [`repositories/${ID}/${NEW}.json`]: { schema_version: 1, assignment_id: ID, github_login: NEW, repo_name: `${ORG}/lab-${OLD}`, repo_id: 5 },
  "students/renames/77.json": { schema_version: 1, github_id: 77, previous_logins: [OLD] },
  ...extra,
});

const standing = (users = { 77: NEW }) => probe.setRepos({ [`lab-${OLD}`]: {} }, users);

test("Accept under the new name hands back the repository they have, under the name it has", () => {
  standing();
  const remote = remoteWith(individual());
  const res = reserve(checkout(remote), { GITHUB_LOGIN: NEW, GITHUB_ID: "77" });
  assert.equal(res.status, 0, res.log);
  assert.equal(res.outputs.outcome, "already-accepted", res.log);
  assert.equal(res.outputs.target_repo, `lab-${OLD}`, "a second repository would be made at the new name");

  // Every record moved, on the remote, and the old ones are gone.
  assert.equal(remoteJson(remote, `acceptances/${ID}/${NEW}.json`).github_login, NEW);
  assert.equal(remoteJson(remote, `acceptances/${ID}/${NEW}.json`).github_id, 77);
  assert.equal(remoteJson(remote, `repositories/${ID}/${NEW}.json`).repo_name, `${ORG}/lab-${OLD}`);
  assert.equal(remoteJson(remote, `observations/${ID}/${NEW}/2026-10-01T09-00-00-000Z.json`).github_login, NEW);
  assert.equal(remoteJson(remote, `acceptances/${ID}/${OLD}.json`), null);
  assert.equal(remoteJson(remote, `repositories/${ID}/${OLD}.json`), null);
});

test("the move is saved even when another run pushed first, and is not lost to the decision's own reset", () => {
  standing();
  const remote = remoteWith(individual());
  const dir = checkout(remote);
  pushFromElsewhere(remote, { [`acceptances/${ID}/third.json`]: acceptance("third", 3) });
  const res = reserve(dir, { GITHUB_LOGIN: NEW, GITHUB_ID: "77" });
  assert.equal(res.status, 0, res.log);
  assert.equal(res.outputs.outcome, "already-accepted", res.log);
  assert.equal(remoteJson(remote, `acceptances/${ID}/${NEW}.json`).github_login, NEW);
  assert.equal(remoteJson(remote, `acceptances/${ID}/third.json`).github_login, "third", "the other run's save survived");
});

test("a renamed member of a team takes no second seat in a full team", () => {
  standing();
  const manifest = { schema_version: 1, assignment_id: ID, team_slug: "alpha", team_name: "alpha", members: [OLD, "mate"], max_members: 2, repo_name: `${ORG}/grp-alpha`, created_at: "2026-10-01T09:00:00Z", created_by: OLD };
  const remote = remoteWith({
    "students/roster.yml": "schema_version: 2\nstudents: []\n",
    [`assignments/${ID}.yml`]: GROUP,
    [`teams/${ID}/alpha.json`]: manifest,
    [`acceptances/${ID}/${OLD}.json`]: acceptance(OLD, 77, { team_slug: "alpha", team_name: "alpha" }),
    [`acceptances/${ID}/mate.json`]: acceptance("mate", 2, { team_slug: "alpha", team_name: "alpha" }),
    [`repositories/${ID}/${OLD}.json`]: { schema_version: 1, assignment_id: ID, github_login: OLD, repo_name: `${ORG}/grp-alpha`, repo_id: 5, team_slug: "alpha" },
  });
  const res = reserve(checkout(remote), { GITHUB_LOGIN: NEW, GITHUB_ID: "77", TEAM_SLUG: "alpha", TEAM_NAME: "alpha", TEAM_ACTION: "join" });
  assert.equal(res.status, 0, res.log);
  assert.equal(res.outputs.outcome, "already-accepted", res.log);
  assert.equal(res.outputs.target_repo, "grp-alpha");
  assert.deepEqual(remoteJson(remote, `teams/${ID}/alpha.json`).members, [NEW, "mate"]);
});

test("a roster row under the old name still admits them under enforced", () => {
  standing();
  const remote = remoteWith(individual({
    "students/roster.yml": `schema_version: 2\nstudents:\n  - student_number: "1"\n    full_name: A\n    github_login: ${OLD}\n`,
    [`assignments/${ID}.yml`]: INDIVIDUAL.replace("roster_mode: open", "roster_mode: enforced") + `cohort:\n  - login:${OLD.toLowerCase()}\n`,
  }));
  const res = reserve(checkout(remote), { GITHUB_LOGIN: NEW, GITHUB_ID: "77" });
  assert.equal(res.status, 0, res.log);
  assert.equal(res.outputs.outcome, "already-accepted", res.log);
});

test("somebody who registered the old name is refused, and nothing of the student's changes", () => {
  standing();
  const remote = remoteWith(individual());
  const before = remoteHead(remote);
  const res = reserve(checkout(remote), { GITHUB_LOGIN: OLD, GITHUB_ID: "99" });
  assert.equal(res.status, 0, res.log);
  assert.equal(res.outputs.outcome, "rejected:login-reused", res.log);
  assert.equal(res.outputs.target_repo, undefined, "nothing to hand over");
  assert.equal(remoteHead(remote), before);
});

test("a student who renamed nothing commits nothing extra", () => {
  standing({});
  const remote = remoteWith(individual());
  const before = remoteHead(remote);
  const res = reserve(checkout(remote), { GITHUB_LOGIN: OLD, GITHUB_ID: "77" });
  assert.equal(res.status, 0, res.log);
  assert.equal(res.outputs.outcome, "already-accepted", res.log);
  assert.equal(res.outputs.target_repo, `lab-${OLD}`);
  assert.doesNotMatch(git(remote, "log", "--format=%s", `${before}..main`), /Follow the rename/);
});

test("already holding both names: nothing moves, and the new name's own acceptance stands", () => {
  standing();
  const remote = remoteWith(individual({
    [`acceptances/${ID}/${NEW}.json`]: acceptance(NEW, 77),
    [`repositories/${ID}/${NEW}.json`]: { schema_version: 1, assignment_id: ID, github_login: NEW, repo_name: `${ORG}/lab-${NEW}`, repo_id: 6 },
  }));
  const res = reserve(checkout(remote), { GITHUB_LOGIN: NEW, GITHUB_ID: "77" });
  assert.equal(res.status, 0, res.log);
  assert.match(res.log, /::warning::.*both/);
  assert.equal(res.outputs.outcome, "already-accepted", res.log);
  assert.equal(res.outputs.target_repo, `lab-${NEW}`);
  assert.equal(remoteJson(remote, `acceptances/${ID}/${OLD}.json`).github_login, OLD);
});

// Found by review, 2026-10-30. After the move nothing is under the old login any
// more and the repository still has the old name, so whoever registered it came
// through as somebody new, and reuse handed them the student's repository.
test("somebody who registers the old name AFTER the move still gets nothing of theirs", () => {
  standing();
  const remote = remoteWith(moved());
  const before = remoteHead(remote);
  const res = reserve(checkout(remote), { GITHUB_LOGIN: OLD, GITHUB_ID: "99" });
  assert.equal(res.status, 0, res.log);
  assert.equal(res.outputs.outcome, "rejected:login-reused", res.log);
  assert.equal(remoteHead(remote), before);
  assert.equal(remoteJson(remote, `acceptances/${ID}/${OLD}.json`), null);
});

test("the old name spelled in another case by another account is refused too", () => {
  standing();
  const remote = remoteWith(individual());
  const res = reserve(checkout(remote), { GITHUB_LOGIN: OLD.toLowerCase(), GITHUB_ID: "99" });
  assert.equal(res.status, 0, res.log);
  assert.equal(res.outputs.outcome, "rejected:login-reused", res.log);
});

// A lecturer's Retry sets the acceptance record aside, and the name the repository
// has was only read while it was there.
test("Retry on a renamed student keeps their repository and makes no second one", () => {
  standing();
  const remote = remoteWith(moved());
  const res = reserve(checkout(remote), { GITHUB_LOGIN: NEW, GITHUB_ID: "77", SET_ASIDE: "true", PERSIST_REFUSALS: "false", BYPASS_WINDOW: "true" });
  assert.equal(res.status, 0, res.log);
  assert.equal(res.outputs.outcome, "accepted", res.log);
  assert.equal(res.outputs.target_repo, `lab-${OLD}`, "a second repository would be made and their record pointed at it");
});

test("Retry in the same run that moves them", () => {
  standing();
  const remote = remoteWith(individual());
  const res = reserve(checkout(remote), { GITHUB_LOGIN: NEW, GITHUB_ID: "77", SET_ASIDE: "true", PERSIST_REFUSALS: "false", BYPASS_WINDOW: "true" });
  assert.equal(res.status, 0, res.log);
  assert.equal(res.outputs.target_repo, `lab-${OLD}`);
  assert.equal(remoteJson(remote, `acceptances/${ID}/${NEW}.json`).github_id, 77);
  assert.equal(remoteJson(remote, `acceptances/${ID}/${OLD}.json`), null);
});

test("Retry under a name another account holds now is refused, and the student's record stays", () => {
  standing();
  const remote = remoteWith(individual());
  const before = remoteHead(remote);
  const res = reserve(checkout(remote), { GITHUB_LOGIN: OLD, GITHUB_ID: "99", SET_ASIDE: "true", PERSIST_REFUSALS: "false", BYPASS_WINDOW: "true" });
  assert.equal(res.status, 0, res.log);
  assert.equal(res.outputs.outcome, "rejected:login-reused", res.log);
  assert.equal(remoteHead(remote), before);
  assert.equal(remoteJson(remote, `acceptances/${ID}/${OLD}.json`).github_id, 77);
});

// GitHub can start a run hours late. An attempt from before the rename, run after
// the records moved, moved them all back and asked provisioning to grant a dead name.
test("an attempt from before the rename, run after the move, changes nothing", () => {
  standing();
  const remote = remoteWith(moved());
  const before = remoteHead(remote);
  const res = reserve(checkout(remote), { GITHUB_LOGIN: OLD, GITHUB_ID: "77" });
  assert.equal(res.status, 0, res.log);
  assert.equal(res.outputs.outcome, "superseded", res.log);
  assert.equal(remoteHead(remote), before);
  assert.equal(remoteJson(remote, `acceptances/${ID}/${NEW}.json`).github_id, 77);
});

test("records under another name and GitHub not saying who they are: nothing is decided", () => {
  standing({ 77: 0 });
  const remote = remoteWith(individual());
  const before = remoteHead(remote);
  const res = reserve(checkout(remote), { GITHUB_LOGIN: NEW, GITHUB_ID: "77" });
  assert.equal(res.status, 1, res.log);
  assert.equal(res.outputs.outcome, "fail:reserve", res.log);
  assert.equal(remoteHead(remote), before);
});

function resolveRetry(dir, login) {
  const scratch = mkdtempSync(join(tmpdir(), "pxl-retry-out-"));
  const out = join(scratch, "out.env");
  writeFileSync(out, "");
  const r = spawnSync("node", [join(root, "scripts", "resolve-retry-account.mjs")], {
    encoding: "utf8",
    env: { ...process.env, ...probe.env, DATA_DIR: dir, ASSIGNMENT_ID: ID, GITHUB_LOGIN: login, GITHUB_OUTPUT: out },
  });
  return { status: r.status, log: r.stdout + r.stderr, output: readFileSync(out, "utf8") };
}

test("Retry asks who the row is from the record, so a renamed student is found by id", () => {
  standing();
  const r = resolveRetry(checkout(remoteWith(individual())), OLD);
  assert.equal(r.status, 0, r.log);
  assert.match(r.output, /^id=77$/m);
  assert.match(r.output, new RegExp(`^login=${NEW}$`, "m"));
});

// Second review. The ledger is for following late writes, never a reason to need
// GitHub's answer on every later Accept.
test("after moving once, an Accept needs no answer from GitHub", () => {
  standing({ 77: 0 });
  const remote = remoteWith(moved());
  const res = reserve(checkout(remote), { GITHUB_LOGIN: NEW, GITHUB_ID: "77" });
  assert.equal(res.status, 0, res.log);
  assert.equal(res.outputs.outcome, "already-accepted", res.log);
  assert.equal(res.outputs.target_repo, `lab-${OLD}`);
});

test("a real rename after an earlier change of case or a rename back still moves the roster and the cohort", () => {
  standing({ 77: "Bea" });
  const remote = remoteWith({
    "students/roster.yml": `schema_version: 2\nstudents:\n  - student_number: "1"\n    full_name: A\n    github_login: Ann\n`,
    [`assignments/${ID}.yml`]: INDIVIDUAL.replace("roster_mode: open", "roster_mode: enforced") + "cohort:\n  - login:ann\n",
    [`acceptances/${ID}/Ann.json`]: acceptance("Ann", 77),
    [`repositories/${ID}/Ann.json`]: { schema_version: 1, assignment_id: ID, github_login: "Ann", repo_name: `${ORG}/lab-Ann`, repo_id: 5 },
    "students/renames/77.json": { schema_version: 1, github_id: 77, previous_logins: ["ann"] },
  });
  probe.setRepos({ "lab-Ann": {} }, { 77: "Bea" });
  const res = reserve(checkout(remote), { GITHUB_LOGIN: "Bea", GITHUB_ID: "77" });
  assert.equal(res.status, 0, res.log);
  assert.equal(res.outputs.outcome, "already-accepted", res.log);
  assert.equal(res.outputs.target_repo, "lab-Ann");
});

test("a pattern edited since is no rename: a Retry follows the pattern as it is", () => {
  probe.setRepos({}, {});
  const remote = remoteWith({
    "students/roster.yml": "schema_version: 2\nstudents: []\n",
    [`assignments/${ID}.yml`]: INDIVIDUAL,
    [`acceptances/${ID}/Ann.json`]: acceptance("Ann", 77),
    [`repositories/${ID}/Ann.json`]: { schema_version: 1, assignment_id: ID, github_login: "Ann", repo_name: `${ORG}/lab-2-Ann`, repo_id: 5 },
  });
  const res = reserve(checkout(remote), { GITHUB_LOGIN: "Ann", GITHUB_ID: "77", SET_ASIDE: "true", PERSIST_REFUSALS: "false", BYPASS_WINDOW: "true" });
  assert.equal(res.status, 0, res.log);
  assert.equal(res.outputs.target_repo, "lab-Ann");
});

test("Retry on a row the nightly has since moved is found through the ledger", () => {
  standing();
  const r = resolveRetry(checkout(remoteWith(moved())), OLD);
  assert.equal(r.status, 0, r.log);
  assert.match(r.output, new RegExp(`^login=${NEW}$`, "m"));
});

test("Retry on an account GitHub no longer has says so and changes nothing", () => {
  standing({});
  const r = resolveRetry(checkout(remoteWith(individual())), OLD);
  assert.equal(r.status, 1, r.log);
  assert.match(r.log, /could not be read/);
  assert.equal(r.output, "");
});

test("Retry on a login nothing has on record is looked up by name, and a typo says so", () => {
  standing({});
  const r = resolveRetry(checkout(remoteWith(individual())), "no-such-student");
  assert.equal(r.status, 1, r.log);
  assert.match(r.log, /No GitHub account named no-such-student.*Check the spelling/);
});
