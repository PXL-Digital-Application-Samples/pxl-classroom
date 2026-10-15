// lib/untouched-repo.mjs - whether a team's repository holds anything a person
// pushed, asked when a student switches out of a team and leaves it empty
// (2026-10-08: a typo team stayed listed, name taken, until a lecturer deleted
// it by hand). Untouched is decided by what GitHub vouches for, never a name.

import { test } from "node:test";
import assert from "node:assert/strict";

import { logReachesCreation, personPushed, repoTouched } from "../lib/untouched-repo.mjs";

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

const CREATED = "2026-10-15T02:29:45Z";
const BOT = "pxl-classroom-provisioner[bot]";
/** The App filling the repository, four seconds after creation, as measured live. */
const filled = (minutes = 0) => ({ actor: { login: BOT }, activity_type: "branch_creation", timestamp: new Date(Date.parse(CREATED) + 4_000 + minutes * 60_000).toISOString() });
const pushBy = (login, minutes) => ({ actor: { login }, activity_type: "push", timestamp: new Date(Date.parse(CREATED) + minutes * 60_000).toISOString() });

// `activity`: the push log's entries, or null for a log that could not be read.
// `githubCopy`: GitHub generated it (`template_repository`); false is a copy
// PXL Classroom pushed, the template's whole history.
function fake({ branches = [{ name: "main" }], commits = [generated], branchesStatus = 200, commitsStatus = 200, activity = null, githubCopy = true } = {}) {
  const asked = [];
  const get = async (path) => {
    asked.push(path);
    if (path.includes("/branches")) return { status: branchesStatus, ok: branchesStatus < 300, data: branchesStatus < 300 ? branches : { message: "x" } };
    if (path.includes("/commits")) return { status: commitsStatus, ok: commitsStatus < 300, data: commitsStatus < 300 ? commits : { message: "x" } };
    if (path.includes("/activity") && activity) return { status: 200, ok: true, data: activity };
    if (/^\/repos\/[^/]+\/[^/]+$/.test(path)) return { status: 200, ok: true, data: { created_at: CREATED, ...(githubCopy ? { template_repository: { full_name: "o/tpl" } } : {}) } };
    return { status: 400, ok: false, data: null };
  };
  return { get, asked };
}
/** As provisioning and acceptance ask it: with PXL Classroom's own login. */
const touched = (f, name = "o/t") => repoTouched(f.get, name, { appLogin: BOT });

test("only the commit GitHub generated: untouched", async () => {
  const { get, asked } = fake();
  assert.equal(await repoTouched(get, "o/team-a", { appLogin: BOT }), "untouched");
  assert.deepEqual(asked, ["/repos/o/team-a/branches?per_page=2", "/repos/o/team-a/activity?per_page=100", "/repos/o/team-a/commits?per_page=21"]);
});

// A copy of the template's whole history (template_full_history): prepared
// branches, and the template's commits by the lecturer, from the first second.
const lecturerCommit = { ...student, sha: "1ec1ec1", author: { login: "tomcoolpxl" }, committer: { login: "tomcoolpxl" } };
const fullHistory = { branches: [{ name: "main" }, { name: "feature-x" }], commits: [lecturerCommit, { ...lecturerCommit, parents: [] }], githubCopy: false };

test("TV-5: a full-history copy nobody but PXL Classroom pushed to is untouched, by its push log - it was kept for ever", async () => {
  // Measured live 2026-10-15: such a copy's log is the App's branch
  // creations alone, from four seconds after creation; a student's push is
  // in it under their login.
  assert.equal(await touched(fake({ ...fullHistory, activity: [filled(), filled(), filled()] })), "untouched");
  assert.equal(await touched(fake({ ...fullHistory, activity: [pushBy("ann", 60), filled()] })), "touched", "a person in the log is their work");
  // A log that says nothing is not "nobody": the commits decide, and keep it.
  assert.equal(await touched(fake({ ...fullHistory, activity: null })), "touched");
  assert.equal(await touched(fake({ ...fullHistory, activity: [] })), "touched", "an empty log is not nobody");
  // And on GitHub's copy the log wins over commits that look generated.
  assert.equal(await touched(fake({ activity: [pushBy("ann", 1), filled()] })), "touched");
});

