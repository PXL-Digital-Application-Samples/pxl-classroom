// lib/team-candidates.mjs: the students a lecturer may put in a team.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { teamCandidates } from "../lib/team-candidates.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const roster = [
  { student_number: "1", full_name: "Ann Peeters", github_login: "ann", class_group: "3A" },
  { student_number: "2", full_name: "Bob Maes", github_login: "bob", class_group: "3A" },
  { student_number: "3", full_name: "Kim Lenaerts", github_login: "kim", class_group: "2B" },
  { student_number: "4", full_name: "Old Student", github_login: "old", class_group: "2024" },
  { student_number: "5", full_name: "No Login Yet", email: "no.login@student.pxl.be" },
];
const logins = (rows) => rows.map((r) => r.github_login).sort();

test("only the students this assignment admits, never the whole roster", () => {
  const assignment = { roster_mode: "enforced", cohort: ["num:1", "num:2"] };
  const { all } = teamCandidates({ assignment, roster });
  assert.deepEqual(logins(all), ["ann", "bob"], "another section and a previous year are not offered");
});

test("an assignment that selects nobody admits the whole roster", () => {
  const { all } = teamCandidates({ assignment: { roster_mode: "claim" }, roster });
  assert.deepEqual(logins(all), ["ann", "bob", "kim", "old"]);
});

test("under open enrolment the roster is not the population - who accepted is", () => {
  const accepted = [
    { github_login: "zed", acceptance_state: "provisioned" },
    { github_login: "ann", acceptance_state: "accepted", full_name: "Ann Peeters" },
  ];
  const { all } = teamCandidates({ assignment: { roster_mode: "open" }, roster, accepted });
  assert.deepEqual(logins(all), ["ann", "zed"]);
});

test("whoever accepted is a candidate, and a row with no acceptance is not", () => {
  const assignment = { roster_mode: "enforced", cohort: ["num:1"] };
  const accepted = [
    { github_login: "late-joiner", acceptance_state: "provisioned" },
    { github_login: "kim", acceptance_state: "not-accepted" },
  ];
  assert.deepEqual(logins(teamCandidates({ assignment, roster, accepted }).all), ["ann", "late-joiner"]);
});

test("a row without a GitHub login cannot be placed in a team, and members are not offered again", () => {
  const assignment = { roster_mode: "enforced" };
  const { unassigned } = teamCandidates({ assignment, roster, teams: [{ members: ["ANN"] }, { members: ["bob"] }] });
  assert.deepEqual(logins(unassigned), ["kim", "old"]);
});

test("a cohort row with no login is not dropped: it waits, named, until a login exists", () => {
  const { all, waiting } = teamCandidates({ assignment: { roster_mode: "claim" }, roster });
  assert.ok(!logins(all).includes(undefined));
  assert.deepEqual(waiting, [{ full_name: "No Login Yet", student_number: "5", email: "no.login@student.pxl.be" }]);
});

test("a row a claim has bound is placeable under the claimed login", () => {
  const loginFor = (row) => (row.email === "no.login@student.pxl.be" ? "nolo-gh" : null);
  const { unassigned, waiting } = teamCandidates({ assignment: { roster_mode: "claim" }, roster, loginFor });
  assert.ok(logins(unassigned).includes("nolo-gh"));
  assert.deepEqual(waiting, []);
});

test("a row's own login wins over whatever a claim says", () => {
  const loginFor = () => "someone-else";
  const { all } = teamCandidates({ assignment: { roster_mode: "enforced", cohort: ["num:1"] }, roster, loginFor });
  assert.deepEqual(logins(all), ["ann"]);
});

test("under open enrolment nobody waits: the roster is not the population", () => {
  assert.deepEqual(teamCandidates({ assignment: { roster_mode: "open" }, roster }).waiting, []);
});

test("one login is one candidate, whatever its case", () => {
  const { all } = teamCandidates({
    assignment: { roster_mode: "enforced", cohort: ["num:1"] },
    roster,
    accepted: [{ github_login: "Ann", acceptance_state: "provisioned" }],
  });
  assert.equal(all.length, 1);
  assert.equal(all[0].full_name, "Ann Peeters");
});

test("the Teams tab asks this function, not the roster", () => {
  const src = readFileSync(join(root, "frontend", "src", "components", "TeamsTable.vue"), "utf8");
  assert.match(src, /teamCandidates\(\{/);
  assert.doesNotMatch(src, /\(props\.roster \|\| \[\]\)\.filter\(/, "the pickers read the whole roster again");
  assert.doesNotMatch(src, /students? on the\s+roster have no team/);
});
