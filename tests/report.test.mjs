// PXL Classroom - report.test.mjs
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
  preservations = {},
  overrides = [],
  teams = [],
  roster = [],
  csv = false,
}) {
  const dir = mkdtempSync(join(tmpdir(), "pxl-report-test-"));
  const id = "test-asgn";

  mkdirSync(join(dir, "assignments"), { recursive: true });
  writeFileSync(join(dir, "assignments", `${id}.yml`), assignmentYaml);

  if (roster.length) {
    mkdirSync(join(dir, "students"), { recursive: true });
    writeFileSync(
      join(dir, "students", "roster.yml"),
      `schema_version: 2\nstudents:\n` +
        roster
          .map(
            (s) =>
              `  - student_number: "${s.student_number}"\n    full_name: ${s.full_name}\n    github_login: ${s.github_login}\n    active: true\n`
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

  // preservation.json sits beside the snapshots, written by preserve.mjs.
  for (const [login, doc] of Object.entries(preservations)) {
    mkdirSync(join(dir, "observations", id, login), { recursive: true });
    writeFileSync(join(dir, "observations", id, login, "preservation.json"), JSON.stringify(doc));
  }

  if (teams.length) {
    mkdirSync(join(dir, "teams", id), { recursive: true });
    for (const t of teams) {
      writeFileSync(join(dir, "teams", id, `${t.team_slug}.json`), JSON.stringify(t));
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
    env: { ...process.env, ASSIGNMENT_ID: id, DATA_DIR: dir, OUTPUT_FORMAT: csv ? "both" : "json" },
  });
  if (res.status !== 0) {
    throw new Error(`report.mjs failed: ${res.status}\n${res.stderr}\n${res.stdout}`);
  }
  const report = JSON.parse(readFileSync(join(dir, "reports", `${id}.json`), "utf8"));
  if (csv) report.csvText = readFileSync(join(dir, "reports", `${id}.csv`), "utf8");
  return report;
}

/** RFC4180-enough splitter: report.mjs quotes only when a field needs it. */
function splitCsvLine(line) {
  const out = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch !== '"') cur += ch;
      else if (line[i + 1] === '"') { cur += '"'; i++; }
      else quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

/** One student's CSV row, as a header -> value map. */
function csvRow(csvText, login) {
  // \uFEFF as an escape, never the literal character: an invisible byte in a
  // regex is a trap for the next reader, and eslint's no-irregular-whitespace
  // rule refuses it.
  const rows = csvText.replace(/^\uFEFF/, "").trim().split(/\r?\n/).map(splitCsvLine);
  const header = rows[0];
  const row = rows.slice(1).find((r) => r[header.indexOf("github_login")] === login);
  return row ? Object.fromEntries(header.map((h, i) => [h, row[i]])) : null;
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

// --- extensions (P0-7) -------------------------------------------------------
//
// The Admin Panel writes an append-only `overrides` array (and has since
// 2026-06-17); `override.schema.json` forbids anything else. report.mjs read a
// top-level `deadline_at` instead, which only the very first panel ever wrote -
// so every extension granted through the live UI did nothing here, while
// lockdown.mjs demoted the student at the assignment's own deadline anyway.
//
// The fixture below is the shape a real control repo holds. The legacy one is
// covered separately, because old control repos still contain it.

/** An override document in the shape the Admin Panel actually commits. */
function extensionDoc(login, value, reason) {
  return {
    schema_version: 1,
    assignment_id: "test-asgn",
    github_login: login,
    overrides: [
      {
        type: "deadline_extension",
        value,
        reason,
        overridden_by: "admin-panel",
        overridden_at: "2026-09-09T12:00:00Z",
      },
    ],
  };
}

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
    overrides: [extensionDoc("carol", "2026-09-15T23:59:59Z", "medical extension")],
  });
  const carol = report.students.find((s) => s.github_login === "carol");
  assert.equal(carol.submission_status, "on-time");
  assert.equal(carol.override_applied, true);
  assert.equal(carol.override_reason, "medical extension");
  assert.equal(carol.effective_deadline_at, "2026-09-15T23:59:59.000Z");
});

