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
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { addedCommits, noSubmissionRow, starterFor, unstartedRepo } from "../lib/starter-commit.mjs";
import { syncRefusal } from "../lib/starter-sync.mjs";
import { validateAgainst } from "../lib/validate.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const writer = join(root, "scripts", "write-repository-record.mjs");
const A = "a".repeat(40);
const B = "b".repeat(40);

test("starterFor: the record's own, else another record naming the same repository, else none", () => {
  const none = { sha: null, count: null, fullHistory: false };
  assert.deepEqual(starterFor({ repo_id: 1, starter_sha: A, starter_commit_count: 14 }, []), { sha: A, count: 14, fullHistory: false });
  assert.deepEqual(starterFor({ repo_id: 1 }, [{ repo_id: 2, starter_sha: B }, { repo_id: 1, starter_sha: A, starter_commit_count: 3 }]), { sha: A, count: 3, fullHistory: false });
  assert.deepEqual(starterFor({ repo_id: 1 }, [{ repo_id: 2, starter_sha: B }]), none);
  assert.deepEqual(starterFor({ repo_id: 1, starter_sha: "not-a-sha" }, []), none);
  assert.deepEqual(starterFor(null, [{ repo_id: 1, starter_sha: A }]), none);
  assert.deepEqual(starterFor({ repo_id: 1, starter_sha: A }, []), { sha: A, count: null, fullHistory: false }, "a count that was not read stays unknown");
  // Which kind of start: any record naming the repository that says so.
  assert.equal(starterFor({ repo_id: 1 }, [{ repo_id: 1, starter_sha: A, full_history: true }]).fullHistory, true);
  assert.equal(starterFor({ repo_id: 1, starter_sha: A }, [{ repo_id: 2, starter_sha: B, full_history: true }]).fullHistory, false, "never another repository's");
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

test("TA-10 (R1-5): 'No submission' before anything is read - an empty repository only for GitHub's copy", () => {
  const row = (extra) => ({ repo_name: "Org/lab-ann", submission_status: "on-time", commit_count: 3, ...extra });
  assert.equal(noSubmissionRow(row()), false);
  assert.equal(noSubmissionRow(row({ repo_name: null })), true, "no repository");
  assert.equal(noSubmissionRow(row({ submission_status: "no-submission" })), true, "the report says so");
  assert.equal(noSubmissionRow(row({ commit_count: 0 })), true, "GitHub's copy with nothing in it");
  // A full-history copy that added nothing on top of what it was given: an
  // amend or a reset inside the template's history - the report's status
  // decides, not the count.
  assert.equal(noSubmissionRow(row({ commit_count: 0, starter_sha: A })), false);
  assert.equal(noSubmissionRow(row({ commit_count: 0, starter_sha: A, submission_status: "no-submission" })), true);
  assert.equal(noSubmissionRow(null), true);
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
  // A retry that RECOVERED one (only the App has pushed, and it has since
  // added the grading workflow a first run failed to add): provisioning's is
  // newer and certain, and wins over the record (review 2026-10-14).
  const recovered = write(dir, "ann", ["--starter-sha", B, "--starter-commit-count", "15"]);
  assert.deepEqual([recovered.starter_sha, recovered.starter_commit_count], [B, 15]);
  // Provisioning did not say it is a full-history copy, so this start is
  // GitHub's copy plus provisioning's grading workflow: no flag.
  assert.equal("full_history" in recovered, false);
});

test("R6-42: a retry keeps the feedback pull request the record names, for the same repository only", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pxl-record-pr-"));
  const first = write(dir, "ann", ["--baseline-sha", A]);
  // What scripts/open-feedback-prs.mjs writes once the pull request is open.
  const path = join(dir, "repositories", "lab", "ann.json");
  writeFileSync(path, JSON.stringify({ ...first, feedback_pr_number: 3, feedback_pr_url: "https://github.com/Org/lab-team/pull/3" }));
  const retry = write(dir, "ann");
  assert.deepEqual([retry.feedback_pr_number, retry.feedback_pr_url, retry.feedback_pr_baseline_sha], [3, "https://github.com/Org/lab-team/pull/3", A], "kept, the baseline too where none was given");
  assert.ok((await validateAgainst("repository-record", retry)).valid);
  // A different repository at that name: nothing of the old one's.
  const other = spawnSync("node", [writer, "--assignment-id", "lab", "--login", "ann", "--org", "Org", "--target-repo", "lab-team",
    "--repo-id", "78", "--repo-url", "https://github.com/Org/lab-team", "--data-dir", dir], { encoding: "utf8" });
  assert.equal(other.status, 0, other.stderr);
  const moved = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual([moved.feedback_pr_number, moved.feedback_pr_url, moved.feedback_pr_baseline_sha], [null, null, null]);
});

test("the writer marks a start full_history exactly when provisioning says so, and carries it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pxl-starter-fh-"));
  const first = write(dir, "ann", ["--starter-sha", A, "--starter-commit-count", "14", "--full-history", "true"]);
  assert.equal(first.full_history, true);
  assert.ok((await validateAgainst("repository-record", first)).valid);
  // A retry provisions nothing, and the record keeps what it was.
  const retry = write(dir, "ann", ["--full-history", "false"]);
  assert.deepEqual([retry.starter_sha, retry.full_history], [A, true]);
  assert.equal(write(dir, "bob").full_history, true, "a teammate gets the repository's");
  // GitHub's copy plus the grading workflow: a start, no flag.
  const other = mkdtempSync(join(tmpdir(), "pxl-starter-gh-"));
  assert.equal("full_history" in write(other, "cleo", ["--starter-sha", B, "--starter-commit-count", "2", "--full-history", "false"]), false);
});

