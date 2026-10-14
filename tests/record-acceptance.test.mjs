// scripts/record-acceptance.sh against real git.
//
// Two teammates finishing provisioning at the same moment both write their
// team's manifest. A rebase of one onto the other conflicts on that file, and
// before 2026-10-02 the per-team concurrency group was what kept that from
// happening. With no group, the script re-applies its writes on the latest
// remote state instead - and stands aside when a newer attempt by the same
// student owns the record.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ID = "groepsindeling";

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
function write(dir, files) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), JSON.stringify(content, null, 2) + "\n");
  }
}
function remoteWith(files) {
  const remote = mkdtempSync(join(tmpdir(), "pxl-remote-"));
  git(remote, "init", "-q", "--bare", "-b", "main");
  const seed = checkout(remote);
  git(seed, "checkout", "-q", "-b", "main");
  write(seed, files);
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
function remoteJson(remote, path) {
  const r = spawnSync("git", ["--git-dir", remote, "show", `main:${path}`], { encoding: "utf8" });
  return r.status === 0 ? JSON.parse(r.stdout) : null;
}

const acceptance = (login, run) => ({
  schema_version: 1, assignment_id: ID, github_login: login, github_id: 4, accepted_at: "2026-10-02T10:35:00Z",
  status: "accepted", team_slug: "fullhouse", team_name: "fullhouse", issue_number: 67, decided_by_run_id: run,
});
const team = (members, extra = {}) => ({
  schema_version: 1, assignment_id: ID, team_slug: "fullhouse", team_name: "fullhouse", members, max_members: 4, ...extra,
});

function record(dir, env = {}) {
  return spawnSync("bash", [join(root, "scripts", "record-acceptance.sh")], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      DATA_DIR: dir,
      ASSIGNMENT_ID: ID,
      LOGIN: "Fars",
      TEAM_SLUG: "fullhouse",
      OUTCOME: "created",
      ORG: "TestOrg",
      TARGET_REPO: "grp-fullhouse",
      REPO_ID: "1401466704",
      REPO_URL: "https://github.com/TestOrg/grp-fullhouse",
      BASELINE_SHA: "",
      STUDENT_PERMISSION: "push",
      RUN_URL: "https://github.com/hub/actions/runs/424242",
      COMMIT_LABEL: "Provision",
      GITHUB_RUN_ID: "424242",
      ...env,
    },
  });
}

test("a teammate's write in between is kept, and this run's record lands on top of it", () => {
  const remote = remoteWith({
    [`acceptances/${ID}/Fars.json`]: acceptance("Fars", "424242"),
    [`teams/${ID}/fullhouse.json`]: team(["Thomas", "Fars"]),
  });
  const dir = checkout(remote);
  // A teammate's decision lands first, rewriting the same manifest.
  const other = checkout(remote);
  write(other, { [`teams/${ID}/fullhouse.json`]: team(["Thomas", "Fars", "Sabri"]) });
  git(other, "commit", "-q", "-am", "Sabri joins");
  git(other, "push", "-q", "origin", "HEAD:main");

  const res = record(dir);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /Push refused/, "the race did not happen, so this proves nothing");
  const manifest = remoteJson(remote, `teams/${ID}/fullhouse.json`);
  assert.deepEqual(manifest.members, ["Thomas", "Fars", "Sabri"], "the teammate's join was lost");
  assert.equal(manifest.repo_name, "TestOrg/grp-fullhouse", "the repository never reached the manifest");
  assert.equal(remoteJson(remote, `acceptances/${ID}/Fars.json`).status, "provisioned");
  assert.equal(remoteJson(remote, `repositories/${ID}/Fars.json`).repo_id, 1401466704);
});

test("a run that no longer owns the decision writes nothing", () => {
  const remote = remoteWith({
    [`acceptances/${ID}/Fars.json`]: acceptance("Fars", "999"),
    [`teams/${ID}/fullhouse.json`]: team(["Thomas", "Fars"]),
  });
  const before = git(remote, "rev-parse", "main");
  const res = record(checkout(remote));
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /newer attempt/);
  assert.equal(git(remote, "rev-parse", "main"), before);
  assert.equal(remoteJson(remote, `repositories/${ID}/Fars.json`), null);
});

test("a record from before decisions were stamped is written as it always was", () => {
  const legacy = acceptance("Fars", undefined);
  delete legacy.decided_by_run_id;
  const remote = remoteWith({
    [`acceptances/${ID}/Fars.json`]: legacy,
    [`teams/${ID}/fullhouse.json`]: team(["Thomas", "Fars"]),
  });
  const res = record(checkout(remote));
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.equal(remoteJson(remote, `acceptances/${ID}/Fars.json`).status, "provisioned");
});

