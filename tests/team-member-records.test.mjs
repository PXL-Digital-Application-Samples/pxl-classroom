// A lecturer's team change must rewrite the student's repository and acceptance
// records, or the collector, lockdown and acceptance keep acting on where the
// student USED to be. Every document planned here is validated against the real
// schema, because the e2e fixture that would otherwise catch a bad shape only
// sees what the SPA actually commits.

import { test } from "node:test";
import assert from "node:assert/strict";

import { planMemberRecordChanges, teamRepository, buildRepositoryRecord } from "../lib/team-member-records.mjs";
import { validateAgainst } from "../lib/validate.mjs";

const NOW = new Date("2026-09-18T10:00:00Z");
const team = (slug, repo) => ({
  schema_version: 1,
  assignment_id: "lab1",
  team_slug: slug,
  team_name: slug.toUpperCase(),
  members: ["x"],
  created_by: "lecturer",
  ...(repo ? { repo_name: `Org/lab1-${slug}`, repo_id: repo, repo_url: `https://github.com/Org/lab1-${slug}` } : {}),
});
const record = (slug, id) => buildRepositoryRecord({
  assignmentId: "lab1",
  login: "ann",
  repo: { repo_name: `Org/lab1-${slug}`, repo_id: id, repo_url: `https://github.com/Org/lab1-${slug}` },
  teamSlug: slug,
  now: NOW,
});
const acceptance = (slug) => ({
  schema_version: 1,
  assignment_id: "lab1",
  github_login: "ann",
  github_id: 1,
  accepted_at: "2026-09-10T08:00:00Z",
  status: "provisioned",
  team_slug: slug,
  team_name: slug.toUpperCase(),
});
const plan = (args) => planMemberRecordChanges({ assignmentId: "lab1", org: "Org", login: "ann", now: NOW, ...args });

function assertValid(changes) {
  for (const c of changes) {
    if (c.content === null) continue;
    const schema = c.path.startsWith("repositories/") ? "repository-record" : "acceptance";
    const { valid, errors } = validateAgainst(schema, JSON.parse(c.content));
    assert.ok(valid, `${c.path}: ${JSON.stringify(errors)}`);
  }
}

test("a moved student's records follow them to the new team's repository", () => {
  const changes = plan({ toTeam: team("blue", 22), repoRecord: { ...record("red", 11), feedback_pr_number: 3 }, acceptance: acceptance("red") });
  assertValid(changes);
  const rec = JSON.parse(changes.find((c) => c.path === "repositories/lab1/ann.json").content);
  assert.equal(rec.repo_name, "Org/lab1-blue");
  assert.equal(rec.repo_id, 22);
  assert.equal(rec.team_slug, "blue");
  assert.equal(rec.feedback_pr_number, null, "a PR number belongs to the repository they left");
  assert.equal(rec.created_at, record("red", 11).created_at, "merged, not rebuilt");
  const acc = JSON.parse(changes.find((c) => c.path === "acceptances/lab1/ann.json").content);
  assert.equal(acc.team_slug, "blue");
  assert.equal(acc.accepted_at, "2026-09-10T08:00:00Z", "the acceptance time is theirs, not the move's");
});

test("a student ADDED to a team with a repository gets a record lockdown can see", () => {
  const changes = plan({ toTeam: team("blue", 22), repoRecord: null, acceptance: null });
  assertValid(changes);
  assert.equal(changes.length, 1, "no acceptance is invented for a student who never accepted");
  const rec = JSON.parse(changes[0].content);
  assert.deepEqual(
    { login: rec.github_login, repo: rec.repo_name, id: rec.repo_id },
    { login: "ann", repo: "Org/lab1-blue", id: 22 },
  );
});

test("a REMOVED student loses the record, so the deadline does not re-invite them", () => {
  const changes = plan({ toTeam: null, repoRecord: record("red", 11), acceptance: acceptance("red") });
  assertValid(changes);
  assert.deepEqual(changes.find((c) => c.path === "repositories/lab1/ann.json"), { path: "repositories/lab1/ann.json", content: null });
  const acc = JSON.parse(changes.find((c) => c.path === "acceptances/lab1/ann.json").content);
  assert.equal(acc.team_slug, undefined, "no team is claimed any more");
  assert.equal(acc.team_name, undefined);
});

test("moving into a team with NO repository yet drops the record rather than naming the old one", () => {
  const changes = plan({ toTeam: team("green", null), repoRecord: record("red", 11), acceptance: acceptance("red") });
  assertValid(changes);
  assert.equal(changes.find((c) => c.path === "repositories/lab1/ann.json").content, null);
});

test("nothing to rewrite writes nothing", () => {
  assert.deepEqual(plan({ toTeam: team("blue", null), repoRecord: null, acceptance: null }), []);
  const same = plan({ toTeam: team("red", 11), repoRecord: record("red", 11), acceptance: acceptance("red") });
  assert.ok(!same.some((c) => c.path.startsWith("acceptances/")), "an unchanged acceptance is not rewritten");
});

test("a bare repo_name, which the schema allows, is completed with the org", () => {
  assert.deepEqual(
    teamRepository({ repo_name: "lab1-red", repo_id: 5 }, "Org"),
    { repo_name: "Org/lab1-red", repo_id: 5, repo_url: "https://github.com/Org/lab1-red" },
  );
  assert.equal(teamRepository({ repo_name: "Org/lab1-red" }, "Org"), null, "no id, no repository");
  assert.equal(teamRepository(null, "Org"), null);
});
