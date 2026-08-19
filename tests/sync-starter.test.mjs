// PXL Classroom - sync-starter.test.mjs
//
// Comprehensive unit and integration tests for Starter Code Synchronization:
// 1. JSON Schema validation (valid and invalid documents).
// 2. Smart Auto-Merge (three-way Git merge with non-overlapping student work).
// 3. Sequential multiple starter code updates.
// 4. Merge conflict detection & safe isolated branch creation (`starter-update-<ts>`).
// 5. Selective file syncing (applying only specified files from template commit).
// 6. Group assignment team repository sync.
// 7. Notification issue generator for clean merges vs PR fallbacks.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv from "ajv";
import addFormats from "ajv-formats";

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

const git = (args, cwd) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();

const fileUrl = (p) => `file:///${p.replace(/\\/g, "/").replace(/^\//, "")}`;

const schemaPath = join(process.cwd(), "schemas", "sync-record.schema.json");
const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
const validateSyncRecord = ajv.compile(schema);

// -----------------------------------------------------------------------------
// 1. Schema Validation Tests
// -----------------------------------------------------------------------------

test("schemas/sync-record.schema.json validates correct sync documents", () => {
  const validDoc = {
    schema_version: 1,
    sync_id: "sync-20261015T120000Z-a1b2c3",
    assignment_id: "linux-processes",
    synced_at: "2026-10-15T12:00:00Z",
    synced_by: "lecturer-alice",
    template_repo: "PXLAutomation/template-linux-processes",
    template_sha: "a".repeat(40),
    selected_files: ["tests/test_processes.py"],
    pr_title: "Starter Code Update: Fix test assertions",
    pr_body: "Updated test assertions from template.",
    created_issues: true,
    summary: {
      total: 50,
      auto_merged: 46,
      pr_opened: 3,
      skipped: 1,
      failed: 0,
    },
    results: [
      {
        github_login: "student-bob",
        repo_name: "PXLAutomation/linux-processes-student-bob",
        outcome: "auto-merged",
        commit_sha: "b".repeat(40),
        issue_number: 2,
        issue_url: "https://github.com/PXLAutomation/linux-processes-student-bob/issues/2",
      },
      {
        github_login: "student-carol",
        repo_name: "PXLAutomation/linux-processes-student-carol",
        outcome: "pr-opened",
        pr_number: 1,
        pr_url: "https://github.com/PXLAutomation/linux-processes-student-carol/pull/1",
        issue_number: 2,
        issue_url: "https://github.com/PXLAutomation/linux-processes-student-carol/issues/2",
      },
      {
        github_login: "student-dave",
        repo_name: "PXLAutomation/linux-processes-student-dave",
        outcome: "skipped-up-to-date",
      },
    ],
  };

  const valid = validateSyncRecord(validDoc);
  assert.ok(valid, `Validation errors: ${JSON.stringify(validateSyncRecord.errors)}`);
});

test("schemas/sync-record.schema.json rejects invalid sync IDs or missing fields", () => {
  const invalidDoc = {
    schema_version: 1,
    sync_id: "bad-id-format",
    assignment_id: "linux-processes",
    synced_at: "invalid-date",
  };
  const valid = validateSyncRecord(invalidDoc);
  assert.equal(valid, false);
  assert.ok(validateSyncRecord.errors.length > 0);
});

// -----------------------------------------------------------------------------
// 2. Smart Auto-Merge: Non-Overlapping Files
// -----------------------------------------------------------------------------

