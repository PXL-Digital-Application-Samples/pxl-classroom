// PXL Classroom — report.test.mjs
//
// Deadline-classification truth table. Drives the report.mjs script against
// a synthetic data tree and asserts the per-student status output. Critical
// for catching regressions in the override-application path (P0-7) and the
// on-time/late/no-submission classification rules.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const reportScript = join(here, "..", "report", "report.mjs");

// Build a complete synthetic data tree for an assignment and run report.mjs
// against it. Returns the parsed reports/<id>.json.
function runReport({
  assignmentYaml,
  acceptances = [],
  repositories = [],
  observations = {},
  overrides = [],
  roster = [],
}) {
  const dir = mkdtempSync(join(tmpdir(), "pxl-report-test-"));
  const id = "test-asgn";

  mkdirSync(join(dir, "assignments"), { recursive: true });
  writeFileSync(join(dir, "assignments", `${id}.yml`), assignmentYaml);

  if (roster.length) {
    mkdirSync(join(dir, "students"), { recursive: true });
    writeFileSync(
      join(dir, "students", "roster.yml"),
      `schema_version: 1\nstudents:\n` +
        roster
          .map(
            (s) =>
              `  - student_id: "${s.student_id}"\n    display_name: ${s.display_name}\n    github_login: ${s.github_login}\n    active: true\n`
          )
          .join("")
    );
  }

  if (acceptances.length) {
    mkdirSync(join(dir, "acceptances", id), { recursive: true });
    for (const a of acceptances) {
      writeFileSync(
        join(dir, "acceptances", id, `${a.github_login}.json`),
        JSON.stringify(a)
      );
    }
  }

  if (repositories.length) {
    mkdirSync(join(dir, "repositories", id), { recursive: true });
    for (const r of repositories) {
      writeFileSync(
        join(dir, "repositories", id, `${r.github_login}.json`),
        JSON.stringify(r)
      );
    }
  }

  for (const [login, obs] of Object.entries(observations)) {
    mkdirSync(join(dir, "observations", id, login), { recursive: true });
    for (let i = 0; i < obs.length; i++) {
      const safeTs = obs[i].observed_at.replace(/[:.]/g, "-");
      writeFileSync(
        join(dir, "observations", id, login, `${safeTs}.json`),
        JSON.stringify(obs[i])
      );
    }
  }

  if (overrides.length) {
    mkdirSync(join(dir, "overrides", id), { recursive: true });
    for (const o of overrides) {
      writeFileSync(
        join(dir, "overrides", id, `${o.github_login}.json`),
        JSON.stringify(o)
      );
    }
  }

  const res = spawnSync("node", [reportScript], {
    encoding: "utf8",
    env: { ...process.env, ASSIGNMENT_ID: id, DATA_DIR: dir, OUTPUT_FORMAT: "json" },
  });
  if (res.status !== 0) {
    throw new Error(`report.mjs failed: ${res.status}\n${res.stderr}\n${res.stdout}`);
  }
  return JSON.parse(readFileSync(join(dir, "reports", `${id}.json`), "utf8"));
}

const BASE_YAML = `schema_version: 1
id: test-asgn
title: Test Assignment
organization: TestOrg
template:
  owner: TestOrg
  repository: tpl
repository_name_pattern: test-asgn-{github_login}
opens_at: 2026-09-01T00:00:00Z
deadline_at: 2026-09-10T23:59:59Z
state: published
`;

test("student with only pre-deadline observations is on-time", () => {
  const report = runReport({
    assignmentYaml: BASE_YAML,
    acceptances: [{ github_login: "alice", status: "accepted" }],
    observations: {
      alice: [
        { observed_at: "2026-09-05T10:00:00Z", sha: "a".repeat(40) },
        { observed_at: "2026-09-09T20:00:00Z", sha: "b".repeat(40) },
      ],
    },
  });
  const alice = report.students.find((s) => s.github_login === "alice");
  assert.equal(alice.submission_status, "on-time");
  assert.equal(alice.last_on_time_sha, "b".repeat(40));
});

test("student with observation after deadline is late", () => {
  const report = runReport({
    assignmentYaml: BASE_YAML,
    acceptances: [{ github_login: "bob", status: "accepted" }],
    observations: {
      bob: [
        { observed_at: "2026-09-05T10:00:00Z", sha: "a".repeat(40) },
        { observed_at: "2026-09-11T10:00:00Z", sha: "c".repeat(40) },
      ],
    },
  });
  const bob = report.students.find((s) => s.github_login === "bob");
  assert.equal(bob.submission_status, "late");
  assert.equal(bob.first_late_sha, "c".repeat(40));
});

test("student with override extending deadline past the late SHA becomes on-time (P0-7)", () => {
  const report = runReport({
    assignmentYaml: BASE_YAML,
    acceptances: [{ github_login: "carol", status: "accepted" }],
    observations: {
      carol: [
        { observed_at: "2026-09-05T10:00:00Z", sha: "a".repeat(40) },
        // Originally late
        { observed_at: "2026-09-11T10:00:00Z", sha: "c".repeat(40) },
      ],
    },
    overrides: [
      {
        github_login: "carol",
        deadline_at: "2026-09-15T23:59:59Z",
        reason: "medical extension",
      },
    ],
  });
  const carol = report.students.find((s) => s.github_login === "carol");
  assert.equal(carol.submission_status, "on-time");
  assert.equal(carol.override_applied, true);
  assert.equal(carol.override_reason, "medical extension");
  assert.equal(carol.effective_deadline_at, "2026-09-15T23:59:59.000Z");
});

test("roster student who didn't accept appears as no-submission", () => {
  const report = runReport({
    assignmentYaml: BASE_YAML,
    roster: [
      { student_id: "01", display_name: "Dave", github_login: "dave-test" },
    ],
  });
  const dave = report.students.find((s) => s.github_login === "dave-test");
  assert.equal(dave.acceptance_state, "not-accepted");
  assert.equal(dave.submission_status, "no-submission");
  assert.equal(dave.display_name, "Dave");
});
