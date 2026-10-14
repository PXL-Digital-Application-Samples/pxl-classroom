// What a Teams-tab write was decided from, asked again of the commit it lands
// on - lib/team-write-guard.mjs, and the rename's own (lib/team-rename.mjs).
//
// 2026-10-14 review: "Undo copy", a member save and a move re-applied files
// decided from what the page had read, over a join or an acceptance that had
// landed since. The rename's check was written inline in the component and
// never ran under a test. Each refusal is driven here over a map standing in
// for the contents API at one commit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { changedSinceRead, seedRefusalAt, unseedRefusalAt } from "../lib/team-write-guard.mjs";
import { membersWithRecords, planTeamRename, renameRefusalAt } from "../lib/team-rename.mjs";
import { repositoryNameFor } from "../lib/repo-name.mjs";

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const decode = (s) => Buffer.from(s, "base64").toString("utf8");
const file = (obj) => ({ content: b64(typeof obj === "string" ? obj : JSON.stringify(obj)) });
const dir = (...names) => names.map((name) => ({ name, type: "file" }));
// A reader at one commit: a 404 is null, anything listed is returned.
const at = (map) => async (path) => (path in map ? map[path] : null);

const seeded = (slug, members, over = {}) => ({
  schema_version: 1, assignment_id: "pe", team_slug: slug, team_name: slug.toUpperCase(), members,
  max_members: 3, created_at: "2026-10-12T10:00:00Z", created_by: "lecturer",
  seeded_from: { source: "assignment", assignment_id: "g", seeded_at: "2026-10-12T09:00:00Z" }, ...over,
});

test("changedSinceRead: the first file that is not the text it was read as, an absent one included", async () => {
  const get = at({ "teams/pe/a.json": file("A\n"), "teams/pe/b.json": file("B2\n") });
  assert.equal(await changedSinceRead({ get, decode, files: [{ path: "teams/pe/a.json", text: "A\n" }] }), null);
  assert.equal(await changedSinceRead({ get, decode, files: [{ path: "teams/pe/a.json", text: "A\n" }, { path: "teams/pe/b.json", text: "B\n" }] }), "teams/pe/b.json");
  assert.equal(await changedSinceRead({ get, decode, files: [{ path: "teams/pe/c.json", text: null }] }), null, "absent and still absent");
  assert.equal(await changedSinceRead({ get, decode, files: [{ path: "teams/pe/a.json", text: null }] }), "teams/pe/a.json", "made since");
});

test("a read that fails refuses the write rather than passing it", async () => {
  const get = async () => { throw Object.assign(new Error("boom"), { status: 502 }); };
  await assert.rejects(changedSinceRead({ get, decode, files: [{ path: "x", text: "y" }] }), /boom/);
});

test("unseedRefusalAt: every team still the seeded team the page saw, and nobody in them with a record", async () => {
  const a = seeded("alpha", ["ann", "bob"]);
  const b = seeded("beta", ["cleo"]);
  const base = { "teams/pe/alpha.json": file(a), "teams/pe/beta.json": file(b) };
  assert.equal(await unseedRefusalAt({ get: at(base), decode, assignmentId: "pe", teams: [a, b] }), null);

  // Bob accepted since the page loaded: his acceptance names alpha.
  assert.match(await unseedRefusalAt({ get: at({ ...base, "acceptances/pe": dir("Bob.json") }), decode, assignmentId: "pe", teams: [a, b] }), /bob accepted since this page loaded/);
  assert.match(await unseedRefusalAt({ get: at({ ...base, "repositories/pe": dir("cleo.json") }), decode, assignmentId: "pe", teams: [a, b] }), /cleo accepted/);
  // The team changed: a member joined, a repository recorded, or it is gone.
  assert.match(await unseedRefusalAt({ get: at({ ...base, "teams/pe/alpha.json": file({ ...a, members: ["ann", "bob", "dan"] }) }), decode, assignmentId: "pe", teams: [a] }), /ALPHA changed since/);
  assert.match(await unseedRefusalAt({ get: at({ ...base, "teams/pe/alpha.json": file({ ...a, repo_name: "Org/grp-alpha" }) }), decode, assignmentId: "pe", teams: [a] }), /changed since/);
  assert.match(await unseedRefusalAt({ get: at({}), decode, assignmentId: "pe", teams: [a] }), /no longer there/);
  // Members compared as GitHub does: case-blind.
  assert.equal(await unseedRefusalAt({ get: at({ "teams/pe/alpha.json": file({ ...a, members: ["ANN", "Bob"] }) }), decode, assignmentId: "pe", teams: [a] }), null);
});

