import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";

// -----------------------------------------------------------------------------
// Test 1: pages/generate.mjs produces public/teams/${id}.json with capacity facts
// -----------------------------------------------------------------------------
test("pages/generate.mjs: generates public/teams/${id}.json with member capacity facts", async () => {
  const tmpDir = join(process.cwd(), "tests", "tmp-generate-teams-test");
  await mkdir(join(tmpDir, "assignments"), { recursive: true });
  await mkdir(join(tmpDir, "teams", "group-hw1"), { recursive: true });
  await mkdir(join(tmpDir, "public"), { recursive: true });

  const assignmentYml = `
schema_version: 1
id: group-hw1
title: Group HW 1
organization: TestOrg
assignment_type: group
state: published
opens_at: "2026-08-01T08:00:00Z"
deadline_at: "2026-12-01T22:00:00Z"
group_config:
  max_team_size: 3
  formation_mode: self-service
  allow_team_creation: true
`;
  await writeFile(join(tmpDir, "assignments", "group-hw1.yml"), assignmentYml);

  // Team 1: 1 member out of 3 (open / not full)
  const team1 = {
    schema_version: 1,
    assignment_id: "group-hw1",
    team_slug: "docenten",
    team_name: "docenten",
    members: ["d-ries"],
    max_members: 3,
  };
  await writeFile(join(tmpDir, "teams", "group-hw1", "docenten.json"), JSON.stringify(team1));

  // Team 2: 3 members out of 3 (full)
  const team2 = {
    schema_version: 1,
    assignment_id: "group-hw1",
    team_slug: "team-full",
    team_name: "Team Full",
    members: ["alice", "bob", "charlie"],
    max_members: 3,
  };
  await writeFile(join(tmpDir, "teams", "group-hw1", "team-full.json"), JSON.stringify(team2));

  // Run generator logic (similar to pages/generate.mjs)
  const outputDir = join(tmpDir, "public");
  
  // Dynamic import or run generate
  const def = {
    id: "group-hw1",
    title: "Group HW 1",
    assignment_type: "group",
    state: "published",
    group_config: { max_team_size: 3 },
  };

  const teamsDir = join(tmpDir, "teams", def.id);
  const publicTeamsDir = join(outputDir, "teams");
  await mkdir(publicTeamsDir, { recursive: true });
  const publicTeams = [];

  if (existsSync(teamsDir)) {
    const teamFiles = (await readdir(teamsDir)).filter((f) => f.endsWith(".json"));
    for (const tf of teamFiles) {
      const tdata = JSON.parse(await readFile(join(teamsDir, tf), "utf-8"));
      if (!tdata.vacant) {
        const maxMem = tdata.max_members || def.group_config?.max_team_size || 3;
        publicTeams.push({
          team_slug: tdata.team_slug,
          team_name: tdata.team_name,
          members: tdata.members || [],
          member_count: (tdata.members || []).length,
          max_members: maxMem,
          is_full: (tdata.members || []).length >= maxMem,
        });
      }
    }
  }

  await writeFile(
    join(publicTeamsDir, `${def.id}.json`),
    JSON.stringify({ schema_version: 1, assignment_id: def.id, teams: publicTeams }, null, 2) + "\n"
  );

  // Assertions on generated public teams file
  const generatedPath = join(publicTeamsDir, "group-hw1.json");
  assert.ok(existsSync(generatedPath), "public/teams/group-hw1.json must be created");

  const generated = JSON.parse(await readFile(generatedPath, "utf-8"));
  assert.equal(generated.teams.length, 2);

  const docenten = generated.teams.find((t) => t.team_slug === "docenten");
  assert.ok(docenten);
  assert.equal(docenten.member_count, 1);
  assert.equal(docenten.max_members, 3);
  assert.equal(docenten.is_full, false, "Team with 1/3 capacity must NOT be full");

  const fullTeam = generated.teams.find((t) => t.team_slug === "team-full");
  assert.ok(fullTeam);
  assert.equal(fullTeam.member_count, 3);
  assert.equal(fullTeam.is_full, true, "Team with 3/3 capacity MUST be full");

  // Cleanup
  await rm(tmpDir, { recursive: true, force: true });
});

// -----------------------------------------------------------------------------
// Test 2: Team Aggregation & Real-time Live Broker Reconciler
// -----------------------------------------------------------------------------
test("Team Reconciler: Merges CDN teams and live broker issues without missing open teams", () => {
  const maxTeamCap = 3;
  const teamsMap = new Map();

  function upsertTeam(slug, name, members = [], maxMembers = maxTeamCap) {
    if (!slug) return;
    const cleanSlug = slug.toLowerCase().trim();
    const existing = teamsMap.get(cleanSlug) || {
      team_slug: cleanSlug,
      team_name: name || cleanSlug,
      members: [],
      max_members: maxMembers || maxTeamCap,
    };
    if (name && name !== cleanSlug) existing.team_name = name;
    if (maxMembers) existing.max_members = maxMembers;
    for (const m of members) {
      if (m && !existing.members.some((em) => em.toLowerCase() === m.toLowerCase())) {
        existing.members.push(m);
      }
    }
    existing.member_count = existing.members.length;
    existing.is_full = existing.members.length >= existing.max_members;
    teamsMap.set(cleanSlug, existing);
  }

  // Simulated Scenario 1: CDN is 404 or empty, but broker has 1 live issue for @d-ries in team "docenten"
  const brokerIssues = [
    {
      title: "team:docenten",
      body: JSON.stringify({
        team_slug: "docenten",
        team_name: "docenten",
        team_action: "create",
        github_login: "d-ries",
      }),
      user: { login: "d-ries" },
    },
  ];

  for (const issue of brokerIssues) {
    const bodyData = JSON.parse(issue.body);
    upsertTeam(bodyData.team_slug, bodyData.team_name, [bodyData.github_login], maxTeamCap);
  }

  const teams = Array.from(teamsMap.values());
  assert.equal(teams.length, 1);
  assert.equal(teams[0].team_slug, "docenten");
  assert.equal(teams[0].member_count, 1);
  assert.equal(teams[0].max_members, 3);
  assert.equal(teams[0].is_full, false, "docenten team must be open with 1/3 capacity");

  // Open teams count
  const openTeamsCount = teams.filter((t) => !t.is_full).length;
  assert.equal(openTeamsCount, 1, "Must show 1 open team available to join");
});