test("a pre-2026-06-17 flat override document still extends", () => {
  const report = runReport({
    assignmentYaml: BASE_YAML,
    acceptances: [{ github_login: "carol", status: "accepted" }],
    observations: {
      carol: [{ observed_at: "2026-09-11T10:00:00Z", sha: "c".repeat(40) }],
    },
    overrides: [
      {
        schema_version: 1,
        assignment_id: "test-asgn",
        github_login: "carol",
        deadline_at: "2026-09-15T23:59:59Z",
        reason: "legacy medical extension",
      },
    ],
  });
  const carol = report.students.find((s) => s.github_login === "carol");
  assert.equal(carol.submission_status, "on-time");
  assert.equal(carol.effective_deadline_at, "2026-09-15T23:59:59.000Z");
});

test("an override that grants no extension is not reported as one", () => {
  // override_applied sits beside effective_deadline_at; an annotation must not
  // read as extra time.
  const report = runReport({
    assignmentYaml: BASE_YAML,
    acceptances: [{ github_login: "carol", status: "accepted" }],
    observations: {
      carol: [{ observed_at: "2026-09-11T10:00:00Z", sha: "c".repeat(40) }],
    },
    overrides: [
      {
        schema_version: 1,
        assignment_id: "test-asgn",
        github_login: "carol",
        overrides: [
          {
            type: "annotation",
            value: "spoke to the student",
            reason: "note",
            overridden_by: "admin-panel",
            overridden_at: "2026-09-09T12:00:00Z",
          },
        ],
      },
    ],
  });
  const carol = report.students.find((s) => s.github_login === "carol");
  assert.equal(carol.override_applied, false);
  assert.equal(carol.override_reason, null);
  assert.equal(carol.effective_deadline_at, "2026-09-10T23:59:59.000Z");
  assert.equal(carol.submission_status, "late");
});

test("an extension that lands exactly on the deadline changes nothing", () => {
  const report = runReport({
    assignmentYaml: BASE_YAML,
    acceptances: [{ github_login: "carol", status: "accepted" }],
    observations: { carol: [{ observed_at: "2026-09-11T10:00:00Z", sha: "c".repeat(40) }] },
    overrides: [extensionDoc("carol", "2026-09-10T23:59:59Z", "same instant")],
  });
  const carol = report.students.find((s) => s.github_login === "carol");
  assert.equal(carol.override_applied, false);
  assert.equal(carol.submission_status, "late");
});

test("an extension recorded for a student who never accepted is still reported", () => {
  // The roster union puts them in the report; the extension should show against
  // them rather than silently vanish, or a lecturer cannot see what they granted.
  const report = runReport({
    assignmentYaml: BASE_YAML,
    roster: [{ student_number: "07", full_name: "Erin", github_login: "erin" }],
    overrides: [extensionDoc("erin", "2026-09-20T23:59:59Z", "granted early")],
  });
  const erin = report.students.find((s) => s.github_login === "erin");
  assert.equal(erin.effective_deadline_at, "2026-09-20T23:59:59.000Z");
  assert.equal(erin.override_applied, true);
  assert.equal(erin.submission_status, "no-submission");
});

test("the last extension in the history is the one reported", () => {
  const report = runReport({
    assignmentYaml: BASE_YAML,
    acceptances: [{ github_login: "carol", status: "accepted" }],
    observations: { carol: [{ observed_at: "2026-09-18T10:00:00Z", sha: "c".repeat(40) }] },
    overrides: [{
      schema_version: 1,
      assignment_id: "test-asgn",
      github_login: "carol",
      overrides: [
        { type: "deadline_extension", value: "2026-09-13T23:59:59Z", reason: "first", overridden_by: "a", overridden_at: "2026-09-09T12:00:00Z" },
        { type: "deadline_extension", value: "2026-09-20T23:59:59Z", reason: "second", overridden_by: "a", overridden_at: "2026-09-12T12:00:00Z" },
      ],
    }],
  });
  const carol = report.students.find((s) => s.github_login === "carol");
  assert.equal(carol.effective_deadline_at, "2026-09-20T23:59:59.000Z");
  assert.equal(carol.override_reason, "second");
  assert.equal(carol.submission_status, "on-time");
});

