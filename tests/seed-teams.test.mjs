import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Ajv from "ajv";
import addFormats from "ajv-formats";

import { planSeed, planUnseed, teamsFromRoster, DEFAULT_MAX_TEAM_SIZE } from "../lib/seed-teams.mjs";

const NOW = "2026-09-01T10:00:00.000Z";

const teamSchema = JSON.parse(readFileSync(new URL("../schemas/team.schema.json", import.meta.url), "utf8"));
const ajv = new Ajv({ strict: false });
addFormats(ajv);
const validateTeam = ajv.compile(teamSchema);

function target(overrides = {}) {
  return {
    id: "linux-networking-2026",
    assignment_type: "group",
    repository_name_pattern: "linux-networking-2026-{team_slug}",
    group_config: { max_team_size: 3 },
    ...overrides,
  };
}

function source(overrides = {}) {
  return {
    id: "linux-processes-2026",
    title: "Linux Processes",
    repository_name_pattern: "linux-processes-2026-{team_slug}",
    ...overrides,
  };
}

function sourceTeams() {
  return [
    { schema_version: 1, assignment_id: "linux-processes-2026", team_slug: "alpha", team_name: "Alpha Team", members: ["alice", "bob"], max_members: 4, repo_id: 1, repo_name: "org/linux-processes-2026-alpha", repo_url: "https://github.com/org/x", created_at: "2026-02-01T00:00:00Z", created_by: "alice" },
    { schema_version: 1, assignment_id: "linux-processes-2026", team_slug: "beta", team_name: "Beta Team", members: ["carol"], max_members: 4 },
  ];
}

