// lib/team-rename.mjs - renaming a team on the Teams tab, only while nobody in
// it has accepted (2026-10-12: a copied team carried a wrong name, and the only
// fix was create, move every member, delete).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { planTeamRename, renameBlocker, teamSlug } from "../lib/team-rename.mjs";
import { validateAgainst } from "../lib/validate.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const nobody = () => false;
const team = {
  schema_version: 1, assignment_id: "pe", team_slug: "3tina-krusty-krabs", team_name: "3TINA_Krusty_Krabs",
  members: ["Gert-JanBollenPXL", "filipbelienpxl"], max_members: 3, created_at: "2026-10-12T10:00:00Z", created_by: "lecturer",
  seeded_from: { source: "assignment", assignment_id: "groepsindeling", seeded_at: "2026-10-12T09:00:00Z" },
};

test("the slug is the rule acceptance applies to a typed name - read from accept.mjs, not copied", () => {
  const accept = readFileSync(join(root, "acceptance", "accept.mjs"), "utf8");
  const body = accept.slice(accept.indexOf("function slugify(value)"), accept.indexOf("function deriveRepoName"));
  assert.ok(body.includes(".toLowerCase()"), "accept.mjs's slugify was renamed; this guard would compare nothing");
  const acceptSlugify = new Function(`${body}; return slugify;`)();
  for (const name of ["3TINA_Krusty Krabs", "  Team -- A!! ", "Ñandú 3B", "already-a-slug"]) {
    assert.equal(teamSlug(name), acceptSlugify(name), name);
  }
});

test("before anyone accepted: name and slug change in one commit - new file written, old one removed", async () => {
  const plan = planTeamRename({ team, newName: "3TINA Krusty Krabs 2", assignmentId: "pe", otherSlugs: ["3tina-pod-pirates"], accepted: nobody });
  assert.equal(plan.ok, true);
  assert.equal(plan.slug, "3tina-krusty-krabs-2");
  assert.deepEqual(plan.changes.map((c) => [c.path, c.content === null ? null : "doc"]), [
    ["teams/pe/3tina-krusty-krabs-2.json", "doc"],
    ["teams/pe/3tina-krusty-krabs.json", null],
  ]);
  assert.equal(plan.doc.team_name, "3TINA Krusty Krabs 2");
  assert.deepEqual(plan.doc.renamed_from, ["3tina-krusty-krabs"], "the old slug is kept: a page loaded before still names it");
  const again = planTeamRename({ team: plan.doc, newName: "3TINA Krusty Krabs", assignmentId: "pe", accepted: nobody });
  assert.deepEqual(again.doc.renamed_from, ["3tina-krusty-krabs-2"], "renamed back: the current slug is never its own old one");
  assert.deepEqual(plan.doc.members, team.members, "everything else is kept, seeded_from included");
  assert.deepEqual(plan.doc.seeded_from, team.seeded_from);
  const { valid, errors } = await validateAgainst("team", plan.doc);
  assert.ok(valid, JSON.stringify(errors));
});

test("a new spelling with the same slug rewrites the one file", () => {
  const plan = planTeamRename({ team, newName: "3TINA Krusty-Krabs", assignmentId: "pe", accepted: nobody });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.changes.map((c) => c.path), ["teams/pe/3tina-krusty-krabs.json"]);
});

test("once anyone accepted, or a repository exists, it is refused and says why", () => {
  const accepted = (m) => m === "filipbelienpxl";
  assert.match(renameBlocker(team, accepted), /@filipbelienpxl has accepted/);
  assert.equal(planTeamRename({ team, newName: "X", assignmentId: "pe", accepted }).ok, false);
  assert.match(renameBlocker({ ...team, repo_name: "Org/pe-3tina-krusty-krabs" }, nobody), /repository already exists/);
  assert.equal(renameBlocker(team, nobody), null);
});

test("a name another team has, an empty name, or no change is refused", () => {
  const plan = (newName) => planTeamRename({ team, newName, assignmentId: "pe", otherSlugs: ["3tina-pod-pirates"], accepted: nobody });
  assert.match(plan("3TINA_Pod-Pirates").reason, /another team in this assignment is already called that/);
  assert.match(plan("   ").reason, /empty/);
  assert.match(plan("!!!").reason, /letter or digit/);
  assert.match(plan("3TINA_Krusty_Krabs").reason, /already its name/);
});