test("a malformed extension leaves the assignment deadline standing", () => {
  // Before the shared module this produced an Invalid Date, which is truthy -
  // so every comparison failed and the student fell through to "late" with no
  // on-time SHA at all.
  const report = runReport({
    assignmentYaml: BASE_YAML,
    acceptances: [{ github_login: "carol", status: "accepted" }],
    observations: { carol: [{ observed_at: "2026-09-05T10:00:00Z", sha: "a".repeat(40) }] },
    overrides: [extensionDoc("carol", "whenever", "typo")],
  });
  const carol = report.students.find((s) => s.github_login === "carol");
  assert.equal(carol.effective_deadline_at, "2026-09-10T23:59:59.000Z");
  assert.equal(carol.submission_status, "on-time");
  assert.equal(carol.override_applied, false);
});

test("the CSV carries the effective deadline and the extension flags", () => {
  const report = runReport({
    assignmentYaml: BASE_YAML,
    acceptances: [{ github_login: "carol", status: "accepted" }],
    observations: { carol: [{ observed_at: "2026-09-11T10:00:00Z", sha: "c".repeat(40) }] },
    overrides: [extensionDoc("carol", "2026-09-15T23:59:59Z", "medical extension")],
    csv: true,
  });
  const row = csvRow(report.csvText, "carol");
  assert.ok(row, "carol has a CSV row");
  assert.equal(row.effective_deadline_at, "2026-09-15T23:59:59.000Z");
  assert.equal(row.override_applied, "true");
  assert.equal(row.override_reason, "medical extension");
  assert.equal(row.submission_status, "on-time");
});

test("a group's most generous extension applies to the whole team repository", () => {
  const teamYaml = BASE_YAML.replace(
    "state: published",
    "state: published\nassignment_type: group",
  );
  const report = runReport({
    assignmentYaml: teamYaml,
    acceptances: [
      { github_login: "dana", status: "accepted", team_slug: "team-a" },
      { github_login: "erin", status: "accepted", team_slug: "team-a" },
    ],
    teams: [{ team_slug: "team-a", team_name: "Team A", members: ["dana", "erin"] }],
    observations: {
      dana: [{ observed_at: "2026-09-12T10:00:00Z", sha: "d".repeat(40) }],
      erin: [{ observed_at: "2026-09-12T10:00:00Z", sha: "d".repeat(40) }],
    },
    // Only erin was granted the extension; they share one repository.
    overrides: [extensionDoc("erin", "2026-09-15T23:59:59Z", "team-mate hospitalised")],
  });
  for (const login of ["dana", "erin"]) {
    const s = report.students.find((x) => x.github_login === login);
    assert.equal(s.effective_deadline_at, "2026-09-15T23:59:59.000Z", login);
    assert.equal(s.submission_status, "on-time", login);
  }
});

test("roster student who didn't accept appears as no-submission", () => {
  const report = runReport({
    assignmentYaml: BASE_YAML,
    roster: [
      { student_number: "01", full_name: "Dave", github_login: "dave-test" },
    ],
  });
  const dave = report.students.find((s) => s.github_login === "dave-test");
  assert.equal(dave.acceptance_state, "not-accepted");
  assert.equal(dave.submission_status, "no-submission");
  assert.equal(dave.full_name, "Dave");
});

test("student with commit_count in observations has commit_count in report", () => {
  const report = runReport({
    assignmentYaml: BASE_YAML,
    acceptances: [{ github_login: "eve", status: "accepted" }],
    observations: {
      eve: [
        { observed_at: "2026-09-05T10:00:00Z", sha: "a".repeat(40), commit_count: 5 },
        { observed_at: "2026-09-09T20:00:00Z", sha: "b".repeat(40), commit_count: 12 },
      ],
    },
  });
  const eve = report.students.find((s) => s.github_login === "eve");
  assert.equal(eve.submission_status, "on-time");
  assert.equal(eve.commit_count, 12);
});

