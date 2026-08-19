import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const acceptScript = join(here, "..", "acceptance", "accept.mjs");

function runAccept(envOverrides = {}, setupData = null) {
  const dir = mkdtempSync(join(tmpdir(), "pxl-accept-test-"));
  const outputEnv = join(dir, "output.env");
  const summaryEnv = join(dir, "summary.md");

  // Always write a default roster unless setupData.noRoster is true
  if (!setupData || !setupData.noRoster) {
    mkdirSync(join(dir, "students"), { recursive: true });
    const roster = setupData?.roster || {
      schema_version: 2,
      students: [
        { student_number: "SIS-1", full_name: "Valid User", github_login: "valid" },
        { student_number: "SIS-2", full_name: "Alice User", github_login: "alice" },
        { student_number: "SIS-3", full_name: "Bob User", github_login: "bob" },
        { student_number: "SIS-4", full_name: "Charlie User", github_login: "charlie" },
        { student_number: "SIS-5", full_name: "Dave User", github_login: "dave" }
      ]
    };
    writeFileSync(join(dir, "students", "roster.yml"), JSON.stringify(roster));
  }

  if (setupData) {
    if (setupData.assignmentYaml) {
      mkdirSync(join(dir, "assignments"), { recursive: true });
      writeFileSync(join(dir, "assignments", `${envOverrides.ASSIGNMENT_ID || "test-asgn"}.yml`), setupData.assignmentYaml);
    }
    if (setupData.acceptances) {
      for (const [assignmentId, logins] of Object.entries(setupData.acceptances)) {
        mkdirSync(join(dir, "acceptances", assignmentId), { recursive: true });
        for (const [login, data] of Object.entries(logins)) {
          writeFileSync(join(dir, "acceptances", assignmentId, `${login}.json`), JSON.stringify(data));
        }
      }
    }
  }

  const res = spawnSync("node", [acceptScript], {
    encoding: "utf8",
    env: {
      ...process.env,
      DATA_DIR: dir,
      GITHUB_OUTPUT: outputEnv,
      GITHUB_STEP_SUMMARY: summaryEnv,
      ...envOverrides
    },
  });

  const outputs = {};
  try {
    const lines = readFileSync(outputEnv, "utf8").split("\n");
    for (const line of lines) {
      if (line) {
        const [k, ...v] = line.split("=");
        outputs[k] = v.join("=");
      }
    }
  } catch (e) {}

  return { status: res.status, stdout: res.stdout, stderr: res.stderr, outputs, dir };
}

test("fail:validation for missing inputs", () => {
  const res = runAccept({ ASSIGNMENT_ID: "" });
  assert.equal(res.status, 1);
  assert.equal(res.outputs.outcome, "fail:validation");
});

test("fail:validation for invalid SLUG", () => {
  for (const bad of ["../foo", "foo/bar", "-foo", "foo_bar"]) {
    const res = runAccept({ ASSIGNMENT_ID: bad, GITHUB_LOGIN: "valid", GITHUB_ID: "123" });
    assert.equal(res.status, 1);
    assert.equal(res.outputs.outcome, "fail:validation");
  }
});

test("fail:validation for invalid LOGIN", () => {
  for (const bad of ["-login", "log/in", "../login"]) {
    const res = runAccept({ ASSIGNMENT_ID: "valid", GITHUB_LOGIN: bad, GITHUB_ID: "123" });
    assert.equal(res.status, 1);
    assert.equal(res.outputs.outcome, "fail:validation");
  }
});

test("rejected:no-assignment", () => {
  const res = runAccept({ ASSIGNMENT_ID: "valid", GITHUB_LOGIN: "valid", GITHUB_ID: "123" });
  assert.equal(res.status, 1);
  assert.equal(res.outputs.outcome, "rejected:no-assignment");
});

test("rejected:not-published", () => {
  const yaml = `state: draft
template:
  owner: x
  repository: y`;
  const res = runAccept({ ASSIGNMENT_ID: "test-asgn", GITHUB_LOGIN: "valid", GITHUB_ID: "123" }, { assignmentYaml: yaml });
  assert.equal(res.status, 1);
  assert.equal(res.outputs.outcome, "rejected:not-published");
});