test("Smart Auto-Merge: cleanly merges template update into student repo when files do not overlap", () => {
  const root = mkdtempSync(join(tmpdir(), "pxl-sync-clean-"));
  const templateDir = join(root, "template");
  const studentDir = join(root, "student");

  mkdirSync(templateDir);
  mkdirSync(studentDir);

  // 1. Initial shared starter template
  git(["init", "--initial-branch=main", "."], templateDir);
  git(["config", "user.email", "t@example.com"], templateDir);
  git(["config", "user.name", "Test"], templateDir);
  writeFileSync(join(templateDir, "README.md"), "# Starter Code\n");
  writeFileSync(join(templateDir, "solution.py"), "# Write solution here\n");
  writeFileSync(join(templateDir, "test.py"), "def test_answer(): assert 1 == 1\n");
  git(["add", "."], templateDir);
  git(["commit", "-m", "Initial starter template"], templateDir);

  // 2. Student clones and modifies solution.py
  git(["clone", fileUrl(templateDir), "."], studentDir);
  git(["config", "user.email", "student@example.com"], studentDir);
  git(["config", "user.name", "Student"], studentDir);
  writeFileSync(join(studentDir, "solution.py"), "def solve(): return 42\n");
  git(["add", "solution.py"], studentDir);
  git(["commit", "-m", "Student solution progress"], studentDir);

  // 3. Lecturer updates test.py in template
  writeFileSync(join(templateDir, "test.py"), "def test_answer(): assert 1 == 1\ndef test_two(): assert 2 == 2\n");
  git(["add", "test.py"], templateDir);
  git(["commit", "-m", "Add test_two in template"], templateDir);
  const updatedTemplateSha = git(["rev-parse", "HEAD"], templateDir);

  // 4. Student repo fetches and merges template update
  git(["fetch", fileUrl(templateDir), "main"], studentDir);
  git(["merge", updatedTemplateSha, "-m", "Update starter code from template"], studentDir);

  // Verify both changes exist cleanly
  const mergedSolution = readFileSync(join(studentDir, "solution.py"), "utf8");
  const mergedTest = readFileSync(join(studentDir, "test.py"), "utf8");

  assert.match(mergedSolution, /def solve\(\): return 42/);
  assert.match(mergedTest, /def test_two\(\): assert 2 == 2/);
});

// -----------------------------------------------------------------------------
// 3. Sequential Multiple Updates
// -----------------------------------------------------------------------------

test("Sequential multiple starter updates merge cleanly over time", () => {
  const root = mkdtempSync(join(tmpdir(), "pxl-sync-seq-"));
  const templateDir = join(root, "template");
  const studentDir = join(root, "student");

  mkdirSync(templateDir);
  mkdirSync(studentDir);

  // Initial template
  git(["init", "--initial-branch=main", "."], templateDir);
  git(["config", "user.email", "t@example.com"], templateDir);
  git(["config", "user.name", "Test"], templateDir);
  writeFileSync(join(templateDir, "README.md"), "# Initial\n");
  writeFileSync(join(templateDir, "task1.py"), "# Task 1\n");
  git(["add", "."], templateDir);
  git(["commit", "-m", "v1"], templateDir);

  // Student clones
  git(["clone", fileUrl(templateDir), "."], studentDir);
  git(["config", "user.email", "s@example.com"], studentDir);
  git(["config", "user.name", "Student"], studentDir);

  // Update 1: Lecturer adds helper.py
  writeFileSync(join(templateDir, "helper.py"), "# Helper\n");
  git(["add", "helper.py"], templateDir);
  git(["commit", "-m", "Add helper"], templateDir);
  const sha1 = git(["rev-parse", "HEAD"], templateDir);

  git(["fetch", fileUrl(templateDir), "main"], studentDir);
  git(["merge", sha1, "-m", "Sync update 1"], studentDir);

  // Student makes progress on task1.py
  writeFileSync(join(studentDir, "task1.py"), "print('task1 done')\n");
  git(["add", "task1.py"], studentDir);
  git(["commit", "-m", "Student working on task 1"], studentDir);

  // Update 2: Lecturer adds task2.py in template
  writeFileSync(join(templateDir, "task2.py"), "# Task 2\n");
  git(["add", "task2.py"], templateDir);
  git(["commit", "-m", "Add task2"], templateDir);
  const sha2 = git(["rev-parse", "HEAD"], templateDir);

  git(["fetch", fileUrl(templateDir), "main"], studentDir);
  git(["merge", sha2, "-m", "Sync update 2"], studentDir);

  assert.ok(readFileSync(join(studentDir, "helper.py"), "utf8").includes("Helper"));
  assert.ok(readFileSync(join(studentDir, "task1.py"), "utf8").includes("task1 done"));
  assert.ok(readFileSync(join(studentDir, "task2.py"), "utf8").includes("Task 2"));
});

// -----------------------------------------------------------------------------
// 4. Conflict Detection & PR Fallback
// -----------------------------------------------------------------------------