test("S4: seedRefusalAt - every file it writes still free, and no seeded student in another team since", async () => {
  const a = seeded("alpha", ["ann", "bob"]);
  const other = { team_slug: "gamma", team_name: "Gamma", members: ["Bob"] };
  // Nothing there yet: the write goes ahead.
  assert.equal(await seedRefusalAt({ get: at({ "teams/pe": dir() }), decode, assignmentId: "pe", teams: [a] }), null);
  // A team nobody is in (the kind planSeed overwrites) is still free.
  assert.equal(await seedRefusalAt({ get: at({ "teams/pe/alpha.json": file({ ...a, members: [] }) }), decode, assignmentId: "pe", teams: [a] }), null);
  // A student made it, or it kept a repository, while the plan waited.
  assert.match(await seedRefusalAt({ get: at({ "teams/pe/alpha.json": file({ ...a, members: ["zed"] }) }), decode, assignmentId: "pe", teams: [a] }), /ALPHA was made or joined since/);
  assert.match(await seedRefusalAt({ get: at({ "teams/pe/alpha.json": file({ ...a, members: [], vacant: true, repo_name: "Org/grp-alpha" }) }), decode, assignmentId: "pe", teams: [a] }), /was made or joined since/);
  // Bob joined another team meanwhile: he would be listed in two.
  assert.match(
    await seedRefusalAt({ get: at({ "teams/pe": dir("gamma.json"), "teams/pe/gamma.json": file(other) }), decode, assignmentId: "pe", teams: [a] }),
    /Bob joined Gamma since the plan was made/,
  );
  // An unreadable file refuses rather than passing.
  assert.match(await seedRefusalAt({ get: at({ "teams/pe/alpha.json": { content: b64("{not json") } }), decode, assignmentId: "pe", teams: [a] }), /could not be read/);
});

test("S3/S4: the CLI's seed and unseed ask the same guards as the Teams tab, after planning again", () => {
  const cli = readFileSync(new URL("../cli/src/commands/teams.mjs", import.meta.url), "utf8");
  assert.match(cli, /precondition: \(\{ request, parentSha \}\) => seedRefusalAt\(/);
  assert.match(cli, /precondition: \(\{ request, parentSha \}\) => unseedRefusalAt\(/);
  assert.match(cli, /seedSignature\(freshPlan\) !== seedSignature\(plan\)/, "planned again after the prompt");
  const modal = readFileSync(new URL("../frontend/src/components/SeedTeamsModal.vue", import.meta.url), "utf8");
  assert.match(modal, /seedRefusalAt\(\{/);
  assert.doesNotMatch(modal, /function planSignature/, "one signature, in lib/seed-teams.mjs");
});

test("renameRefusalAt: the file as read, no team at the new name, no member with a record", async () => {
  const t = seeded("krusty", ["ann"]);
  const text = JSON.stringify(t, null, 2) + "\n";
  const args = (map, over = {}) => ({ get: at(map), decode, assignmentId: "pe", storedSlug: "krusty", storedText: text, newSlug: "krusty-krabs", members: ["ann"], ...over });
  const base = { "teams/pe/krusty.json": file(text) };
  assert.equal(await renameRefusalAt(args(base)), null);
  assert.match(await renameRefusalAt(args({ "teams/pe/krusty.json": file(text.replace("ann", "ann2")) })), /changed while you renamed it/);
  assert.match(await renameRefusalAt(args({ ...base, "teams/pe/krusty-krabs.json": file({}) })), /krusty-krabs was made meanwhile/);
  assert.match(await renameRefusalAt(args({ ...base, "acceptances/pe": dir("ANN.json", "zed.json") })), /a member accepted meanwhile/);
  assert.equal(await renameRefusalAt(args({ ...base, "acceptances/pe": dir("zed.json") })), null, "somebody else's record");
  // Directories, not only files, can be listed there: a subdirectory is no record.
  assert.equal(await renameRefusalAt(args({ ...base, "repositories/pe": [{ name: "ann.json", type: "dir" }] })), null);
});

test("membersWithRecords is ONE answer: the page's listing (type: file) and the contents API's alike", () => {
  assert.deepEqual(membersWithRecords(dir("Ann.json", "readme.md"), ["ann", "bob"]), ["ann"]);
  assert.deepEqual(membersWithRecords([{ name: "bob.json" }], ["ann", "bob"]), ["bob"], "an entry with no type is a file");
  assert.deepEqual(membersWithRecords(null, ["ann"]), []);
});

test("a rename may not take a slug another team had before ITS rename", () => {
  const t = seeded("krusty", []);
  const plan = planTeamRename({ team: t, newName: "Pod", assignmentId: "pe", otherSlugs: ["bravo"], reservedSlugs: ["pod"], accepted: () => false });
  assert.equal(plan.ok, false);
  assert.match(plan.reason, /was called that until it was renamed/);
  // ...but its own old name is its to take back.
  const own = planTeamRename({ team: { ...t, renamed_from: ["pod"] }, newName: "Pod", assignmentId: "pe", reservedSlugs: [], accepted: () => false });
  assert.equal(own.ok, true);
});

test("repositoryNameFor: acceptance's rule, for a team and for a student", () => {
  assert.equal(repositoryNameFor("grp-{team_slug}", { teamSlug: "alpha", login: "ann" }), "grp-alpha");
  assert.equal(repositoryNameFor("lab-{github_login}", { login: "ann" }), "lab-ann");
  assert.equal(repositoryNameFor("{team_slug}-by-{github_login}", { teamSlug: "alpha", login: "ann" }), "alpha-by-ann");
  assert.equal(repositoryNameFor("", { teamSlug: "alpha", login: "ann" }), "alpha", "no pattern: the bare slug, as acceptance has always made it");
  assert.equal(repositoryNameFor(null, { login: "ann" }), "ann");
});
