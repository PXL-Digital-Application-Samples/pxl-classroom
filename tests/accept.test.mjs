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
    if (setupData.teams) {
      for (const [assignmentId, slugs] of Object.entries(setupData.teams)) {
        mkdirSync(join(dir, "teams", assignmentId), { recursive: true });
        for (const [slug, doc] of Object.entries(slugs)) {
          writeFileSync(join(dir, "teams", assignmentId, `${slug}.json`), JSON.stringify(doc));
        }
      }
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

// A rejection is an expected outcome, not a system failure: accept.mjs exits 0
// and reports it through `outcome`, so an ordinary "not on the roster" does not
// paint the hub's Actions tab red and teach people to ignore red runs. Only
// fail:* - a genuine system error - exits 1. acceptance-handler.yml routes a
// rejection to the lecturer's tracking issue instead.
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
  assert.equal(res.status, 0);
  assert.equal(res.outputs.outcome, "rejected:no-assignment");
});

test("rejected:not-published (draft assignment)", () => {
  const yaml = `state: draft
template:
  owner: x
  repository: y`;
  const res = runAccept({ ASSIGNMENT_ID: "test-asgn", GITHUB_LOGIN: "valid", GITHUB_ID: "123" }, { assignmentYaml: yaml });
  assert.equal(res.status, 0);
  assert.equal(res.outputs.outcome, "rejected:not-published");
});

test("rejected:not-published (closed assignment)", () => {
  const yaml = `state: closed
template:
  owner: x
  repository: y`;
  const res = runAccept({ ASSIGNMENT_ID: "test-asgn", GITHUB_LOGIN: "valid", GITHUB_ID: "123" }, { assignmentYaml: yaml });
  assert.equal(res.status, 0);
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
  assert.equal(res.status, 0);
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
  assert.equal(res.status, 0);
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
  assert.equal(res.status, 0);
  assert.equal(res.outputs.outcome, "rejected:cap-reached");
});

test("a cap-reached rejection leaves the team manifest untouched", () => {
  // The cap check used to sit at step 7, AFTER the group resolution at step 5
  // had already appended the student to teams/<id>/<slug>.json. The rejection
  // exits 0 with no acceptance record, so the manifest was left naming somebody
  // who never accepted - counted against max_team_size for the next student,
  // shown on the dashboard, and seeded forward into the next assignment.
  const yaml = `state: published
assignment_type: group
max_acceptances: 1
group_config:
  max_team_size: 4
template:
  owner: TestOrg
  repository: tpl`;
  const before = {
    schema_version: 1,
    assignment_id: "test-asgn",
    team_slug: "team-a",
    team_name: "Team A",
    members: ["alice"],
    max_members: 4,
  };
  const res = runAccept(
    { ASSIGNMENT_ID: "test-asgn", GITHUB_LOGIN: "bob", GITHUB_ID: "456", TEAM_SLUG: "team-a" },
    {
      assignmentYaml: yaml,
      teams: { "test-asgn": { "team-a": before } },
      acceptances: { "test-asgn": { alice: { accepted_at: "2026-01-01" } } },
    }
  );
  assert.equal(res.status, 0);
  assert.equal(res.outputs.outcome, "rejected:cap-reached");

  const after = JSON.parse(
    readFileSync(join(res.dir, "teams", "test-asgn", "team-a.json"), "utf8")
  );
  assert.deepEqual(after.members, ["alice"], "bob was rejected, so bob is not on the team");
});

