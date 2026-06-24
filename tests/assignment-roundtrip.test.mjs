import test from "node:test";
import assert from "node:assert";
import { validateAgainst } from "../lib/validate.mjs";

test("SPA-serialized YAML passes validateAgainst('assignment', ...)", () => {
  // A representative SPA-serialized assignment definition
  const spaSerialized = {
    schema_version: 1,
    id: "linux-processes-2026",
    title: "Linux Processes",
    description: "Short student-facing description",
    organization: "PXLAutomation",
    template: {
      owner: "PXLAutomation",
      repository: "template-automation-pe-1"
    },
    repository_name_pattern: "linux-processes-{github_login}",
    opens_at: "2026-09-21T06:00:00Z",
    deadline_at: "2026-10-05T21:59:59Z",
    timezone: "Europe/Brussels",
    submission_ref: "refs/heads/main",
    student_permission: "admin",
    acceptance_mode: "self-service",
    late_policy: "report",
    state: "published",
    max_acceptances: 250,
    lock_down_enabled: true
  };

  const { valid, errors } = validateAgainst("assignment", spaSerialized);
  assert.ok(valid, `SPA-serialized YAML should be valid, but got errors: ${JSON.stringify(errors)}`);
});

test("SPA-serialized YAML with autograde passes validateAgainst('assignment', ...)", () => {
  const spaSerialized = {
    schema_version: 1,
    id: "linux-processes-2026",
    title: "Linux Processes",
    description: "Short student-facing description",
    organization: "PXLAutomation",
    template: {
      owner: "PXLAutomation",
      repository: "template-automation-pe-1"
    },
    repository_name_pattern: "linux-processes-{github_login}",
    opens_at: "2026-09-21T06:00:00Z",
    deadline_at: "2026-10-05T21:59:59Z",
    timezone: "Europe/Brussels",
    submission_ref: "refs/heads/main",
    student_permission: "admin",
    acceptance_mode: "self-service",
    late_policy: "report",
    state: "published",
    max_acceptances: 250,
    lock_down_enabled: true,
    autograde: {
      enabled: true,
      tests: [
        {
          id: "test1",
          type: "run",
          command: "npm test",
          timeout_s: 30,
          points: 10
        }
      ]
    }
  };

  const { valid, errors } = validateAgainst("assignment", spaSerialized);
  assert.ok(valid, `SPA-serialized YAML with autograde should be valid, but got errors: ${JSON.stringify(errors)}`);
});
