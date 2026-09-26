// Who a starter sync's tracking issue is assigned to: lib/sync-issue.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { issueAssignees, loginsByRepo, MAX_ASSIGNEES, oneRecordPerRepo } from "../lib/sync-issue.mjs";

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

test("ONE RECORD PER REPOSITORY: a team is planned once, through its first member; no-repository rows are kept", () => {
  // Review 2026-09-26: the CLI planned each member of a team concurrently,
  // and each opened its own pull request in the one repository.
  const recs = [
    { login: "ann", repo: "Org/grp-a" }, { login: "ben", repo: "org/GRP-A" },
    { login: "cas", repo: "Org/solo" }, { login: "dee", repo: null }, { login: "eve", repo: null },
  ];
  assert.deepEqual(oneRecordPerRepo(recs, (r) => r.repo).map((r) => r.login), ["ann", "cas", "dee", "eve"]);
  assert.deepEqual(oneRecordPerRepo(null, (r) => r), []);
});

test("the CLI sync plans per repository, not per record", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../cli/src/commands/sync-starter.mjs", import.meta.url), "utf8");
  assert.match(src, /withConcurrency\(perRepo,/);
  assert.match(src, /oneRecordPerRepo\(records,/);
});

test("a record whose repository nobody else names still assigns its own login", () => {
  assert.deepEqual(issueAssignees({ login: "solo", repoName: "Org/x", byRepo: new Map() }), ["solo"]);
  assert.deepEqual(issueAssignees({ login: "", repoName: "Org/x", byRepo: new Map() }), []);
});
