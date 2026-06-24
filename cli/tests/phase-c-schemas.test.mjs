// PXL Classroom CLI — Phase C schema-shape tests.
//
// Covers the new fields landing in Phase C:
//   - assignment.schema.json    : feedback_pr + feedback_pr_baseline_branch + autograde
//   - repository-record.schema.json : feedback_pr_number, feedback_pr_url, feedback_pr_baseline_sha
//   - grading-result.schema.json (new)
//
// No network. Same pattern as roster-csv.test.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { validateAgainst } from "../src/lib/validate.mjs";

function baseAssignment(overrides = {}) {
  return {
    schema_version: 1,
    id: "linux-processes-2026",
    title: "Linux processes 2026",
    organization: "PXLAutomation",
    template: { owner: "PXLAutomation", repository: "template-linux-processes" },
    repository_name_pattern: "linux-processes-{github_login}",
    opens_at: "2026-01-01T00:00:00.000Z",
    deadline_at: "2026-02-01T00:00:00.000Z",
    ...overrides,
  };
}

test("assignment with feedback_pr enabled passes validation", () => {
  const { valid, errors } = validateAgainst("assignment", baseAssignment({
    feedback_pr: true,
    feedback_pr_baseline_branch: "pxl-baseline",
  }));
  assert.equal(valid, true, JSON.stringify(errors));
});

test("assignment with feedback_pr_baseline_branch but no flag still validates (independent fields)", () => {
  const { valid } = validateAgainst("assignment", baseAssignment({
    feedback_pr_baseline_branch: "alt-base",
  }));
  assert.equal(valid, true);
});

test("assignment with invalid baseline branch pattern fails", () => {
  const { valid, errors } = validateAgainst("assignment", baseAssignment({
    feedback_pr: true,
    feedback_pr_baseline_branch: "bad branch with spaces",
  }));
  assert.equal(valid, false);
  assert.ok(errors.some((e) => /feedback_pr_baseline_branch/.test(JSON.stringify(e))));
});

test("assignment with autograde block validates (run + io + python)", () => {
  const { valid, errors } = validateAgainst("assignment", baseAssignment({
    autograde: {
      enabled: true,
      tests: [
        { id: "compile", type: "run", command: "make", timeout_s: 30, points: 10 },
        { id: "io-1",    type: "io",  command: "./a.out", stdin: "1 2\n", expected_stdout: "3", timeout_s: 5, points: 5 },
        { id: "py",      type: "python", script: "print(1+1)", points: 5 },
      ],
    },
  }));
  assert.equal(valid, true, JSON.stringify(errors));
});

test("autograde requires tests array (empty rejected)", () => {
  const { valid } = validateAgainst("assignment", baseAssignment({
    autograde: { enabled: true, tests: [] },
  }));
  assert.equal(valid, false);
});

test("autograde test rejects unknown type", () => {
  const { valid, errors } = validateAgainst("assignment", baseAssignment({
    autograde: {
      enabled: true,
      tests: [{ id: "bad", type: "wat", points: 1 }],
    },
  }));
  assert.equal(valid, false);
  assert.ok(errors.some((e) => /enum/.test(JSON.stringify(e))));
});

test("repository-record accepts feedback_pr_* fields", () => {
  const { valid, errors } = validateAgainst("repository-record", {
    schema_version: 1,
    assignment_id: "linux-processes-2026",
    github_login: "alice",
    repo_id: 12345,
    repo_name: "PXLAutomation/linux-processes-alice",
    repo_url: "https://github.com/PXLAutomation/linux-processes-alice",
    feedback_pr_number: 7,
    feedback_pr_url: "https://github.com/PXLAutomation/linux-processes-alice/pull/7",
    feedback_pr_baseline_sha: "a".repeat(40),
  });
  assert.equal(valid, true, JSON.stringify(errors));
});

test("grading-result schema accepts a minimal pass-fail record", () => {
  const { valid, errors } = validateAgainst("grading-result", {
    schema_version: 1,
    assignment_id: "linux-processes-2026",
    github_login: "alice",
    archive_sha: "a".repeat(40),
    archive_branch: "preserved/linux-processes-2026/alice",
    graded_at: "2026-02-02T12:00:00.000Z",
    graded_by: "lecturer",
    runner: "docker",
    total_points: 20,
    earned_points: 15,
    tests: [
      { id: "compile",    passed: true,  points: 10, earned: 10, duration_ms: 1234, exit_code: 0, timed_out: false },
      { id: "tests-pass", passed: false, points: 10, earned: 0,  duration_ms: 5678, exit_code: 1, timed_out: false, stderr: "expected 42" },
    ],
  });
  assert.equal(valid, true, JSON.stringify(errors));
});

test("grading-result rejects unknown runner", () => {
  const { valid } = validateAgainst("grading-result", {
    schema_version: 1,
    assignment_id: "x", github_login: "y",
    archive_sha: "a".repeat(40),
    graded_at: "2026-02-02T12:00:00.000Z",
    graded_by: "z", runner: "yolo",
    tests: [],
  });
  assert.equal(valid, false);
});