test("a failed write is a failed step, not a record pushed around it", () => {
  const remote = remoteWith({
    [`acceptances/${ID}/Fars.json`]: acceptance("Fars", "424242"),
    [`teams/${ID}/fullhouse.json`]: team(["Thomas", "Fars"]),
  });
  const before = git(remote, "rev-parse", "main");
  // write-repository-record.mjs refuses a non-numeric repository id.
  const res = record(checkout(remote), { REPO_ID: "not-a-number" });
  assert.notEqual(res.status, 0, "a failed write reported success");
  assert.equal(git(remote, "rev-parse", "main"), before);
});

test("LD5: a run that failed AFTER the grant still writes the student's record, so the lock and the archive see it", () => {
  // Review 2026-10-14: a failure after step 5 wrote the team's record only
  // (or, alone, nothing), and lockdown, which works from the students'
  // records, never locked a repository the student held.
  const remote = remoteWith({
    [`acceptances/${ID}/Fars.json`]: acceptance("Fars", "424242"),
    [`teams/${ID}/fullhouse.json`]: team(["Fars"]),
  });
  const res = record(checkout(remote), { OUTCOME: "fail:template-not-populated", GRANTED: "true" });
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.equal(remoteJson(remote, `repositories/${ID}/Fars.json`)?.repo_id, 1401466704);
  assert.equal(remoteJson(remote, `acceptances/${ID}/Fars.json`).status, "failed", "still failed, so Retry finishes it");
  assert.equal(remoteJson(remote, `teams/${ID}/fullhouse.json`).repo_name, "TestOrg/grp-fullhouse");

  // Failed BEFORE the grant: the team's record only, as before.
  const before = remoteWith({
    [`acceptances/${ID}/Fars.json`]: acceptance("Fars", "424242"),
    [`teams/${ID}/fullhouse.json`]: team(["Fars"]),
  });
  const early = record(checkout(before), { OUTCOME: "fail:grant", GRANTED: "" });
  assert.equal(early.status, 0, early.stdout + early.stderr);
  assert.equal(remoteJson(before, `repositories/${ID}/Fars.json`), null);
  assert.equal(remoteJson(before, `teams/${ID}/fullhouse.json`).repo_name, "TestOrg/grp-fullhouse");
});

test("TL-7: an INDIVIDUAL student granted their repository before a failure still gets a record; one never granted gets none", () => {
  // No team, so no manifest to carry the repository: the student's own record
  // is the only thing lockdown reads.
  const solo = { ...acceptance("Fars", "424242") };
  delete solo.team_slug;
  delete solo.team_name;
  const env = { TEAM_SLUG: "", TARGET_REPO: "lab-fars", REPO_URL: "https://github.com/TestOrg/lab-fars" };
  const remote = remoteWith({ [`acceptances/${ID}/Fars.json`]: solo });
  const res = record(checkout(remote), { ...env, OUTCOME: "fail:template-not-populated", GRANTED: "true" });
  assert.equal(res.status, 0, res.stdout + res.stderr);
  const rec = remoteJson(remote, `repositories/${ID}/Fars.json`);
  assert.equal(rec?.repo_id, 1401466704);
  assert.equal(rec?.team_slug, undefined);
  assert.equal(remoteJson(remote, `acceptances/${ID}/Fars.json`).status, "failed");

  const never = remoteWith({ [`acceptances/${ID}/Fars.json`]: solo });
  const early = record(checkout(never), { ...env, OUTCOME: "fail:grant", GRANTED: "" });
  assert.equal(early.status, 0, early.stdout + early.stderr);
  assert.equal(remoteJson(never, `repositories/${ID}/Fars.json`), null);
});

test("a remote that stops answering is a failed step, never 'Nothing to record.'", () => {
  // Review 2026-10-06: the push failed, the fetch after it failed too, and the
  // loop wrote the record again on top of its own unpushed commit - found
  // nothing new, said "Nothing to record." and exited 0, while a FAILED record
  // never reached the branch.
  const remote = remoteWith({
    [`acceptances/${ID}/Fars.json`]: acceptance("Fars", "424242"),
    [`teams/${ID}/fullhouse.json`]: team(["Fars"]),
  });
  const before = git(remote, "rev-parse", "main");
  const dir = checkout(remote);
  git(dir, "remote", "set-url", "origin", join(tmpdir(), `gone-${Date.now()}`));
  const res = record(dir, { OUTCOME: "fail:grant", TEAM_SLUG: "", MAX_RETRIES: "3" });
  assert.notEqual(res.status, 0, `reported success: ${res.stdout}`);
  assert.doesNotMatch(res.stdout, /Nothing to record/);
  assert.match(res.stderr, /could not be pushed after 3 attempts/);
  assert.equal(git(remote, "rev-parse", "main"), before);
});
