// lib/starter-commit.mjs and the record writer that carries `starter_sha`.
//
// A repository copied with the template's full history (template_full_history,
// 2026-10-14) has many commits from the first second, so "not started" is "still
// at the commit it was given", recorded at provisioning. That commit is the
// REPOSITORY's: the record is rebuilt whole on every write, so a retry or a
// teammate joining later must not lose it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { addedCommits, starterFor, unstartedRepo } from "../lib/starter-commit.mjs";
import { syncRefusal } from "../lib/starter-sync.mjs";
import { validateAgainst } from "../lib/validate.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const writer = join(root, "scripts", "write-repository-record.mjs");
const A = "a".repeat(40);
const B = "b".repeat(40);

test("starterFor: the record's own, else another record naming the same repository, else none", () => {
  const none = { sha: null, count: null };
  assert.deepEqual(starterFor({ repo_id: 1, starter_sha: A, starter_commit_count: 14 }, []), { sha: A, count: 14 });
  assert.deepEqual(starterFor({ repo_id: 1 }, [{ repo_id: 2, starter_sha: B }, { repo_id: 1, starter_sha: A, starter_commit_count: 3 }]), { sha: A, count: 3 });
  assert.deepEqual(starterFor({ repo_id: 1 }, [{ repo_id: 2, starter_sha: B }]), none);
  assert.deepEqual(starterFor({ repo_id: 1, starter_sha: "not-a-sha" }, []), none);
  assert.deepEqual(starterFor(null, [{ repo_id: 1, starter_sha: A }]), none);
  assert.deepEqual(starterFor({ repo_id: 1, starter_sha: A }, []), { sha: A, count: null }, "a count that was not read stays unknown");
});

test("addedCommits: the commits it was not given, never below zero, the count itself where nothing was recorded", () => {
  assert.equal(addedCommits({ starterCount: 14, commitCount: 17 }), 3);
  assert.equal(addedCommits({ starterCount: 14, commitCount: 14 }), 0);
  assert.equal(addedCommits({ starterCount: 14, commitCount: 9 }), 0, "reset to an older template commit added nothing");
  assert.equal(addedCommits({ starterCount: null, commitCount: 5 }), 5);
  assert.equal(addedCommits({ starterCount: 14, commitCount: null }), null);
});

test("unstartedRepo: at the commit given; GitHub's copy keeps the one-commit rule", () => {
  assert.equal(unstartedRepo({ starterSha: A, latestSha: A, commitCount: 14 }), true);
  assert.equal(unstartedRepo({ starterSha: A, latestSha: B, commitCount: 14 }), false);
  assert.equal(unstartedRepo({ starterSha: A, latestSha: null, commitCount: null }), false, "never observed is not evidence");
  assert.equal(unstartedRepo({ starterSha: null, latestSha: B, commitCount: 1 }), true);
  assert.equal(unstartedRepo({ starterSha: null, latestSha: B, commitCount: 2 }), false);
  assert.equal(unstartedRepo({ starterSha: null, latestSha: B, commitCount: null }), false);
});

function write(dir, login, extra = []) {
  const res = spawnSync("node", [writer,
    "--assignment-id", "lab", "--login", login, "--org", "Org", "--target-repo", "lab-team",
    "--repo-id", "77", "--repo-url", "https://github.com/Org/lab-team", "--data-dir", dir, ...extra], { encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr + res.stdout);
  return JSON.parse(readFileSync(join(dir, "repositories", "lab", `${login}.json`), "utf8"));
}

test("the writer records the commit given, keeps it through a retry, and gives it to a teammate", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pxl-starter-"));
  const first = write(dir, "ann", ["--starter-sha", A, "--starter-commit-count", "14"]);
  assert.equal(first.starter_sha, A);
  assert.equal(first.starter_commit_count, 14);
  assert.ok((await validateAgainst("repository-record", first)).valid);
  // A retry provisions nothing (`reused`) and passes neither.
  const retry = write(dir, "ann", ["--starter-sha", "", "--starter-commit-count", ""]);
  assert.deepEqual([retry.starter_sha, retry.starter_commit_count], [A, 14], "a retry keeps both");
  const mate = write(dir, "bob");
  assert.deepEqual([mate.starter_sha, mate.starter_commit_count], [A, 14], "a teammate joining later gets the repository's");
});

test("starter sync refuses a full-history assignment, before it reads or writes anything", () => {
  // Such a student's first commit IS the template's first commit, so the sync
  // would plan from it and replace a file they reset on purpose.
  assert.match(syncRefusal({ template_full_history: true }), /full history/);
  assert.equal(syncRefusal({}), null);
  assert.equal(syncRefusal({ template_full_history: false }), null);
  // The copy is per student (review 2026-10-14): switched off after some
  // accepted, the setting alone re-opened the sync onto them.
  assert.match(syncRefusal({ template_full_history: false }, [{ repo_id: 1 }, { repo_id: 2, starter_sha: A }]), /some of its students/);
  assert.equal(syncRefusal({}, [{ repo_id: 1 }, { repo_id: 2 }]), null);

  const dir = mkdtempSync(join(tmpdir(), "pxl-sync-refuse-"));
  mkdirSync(join(dir, "assignments"));
  writeFileSync(join(dir, "assignments", "lab.yml"), "id: lab\ntemplate:\n  owner: Org\n  repository: tpl\ntemplate_full_history: true\n");
  const res = spawnSync("node", [join(root, "scripts", "sync-starter.mjs")], {
    encoding: "utf8",
    // An API nobody answers: a call made before the refusal would fail differently.
    env: { ...process.env, GITHUB_TOKEN: "stub", ORG: "Org", ASSIGNMENT_ID: "lab", DATA_DIR: dir, GITHUB_API_URL: "http://127.0.0.1:9" },
  });
  assert.notEqual(res.status, 0);
  assert.match(res.stdout + res.stderr, /Not synced: its students were given the template with its full history/);
});

test("a repository of GitHub's copy records none, and another repository's is never borrowed", () => {
  const dir = mkdtempSync(join(tmpdir(), "pxl-starter-"));
  mkdirSync(join(dir, "repositories", "lab"), { recursive: true });
  writeFileSync(join(dir, "repositories", "lab", "zed.json"), JSON.stringify({ repo_id: 99, starter_sha: B }));
  assert.equal("starter_sha" in write(dir, "ann"), false);
});