function plan(over = {}) {
  return planSeed({
    sourceTeams: sourceTeams(),
    targetAssignment: target(),
    sourceAssignment: source(),
    now: NOW,
    actor: "tomcoolpxl",
    ...over,
  });
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

test("carries teams forward with fresh metadata and target capacity", () => {
  const p = plan();
  assert.equal(p.ok, true);
  assert.deepEqual(p.errors, []);
  assert.equal(p.stats.teams, 2);
  assert.equal(p.stats.students, 3);

  const alpha = p.teams.find((t) => t.team_slug === "alpha");
  assert.deepEqual(alpha.members, ["alice", "bob"]);
  assert.equal(alpha.assignment_id, "linux-networking-2026");
  assert.equal(alpha.team_name, "Alpha Team");
  assert.equal(alpha.created_at, NOW);
  assert.equal(alpha.created_by, "tomcoolpxl");
  assert.deepEqual(alpha.seeded_from, {
    source: "assignment",
    assignment_id: "linux-processes-2026",
    assignment_title: "Linux Processes",
    seeded_at: NOW,
    seeded_by: "tomcoolpxl",
  });
});

test("re-derives max_members from the target, never copies the source's", () => {
  const p = plan();
  for (const t of p.teams) assert.equal(t.max_members, 3);
});

test("strips repository facts - a seeded team owns no repo yet", () => {
  const alpha = plan().teams.find((t) => t.team_slug === "alpha");
  assert.equal("repo_id" in alpha, false);
  assert.equal("repo_url" in alpha, false);
  assert.equal("repo_name" in alpha, false);
  assert.equal("vacant" in alpha, false);
});

test("every produced team validates against team.schema.json", () => {
  for (const t of plan().teams) {
    const ok = validateTeam(t);
    assert.equal(ok, true, JSON.stringify(validateTeam.errors));
  }
});

test("emits one change per team at teams/<target>/<slug>.json", () => {
  const p = plan();
  assert.deepEqual(
    p.changes.map((c) => c.path),
    ["teams/linux-networking-2026/alpha.json", "teams/linux-networking-2026/beta.json"]
  );
  assert.equal(p.changes[0].content.endsWith("\n"), true);
  assert.deepEqual(JSON.parse(p.changes[0].content).members, ["alice", "bob"]);
});

test("output is deterministic and sorted by slug", () => {
  const a = planSeed({ sourceTeams: sourceTeams().reverse(), targetAssignment: target(), sourceAssignment: source(), now: NOW, actor: "x" });
  const b = plan({ actor: "x" });
  assert.deepEqual(a.teams.map((t) => t.team_slug), ["alpha", "beta"]);
  assert.deepEqual(a.teams, b.teams);
});

test("never mutates its inputs", () => {
  const src = sourceTeams();
  const frozen = JSON.parse(JSON.stringify(src));
  planSeed({ sourceTeams: src, targetAssignment: target(), sourceAssignment: source(), now: NOW });
  assert.deepEqual(src, frozen);
});

// ---------------------------------------------------------------------------
// Configuration errors - these block the whole seed
// ---------------------------------------------------------------------------

test("blocks when a source team exceeds the target's max team size", () => {
  const p = plan({
    sourceTeams: [{ team_slug: "big", team_name: "Big", members: ["a", "b", "c", "d"] }],
  });
  assert.equal(p.ok, false);
  assert.equal(p.errors[0].code, "over-capacity");
  assert.match(p.errors[0].message, /big \(4\)/);
  assert.deepEqual(p.teams, []);
  assert.deepEqual(p.changes, []);
});

test("blocks when the target pattern has no {team_slug}", () => {
  const p = plan({ targetAssignment: target({ repository_name_pattern: "netw-{github_login}" }) });
  assert.equal(p.ok, false);
  assert.equal(p.errors.some((e) => e.code === "pattern-missing-team-slug"), true);
});

test("blocks when target and source share a repository name pattern", () => {
  const p = plan({
    targetAssignment: target({ repository_name_pattern: "linux-processes-2026-{team_slug}" }),
  });
  assert.equal(p.ok, false);
  const err = p.errors.find((e) => e.code === "pattern-collision");
  assert.ok(err, "expected pattern-collision");
  assert.match(err.message, /instead of new ones/);
});

test("blocks when the target is not a group assignment", () => {
  const p = plan({ targetAssignment: target({ assignment_type: "individual" }) });
  assert.equal(p.ok, false);
  assert.equal(p.errors.some((e) => e.code === "not-group"), true);
});

test("blocks when the source has nothing to carry over", () => {
  const p = plan({ sourceTeams: [{ team_slug: "ghost", team_name: "Ghost", members: [], vacant: true }] });
  assert.equal(p.ok, false);
  assert.equal(p.errors[0].code, "no-source-teams");
});

test("roster source with no team columns reports a roster-specific error", () => {
  const p = plan({ sourceTeams: [], sourceAssignment: null, source: "roster" });
  assert.equal(p.ok, false);
  assert.match(p.errors[0].message, /team_slug \/ team_name columns/);
});

test("no target assignment is an error, not a throw", () => {
  const p = planSeed({ sourceTeams: sourceTeams() });
  assert.equal(p.ok, false);
  assert.equal(p.errors[0].code, "no-target");
});

// ---------------------------------------------------------------------------
// Source hygiene
// ---------------------------------------------------------------------------

test("skips vacant and empty source teams without failing", () => {
  const p = plan({
    sourceTeams: [
      ...sourceTeams(),
      { team_slug: "gone", team_name: "Gone", members: ["dave"], vacant: true },
      { team_slug: "empty", team_name: "Empty", members: [] },
    ],
  });
  assert.equal(p.ok, true);
  assert.deepEqual(p.teams.map((t) => t.team_slug), ["alpha", "beta"]);
  assert.deepEqual(
    p.skipped.map((s) => `${s.team_slug}:${s.reason}`).sort(),
    ["empty:no-members", "gone:vacant"]
  );
});

test("dedupes members case-insensitively", () => {
  const p = plan({
    sourceTeams: [{ team_slug: "alpha", team_name: "Alpha", members: ["Alice", "alice", "BOB"] }],
  });
  assert.deepEqual(p.teams[0].members, ["Alice", "BOB"]);
});

test("skips a source team whose slug is not URL-safe, and warns", () => {
  const p = plan({
    sourceTeams: [...sourceTeams(), { team_slug: "Team Ålpha!", team_name: "Bad", members: ["dave"] }],
  });
  assert.equal(p.ok, true);
  assert.equal(p.warnings.some((w) => w.code === "invalid-slug"), true);
  assert.equal(p.teams.length, 2);
});

test("falls back to the slug when the source team has no name", () => {
  const p = plan({ sourceTeams: [{ team_slug: "alpha", members: ["alice"] }] });
  assert.equal(p.teams[0].team_name, "alpha");
});

// ---------------------------------------------------------------------------
// Reconciliation against teams the target already has
// ---------------------------------------------------------------------------

test("never overwrites a target team students already joined", () => {
  const p = plan({
    existingTeams: [{ team_slug: "alpha", team_name: "Alpha (student-formed)", members: ["zoe"] }],
  });
  assert.equal(p.ok, true);
  assert.deepEqual(p.teams.map((t) => t.team_slug), ["beta"]);
  assert.equal(p.warnings.some((w) => w.code === "existing-team-kept"), true);
  assert.equal(p.skipped.some((s) => s.team_slug === "alpha" && s.reason === "already-populated"), true);
});

test("reseeds over an existing target team that has no members", () => {
  const p = plan({ existingTeams: [{ team_slug: "alpha", team_name: "Alpha", members: [], vacant: true }] });
  assert.deepEqual(p.teams.map((t) => t.team_slug), ["alpha", "beta"]);
});

test("drops a member who already belongs to another team in the target", () => {
  const p = plan({
    existingTeams: [{ team_slug: "gamma", team_name: "Gamma", members: ["bob"] }],
  });
  const alpha = p.teams.find((t) => t.team_slug === "alpha");
  assert.deepEqual(alpha.members, ["alice"]);
  const warn = p.warnings.find((w) => w.code === "member-already-teamed");
  assert.ok(warn);
  assert.deepEqual(warn.logins, ["bob"]);
});

test("a login is never written into two team files of one assignment", () => {
  const p = plan({
    sourceTeams: [
      { team_slug: "alpha", team_name: "Alpha", members: ["alice", "bob"] },
      { team_slug: "beta", team_name: "Beta", members: ["bob", "carol"] },
    ],
  });
  const seen = new Map();
  for (const t of p.teams) {
    for (const m of t.members) {
      assert.equal(seen.has(m.toLowerCase()), false, `${m} appears in two teams`);
      seen.set(m.toLowerCase(), t.team_slug);
    }
  }
  assert.equal(seen.get("bob"), "alpha");
});

test("skips a team whose members have all been claimed elsewhere", () => {
  const p = plan({
    existingTeams: [{ team_slug: "gamma", team_name: "Gamma", members: ["carol"] }],
  });
  assert.deepEqual(p.teams.map((t) => t.team_slug), ["alpha"]);
  assert.equal(p.skipped.some((s) => s.team_slug === "beta" && s.reason === "all-members-already-teamed"), true);
});

// ---------------------------------------------------------------------------
// Warnings
// ---------------------------------------------------------------------------

test("warns about carried-over students who are not on the roster", () => {
  const p = plan({
    roster: { students: [{ student_number: "1", full_name: "Alice", github_login: "alice" }] },
  });
  const warn = p.warnings.find((w) => w.code === "not-on-roster");
  assert.ok(warn);
  assert.deepEqual(warn.logins.sort(), ["bob", "carol"]);
});

test("suppresses the roster warning when the target is roster_mode: open", () => {
  const p = plan({
    targetAssignment: target({ roster_mode: "open", max_acceptances: 50 }),
    roster: { students: [] },
  });
  assert.equal(p.warnings.some((w) => w.code === "not-on-roster"), false);
});

test("on the roster but outside the cohort is its own warning", () => {
  // THE CASE THE ROSTER-ONLY CHECK WAS BLIND TO. Carol is enrolled, so "not on
  // the roster" is false and nothing warned - but the assignment is not for her
  // and she is refused at the accept button. It did not exist while a cohort was
  // a rule over class groups; it does now.
  //
  // Two warnings rather than one, because they send a lecturer to do different
  // things: import a student, or add them to this assignment.
  const p = plan({
    targetAssignment: target({ roster_mode: "enforced", cohort: ["num:1", "num:2"] }),
    roster: {
      students: [
        { student_number: "1", full_name: "Alice", github_login: "alice" },
        { student_number: "2", full_name: "Bob", github_login: "bob" },
        { student_number: "3", full_name: "Carol", github_login: "carol" },
      ],
    },
  });

  assert.equal(p.warnings.some((w) => w.code === "not-on-roster"), false, "everyone IS on the roster");
  const warn = p.warnings.find((w) => w.code === "not-in-cohort");
  assert.ok(warn, "a rostered student outside the cohort has to be named");
  assert.deepEqual(warn.logins, ["carol"]);
  assert.match(warn.message, /Who is this assignment for/);
});

test("an assignment that names no cohort warns about nobody", () => {
  // Absent cohort means every roster student, so a carried-over team is fine.
  const p = plan({
    targetAssignment: target({ roster_mode: "enforced" }),
    roster: {
      students: [
        { student_number: "1", github_login: "alice" },
        { student_number: "2", github_login: "bob" },
        { student_number: "3", github_login: "carol" },
      ],
    },
  });
  assert.equal(p.warnings.some((w) => w.code === "not-in-cohort"), false);
  assert.equal(p.warnings.some((w) => w.code === "not-on-roster"), false);
});

test("a claim student's login is resolved, not reported as a stranger", () => {
  // THE PRE-EXISTING DEFECT. Under `claim` a properly enrolled student has no
  // `github_login` on their roster row until the nightly folds their claim in -
  // and the check read only that column, so seeding told the lecturer these
  // students "are not on the roster and will be rejected when they accept",
  // about people who will be admitted. It errs in the direction that makes a
  // lecturer undo correct work.
  const roster = {
    students: [
      { student_number: "1", full_name: "Alice", email: "alice@student.pxl.be" },
      { student_number: "2", full_name: "Bob", email: "bob@student.pxl.be" },
      { student_number: "3", full_name: "Carol", email: "carol@student.pxl.be" },
    ],
  };
  const targetAssignment = target({ roster_mode: "claim" });

  // Without the bindings there is nothing to resolve against, and the old
  // behaviour is what you get - which is what makes this a real fix and not a
  // preference.
  const blind = plan({ targetAssignment, roster });
  assert.deepEqual(
    blind.warnings.find((w) => w.code === "not-on-roster")?.logins.sort(),
    ["alice", "bob", "carol"],
    "the roster column alone cannot see a claim binding",
  );

  const extraLogins = new Map([
    ["alice", roster.students[0]],
    ["bob", roster.students[1]],
    ["carol", roster.students[2]],
  ]);
  const resolved = plan({ targetAssignment, roster, extraLogins });
  assert.equal(resolved.warnings.some((w) => w.code === "not-on-roster"), false);
  assert.equal(resolved.warnings.some((w) => w.code === "not-in-cohort"), false);
});

test("unplaced counts the cohort, not the organization", () => {
  // Seeding a 22-person cohort in a 200-student org used to report 178 unplaced
  // students, none of whom the assignment was for. This file said why: unplaced
  // "means nothing unless the roster IS the cohort". An explicit cohort makes
  // it correct.
  const students = [
    { student_number: "1", full_name: "Alice", github_login: "alice" },
    { student_number: "2", full_name: "Bob", github_login: "bob" },
    { student_number: "3", full_name: "Carol", github_login: "carol" },
    { student_number: "4", full_name: "Dave", github_login: "dave" },
    { student_number: "9", full_name: "Zoe (another section)", github_login: "zoe" },
  ];

  const scoped = plan({
    targetAssignment: target({ roster_mode: "enforced", cohort: ["num:1", "num:2", "num:3", "num:4"] }),
    roster: { students },
  });
  assert.deepEqual(scoped.unplaced.map((u) => u.github_login), ["dave"], "Zoe is not this assignment's problem");

  const unscoped = plan({ targetAssignment: target({ roster_mode: "enforced" }), roster: { students } });
  assert.deepEqual(
    unscoped.unplaced.map((u) => u.github_login).sort(),
    ["dave", "zoe"],
    "with no cohort the whole roster is the cohort, and Zoe is unplaced",
  );
});

test("warns about teams below the minimum team size", () => {
  const p = plan({ targetAssignment: target({ group_config: { max_team_size: 3, min_team_size: 2 } }) });
  const warn = p.warnings.find((w) => w.code === "under-capacity");
  assert.ok(warn);
  assert.deepEqual(warn.teams, ["beta"]);
});

test("warns when the carried-over cohort exceeds max_acceptances", () => {
  const p = plan({ targetAssignment: target({ max_acceptances: 2 }) });
  assert.equal(p.warnings.some((w) => w.code === "cap-exceeded"), true);
});

test("a plan with warnings is still applicable", () => {
  const p = plan({ roster: { students: [] }, targetAssignment: target({ group_config: { max_team_size: 3, min_team_size: 3 } }) });
  assert.equal(p.ok, true);
  assert.ok(p.warnings.length >= 2);
  assert.equal(p.changes.length, 2);
});

// ---------------------------------------------------------------------------
// Roster as a source
// ---------------------------------------------------------------------------

test("teamsFromRoster groups by the course-wide team_slug", () => {
  const teams = teamsFromRoster([
    { student_number: "1", full_name: "A", github_login: "alice", team_slug: "alpha", team_name: "Alpha Team" },
    { student_number: "2", full_name: "B", github_login: "bob", team_slug: "alpha" },
    { student_number: "3", full_name: "C", github_login: "carol", team_slug: "beta", team_name: "Beta Team" },
  ]);
  assert.deepEqual(teams.map((t) => t.team_slug), ["alpha", "beta"]);
  assert.deepEqual(teams[0].members, ["alice", "bob"]);
  assert.equal(teams[0].team_name, "Alpha Team");
});

test("teamsFromRoster prefers the per-assignment mapping over the course-wide one", () => {
  const teams = teamsFromRoster(
    [
      { student_number: "1", full_name: "A", github_login: "alice", team_slug: "alpha", teams: { "netw-2026": "exam-pair-1" } },
      { student_number: "2", full_name: "B", github_login: "bob", team_slug: "alpha" },
    ],
    { assignmentId: "netw-2026" }
  );
  assert.deepEqual(teams.map((t) => t.team_slug).sort(), ["alpha", "exam-pair-1"]);
});

test("teamsFromRoster ignores inactive students, unlinked accounts and ungrouped entries", () => {
  const teams = teamsFromRoster([
    { student_number: "1", full_name: "A", github_login: "alice", team_slug: "alpha" },
    { student_number: "2", full_name: "B", github_login: "bob", team_slug: "alpha", active: false },
    { student_number: "3", full_name: "C", github_login: null, team_slug: "alpha" },
    { student_number: "4", full_name: "D", github_login: "dave" },
  ]);
  assert.equal(teams.length, 1);
  assert.deepEqual(teams[0].members, ["alice"]);
});

test("a roster-sourced plan records provenance without an assignment id", () => {
  const rosterTeams = teamsFromRoster([
    { student_number: "1", full_name: "A", github_login: "alice", team_slug: "alpha", team_name: "Alpha" },
  ]);
  const p = planSeed({
    sourceTeams: rosterTeams,
    targetAssignment: target(),
    sourceAssignment: null,
    source: "roster",
    now: NOW,
    actor: "tomcoolpxl",
  });
  assert.equal(p.ok, true);
  assert.deepEqual(p.teams[0].seeded_from, { source: "roster", seeded_at: NOW, seeded_by: "tomcoolpxl" });
  assert.equal(validateTeam(p.teams[0]), true, JSON.stringify(validateTeam.errors));
});

test("default max team size is used when group_config omits it", () => {
  const p = plan({ targetAssignment: target({ group_config: {} }) });
  assert.equal(p.teams[0].max_members, DEFAULT_MAX_TEAM_SIZE);
});

// ---------------------------------------------------------------------------
// Who is left without a team - the residual manual work after a carry-forward
// ---------------------------------------------------------------------------

const ROSTER = {
  students: [
    { student_number: "1", full_name: "Alice A", github_login: "alice" },
    { student_number: "2", full_name: "Bob B", github_login: "bob" },
    { student_number: "3", full_name: "Carol C", github_login: "carol" },
    { student_number: "4", full_name: "Dave D", github_login: "dave" },
    { student_number: "5", full_name: "Erin E", github_login: "erin", active: false },
    { student_number: "6", full_name: "Frank F", github_login: null },
  ],
};

test("reports roster students who end up in no team", () => {
  const p = plan({ roster: ROSTER });
  assert.deepEqual(p.unplaced.map((u) => u.github_login), ["dave"]);
  assert.equal(p.unplaced[0].full_name, "Dave D");
  assert.equal(p.stats.unplaced, 1);
  const warn = p.warnings.find((w) => w.code === "unplaced");
  assert.ok(warn);
  assert.match(warn.message, /@dave/);
});

test("unplaced ignores inactive students and unlinked accounts", () => {
  const p = plan({ roster: ROSTER });
  const logins = p.unplaced.map((u) => u.github_login);
  assert.equal(logins.includes("erin"), false);
  assert.equal(logins.includes(null), false);
});

test("a student already in a target team counts as placed", () => {
  const p = plan({
    roster: ROSTER,
    existingTeams: [{ team_slug: "delta", team_name: "Delta", members: ["dave"] }],
  });
  assert.deepEqual(p.unplaced, []);
  assert.equal(p.warnings.some((w) => w.code === "unplaced"), false);
});

test("unplaced is not computed under roster_mode: open", () => {
  const p = plan({
    roster: ROSTER,
    targetAssignment: target({ roster_mode: "open", max_acceptances: 50 }),
  });
  assert.deepEqual(p.unplaced, []);
  assert.equal(p.stats.unplaced, 0);
});

test("a kept team names the students it strands", () => {
  const p = plan({
    roster: ROSTER,
    // alpha exists in the target with only zoe in it, so alice and bob - who
    // were carried over together - land nowhere.
    existingTeams: [{ team_slug: "alpha", team_name: "Alpha", members: ["zoe"] }],
  });
  const warn = p.warnings.find((w) => w.code === "existing-team-kept");
  assert.ok(warn);
  assert.match(warn.message, /were therefore not placed/);
  assert.deepEqual(warn.logins.sort(), ["alice", "bob"]);
  assert.deepEqual(p.unplaced.map((u) => u.github_login).sort(), ["alice", "bob", "dave"]);
});

test("a long unplaced list stays readable", () => {
  const many = { students: Array.from({ length: 25 }, (_, i) => ({
    student_number: String(i), full_name: `S${i}`, github_login: `student${i}`,
  })) };
  const p = plan({ roster: many });
  const warn = p.warnings.find((w) => w.code === "unplaced");
  assert.match(warn.message, /and 17 more/);
  assert.equal(p.unplaced.length, 25);
});

test("no roster means no unplaced claim rather than a wrong one", () => {
  const p = plan();
  assert.deepEqual(p.unplaced, []);
  assert.equal(p.warnings.some((w) => w.code === "unplaced"), false);
});

// ---------------------------------------------------------------------------
// Undoing a seed. Narrow on purpose: this deletes files, so anything a student
// has touched is kept and reported rather than quietly removed.
// ---------------------------------------------------------------------------

function seededTeam(slug, members, extra = {}) {
  return {
    team_slug: slug,
    team_name: slug,
    members,
    seeded_from: { source: "assignment", assignment_id: "prev", seeded_at: NOW },
    ...extra,
  };
}

test("unseed removes carried-over teams nobody has accepted into", () => {
  const p = planUnseed({
    assignmentId: "netw",
    teams: [seededTeam("alpha", ["alice"]), seededTeam("beta", ["bob"])],
    acceptedLogins: [],
  });
  assert.deepEqual(p.removable.map((t) => t.team_slug), ["alpha", "beta"]);
  assert.deepEqual(p.kept, []);
  assert.deepEqual(p.changes, [
    { path: "teams/netw/alpha.json", content: null },
    { path: "teams/netw/beta.json", content: null },
  ]);
});

test("unseed keeps a team a member has accepted into", () => {
  const p = planUnseed({
    assignmentId: "netw",
    teams: [seededTeam("alpha", ["alice"]), seededTeam("beta", ["bob"])],
    acceptedLogins: ["ALICE"],
  });
  assert.deepEqual(p.removable.map((t) => t.team_slug), ["beta"]);
  assert.deepEqual(p.kept.map((t) => t.team_slug), ["alpha"]);
});

test("unseed keeps a team that owns a repository", () => {
  const p = planUnseed({
    assignmentId: "netw",
    teams: [seededTeam("alpha", ["alice"], { repo_url: "https://github.com/o/netw-alpha" })],
    acceptedLogins: [],
  });
  assert.deepEqual(p.removable, []);
  assert.deepEqual(p.kept.map((t) => t.team_slug), ["alpha"]);
});

test("unseed keeps a team recorded by repo_id alone", () => {
  const p = planUnseed({
    assignmentId: "netw",
    teams: [seededTeam("alpha", ["alice"], { repo_id: 4242 })],
    acceptedLogins: [],
  });
  assert.deepEqual(p.removable, []);
});

test("unseed never touches a team that was not seeded", () => {
  const p = planUnseed({
    assignmentId: "netw",
    teams: [
      { team_slug: "student-made", team_name: "Student Made", members: ["zoe"] },
      seededTeam("alpha", ["alice"]),
    ],
    acceptedLogins: [],
  });
  assert.deepEqual(p.removable.map((t) => t.team_slug), ["alpha"]);
  assert.deepEqual(p.kept, []);
});

test("unseed handles an empty seeded team", () => {
  const p = planUnseed({
    assignmentId: "netw",
    teams: [seededTeam("alpha", [])],
    acceptedLogins: [],
  });
  assert.deepEqual(p.removable.map((t) => t.team_slug), ["alpha"]);
});

test("unseed of nothing is not an error", () => {
  const p = planUnseed({ assignmentId: "netw" });
  assert.deepEqual(p.removable, []);
  assert.deepEqual(p.changes, []);
});

test("unseed accepts a Set of accepted logins and matches case-insensitively", () => {
  const p = planUnseed({
    assignmentId: "netw",
    teams: [seededTeam("alpha", ["Alice"])],
    acceptedLogins: new Set(["alice"]),
  });
  assert.deepEqual(p.removable, []);
});

test("unseed output is deterministic", () => {
  const teams = [seededTeam("gamma", ["c"]), seededTeam("alpha", ["a"]), seededTeam("beta", ["b"])];
  const p = planUnseed({ assignmentId: "netw", teams, acceptedLogins: [] });
  assert.deepEqual(p.removable.map((t) => t.team_slug), ["alpha", "beta", "gamma"]);
});