test("student with 1 commit (unstarted repo) is classified as no-submission", () => {
  const report = runReport({
    assignmentYaml: BASE_YAML,
    acceptances: [{ github_login: "frank", status: "accepted" }],
    observations: {
      frank: [
        { observed_at: "2026-09-05T10:00:00Z", sha: "a".repeat(40), commit_count: 1, commit_message: "Initial commit" },
      ],
    },
  });
  const frank = report.students.find((s) => s.github_login === "frank");
  assert.equal(frank.submission_status, "no-submission");
  assert.equal(frank.commit_count, 1);
});

test("group assignment report aggregates teams, calculates under_capacity, and attaches team metadata to students", () => {
  const groupYaml = `schema_version: 1
id: test-asgn
title: Group Test Assignment
organization: TestOrg
assignment_type: group
group_config:
  min_team_size: 3
  max_team_size: 4
template:
  owner: TestOrg
  repository: tpl
repository_name_pattern: test-asgn-{team_slug}
opens_at: 2026-09-01T00:00:00Z
deadline_at: 2026-09-10T23:59:59Z
state: published
`;

  const dir = mkdtempSync(join(tmpdir(), "pxl-group-report-test-"));
  const id = "test-asgn";

  mkdirSync(join(dir, "assignments"), { recursive: true });
  writeFileSync(join(dir, "assignments", `${id}.yml`), groupYaml);

  mkdirSync(join(dir, "teams", id), { recursive: true });
  writeFileSync(
    join(dir, "teams", id, "team-alpha.json"),
    JSON.stringify({
      schema_version: 1,
      assignment_id: id,
      team_slug: "team-alpha",
      team_name: "Alpha Team",
      members: ["alice", "bob"],
      max_members: 4,
      repo_name: "TestOrg/test-asgn-team-alpha",
    })
  );
  writeFileSync(
    join(dir, "teams", id, "team-beta.json"),
    JSON.stringify({
      schema_version: 1,
      assignment_id: id,
      team_slug: "team-beta",
      team_name: "Beta Team",
      members: ["charlie", "dave", "eve"],
      max_members: 4,
      repo_name: "TestOrg/test-asgn-team-beta",
    })
  );

  mkdirSync(join(dir, "acceptances", id), { recursive: true });
  for (const s of ["alice", "bob"]) {
    writeFileSync(
      join(dir, "acceptances", id, `${s}.json`),
      JSON.stringify({ github_login: s, status: "accepted", team_slug: "team-alpha", team_name: "Alpha Team" })
    );
  }
  for (const s of ["charlie", "dave", "eve"]) {
    writeFileSync(
      join(dir, "acceptances", id, `${s}.json`),
      JSON.stringify({ github_login: s, status: "accepted", team_slug: "team-beta", team_name: "Beta Team" })
    );
  }

  const res = spawnSync("node", [reportScript], {
    encoding: "utf8",
    env: { ...process.env, ASSIGNMENT_ID: id, DATA_DIR: dir, OUTPUT_FORMAT: "json" },
  });
  assert.equal(res.status, 0);

  const report = JSON.parse(readFileSync(join(dir, "reports", `${id}.json`), "utf8"));
  assert.ok(Array.isArray(report.teams));
  assert.equal(report.teams.length, 2);

  const alpha = report.teams.find((t) => t.team_slug === "team-alpha");
  assert.equal(alpha.team_name, "Alpha Team");
  assert.equal(alpha.members.length, 2);
  assert.equal(alpha.under_capacity, true); // 2 < 3 (min_team_size)

  const beta = report.teams.find((t) => t.team_slug === "team-beta");
  assert.equal(beta.team_name, "Beta Team");
  assert.equal(beta.members.length, 3);
  assert.equal(beta.under_capacity, false); // 3 >= 3

  const alice = report.students.find((s) => s.github_login === "alice");
  assert.equal(alice.team_slug, "team-alpha");
  assert.equal(alice.team_name, "Alpha Team");
});