test("rejected:not-open", () => {
  const future = new Date(Date.now() + 86400000).toISOString();
  const yaml = `state: published
opens_at: "${future}"
template:
  owner: x
  repository: y`;
  const res = runAccept({ ASSIGNMENT_ID: "test-asgn", GITHUB_LOGIN: "valid", GITHUB_ID: "123" }, { assignmentYaml: yaml });
  assert.equal(res.status, 1);
  assert.equal(res.outputs.outcome, "rejected:not-open");
});

test("rejected:past-deadline", () => {
  const past = new Date(Date.now() - 86400000).toISOString();
  const yaml = `state: published
deadline_at: "${past}"
template:
  owner: x
  repository: y`;
  const res = runAccept({ ASSIGNMENT_ID: "test-asgn", GITHUB_LOGIN: "valid", GITHUB_ID: "123" }, { assignmentYaml: yaml });
  assert.equal(res.status, 1);
  assert.equal(res.outputs.outcome, "rejected:past-deadline");
});

test("idempotency - already-accepted", () => {
  const yaml = `state: published
repository_name_pattern: test-{github_login}
template:
  owner: TestOrg
  repository: tpl`;
  const res = runAccept(
    { ASSIGNMENT_ID: "test-asgn", GITHUB_LOGIN: "alice", GITHUB_ID: "123" },
    { assignmentYaml: yaml, acceptances: { "test-asgn": { "alice": { accepted_at: "2026-01-01" } } } }
  );
  assert.equal(res.status, 0);
  assert.equal(res.outputs.outcome, "already-accepted");
  assert.equal(res.outputs.target_repo, "test-alice");
  assert.equal(res.outputs.template_owner, "TestOrg");
  assert.equal(res.outputs.template_repo, "tpl");
});

test("rejected:cap-reached", () => {
  const yaml = `state: published
max_acceptances: 1
template:
  owner: TestOrg
  repository: tpl`;
  const res = runAccept(
    { ASSIGNMENT_ID: "test-asgn", GITHUB_LOGIN: "bob", GITHUB_ID: "456" },
    { assignmentYaml: yaml, acceptances: { "test-asgn": { "alice": { accepted_at: "2026-01-01" } } } }
  );
  assert.equal(res.status, 1);
  assert.equal(res.outputs.outcome, "rejected:cap-reached");
});

test("accepted - happy path with deriveRepoName \`{github_login}\` substitution", () => {
  const yaml = `state: published
repository_name_pattern: hw-{github_login}
template:
  owner: TestOrg
  repository: tpl`;
  const res = runAccept(
    { ASSIGNMENT_ID: "test-asgn", GITHUB_LOGIN: "charlie", GITHUB_ID: "789" },
    { assignmentYaml: yaml }
  );
  assert.equal(res.status, 0);
  assert.equal(res.outputs.outcome, "accepted");
  assert.equal(res.outputs.target_repo, "hw-charlie");
});

test("accepted - deriveRepoName \`{login}\` legacy mis-match (doesn't substitute)", () => {
  const yaml = `state: published
repository_name_pattern: hw-{login}
template:
  owner: TestOrg
  repository: tpl`;
  const res = runAccept(
    { ASSIGNMENT_ID: "test-asgn", GITHUB_LOGIN: "charlie", GITHUB_ID: "789" },
    { assignmentYaml: yaml }
  );
  assert.equal(res.status, 0);
  assert.equal(res.outputs.outcome, "accepted");
  // {login} is not recognized by the script, only {github_login}
  assert.equal(res.outputs.target_repo, "hw-{login}");
});

test("fail:exception - legacy template_owner shape without template.owner", () => {
  const yaml = `state: published
template_owner: OldOrg
template_repo: old-tpl`;
  const res = runAccept(
    { ASSIGNMENT_ID: "test-asgn", GITHUB_LOGIN: "dave", GITHUB_ID: "111" },
    { assignmentYaml: yaml }
  );
  assert.equal(res.status, 1);
  assert.equal(res.outputs.outcome, "fail:exception");
});