test("ONLY THIS APP is nobody: no actor (a deploy key), another bot, or an agent's push is work (review 2026-10-15)", async () => {
  const noActor = { activity_type: "push", actor: null, timestamp: filled(30).timestamp };
  const workflowBot = { ...pushBy("github-actions[bot]", 30) };
  const agent = { ...pushBy("copilot-swe-agent[bot]", 30), activity_type: "branch_creation" };
  for (const [label, entry] of [["no actor", noActor], ["github-actions", workflowBot], ["an agent", agent]]) {
    assert.equal(await touched(fake({ ...fullHistory, activity: [entry, filled()] })), "touched", `full history, ${label}`);
    // On GitHub's copy too, even where the commits alone would say untouched.
    assert.equal(await touched(fake({ commits: [botAdded, generated], activity: [entry, filled()] })), "touched", `GitHub's copy, ${label}`);
  }
  // Without knowing which App is ours, a log of bots decides nothing: the commits do.
  assert.equal(await repoTouched(fake({ ...fullHistory, activity: [filled()] }).get, "o/t"), "touched");
});

test("GITHUB'S COPY is decided by its commits: an App-only log does not override a student's commit", async () => {
  // The first version returned untouched from the log alone, before the
  // commits, which deleted on less evidence than before (review 2026-10-15).
  assert.equal(await touched(fake({ commits: [student, generated], activity: [filled()] })), "touched");
  assert.equal(await touched(fake({ branches: [{ name: "main" }, { name: "wip" }], activity: [filled()] })), "touched", "a second branch still counts");
  assert.equal(await touched(fake({ commits: [botAdded, generated], activity: [filled()] })), "untouched");
});

test("the App alone is nobody only when the log reaches back to the creation - a push can have fallen off its start", async () => {
  // GitHub does not say how long it keeps the log. Months in, a student's
  // push may be gone from it while a later App push (a starter sync) is not.
  const laterSync = { ...filled(60 * 24 * 90), activity_type: "push" };
  assert.equal(await touched(fake({ ...fullHistory, activity: [laterSync] })), "touched", "kept: the commits still see work");
  // A GitHub copy in that state: the student's commit is under the sync.
  assert.equal(await touched(fake({ commits: [botAdded, student, generated], activity: [laterSync] })), "touched");
  // The oldest entry a branch the App made, but long after creation: not the filling.
  assert.equal(await touched(fake({ ...fullHistory, activity: [filled(60)] })), "touched");
});

test("logReachesCreation: the App's branch creation within minutes of created_at, and nothing else", () => {
  assert.equal(logReachesCreation([filled(), filled(2)], CREATED), true);
  assert.equal(logReachesCreation([filled(14)], CREATED), true, "a full-history push can take minutes");
  assert.equal(logReachesCreation([filled(16)], CREATED), false);
  assert.equal(logReachesCreation([pushBy(BOT, 0.1)], CREATED), false, "a push is not the filling");
  assert.equal(logReachesCreation([{ ...filled(), actor: { login: "ann" } }], CREATED), false);
  assert.equal(logReachesCreation([], CREATED), false);
  assert.equal(logReachesCreation([filled()], undefined), false);
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
  // head the template's own commit by the lecturer - when the log reaches back
  // to the creation.
  const lecturerHead = { ...student, author: { login: "lecturer" } };
  const fromCreation = { ok: true, status: 200, data: [filled(), filled(1)] };
  assert.equal(personPushed(fromCreation, lecturerHead, { createdAt: CREATED }), false);
  // Without the creation, a log of bots says nothing (a student's pushes can
  // have fallen off its start): the head decides, and here it cannot.
  assert.equal(personPushed(fromCreation, lecturerHead), null);
  // An entry with no actor is a person (a deploy key).
  assert.equal(personPushed({ ok: true, status: 200, data: [{ actor: null, activity_type: "push" }, filled()] }, generated), true);
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

// PG7, that both student pages ask it, is run rather than grepped (TS-12):
// tests/e2e/11 (the student page) and tests/e2e/16 (the team card), where only
// the App pushed reads "No commits pushed" and a person's push does not.

test("a read that failed is unknown - never untouched, so nothing is deleted on it", async () => {
  assert.equal(await repoTouched(fake({ branchesStatus: 403 }).get, "o/t"), "unknown");
  assert.equal(await repoTouched(fake({ branchesStatus: 400 }).get, "o/t"), "unknown");
  assert.equal(await repoTouched(fake({ commitsStatus: 502 }).get, "o/t"), "unknown");
  assert.equal(await repoTouched(fake({ commits: [] }).get, "o/t"), "unknown");
});