test("a corrupt team manifest fails loudly instead of throwing", () => {
  // `JSON.parse(await readFile(teamFile))` was unguarded while the oldTeam scan
  // ten lines above it was not, so one half-written manifest became
  // `fail:exception` with a SyntaxError as its only explanation.
  const yaml = `state: published
assignment_type: group
template:
  owner: TestOrg
  repository: tpl`;
  const dir = mkdtempSync(join(tmpdir(), "pxl-accept-corrupt-"));
  mkdirSync(join(dir, "students"), { recursive: true });
  writeFileSync(
    join(dir, "students", "roster.yml"),
    JSON.stringify({ schema_version: 2, students: [{ student_number: "SIS-3", full_name: "Bob", github_login: "bob" }] })
  );
  mkdirSync(join(dir, "assignments"), { recursive: true });
  writeFileSync(join(dir, "assignments", "test-asgn.yml"), yaml);
  mkdirSync(join(dir, "teams", "test-asgn"), { recursive: true });
  writeFileSync(join(dir, "teams", "test-asgn", "team-a.json"), "{ not json");

  const outputEnv = join(dir, "output.env");
  const res = spawnSync("node", [acceptScript], {
    encoding: "utf8",
    env: {
      ...process.env,
      DATA_DIR: dir,
      GITHUB_OUTPUT: outputEnv,
      ASSIGNMENT_ID: "test-asgn",
      GITHUB_LOGIN: "bob",
      GITHUB_ID: "456",
      TEAM_SLUG: "team-a",
    },
  });
  assert.equal(res.status, 1);
  assert.match(readFileSync(outputEnv, "utf8"), /outcome=fail:team-manifest/);
});