test("rejected:no-roster", () => {
  const yaml = `state: published
template:
  owner: TestOrg
  repository: tpl`;
  const res = runAccept(
    { ASSIGNMENT_ID: "test-asgn", GITHUB_LOGIN: "valid", GITHUB_ID: "123" },
    { assignmentYaml: yaml, noRoster: true }
  );
  assert.equal(res.status, 1);
  assert.equal(res.outputs.outcome, "rejected:no-roster");
});

test("rejected:not-on-roster", () => {
  const yaml = `state: published
template:
  owner: TestOrg
  repository: tpl`;
  const res = runAccept(
    { ASSIGNMENT_ID: "test-asgn", GITHUB_LOGIN: "stranger", GITHUB_ID: "999" },
    { assignmentYaml: yaml }
  );
  assert.equal(res.status, 1);
  assert.equal(res.outputs.outcome, "rejected:not-on-roster");
});

// --- roster_mode: open ------------------------------------------------------
//
// Restores the v1 "open acceptance" behaviour per assignment. The roster gate
// is skipped; opens_at..deadline_at and max_acceptances remain the guardrails.

test("roster_mode:open - accepts a login absent from the roster", () => {
  const yaml = `state: published
roster_mode: open
max_acceptances: 50
repository_name_pattern: exam-{github_login}
template:
  owner: TestOrg
  repository: tpl`;
  const res = runAccept(
    { ASSIGNMENT_ID: "test-asgn", GITHUB_LOGIN: "stranger", GITHUB_ID: "999" },
    { assignmentYaml: yaml }
  );
  assert.equal(res.status, 0);
  assert.equal(res.outputs.outcome, "accepted");
  assert.equal(res.outputs.target_repo, "exam-stranger");
});

test("roster_mode:open - accepts when no roster file exists at all", () => {
  // The scaffold-default control repo case: a freshly created org has no
  // students/roster.yml, which under enforced mode rejects everyone.
  const yaml = `state: published
roster_mode: open
max_acceptances: 50
repository_name_pattern: exam-{github_login}
template:
  owner: TestOrg
  repository: tpl`;
  const res = runAccept(
    { ASSIGNMENT_ID: "test-asgn", GITHUB_LOGIN: "stranger", GITHUB_ID: "999" },
    { assignmentYaml: yaml, noRoster: true }
  );
  assert.equal(res.status, 0);
  assert.equal(res.outputs.outcome, "accepted");
  assert.equal(res.outputs.target_repo, "exam-stranger");
});

test("roster_mode:open - still enforces the deadline window", () => {
  const past = new Date(Date.now() - 86400000).toISOString();
  const yaml = `state: published
roster_mode: open
deadline_at: "${past}"
template:
  owner: TestOrg
  repository: tpl`;
  const res = runAccept(
    { ASSIGNMENT_ID: "test-asgn", GITHUB_LOGIN: "stranger", GITHUB_ID: "999" },
    { assignmentYaml: yaml, noRoster: true }
  );
  assert.equal(res.status, 1);
  assert.equal(res.outputs.outcome, "rejected:past-deadline");
});

test("roster_mode:open - still enforces opens_at", () => {
  const future = new Date(Date.now() + 86400000).toISOString();
  const yaml = `state: published
roster_mode: open
opens_at: "${future}"
template:
  owner: TestOrg
  repository: tpl`;
  const res = runAccept(
    { ASSIGNMENT_ID: "test-asgn", GITHUB_LOGIN: "stranger", GITHUB_ID: "999" },
    { assignmentYaml: yaml, noRoster: true }
  );
  assert.equal(res.status, 1);
  assert.equal(res.outputs.outcome, "rejected:not-open");
});