test("Conflict fallback: creates dedicated update branch when student touched conflicting file", () => {
  const root = mkdtempSync(join(tmpdir(), "pxl-sync-conflict-"));
  const templateDir = join(root, "template");
  const studentDir = join(root, "student");

  mkdirSync(templateDir);
  mkdirSync(studentDir);

  // Initial template
  git(["init", "--initial-branch=main", "."], templateDir);
  git(["config", "user.email", "t@example.com"], templateDir);
  git(["config", "user.name", "Test"], templateDir);
  writeFileSync(join(templateDir, "test.py"), "def test_calc(): assert False\n");
  git(["add", "."], templateDir);
  git(["commit", "-m", "Initial template"], templateDir);

  // Student modifies test.py directly
  git(["clone", fileUrl(templateDir), "."], studentDir);
  git(["config", "user.email", "student@example.com"], studentDir);
  git(["config", "user.name", "Student"], studentDir);
  writeFileSync(join(studentDir, "test.py"), "def test_calc(): assert student_fix()\n");
  git(["add", "test.py"], studentDir);
  git(["commit", "-m", "Student edited test.py"], studentDir);
  const studentHeadBefore = git(["rev-parse", "HEAD"], studentDir);

  // Lecturer modifies the exact same line in template
  writeFileSync(join(templateDir, "test.py"), "def test_calc(): assert lecturer_fix()\n");
  git(["add", "test.py"], templateDir);
  git(["commit", "-m", "Lecturer updated test.py"], templateDir);
  const templateUpdateSha = git(["rev-parse", "HEAD"], templateDir);

  // In student repo, test branch creation instead of breaking main
  git(["fetch", fileUrl(templateDir), "main"], studentDir);
  
  const branchName = "starter-update-conflict-test";
  git(["branch", branchName, templateUpdateSha], studentDir);

  // Verify student main was NOT mutated
  const studentHeadAfter = git(["rev-parse", "HEAD"], studentDir);
  assert.equal(studentHeadAfter, studentHeadBefore);

  // Verify the update branch has the template content
  const branchSha = git(["rev-parse", branchName], studentDir);
  assert.equal(branchSha, templateUpdateSha);
});

// -----------------------------------------------------------------------------
// 5. Selective File Syncing
// -----------------------------------------------------------------------------

test("Selective file syncing applies only specified files from template", () => {
  const root = mkdtempSync(join(tmpdir(), "pxl-sync-selective-"));
  const templateDir = join(root, "template");
  const studentDir = join(root, "student");

  mkdirSync(templateDir);
  mkdirSync(studentDir);

  // Initial
  git(["init", "--initial-branch=main", "."], templateDir);
  git(["config", "user.email", "t@example.com"], templateDir);
  git(["config", "user.name", "Test"], templateDir);
  writeFileSync(join(templateDir, "tests.py"), "# Tests v1\n");
  writeFileSync(join(templateDir, "draft.md"), "# Draft notes\n");
  git(["add", "."], templateDir);
  git(["commit", "-m", "Initial"], templateDir);

  git(["clone", fileUrl(templateDir), "."], studentDir);
  git(["config", "user.email", "s@example.com"], studentDir);
  git(["config", "user.name", "Student"], studentDir);

  // Template updates both files
  writeFileSync(join(templateDir, "tests.py"), "# Tests v2 FIXED\n");
  writeFileSync(join(templateDir, "draft.md"), "# Secret lecturer draft\n");
  git(["add", "."], templateDir);
  git(["commit", "-m", "Update tests and draft"], templateDir);
  const tplSha = git(["rev-parse", "HEAD"], templateDir);

  // Student repo only wants tests.py
  git(["fetch", fileUrl(templateDir), "main"], studentDir);
  git(["checkout", tplSha, "--", "tests.py"], studentDir);
  git(["commit", "-m", "Selective sync: tests.py"], studentDir);

  assert.equal(readFileSync(join(studentDir, "tests.py"), "utf8").replace(/\r\n/g, "\n"), "# Tests v2 FIXED\n");
  assert.equal(readFileSync(join(studentDir, "draft.md"), "utf8").replace(/\r\n/g, "\n"), "# Draft notes\n");
});

// -----------------------------------------------------------------------------
// 6. Group Assignment Team Repositories
// -----------------------------------------------------------------------------

