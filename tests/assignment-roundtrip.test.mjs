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
      execution_environment: "github_actions",
      visibility: "private",
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

// The SPA's buildDoc() always emits roster_mode, and the schema is
// additionalProperties:false - so an unlisted field would break every save.
test("roster_mode accepts both enum values and rejects anything else", () => {
  const base = {
    schema_version: 1,
    id: "exam-2026",
    title: "Exam",
    organization: "PXLAutomation",
    template: { owner: "PXLAutomation", repository: "tpl" },
    repository_name_pattern: "exam-{github_login}",
    opens_at: "2026-09-21T06:00:00Z",
    deadline_at: "2026-10-05T21:59:59Z",
    state: "published",
    // Required under roster_mode: open - see the dedicated test below.
    max_acceptances: 40,
  };

  for (const mode of ["enforced", "open"]) {
    const { valid, errors } = validateAgainst("assignment", { ...base, roster_mode: mode });
    assert.ok(valid, `roster_mode="${mode}" should be valid, got: ${JSON.stringify(errors)}`);
  }

  for (const bad of ["Open", "OPEN", "none", "", true, 1, null]) {
    const { valid } = validateAgainst("assignment", { ...base, roster_mode: bad });
    assert.ok(!valid, `roster_mode=${JSON.stringify(bad)} should be rejected by the schema`);
  }

  // Omitted entirely - still valid (defaults to enforced at read time).
  const { valid } = validateAgainst("assignment", base);
  assert.ok(valid, "roster_mode is optional");
});

test("roster_mode: open requires max_acceptances", () => {
  const base = {
    schema_version: 1,
    id: "exam-2026",
    title: "Exam",
    organization: "PXLAutomation",
    template: { owner: "PXLAutomation", repository: "tpl" },
    repository_name_pattern: "exam-{github_login}",
    opens_at: "2026-09-21T06:00:00Z",
    deadline_at: "2026-10-05T21:59:59Z",
    state: "published",
  };

  // Open enrollment drops the roster gate - the cap is the only limit left.
  const uncapped = validateAgainst("assignment", { ...base, roster_mode: "open" });
  assert.ok(!uncapped.valid, "roster_mode: open without max_acceptances must be rejected");

  const capped = validateAgainst("assignment", { ...base, roster_mode: "open", max_acceptances: 40 });
  assert.ok(capped.valid, `open + cap should be valid, got: ${JSON.stringify(capped.errors)}`);

  // Enforced mode keeps the cap optional - the roster is the guardrail there.
  const enforcedUncapped = validateAgainst("assignment", { ...base, roster_mode: "enforced" });
  assert.ok(enforcedUncapped.valid, "enforced mode may omit max_acceptances");
  assert.ok(validateAgainst("assignment", base).valid, "absent roster_mode may omit max_acceptances");
});

test("assignment with default prefilled repository_name_pattern '{slug}-{github_login}' passes schema validation", () => {
  const spaSerialized = {
    schema_version: 1,
    id: "linux-processes-2026",
    title: "Linux Processes",
    description: "Short description",
    organization: "PXLAutomation",
    template: {
      owner: "PXLAutomation",
      repository: "template-automation-pe-1"
    },
    repository_name_pattern: "{slug}-{github_login}",
    opens_at: "2026-09-21T06:00:00Z",
    deadline_at: "2026-10-05T21:59:59Z",
    timezone: "Europe/Brussels",
    submission_ref: "refs/heads/main",
    student_permission: "admin",
    acceptance_mode: "self-service",
    late_policy: "report",
    state: "draft"
  };

  const { valid, errors } = validateAgainst("assignment", spaSerialized);
  assert.ok(valid, `Default '{slug}-{github_login}' pattern should be valid, but got: ${JSON.stringify(errors)}`);
});