test("roster_mode:open - without max_acceptances fails closed", () => {
  // Open enrollment drops the roster gate, so the cap is the only limit left
  // on who can claim a repo. Schema + Admin Panel require it; this is the
  // backstop for hand-edited YAML.
  const yaml = `state: published
roster_mode: open
template:
  owner: TestOrg
  repository: tpl`;
  const res = runAccept(
    { ASSIGNMENT_ID: "test-asgn", GITHUB_LOGIN: "stranger", GITHUB_ID: "999" },
    { assignmentYaml: yaml, noRoster: true }
  );
  assert.equal(res.status, 1);
  assert.equal(res.outputs.outcome, "fail:config");
});

test("roster_mode:open - still enforces max_acceptances", () => {
  const yaml = `state: published
roster_mode: open
max_acceptances: 1
template:
  owner: TestOrg
  repository: tpl`;
  const res = runAccept(
    { ASSIGNMENT_ID: "test-asgn", GITHUB_LOGIN: "stranger", GITHUB_ID: "999" },
    { assignmentYaml: yaml, noRoster: true, acceptances: { "test-asgn": { "someone": { accepted_at: "2026-01-01" } } } }
  );
  assert.equal(res.status, 1);
  assert.equal(res.outputs.outcome, "rejected:cap-reached");
});

test("roster_mode:open - still requires state: published", () => {
  const yaml = `state: draft
roster_mode: open
template:
  owner: TestOrg
  repository: tpl`;
  const res = runAccept(
    { ASSIGNMENT_ID: "test-asgn", GITHUB_LOGIN: "stranger", GITHUB_ID: "999" },
    { assignmentYaml: yaml, noRoster: true }
  );
  assert.equal(res.status, 1);
  assert.equal(res.outputs.outcome, "rejected:not-published");
});

test("roster_mode:open - idempotency still returns already-accepted", () => {
  const yaml = `state: published
roster_mode: open
max_acceptances: 50
repository_name_pattern: exam-{github_login}
template:
  owner: TestOrg
  repository: tpl`;
  const res = runAccept(
    { ASSIGNMENT_ID: "test-asgn", GITHUB_LOGIN: "stranger", GITHUB_ID: "999" },
    { assignmentYaml: yaml, noRoster: true, acceptances: { "test-asgn": { "stranger": { accepted_at: "2026-01-01" } } } }
  );
  assert.equal(res.status, 0);
  assert.equal(res.outputs.outcome, "already-accepted");
  assert.equal(res.outputs.target_repo, "exam-stranger");
});

test("roster_mode:enforced - explicit value still gates on the roster", () => {
  const yaml = `state: published
roster_mode: enforced
template:
  owner: TestOrg
  repository: tpl`;
  const res = runAccept(
    { ASSIGNMENT_ID: "test-asgn", GITHUB_LOGIN: "stranger", GITHUB_ID: "999" },
    { assignmentYaml: yaml }
  );
  assert.equal(res.status, 1);
  assert.equal(res.outputs.outcome, "rejected:not-on-roster");
});

test("roster_mode - unrecognised values fail closed (treated as enforced)", () => {
  // Fail-closed matters: a typo must never silently open enrollment. Schema
  // validation rejects these at save time; accept.mjs is the backstop for
  // hand-edited YAML.
  for (const bad of ["Open", "OPEN", "yes", "true", "", "none"]) {
    const yaml = `state: published
roster_mode: "${bad}"
template:
  owner: TestOrg
  repository: tpl`;
    const res = runAccept(
      { ASSIGNMENT_ID: "test-asgn", GITHUB_LOGIN: "stranger", GITHUB_ID: "999" },
      { assignmentYaml: yaml }
    );
    assert.equal(res.status, 1, `roster_mode="${bad}" should not open enrollment`);
    assert.equal(res.outputs.outcome, "rejected:not-on-roster", `roster_mode="${bad}"`);
  }
});

test("roster_mode - absent value defaults to enforced (backward compatible)", () => {
  const yaml = `state: published
template:
  owner: TestOrg
  repository: tpl`;
  const res = runAccept(
    { ASSIGNMENT_ID: "test-asgn", GITHUB_LOGIN: "stranger", GITHUB_ID: "999" },
    { assignmentYaml: yaml, noRoster: true }
  );
  assert.equal(res.status, 1);
  assert.equal(res.outputs.outcome, "rejected:no-roster");
});
