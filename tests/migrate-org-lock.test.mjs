// The migration from per-repository rulesets to one organization ruleset.
//
// The order is the safety property: create and VERIFY the organization ruleset
// before disabling any repository one. Deleting first leaves a window with no
// lock on a cohort whose deadline has passed - the same rule publish-assignment
// follows with the broker secret, where the new workflow is pushed BEFORE the
// old credential is removed.
//
// Driven as a subprocess against a real control-repo directory, because the
// script's job is reading those files and the ordering is what is under test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(root, "scripts", "migrate-org-lock.mjs");

function controlDir(record, assignment = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pxl-migrate-"));
  mkdirSync(join(dir, "lockdowns", "lab-1"), { recursive: true });
  mkdirSync(join(dir, "assignments"), { recursive: true });
  writeFileSync(join(dir, "lockdowns", "lab-1", "lockdown-record.json"), JSON.stringify(record, null, 2));
  writeFileSync(join(dir, "assignments", "lab-1.yml"), [
    "schema_version: 1",
    "id: lab-1",
    "title: Lab 1",
    "organization: TestOrg",
    "template:",
    "  owner: TestOrg",
    "  repository: tpl",
    "repository_name_pattern: lab-1-{github_login}",
    "opens_at: 2026-08-01T08:00:00.000Z",
    "deadline_at: 2026-09-01T22:00:00.000Z",
    "state: closed",
    ...Object.entries(assignment).map(([k, v]) => `${k}: ${v}`),
    "",
  ].join("\n"));
  return dir;
}

const run = (dir, env = {}) =>
  spawnSync("node", [SCRIPT], {
    encoding: "utf8",
    env: {
      ...process.env,
      ORG: "TestOrg",
      DATA_DIR: dir,
      GITHUB_TOKEN: "x",
      // A base that resolves to nothing, so a run that gets as far as an API
      // call fails loudly instead of touching anything real.
      GITHUB_API_URL: "http://127.0.0.1:9",
      ...env,
    },
  });

const record = (rows) => ({
  schema_version: 1,
  assignment_id: "lab-1",
  executed_at: "2026-09-01T22:05:00.000Z",
  lock_method: "ruleset",
  results: rows,
});

test("DRY RUN IS SACRED - it reports and touches nothing", () => {
  // Not "makes no lasting change": no writes at all. The API base points at a
  // closed port, so a dry run that reached GitHub would fail rather than pass.
  const dir = controlDir(record([
    { github_login: "ada", repo_name: "TestOrg/lab-1-ada", repo_id: 11, lock_method: "ruleset", verified: true },
    { github_login: "bo", repo_name: "TestOrg/lab-1-bo", repo_id: 22, lock_method: "ruleset", verified: true },
  ]));
  try {
    const res = run(dir, { DRY_RUN: "1" });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /DRY RUN/);
    assert.match(res.stdout, /would cover 2 repositories/);
    assert.match(res.stdout, /disable 2 repository ruleset\(s\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("it reads the submission ref off the assignment, not a default", () => {
  const dir = controlDir(
    record([{ github_login: "ada", repo_name: "TestOrg/lab-1-ada", repo_id: 11, lock_method: "ruleset", verified: true }]),
    { submission_ref: "refs/heads/hand-in" },
  );
  try {
    assert.match(run(dir, { DRY_RUN: "1" }).stdout, /on refs\/heads\/hand-in/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a demoted cohort is left alone - the inverse is different", () => {
  // Moving a demotion to a ruleset would silently change what the student lost:
  // demotion takes Actions, secrets and runners, a ruleset takes none of them.
  const dir = controlDir(record([
    { github_login: "ada", repo_name: "TestOrg/lab-1-ada", repo_id: 11, lock_method: "demotion", verified: true },
  ]));
  try {
    const res = run(dir, { DRY_RUN: "1" });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /no repository-ruleset rows to migrate/);
    assert.match(res.stdout, /methods: demotion/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an already-migrated cohort is not migrated twice", () => {
  const dir = controlDir(record([
    { github_login: "ada", repo_name: "TestOrg/lab-1-ada", repo_id: 11, lock_method: "org-ruleset", verified: true },
  ]));
  try {
    assert.match(run(dir, { DRY_RUN: "1" }).stdout, /no repository-ruleset rows/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a team's five rows over one repository are ONE id", () => {
  // The lockdown record writes a row per LOGIN, and a group repository is one
  // object with one lock on it. Counting rows would target the same repository
  // five times and report a cohort five times its size.
  const rows = ["ada", "bo", "cy", "di", "eve"].map((l) => ({
    github_login: l, repo_name: "TestOrg/lab-1-alpha", repo_id: 77, team_slug: "alpha",
    lock_method: "ruleset", verified: true,
  }));
  const dir = controlDir(record(rows));
  try {
    const out = run(dir, { DRY_RUN: "1" }).stdout;
    assert.match(out, /would cover 1 repository\b/);
    assert.match(out, /disable 1 repository ruleset/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a row with no repo_id is not migrated - an org ruleset targets ids", () => {
  const dir = controlDir(record([
    { github_login: "ada", repo_name: "TestOrg/lab-1-ada", lock_method: "ruleset", verified: true },
  ]));
  try {
    assert.match(run(dir, { DRY_RUN: "1" }).stdout, /no repository-ruleset rows to migrate/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an organization with no lockdown records says so and stops", () => {
  const dir = mkdtempSync(join(tmpdir(), "pxl-migrate-empty-"));
  try {
    const res = run(dir, { DRY_RUN: "1" });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /nothing to migrate/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the workflow runs the script, and dry-run is its default", () => {
  // A script nothing calls looks exactly like a working migration, and a
  // destructive default is how somebody migrates twelve organizations by
  // pressing a button to see what it does.
  const wf = readFileSync(join(root, ".github/workflows/migrate-org-lock.yml"), "utf8");
  assert.match(wf, /node scripts\/migrate-org-lock\.mjs/);
  const dryRun = wf.slice(wf.indexOf("dry_run:"));
  assert.match(dryRun.slice(0, 200), /default: true/);
  // It changes what stops a graded cohort being written to, so it must not run
  // beside a finalize doing the same thing.
  assert.match(wf, /group: lockdown-\$\{\{ matrix\.org \}\}/);
  assert.match(wf, /max-parallel: 1/);
});

test("the script creates BEFORE it disables, and verifies in between", () => {
  // The ordering cannot be observed from outside without a live API, so it is
  // asserted where it is written - and anchored on the calls themselves, so a
  // reordering fails rather than a comment being edited.
  const src = readFileSync(SCRIPT, "utf8");
  const create = src.indexOf("ensureOrgSubmissionLock(");
  const verify = src.indexOf("findOrgSubmissionLock(");
  const release = src.indexOf("releaseSubmissionLock(gh");
  assert.ok(create > -1 && verify > -1 && release > -1, "the three steps must all be present");
  assert.ok(create < verify, "it must create before it verifies");
  assert.ok(verify < release, "it must verify before it disables anything");
  // And the repository rulesets are disabled, never deleted: one re-created
  // later without the App in bypass_actors locks this system out too.
  assert.ok(!/DELETE.*\/rulesets\//.test(src), "repository rulesets are disabled, not deleted");
});
