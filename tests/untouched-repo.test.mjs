// lib/untouched-repo.mjs - whether a team's repository holds anything a person
// pushed, asked when a student switches out of a team and leaves it empty
// (2026-10-08: a typo team stayed listed, name taken, until a lecturer deleted
// it by hand). Untouched is decided by what GitHub vouches for, never a name.

import { test } from "node:test";
import assert from "node:assert/strict";

import { repoTouched } from "../lib/untouched-repo.mjs";

// The generated first commit, as measured on PXL-Systems-Expert's team
// repositories on 2026-10-08: no parent, the App's bot, committed by GitHub,
// verified.
const generated = {
  sha: "93acd0a",
  parents: [],
  author: { login: "pxl-classroom-provisioner[bot]" },
  committer: { login: "web-flow" },
  commit: { verification: { verified: true } },
};
const botAdded = {
  sha: "b0b0b0b",
  parents: [{ sha: "93acd0a" }],
  author: { login: "pxl-classroom-provisioner[bot]" },
  committer: { login: "pxl-classroom-provisioner[bot]" },
  commit: { verification: { verified: true } },
};
const student = {
  sha: "5717d3e",
  parents: [{ sha: "93acd0a" }],
  author: { login: "TomVerheyenPXL" },
  committer: { login: "TomVerheyenPXL" },
  commit: { verification: { verified: false } },
};
// A commit whose author EMAIL is the bot's: GitHub maps the login from the
// address, which anyone can type - and cannot sign it.
const spoofed = { ...student, author: { login: "pxl-classroom-provisioner[bot]" } };

function fake({ branches = [{ name: "main" }], commits = [generated], branchesStatus = 200, commitsStatus = 200 } = {}) {
  const asked = [];
  const get = async (path) => {
    asked.push(path);
    if (path.includes("/branches")) return { status: branchesStatus, ok: branchesStatus < 300, data: branchesStatus < 300 ? branches : { message: "x" } };
    if (path.includes("/commits")) return { status: commitsStatus, ok: commitsStatus < 300, data: commitsStatus < 300 ? commits : { message: "x" } };
    return { status: 400, ok: false, data: null };
  };
  return { get, asked };
}

test("only the commit GitHub generated: untouched", async () => {
  const { get, asked } = fake();
  assert.equal(await repoTouched(get, "o/team-a"), "untouched");
  assert.deepEqual(asked, ["/repos/o/team-a/branches?per_page=2", "/repos/o/team-a/commits?per_page=21"]);
});

test("PXL Classroom's own verified commits on top (the grading workflow, a sync): still untouched", async () => {
  assert.equal(await repoTouched(fake({ commits: [botAdded, generated] }).get, "o/t"), "untouched");
});

test("anything a person pushed is their work", async () => {
  assert.equal(await repoTouched(fake({ commits: [student, generated] }).get, "o/t"), "touched");
  assert.equal(await repoTouched(fake({ commits: [spoofed, generated] }).get, "o/t"), "touched", "a bot's name on an unverified commit is not the bot");
  assert.equal(await repoTouched(fake({ commits: [{ ...student, parents: [] }] }).get, "o/t"), "touched", "a root a student made (git init, force-push)");
  assert.equal(await repoTouched(fake({ branches: [{ name: "main" }, { name: "wip" }] }).get, "o/t"), "touched", "a second branch");
  const many = [...Array.from({ length: 21 }, () => botAdded), generated];
  assert.equal(await repoTouched(fake({ commits: many }).get, "o/t"), "touched", "past the cap, whoever made them");
});

test("no repository, or an empty one, has nothing in it", async () => {
  assert.equal(await repoTouched(fake({ branchesStatus: 404 }).get, "o/t"), "absent");
  assert.equal(await repoTouched(fake({ branches: [] }).get, "o/t"), "untouched");
  assert.equal(await repoTouched(fake({ commitsStatus: 409 }).get, "o/t"), "untouched");
});

test("a read that failed is unknown - never untouched, so nothing is deleted on it", async () => {
  assert.equal(await repoTouched(fake({ branchesStatus: 403 }).get, "o/t"), "unknown");
  assert.equal(await repoTouched(fake({ branchesStatus: 400 }).get, "o/t"), "unknown");
  assert.equal(await repoTouched(fake({ commitsStatus: 502 }).get, "o/t"), "unknown");
  assert.equal(await repoTouched(fake({ commits: [] }).get, "o/t"), "unknown");
});
