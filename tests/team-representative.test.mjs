import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { teamRepresentative } from "../lib/team-representative.mjs";

const team = { members: ["aaron", "Zoe"], repo_name: "Org/lab-red" };
const aaron = { github_login: "aaron", repo_name: null, submission_status: "no-submission" };
const zoe = { github_login: "zoe", repo_name: "Org/lab-red", submission_status: "on-time", commit_count: 4 };

test("the team speaks through a member ON its repository, not the alphabetically first", () => {
  // A seeded team: aaron never accepted, so his row has no repository. Taking
  // `memberStudents[0]` read the team as "No submission" while zoe had pushed.
  assert.equal(teamRepresentative(team, [aaron, zoe]), zoe);
});

test("a member whose row names ANOTHER repository does not speak for this one", () => {
  const stale = { github_login: "aaron", repo_name: "Org/lab-blue", submission_status: "on-time" };
  assert.equal(teamRepresentative(team, [stale, zoe]), zoe);
  assert.equal(teamRepresentative(team, [stale]), null, "nobody on it is nobody, never somebody else's numbers");
});

test("bare and full names, and login case, are the same thing", () => {
  assert.equal(teamRepresentative({ members: ["ZOE"], repo_name: "lab-red" }, [zoe]), zoe);
});

test("no repository on the manifest yet: any member who has one", () => {
  assert.equal(teamRepresentative({ members: ["aaron", "zoe"] }, [aaron, zoe]), zoe);
  assert.equal(teamRepresentative({ members: ["aaron"] }, [aaron]), null);
  assert.equal(teamRepresentative(null, [zoe]), null);
});

test("report.mjs and the live refresh both ask it, and neither takes [0] any more", () => {
  for (const file of ["report/report.mjs", "frontend/src/views/AssignmentDetailView.vue"]) {
    const src = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    assert.match(src, /teamRepresentative\(/, `${file} must ask the one judge`);
    assert.doesNotMatch(src, /memberStudents\[0\]/, `${file} still reads the first member`);
  }
});