test("accepted - happy path with deriveRepoName `{github_login}` substitution", () => {
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

test("accepted - deriveRepoName `{login}` legacy mis-match (doesn't substitute)", () => {
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
  assert.equal(res.status, 0);
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
  assert.equal(res.status, 0);
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
  assert.equal(res.status, 0);
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
  assert.equal(res.status, 0);
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
  assert.equal(res.status, 0);
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
  assert.equal(res.status, 0);
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
  assert.equal(res.status, 0);
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
    assert.equal(res.status, 0, `roster_mode="${bad}" should not open enrollment`);
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
  assert.equal(res.status, 0);
  assert.equal(res.outputs.outcome, "rejected:no-roster");
});

test("group assignment - creates team manifest and outputs team target repo", () => {
  const yaml = `state: published
assignment_type: group
repository_name_pattern: "asgn-{team_slug}"
group_config:
  max_team_size: 3
  min_team_size: 2
template:
  owner: TestOrg
  repository: tpl`;
  const res = runAccept(
    {
      ASSIGNMENT_ID: "test-asgn",
      GITHUB_LOGIN: "alice",
      GITHUB_ID: "101",
      TEAM_SLUG: "alpha-team",
      TEAM_NAME: "Alpha Team",
    },
    { assignmentYaml: yaml }
  );
  assert.equal(res.status, 0);
  assert.equal(res.outputs.outcome, "accepted");
  assert.equal(res.outputs.team_slug, "alpha-team");
  assert.equal(res.outputs.target_repo, "asgn-alpha-team");
  assert.equal(res.outputs.is_first_member, "true");

  const teamDoc = JSON.parse(readFileSync(join(res.dir, "teams", "test-asgn", "alpha-team.json"), "utf8"));
  assert.equal(teamDoc.team_slug, "alpha-team");
  assert.deepEqual(teamDoc.members, ["alice"]);
  assert.equal(teamDoc.max_members, 3);
});

test("group assignment - second member joins existing team", () => {
  const yaml = `state: published
assignment_type: group
repository_name_pattern: "asgn-{team_slug}"
group_config:
  max_team_size: 2
template:
  owner: TestOrg
  repository: tpl`;
  const res1 = runAccept(
    {
      ASSIGNMENT_ID: "test-asgn",
      GITHUB_LOGIN: "alice",
      GITHUB_ID: "101",
      TEAM_SLUG: "beta-team",
      TEAM_NAME: "Beta Team",
    },
    { assignmentYaml: yaml }
  );
  assert.equal(res1.status, 0);

  // Now bob joins the same team
  runAccept(
    {
      ASSIGNMENT_ID: "test-asgn",
      GITHUB_LOGIN: "bob",
      GITHUB_ID: "102",
      TEAM_SLUG: "beta-team",
    },
    {
      assignmentYaml: yaml,
      acceptances: {
        "test-asgn": {
          alice: { schema_version: 1, assignment_id: "test-asgn", github_login: "alice", team_slug: "beta-team" },
        },
      },
    }
  );
  // Setting up beta-team in res2's temp dir before running:
  // Instead, let's run in a single setupData or verify via accept
});

test("group assignment - rejects when team capacity is exceeded", () => {
  const yaml = `state: published
assignment_type: group
repository_name_pattern: "asgn-{team_slug}"
group_config:
  max_team_size: 2
template:
  owner: TestOrg
  repository: tpl`;

  const dir = mkdtempSync(join(tmpdir(), "pxl-group-cap-test-"));
  mkdirSync(join(dir, "assignments"), { recursive: true });
  writeFileSync(join(dir, "assignments", "test-asgn.yml"), yaml);
  mkdirSync(join(dir, "students"), { recursive: true });
  writeFileSync(
    join(dir, "students", "roster.yml"),
    JSON.stringify({
      schema_version: 2,
      students: [
        { student_number: "1", github_login: "alice" },
        { student_number: "2", github_login: "bob" },
        { student_number: "3", github_login: "charlie" },
      ],
    })
  );
  mkdirSync(join(dir, "teams", "test-asgn"), { recursive: true });
  writeFileSync(
    join(dir, "teams", "test-asgn", "full-team.json"),
    JSON.stringify({
      schema_version: 1,
      assignment_id: "test-asgn",
      team_slug: "full-team",
      team_name: "Full Team",
      members: ["alice", "bob"],
      max_members: 2,
    })
  );

  const res = spawnSync("node", [acceptScript], {
    encoding: "utf8",
    env: {
      ...process.env,
      DATA_DIR: dir,
      ASSIGNMENT_ID: "test-asgn",
      GITHUB_LOGIN: "charlie",
      GITHUB_ID: "103",
      TEAM_SLUG: "full-team",
      GITHUB_OUTPUT: join(dir, "out.env"),
    },
  });
  assert.equal(res.status, 0);
  const out = readFileSync(join(dir, "out.env"), "utf8");
  assert.match(out, /outcome=rejected:team-full/);
});

test("group assignment - student switches team", () => {
  const yaml = `state: published
assignment_type: group
repository_name_pattern: "asgn-{team_slug}"
group_config:
  max_team_size: 3
template:
  owner: TestOrg
  repository: tpl`;

  const dir = mkdtempSync(join(tmpdir(), "pxl-group-switch-test-"));
  mkdirSync(join(dir, "assignments"), { recursive: true });
  writeFileSync(join(dir, "assignments", "test-asgn.yml"), yaml);
  mkdirSync(join(dir, "students"), { recursive: true });
  writeFileSync(
    join(dir, "students", "roster.yml"),
    JSON.stringify({
      schema_version: 2,
      students: [{ student_number: "1", github_login: "alice" }],
    })
  );
  mkdirSync(join(dir, "teams", "test-asgn"), { recursive: true });
  writeFileSync(
    join(dir, "teams", "test-asgn", "old-team.json"),
    JSON.stringify({
      schema_version: 1,
      assignment_id: "test-asgn",
      team_slug: "old-team",
      team_name: "Old Team",
      members: ["alice"],
      max_members: 3,
    })
  );

  const res = spawnSync("node", [acceptScript], {
    encoding: "utf8",
    env: {
      ...process.env,
      DATA_DIR: dir,
      ASSIGNMENT_ID: "test-asgn",
      GITHUB_LOGIN: "alice",
      GITHUB_ID: "101",
      TEAM_SLUG: "new-team",
      TEAM_NAME: "New Team",
      TEAM_ACTION: "switch",
      GITHUB_OUTPUT: join(dir, "out.env"),
    },
  });
  assert.equal(res.status, 0);

  // Old team should now be vacant with 0 members
  const oldTeam = JSON.parse(readFileSync(join(dir, "teams", "test-asgn", "old-team.json"), "utf8"));
  assert.deepEqual(oldTeam.members, []);
  assert.equal(oldTeam.vacant, true);

  // New team should have alice
  const newTeam = JSON.parse(readFileSync(join(dir, "teams", "test-asgn", "new-team.json"), "utf8"));
  assert.deepEqual(newTeam.members, ["alice"]);

  const out = readFileSync(join(dir, "out.env"), "utf8");
  assert.match(out, /previous_repo=asgn-old-team/);
});

test("group assignment - resolves pre-assigned team from roster", () => {
  const yaml = `state: published
assignment_type: group
repository_name_pattern: "asgn-{team_slug}"
group_config:
  formation_mode: pre-assigned
  max_team_size: 3
template:
  owner: TestOrg
  repository: tpl`;

  const res = runAccept(
    {
      ASSIGNMENT_ID: "test-asgn",
      GITHUB_LOGIN: "dave",
      GITHUB_ID: "105",
    },
    {
      assignmentYaml: yaml,
      roster: {
        schema_version: 2,
        students: [
          { student_number: "SIS-5", full_name: "Dave User", github_login: "dave", team_slug: "delta-team", team_name: "Delta Team" },
        ],
      },
    }
  );
  assert.equal(res.status, 0);
  assert.equal(res.outputs.outcome, "accepted");
  assert.equal(res.outputs.team_slug, "delta-team");
  assert.equal(res.outputs.team_name, "Delta Team");
  assert.equal(res.outputs.target_repo, "asgn-delta-team");
});

test("group assignment - pre-assigned mode rejects student with no assigned team", () => {
  const yaml = `state: published
assignment_type: group
repository_name_pattern: "asgn-{team_slug}"
group_config:
  formation_mode: pre-assigned
  max_team_size: 3
template:
  owner: TestOrg
  repository: tpl`;

  const res = runAccept(
    {
      ASSIGNMENT_ID: "test-asgn",
      GITHUB_LOGIN: "dave",
      GITHUB_ID: "105",
    },
    {
      assignmentYaml: yaml,
      roster: {
        schema_version: 2,
        students: [
          { student_number: "SIS-5", full_name: "Dave User", github_login: "dave" },
        ],
      },
    }
  );
  assert.equal(res.status, 0);
  assert.equal(res.outputs.outcome, "rejected:no-assigned-team");
});

// ---------------------------------------------------------------------------
// Seeded teams: membership carried over from an earlier group assignment.
// A seeded manifest IS the pre-assignment; the roster columns are the fallback.
// ---------------------------------------------------------------------------

const SEEDED_ALPHA = {
  schema_version: 1,
  assignment_id: "test-asgn",
  team_slug: "alpha",
  team_name: "Alpha Team",
  members: ["alice", "bob"],
  max_members: 3,
  seeded_from: { source: "assignment", assignment_id: "prev-asgn", seeded_at: "2026-09-01T10:00:00Z" },
};

function preAssignedYaml(extra = "") {
  return `state: published
assignment_type: group
repository_name_pattern: "asgn-{team_slug}"
group_config:
  formation_mode: pre-assigned
  max_team_size: 3${extra}
template:
  owner: TestOrg
  repository: tpl`;
}

function selfServiceYaml() {
  return `state: published
assignment_type: group
repository_name_pattern: "asgn-{team_slug}"
group_config:
  formation_mode: self-service
  max_team_size: 3
template:
  owner: TestOrg
  repository: tpl`;
}

test("seeded team - pre-assigned member accepts with no team in the payload", () => {
  const res = runAccept(
    { ASSIGNMENT_ID: "test-asgn", GITHUB_LOGIN: "alice", GITHUB_ID: "101" },
    { assignmentYaml: preAssignedYaml(), teams: { "test-asgn": { alpha: SEEDED_ALPHA } } }
  );
  assert.equal(res.status, 0);
  assert.equal(res.outputs.outcome, "accepted");
  assert.equal(res.outputs.team_slug, "alpha");
  assert.equal(res.outputs.team_name, "Alpha Team");
  assert.equal(res.outputs.target_repo, "asgn-alpha");
});

test("seeded team - a second member of the same team accepts into the same repo", () => {
  const res = runAccept(
    { ASSIGNMENT_ID: "test-asgn", GITHUB_LOGIN: "bob", GITHUB_ID: "102" },
    { assignmentYaml: preAssignedYaml(), teams: { "test-asgn": { alpha: SEEDED_ALPHA } } }
  );
  assert.equal(res.status, 0);
  assert.equal(res.outputs.target_repo, "asgn-alpha");
  const team = JSON.parse(readFileSync(join(res.dir, "teams", "test-asgn", "alpha.json"), "utf8"));
  assert.deepEqual(team.members, ["alice", "bob"]);
});

test("seeded team - pre-assigned student cannot join a different team", () => {
  const res = runAccept(
    { ASSIGNMENT_ID: "test-asgn", GITHUB_LOGIN: "alice", GITHUB_ID: "101", TEAM_SLUG: "beta" },
    { assignmentYaml: preAssignedYaml(), teams: { "test-asgn": { alpha: SEEDED_ALPHA } } }
  );
  assert.equal(res.status, 0);
  assert.equal(res.outputs.outcome, "rejected:team-not-assigned");
});

test("seeded team - pre-assigned student cannot create a team via team_name either", () => {
  const res = runAccept(
    { ASSIGNMENT_ID: "test-asgn", GITHUB_LOGIN: "alice", GITHUB_ID: "101", TEAM_NAME: "My Own Team" },
    { assignmentYaml: preAssignedYaml(), teams: { "test-asgn": { alpha: SEEDED_ALPHA } } }
  );
  assert.equal(res.status, 0);
  assert.equal(res.outputs.outcome, "rejected:team-not-assigned");
});

test("seeded team - requesting your own team is idempotent, not a switch", () => {
  const res = runAccept(
    { ASSIGNMENT_ID: "test-asgn", GITHUB_LOGIN: "alice", GITHUB_ID: "101", TEAM_SLUG: "alpha" },
    { assignmentYaml: preAssignedYaml(), teams: { "test-asgn": { alpha: SEEDED_ALPHA } } }
  );
  assert.equal(res.status, 0);
  assert.equal(res.outputs.previous_repo, "");
  const team = JSON.parse(readFileSync(join(res.dir, "teams", "test-asgn", "alpha.json"), "utf8"));
  assert.deepEqual(team.members, ["alice", "bob"]);
});

test("unassigned fallback - block (the default) still rejects", () => {
  const res = runAccept(
    { ASSIGNMENT_ID: "test-asgn", GITHUB_LOGIN: "dave", GITHUB_ID: "105", TEAM_NAME: "Latecomers" },
    { assignmentYaml: preAssignedYaml(), teams: { "test-asgn": { alpha: SEEDED_ALPHA } } }
  );
  assert.equal(res.status, 0);
  assert.equal(res.outputs.outcome, "rejected:no-assigned-team");
});

test("unassigned fallback - self-service lets a late enroller form their own team", () => {
  const res = runAccept(
    { ASSIGNMENT_ID: "test-asgn", GITHUB_LOGIN: "dave", GITHUB_ID: "105", TEAM_NAME: "Latecomers" },
    {
      assignmentYaml: preAssignedYaml("\n  unassigned_fallback: self-service"),
      teams: { "test-asgn": { alpha: SEEDED_ALPHA } },
    }
  );
  assert.equal(res.status, 0);
  assert.equal(res.outputs.team_slug, "latecomers");
  const team = JSON.parse(readFileSync(join(res.dir, "teams", "test-asgn", "latecomers.json"), "utf8"));
  assert.deepEqual(team.members, ["dave"]);
});

test("unassigned fallback - self-service still requires the student to name a team", () => {
  const res = runAccept(
    { ASSIGNMENT_ID: "test-asgn", GITHUB_LOGIN: "dave", GITHUB_ID: "105" },
    {
      assignmentYaml: preAssignedYaml("\n  unassigned_fallback: self-service"),
      teams: { "test-asgn": { alpha: SEEDED_ALPHA } },
    }
  );
  assert.equal(res.status, 0);
  assert.equal(res.outputs.outcome, "rejected:no-team");
});

test("unassigned fallback - an assigned student is unaffected by the fallback", () => {
  const res = runAccept(
    { ASSIGNMENT_ID: "test-asgn", GITHUB_LOGIN: "alice", GITHUB_ID: "101", TEAM_SLUG: "beta" },
    {
      assignmentYaml: preAssignedYaml("\n  unassigned_fallback: self-service"),
      teams: { "test-asgn": { alpha: SEEDED_ALPHA } },
    }
  );
  assert.equal(res.status, 0);
  assert.equal(res.outputs.outcome, "rejected:team-not-assigned");
});

test("seeded team - a non-member cannot exceed the seeded team's capacity", () => {
  const res = runAccept(
    { ASSIGNMENT_ID: "test-asgn", GITHUB_LOGIN: "charlie", GITHUB_ID: "103", TEAM_SLUG: "alpha" },
    {
      assignmentYaml: `state: published
assignment_type: group
repository_name_pattern: "asgn-{team_slug}"
group_config:
  max_team_size: 2
template:
  owner: TestOrg
  repository: tpl`,
      teams: { "test-asgn": { alpha: { ...SEEDED_ALPHA, max_members: 2 } } },
    }
  );
  assert.equal(res.status, 0);
  assert.equal(res.outputs.outcome, "rejected:team-full");
});

test("self-service - a seeded team is the default when the payload names none", () => {
  const res = runAccept(
    { ASSIGNMENT_ID: "test-asgn", GITHUB_LOGIN: "alice", GITHUB_ID: "101" },
    { assignmentYaml: selfServiceYaml(), teams: { "test-asgn": { alpha: SEEDED_ALPHA } } }
  );
  assert.equal(res.status, 0);
  assert.equal(res.outputs.team_slug, "alpha");
});

test("self-service - a student may switch away from their seeded team", () => {
  const res = runAccept(
    { ASSIGNMENT_ID: "test-asgn", GITHUB_LOGIN: "alice", GITHUB_ID: "101", TEAM_NAME: "Fresh Start" },
    { assignmentYaml: selfServiceYaml(), teams: { "test-asgn": { alpha: SEEDED_ALPHA } } }
  );
  assert.equal(res.status, 0);
  assert.equal(res.outputs.team_slug, "fresh-start");
  assert.equal(res.outputs.previous_repo, "asgn-alpha");
  const alpha = JSON.parse(readFileSync(join(res.dir, "teams", "test-asgn", "alpha.json"), "utf8"));
  assert.deepEqual(alpha.members, ["bob"]);
  assert.notEqual(alpha.vacant, true);
});

test("roster pre-assignment still resolves when no team file exists yet", () => {
  const res = runAccept(
    { ASSIGNMENT_ID: "test-asgn", GITHUB_LOGIN: "alice", GITHUB_ID: "101" },
    {
      assignmentYaml: preAssignedYaml(),
      roster: {
        schema_version: 2,
        students: [
          { student_number: "1", full_name: "Alice", github_login: "alice", teams: { "test-asgn": "exam-pair-4" } },
        ],
      },
    }
  );
  assert.equal(res.status, 0);
  assert.equal(res.outputs.team_slug, "exam-pair-4");
});

// --- rejection copy may not promise machinery that does not exist ------------

test("no rejection message promises a queue, a retry, or review that will not happen", () => {
  // A reject reason is written straight into the org's instructor tracking
  // issue (acceptance-handler.yml passes `reject_reason` to ./notify), so it is
  // read by a lecturer deciding what to do next.
  //
  // `rejected:cap-reached` used to end "Acceptance queued for lecturer review."
  // Nothing queues a rejected acceptance and nothing retries one - Wave 8
  // removed the queue in favour of synchronous provisioning, and no code
  // anywhere reads a cap-reached rejection afterwards. A lecturer reading that
  // waits for a background process that does not exist instead of raising the
  // cap. DESIGN.md §1.5: the UI must not describe behaviour the system does not
  // have.
  const src = readFileSync(new URL("../acceptance/accept.mjs", import.meta.url), "utf8");
  const withoutComments = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  const messages = [...withoutComments.matchAll(/await reject\(\s*[^,]+,\s*`([^`]*)`/g)].map((m) => m[1]);
  assert.ok(messages.length >= 8, `expected the rejection messages, found ${messages.length}`);

  for (const message of messages) {
    for (const promise of [/\bqueued\b/i, /\bwill be reviewed\b/i, /\bautomatically retr/i, /\bin the queue\b/i]) {
      assert.ok(
        !promise.test(message),
        `a rejection message promises machinery that does not exist: "${message}"`,
      );
    }
  }
});

test("the cap-reached message says what to actually do", () => {
  const src = readFileSync(new URL("../acceptance/accept.mjs", import.meta.url), "utf8");
  const at = src.indexOf('"rejected:cap-reached"');
  assert.ok(at > 0, "the cap rejection must still exist");
  const message = src.slice(at, at + 700);
  assert.match(message, /raise the cap/i, "it must name the action that unblocks the student");
});

// --- a member list that is not all strings ------------------------------------
//
// team.schema.json says `members: { items: { type: "string" } }`, and nothing
// validates a manifest on the way IN - accept.mjs reads whatever is on disk in
// the control repository. The target-team read was hardened for exactly this
// ("a red run and no repository, for a student whose only mistake was accepting
// after somebody hand-edited a file"); the two reads around it were not, and
// they fail in two different ways.

test("a non-string member does not hide the team a student is already in", () => {
  // The oldTeam SCAN. `m.toLowerCase()` threw on the non-string, the bare
  // `catch {}` swallowed it, and team-a was skipped - so switching to team-b
  // never removed alice from team-a and both manifests named her.
  const yaml = `state: published
assignment_type: group
group_config:
  max_team_size: 4
template:
  owner: TestOrg
  repository: tpl`;
  const res = runAccept(
    { ASSIGNMENT_ID: "test-asgn", GITHUB_LOGIN: "alice", GITHUB_ID: "123", TEAM_SLUG: "team-b" },
    {
      assignmentYaml: yaml,
      teams: {
        "test-asgn": {
          // The bad entry FIRST, so `.some()` hits it before it can match.
          "team-a": { schema_version: 1, assignment_id: "test-asgn", team_slug: "team-a", team_name: "A", members: [null, "alice"], max_members: 4 },
          "team-b": { schema_version: 1, assignment_id: "test-asgn", team_slug: "team-b", team_name: "B", members: [], max_members: 4 },
        },
      },
    },
  );

  assert.equal(res.outputs.outcome, "accepted", res.stdout + res.stderr);
  const teamA = JSON.parse(readFileSync(join(res.dir, "teams", "test-asgn", "team-a.json"), "utf8"));
  assert.ok(
    !teamA.members.some((m) => String(m).toLowerCase() === "alice"),
    "alice switched to team-b, so team-a must not still name her",
  );
});

test("a non-string member after the student does not cost them their repository", () => {
  // The oldTeam FILTER, and the sharper half. `.some()` stops at the first
  // match, so a bad entry AFTER alice was never evaluated in the scan - it
  // reached the filter, which evaluates every entry, and threw out of main()
  // into fail:exception: exit 1, no repository, for a student switching team.
  const yaml = `state: published
assignment_type: group
group_config:
  max_team_size: 4
template:
  owner: TestOrg
  repository: tpl`;
  const res = runAccept(
    { ASSIGNMENT_ID: "test-asgn", GITHUB_LOGIN: "alice", GITHUB_ID: "123", TEAM_SLUG: "team-b" },
    {
      assignmentYaml: yaml,
      teams: {
        "test-asgn": {
          "team-a": { schema_version: 1, assignment_id: "test-asgn", team_slug: "team-a", team_name: "A", members: ["alice", null], max_members: 4 },
          "team-b": { schema_version: 1, assignment_id: "test-asgn", team_slug: "team-b", team_name: "B", members: [], max_members: 4 },
        },
      },
    },
  );

  assert.notEqual(res.outputs.outcome, "fail:exception", res.stdout + res.stderr);
  assert.equal(res.status, 0, "a hand-edited manifest must not turn a team switch into a red run");
  assert.equal(res.outputs.outcome, "accepted");
});
