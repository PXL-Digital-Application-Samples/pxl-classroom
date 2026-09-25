// Who a starter sync's tracking issue is assigned to: lib/sync-issue.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { issueAssignees, loginsByRepo, MAX_ASSIGNEES } from "../lib/sync-issue.mjs";

const rec = (login, repo) => ({ github_login: login, repo_name: repo });

test("an individual repository: its own student", () => {
  const byRepo = loginsByRepo([rec("alice", "Org/a-alice"), rec("bob", "Org/a-bob")]);
  assert.deepEqual(issueAssignees({ login: "alice", repoName: "Org/a-alice", byRepo }), ["alice"]);
});

test("a group repository: every member, the record's own first", () => {
  const byRepo = loginsByRepo([rec("ann", "Org/grp-t1"), rec("ben", "Org/grp-t1"), rec("cas", "Org/grp-t1"), rec("dan", "Org/grp-t2")]);
  assert.deepEqual(issueAssignees({ login: "ben", repoName: "Org/grp-t1", byRepo }), ["ben", "ann", "cas"]);
});

test("the repository name matches whatever its case, and a login appears once whatever its case", () => {
  const byRepo = loginsByRepo([rec("Ann", "Org/GRP-T1"), rec("ann", "org/grp-t1"), rec("Ben", "Org/grp-t1")]);
  assert.deepEqual(issueAssignees({ login: "ANN", repoName: "org/Grp-T1", byRepo }), ["ANN", "Ben"]);
});

test("unreadable or incomplete records are skipped - they decide who is told, never who is synced", () => {
  const byRepo = loginsByRepo([null, undefined, {}, rec("", "Org/r"), rec("x", ""), rec("ok", "Org/r")]);
  assert.deepEqual([...byRepo.entries()], [["org/r", ["ok"]]]);
  assert.deepEqual(loginsByRepo(undefined), new Map());
});

test("never more than GitHub's ten", () => {
  const members = Array.from({ length: 14 }, (_, i) => rec(`m${i}`, "Org/big"));
  const out = issueAssignees({ login: "m13", repoName: "Org/big", byRepo: loginsByRepo(members) });
  assert.equal(MAX_ASSIGNEES, 10);
  assert.equal(out.length, 10);
  assert.equal(out[0], "m13", "the record's own student is never the one cut");
});

test("a record whose repository nobody else names still assigns its own login", () => {
  assert.deepEqual(issueAssignees({ login: "solo", repoName: "Org/x", byRepo: new Map() }), ["solo"]);
  assert.deepEqual(issueAssignees({ login: "", repoName: "Org/x", byRepo: new Map() }), []);
});