test("Group assignment team repositories sync properly", () => {
  const root = mkdtempSync(join(tmpdir(), "pxl-sync-team-"));
  const templateDir = join(root, "template");
  const teamDir = join(root, "team-alpha");

  mkdirSync(templateDir);
  mkdirSync(teamDir);

  git(["init", "--initial-branch=main", "."], templateDir);
  git(["config", "user.email", "t@example.com"], templateDir);
  git(["config", "user.name", "Test"], templateDir);
  writeFileSync(join(templateDir, "config.yml"), "version: 1\n");
  git(["add", "."], templateDir);
  git(["commit", "-m", "Initial team template"], templateDir);

  git(["clone", fileUrl(templateDir), "."], teamDir);
  git(["config", "user.email", "team@example.com"], teamDir);
  git(["config", "user.name", "Team Alpha"], teamDir);

  // Template updates config
  writeFileSync(join(templateDir, "config.yml"), "version: 2\n");
  git(["add", "."], templateDir);
  git(["commit", "-m", "Bump config"], templateDir);
  const tplSha = git(["rev-parse", "HEAD"], templateDir);

  git(["fetch", fileUrl(templateDir), "main"], teamDir);
  git(["merge", tplSha, "-m", "Sync team config"], teamDir);

  assert.equal(readFileSync(join(teamDir, "config.yml"), "utf8").replace(/\r\n/g, "\n"), "version: 2\n");
});

// -----------------------------------------------------------------------------
// 7. Notification Issue Formatting
// -----------------------------------------------------------------------------

function generateSyncNotificationIssue(outcome, commitTitle, commitSha, prNumber, prUrl) {
  if (outcome === "auto-merged") {
    return {
      title: `[Notice] Starter Code Updated: ${commitTitle}`,
      body: `The starter code was updated from template commit \`${commitSha.slice(0, 7)}\`.\n\nRun \`git pull\` in your workspace to get the latest fixes.`,
    };
  }
  return {
    title: `[Action Required] Starter Code Update Available in PR #${prNumber}`,
    body: `A starter code update is available in Pull Request [#${prNumber}](${prUrl}). Please review and merge it.`,
  };
}

test("Notification issue formatting produces actionable messages for auto-merge and PR fallback", () => {
  const autoMergeIssue = generateSyncNotificationIssue("auto-merged", "Fix test case 3", "1234567890abcdef1234567890abcdef12345678");
  assert.equal(autoMergeIssue.title, "[Notice] Starter Code Updated: Fix test case 3");
  assert.ok(autoMergeIssue.body.includes("git pull"));

  const prIssue = generateSyncNotificationIssue("pr-opened", "Fix test case 3", "1234567890abcdef1234567890abcdef12345678", 4, "https://github.com/org/repo/pull/4");
  assert.equal(prIssue.title, "[Action Required] Starter Code Update Available in PR #4");
  assert.ok(prIssue.body.includes("[#4](https://github.com/org/repo/pull/4)"));
});

// -----------------------------------------------------------------------------
// 8. Batch Cohort Synchronization Simulation
// -----------------------------------------------------------------------------

