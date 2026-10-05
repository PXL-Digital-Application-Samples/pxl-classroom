// The Teams tab's rows come from the team files; the report only adds the work.
// frontend/src/lib/team-rows.js says why: the report is rebuilt by a workflow,
// so trusting it for membership showed the old team for a minute after every
// save, move and delete (testbed, 2026-10-04).

import { test } from "node:test";
import assert from "node:assert/strict";
import { teamRows } from "../frontend/src/lib/team-rows.js";

const reported = (slug, members, extra = {}) => ({
  team_slug: slug, team_name: slug.toUpperCase(), members,
  repo_name: `org/demo-${slug}`, repo_url: `https://github.com/org/demo-${slug}`,
  submission_status: "on-time", commit_count: 4, under_capacity: false, warnings: [], ...extra,
});
const file = (slug, members, extra = {}) => ({ slug, doc: { team_slug: slug, team_name: `Team ${slug}`, members, ...extra } });

test("the file decides who is in the team; the report keeps the work", () => {
  const rows = teamRows(
    [reported("alpha", ["ann", "bram"])],
    { listed: true, files: [file("alpha", ["ann"])] },
    { minTeamSize: 2 },
  );
  assert.deepEqual(rows[0].members, ["ann"]);
  assert.equal(rows[0].team_name, "Team alpha");
  assert.equal(rows[0].commit_count, 4, "commits come from the report");
  assert.equal(rows[0].repo_url, "https://github.com/org/demo-alpha");
  assert.equal(rows[0].under_capacity, true, "recomputed from the file's members, not the report's");
  assert.deepEqual(rows[0].warnings, ["under-capacity"]);
});

test("a team whose file is gone disappears at once - when the listing was read", () => {
  const rows = teamRows(
    [reported("alpha", ["ann"]), reported("echo", [])],
    { listed: true, files: [file("alpha", ["ann"])] },
  );
  assert.deepEqual(rows.map((r) => r.team_slug), ["alpha"]);
});

test("a listing that could not be read changes nothing", () => {
  const before = [reported("alpha", ["ann"]), reported("echo", [])];
  assert.deepEqual(teamRows(before, { listed: false, files: [] }), before);
});

test("a file that could not be read keeps its report row as it was", () => {
  const rows = teamRows(
    [reported("alpha", ["ann", "bram"])],
    { listed: true, files: [{ slug: "alpha", doc: null }] },
  );
  assert.deepEqual(rows[0].members, ["ann", "bram"]);
});

test("a team the report has not seen yet is a row now, with no work to show", () => {
  const rows = teamRows([], { listed: true, files: [file("delta", ["gilles"], { repo_name: null })] }, { minTeamSize: 2 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].submission_status, "no-submission");
  assert.equal(rows[0].commit_count, null);
  assert.equal(rows[0].repo_url, null);
  assert.equal(rows[0].under_capacity, true);
});

test("an emptied team is still a row (its members all left), and other warnings survive", () => {
  const rows = teamRows(
    [reported("bravo", ["chloe"], { warnings: ["missing-repo-id"] })],
    { listed: true, files: [file("bravo", [], { vacant: true })] },
    { minTeamSize: 2 },
  );
  assert.deepEqual(rows[0].members, []);
  assert.deepEqual(rows[0].warnings, ["missing-repo-id", "under-capacity"]);
});

test("slugs match case-insensitively and rows come out sorted", () => {
  const rows = teamRows(
    [reported("Charlie", ["dries"])],
    { listed: true, files: [file("delta", ["gilles"]), file("charlie", ["dries", "emma"])] },
  );
  assert.deepEqual(rows.map((r) => r.team_slug), ["charlie", "delta"]);
  assert.equal(rows[0].commit_count, 4, "the report row was found despite the case");
});
