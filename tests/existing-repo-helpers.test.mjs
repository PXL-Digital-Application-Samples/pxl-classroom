// The three answers acceptance asks before it treats a repository at a name as
// the student's own (review 2026-10-14, TA-1): which repository a team file
// records, whether a decision of theirs made the team's, and whether a Retry
// is redoing the attempt that made it. Each was reached only through
// accept.mjs; here each is asked directly, edges first.

import { test } from "node:test";
import assert from "node:assert/strict";
import { manifestRepoName, ownDecisionMadeTeamRepo, retriedOwnRepo } from "../lib/existing-repo.mjs";

test("manifestRepoName: the bare name in this org, never another owner's, never a malformed one", () => {
  assert.equal(manifestRepoName("Org/grp-alpha", "Org"), "grp-alpha");
  assert.equal(manifestRepoName("org/grp-alpha", "ORG"), "grp-alpha", "owners compared as GitHub does");
  assert.equal(manifestRepoName("grp-alpha", "Org"), "grp-alpha", "a bare name is in this org");
  assert.equal(manifestRepoName(" Org/grp-alpha ", "Org"), "grp-alpha");
  assert.equal(manifestRepoName("Other/grp-alpha", "Org"), null, "another owner's repository is not this team's");
  for (const bad of ["Org/", "Org/grp alpha", "Org/grp/alpha", "Org/../x", "Org/" + "a".repeat(101), "", "   ", null, undefined, 42]) {
    assert.equal(manifestRepoName(bad, "Org"), null, `refused: ${JSON.stringify(bad)}`);
  }
});

test("ownDecisionMadeTeamRepo: only an admitted run decision into THIS team, under refuse, that made what it found", () => {
  const into = (extra = {}) => ({ team_slug: "alpha", decided_by_run_id: "123", ...extra });
  assert.equal(ownDecisionMadeTeamRepo(into(), { teamSlug: "alpha", policy: "refuse" }), true);
  assert.equal(ownDecisionMadeTeamRepo(into(), { teamSlug: "ALPHA", policy: "refuse" }), true, "slugs compared without case");
  assert.equal(ownDecisionMadeTeamRepo(into(), { teamSlug: "beta", policy: "refuse" }), false, "a decision into another team asked about another name");
  assert.equal(ownDecisionMadeTeamRepo(into(), { teamSlug: "alpha", policy: "reuse" }), false, "under reuse it asked nothing");
  assert.equal(ownDecisionMadeTeamRepo(into({ decided_by_run_id: "0" }), { teamSlug: "alpha", policy: "refuse" }), false, "a lecturer's record asked GitHub nothing");
  assert.equal(ownDecisionMadeTeamRepo(into({ reused_existing_repo: true }), { teamSlug: "alpha", policy: "refuse" }), false, "it reused what was there");
  assert.equal(ownDecisionMadeTeamRepo(null, { teamSlug: "alpha", policy: "refuse" }), false);
  assert.equal(ownDecisionMadeTeamRepo(into(), { teamSlug: "", policy: "refuse" }), false);
});

test("retriedOwnRepo: the set-aside record of the attempt a Retry redoes, for a student and for a team", () => {
  const prior = (extra = {}) => ({ github_login: "ann", status: "failed", ...extra });
  assert.equal(retriedOwnRepo(prior(), { isGroup: false, policy: "refuse" }), true);
  assert.equal(retriedOwnRepo(prior({ decided_by_run_id: "0" }), { isGroup: false, policy: "refuse" }), false, "a lecturer's record asked nothing");
  assert.equal(retriedOwnRepo(prior({ reused_existing_repo: true }), { isGroup: false, policy: "refuse" }), false, "it reused what was there");
  assert.equal(retriedOwnRepo(null, { isGroup: false, policy: "refuse" }), false, "no record, no evidence");
  assert.equal(retriedOwnRepo("garbage", { isGroup: false, policy: "refuse" }), false, "an unreadable copy is not evidence");
  // A team: only a decision into this team, under refuse.
  assert.equal(retriedOwnRepo(prior({ team_slug: "alpha" }), { isGroup: true, teamSlug: "alpha", policy: "refuse" }), true);
  assert.equal(retriedOwnRepo(prior({ team_slug: "alpha" }), { isGroup: true, teamSlug: "beta", policy: "refuse" }), false);
  assert.equal(retriedOwnRepo(prior({ team_slug: "alpha" }), { isGroup: true, teamSlug: "alpha", policy: "reuse" }), false);
});
