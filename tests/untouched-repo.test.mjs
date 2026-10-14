// lib/untouched-repo.mjs - whether a team's repository holds anything a person
// pushed, asked when a student switches out of a team and leaves it empty
// (2026-10-08: a typo team stayed listed, name taken, until a lecturer deleted
// it by hand). Untouched is decided by what GitHub vouches for, never a name.

import { test } from "node:test";
import assert from "node:assert/strict";

import { readFileSync } from "node:fs";
import { personPushed, repoTouched } from "../lib/untouched-repo.mjs";

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

// --- personPushed: what the student pages say (review 2026-10-14, PG7) -------

const log = (...actors) => ({ ok: true, status: 200, data: actors.map((login) => ({ actor: { login }, activity_type: "push" })) });

test("PG7: a person in the push log has pushed; only PXL Classroom's App has not", () => {
  assert.equal(personPushed(log("pxl-classroom-provisioner[bot]", "TomVerheyenPXL"), botAdded), true);
  // A full-history copy and its grading workflow: the App's pushes alone, the
  // head the template's own commit by the lecturer.
  assert.equal(personPushed(log("pxl-classroom-provisioner[bot]", "pxl-classroom-provisioner[bot]"), { ...student, author: { login: "lecturer" } }), false);
});

test("PG7: an empty log says nothing, unless the head is still the commit GitHub generated", () => {
  // GitHub does not say how long the log is kept: empty is not "nobody".
  assert.equal(personPushed(log(), student), null);
  assert.equal(personPushed(log(), generated), false);
  assert.equal(personPushed({ ok: false, status: 403, data: {} }, generated), false, "the head alone decides when the log is unread");
  assert.equal(personPushed({ ok: false, status: 403, data: {} }, student), null);
  // A full page of bots may hold more.
  assert.equal(personPushed(log(...Array(100).fill("x[bot]")), student), null);
});

test("PG7: both student pages ask it, beside the newest commit", () => {
  for (const f of ["../frontend/src/views/AssignmentView.vue", "../frontend/src/components/GroupAcceptanceCard.vue"]) {
    const src = readFileSync(new URL(f, import.meta.url), "utf8");
    assert.match(src, /personPushed\(log, res\.ok && Array\.isArray\(res\.data\) \? res\.data\[0\] : null\)/, f);
    assert.match(src, /Pushed\.value === false\) return 'no-submission'/, f);
  }
});

test("a read that failed is unknown - never untouched, so nothing is deleted on it", async () => {
  assert.equal(await repoTouched(fake({ branchesStatus: 403 }).get, "o/t"), "unknown");
  assert.equal(await repoTouched(fake({ branchesStatus: 400 }).get, "o/t"), "unknown");
  assert.equal(await repoTouched(fake({ commitsStatus: 502 }).get, "o/t"), "unknown");
  assert.equal(await repoTouched(fake({ commits: [] }).get, "o/t"), "unknown");
});