test("AC5: the team's file keeps its repository's start, so a joiner after the only carrier left still gets it", async () => {
  // Review 2026-10-14: the start lived on the members' records alone. Ann
  // made the team's copy and switched out, her record now names another
  // repository, and Bob, joining next, had nothing to copy it from.
  const dir = mkdtempSync(join(tmpdir(), "pxl-starter-team-"));
  const teamFile = join(dir, "teams", "lab", "alpha.json");
  mkdirSync(dirname(teamFile), { recursive: true });
  writeFileSync(teamFile, JSON.stringify({
    schema_version: 1, assignment_id: "lab", team_slug: "alpha", team_name: "Alpha", members: ["ann"], max_members: 3,
    created_at: "2026-10-14T10:00:00Z", created_by: "ann",
  }));
  write(dir, "ann", ["--team-slug", "alpha", "--starter-sha", A, "--starter-commit-count", "14", "--full-history", "true"]);
  const team = JSON.parse(readFileSync(teamFile, "utf8"));
  assert.deepEqual([team.starter_sha, team.starter_commit_count, team.full_history], [A, 14, true]);
  assert.ok((await validateAgainst("team", team)).valid, "the team schema takes it");
  // Ann moves on: her record names another repository now.
  rmSync(join(dir, "repositories", "lab", "ann.json"));
  const bob = write(dir, "bob", ["--team-slug", "alpha"]);
  assert.deepEqual([bob.starter_sha, bob.starter_commit_count, bob.full_history], [A, 14, true], "carried from the team's file");
});

test("TA-9: a different repository at the team's name (removed and made again) drops the old one's start from the team's file", () => {
  // `sameRepo` false: the file's start was the old repository's, and this run
  // recorded none for the new one - so none is kept, rather than the old one.
  const dir = mkdtempSync(join(tmpdir(), "pxl-starter-remade-"));
  const teamFile = join(dir, "teams", "lab", "alpha.json");
  mkdirSync(dirname(teamFile), { recursive: true });
  writeFileSync(teamFile, JSON.stringify({
    schema_version: 1, assignment_id: "lab", team_slug: "alpha", team_name: "Alpha", members: ["ann"], max_members: 3,
    created_at: "2026-10-14T10:00:00Z", created_by: "ann", repo_id: 41, starter_sha: A, starter_commit_count: 14, full_history: true,
  }));
  const record = write(dir, "ann", ["--team-slug", "alpha"]);
  assert.equal(record.starter_sha, undefined, "the old repository's start is not carried onto the new one's record");
  const team = JSON.parse(readFileSync(teamFile, "utf8"));
  assert.equal(team.repo_id, 77);
  assert.equal(team.starter_sha, undefined);
  assert.equal(team.starter_commit_count, undefined);
  assert.equal(team.full_history, undefined);
  // The same repository with nothing new to say keeps what the file holds.
  writeFileSync(teamFile, JSON.stringify({ ...team, repo_id: 77, starter_sha: A, starter_commit_count: 14 }));
  write(dir, "ann", ["--team-slug", "alpha"]);
  assert.equal(JSON.parse(readFileSync(teamFile, "utf8")).starter_sha, A);
});

test("starterFor: where a team's records differ, every member is read against the one with the most commits", () => {
  // Ann's record holds the copy's head (14); Bob's run recovered the head after
  // the App added the grading workflow (15). One repository, one answer.
  const ann = { repo_id: 77, starter_sha: A, starter_commit_count: 14 };
  const bob = { repo_id: 77, starter_sha: B, starter_commit_count: 15 };
  const cleo = { repo_id: 77 };
  for (const record of [ann, bob, cleo]) {
    assert.deepEqual(starterFor(record, [ann, bob, cleo]), { sha: B, count: 15, fullHistory: false }, JSON.stringify(record));
  }
  // Without counts, the record's own, then the first other.
  assert.deepEqual(starterFor({ repo_id: 77, starter_sha: A }, [{ repo_id: 77, starter_sha: B }]), { sha: A, count: null, fullHistory: false });
});

test("starter sync refuses a full-history assignment, before it reads or writes anything", () => {
  // Such a student's first commit IS the template's first commit, so the sync
  // would plan from it and replace a file they reset on purpose.
  assert.match(syncRefusal({ template_full_history: true }), /full history/);
  assert.equal(syncRefusal({}), null);
  assert.equal(syncRefusal({ template_full_history: false }), null);
  // The copy is per student (review 2026-10-14): switched off after some
  // accepted, the setting alone re-opened the sync onto them.
  assert.match(syncRefusal({ template_full_history: false }, [{ repo_id: 1 }, { repo_id: 2, starter_sha: A, full_history: true }]), /some of its students/);
  assert.equal(syncRefusal({}, [{ repo_id: 1 }, { repo_id: 2 }]), null);
  // A start recorded for GitHub's copy plus provisioning's grading workflow is
  // not a full-history copy: those students are synced like anyone's.
  assert.equal(syncRefusal({}, [{ repo_id: 2, starter_sha: A, starter_commit_count: 2 }]), null);

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