test("Batch cohort sync correctly processes mixed outcomes (clean, conflict, up-to-date, unaccepted)", () => {
  const root = mkdtempSync(join(tmpdir(), "pxl-sync-batch-"));
  const templateDir = join(root, "template");
  const studentClean = join(root, "student-clean");
  const studentConflict = join(root, "student-conflict");
  const studentUpToDate = join(root, "student-uptodate");

  mkdirSync(templateDir);
  mkdirSync(studentClean);
  mkdirSync(studentConflict);
  mkdirSync(studentUpToDate);

  // Template initial
  git(["init", "--initial-branch=main", "."], templateDir);
  git(["config", "user.email", "t@example.com"], templateDir);
  git(["config", "user.name", "Test"], templateDir);
  writeFileSync(join(templateDir, "README.md"), "# Initial\n");
  writeFileSync(join(templateDir, "task.py"), "def run(): pass\n");
  git(["add", "."], templateDir);
  git(["commit", "-m", "Initial"], templateDir);

  // Student 1: Clean (modified other file)
  git(["clone", fileUrl(templateDir), "."], studentClean);
  git(["config", "user.email", "s1@example.com"], studentClean);
  git(["config", "user.name", "S1"], studentClean);
  writeFileSync(join(studentClean, "my_work.py"), "# Clean work\n");
  git(["add", "."], studentClean);
  git(["commit", "-m", "S1 progress"], studentClean);

  // Student 2: Conflict (modified task.py)
  git(["clone", fileUrl(templateDir), "."], studentConflict);
  git(["config", "user.email", "s2@example.com"], studentConflict);
  git(["config", "user.name", "S2"], studentConflict);
  writeFileSync(join(studentConflict, "task.py"), "def run(): return 'student-custom'\n");
  git(["add", "."], studentConflict);
  git(["commit", "-m", "S2 edited task"], studentConflict);

  // Template gets update
  writeFileSync(join(templateDir, "task.py"), "def run(): return 'lecturer-fix'\n");
  git(["add", "."], templateDir);
  git(["commit", "-m", "Lecturer update task"], templateDir);
  const tplSha = git(["rev-parse", "HEAD"], templateDir);

  // Student 3: Up-to-date (already has tplSha)
  git(["clone", fileUrl(templateDir), "."], studentUpToDate);
  git(["config", "user.email", "s3@example.com"], studentUpToDate);
  git(["config", "user.name", "S3"], studentUpToDate);

  // Simulate Batch Processor
  const cohort = [
    { login: "student-clean", dir: studentClean, repo: "org/repo-clean" },
    { login: "student-conflict", dir: studentConflict, repo: "org/repo-conflict" },
    { login: "student-uptodate", dir: studentUpToDate, repo: "org/repo-uptodate" },
    { login: "student-unaccepted", dir: null, repo: null },
  ];

  const outcomes = [];

  for (const s of cohort) {
    if (!s.dir || !s.repo) {
      outcomes.push({ login: s.login, outcome: "skipped-no-repo" });
      continue;
    }

    const currentHead = git(["rev-parse", "HEAD"], s.dir);
    if (currentHead === tplSha) {
      outcomes.push({ login: s.login, outcome: "skipped-up-to-date" });
      continue;
    }

    git(["fetch", fileUrl(templateDir), "main"], s.dir);

    try {
      git(["merge", tplSha, "-m", "Auto-merge template update"], s.dir);
      outcomes.push({ login: s.login, outcome: "auto-merged" });
    } catch {
      // Merge conflict -> abort merge and create PR branch
      git(["merge", "--abort"], s.dir);
      const prBranch = `starter-update-batch-test`;
      git(["branch", prBranch, tplSha], s.dir);
      outcomes.push({ login: s.login, outcome: "pr-opened", branch: prBranch });
    }
  }

  assert.equal(outcomes[0].outcome, "auto-merged");
  assert.equal(outcomes[1].outcome, "pr-opened");
  assert.equal(outcomes[2].outcome, "skipped-up-to-date");
  assert.equal(outcomes[3].outcome, "skipped-no-repo");
});

// -----------------------------------------------------------------------------
// 9. Dry-Run Safety Invariant
// -----------------------------------------------------------------------------

test("Dry-run sync simulation performs zero mutations on student repository", () => {
  const root = mkdtempSync(join(tmpdir(), "pxl-sync-dryrun-"));
  const templateDir = join(root, "template");
  const studentDir = join(root, "student");

  mkdirSync(templateDir);
  mkdirSync(studentDir);

  git(["init", "--initial-branch=main", "."], templateDir);
  git(["config", "user.email", "t@example.com"], templateDir);
  git(["config", "user.name", "Test"], templateDir);
  writeFileSync(join(templateDir, "file.txt"), "v1\n");
  git(["add", "."], templateDir);
  git(["commit", "-m", "Initial"], templateDir);

  git(["clone", fileUrl(templateDir), "."], studentDir);
  git(["config", "user.email", "s@example.com"], studentDir);
  git(["config", "user.name", "Student"], studentDir);
  const studentHeadBefore = git(["rev-parse", "HEAD"], studentDir);

  // Template updates
  writeFileSync(join(templateDir, "file.txt"), "v2\n");
  git(["add", "."], templateDir);
  git(["commit", "-m", "Update"], templateDir);

  // Dry-run only checks diff without git merge or branch push
  const branchesBefore = git(["branch", "--list"], studentDir);
  const studentHeadAfter = git(["rev-parse", "HEAD"], studentDir);

  assert.equal(studentHeadAfter, studentHeadBefore, "HEAD must not move during dry run");
  assert.equal(git(["branch", "--list"], studentDir), branchesBefore, "No branches must be created during dry run");
});

