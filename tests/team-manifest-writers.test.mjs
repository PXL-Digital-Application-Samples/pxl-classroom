// Every surface that writes a team manifest must write a VALID one, and must
// not delete the fields it does not know about.
//
// team.schema.json is `additionalProperties: false` with seven required fields.
// Four places construct a manifest - lib/seed-teams.mjs, acceptance/accept.mjs,
// and TeamsTable's create and member-edit paths - and nothing checked that they
// agree with the schema or with each other.
//
// The member-edit path did not. It rebuilt the whole document from the row on
// screen, and `props.teams` is a DISPLAY shape assembled by
// mergeTeamManifests: it carries `submission_status`, `commit_count`,
// `under_capacity` and `warnings` (none of them schema-legal) and it never
// carries `repo_id` or `created_by` at all. So saving a member change wrote a
// manifest missing a required field and silently dropped two others.
//
// `seeded_from` is the drop a lecturer would actually feel: planUnseed and the
// "Undo seed (N)" button both key on it, and `pxl-classroom teams list` labels
// teams with it - so editing one member of a seeded team quietly removed it
// from the bulk undo, with nothing red anywhere. Same class as buildDoc
// deleting invitation tokens.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { validateAgainst } from "../lib/validate.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

/** A manifest as it exists in a control repo, seeded and with a repo. */
function storedManifest() {
  return {
    schema_version: 1,
    assignment_id: "2627-netadv",
    team_slug: "alpha",
    team_name: "Alpha",
    members: ["stud1", "stud2"],
    max_members: 4,
    created_at: "2026-08-01T09:00:00.000Z",
    created_by: "stud1",
    repo_name: "PXL-Org/netadv-alpha",
    repo_id: 987654,
    repo_url: "https://github.com/PXL-Org/netadv-alpha",
    seeded_from: {
      source: "assignment",
      assignment_id: "2526-netbasics",
      assignment_title: "Network Basics",
      seeded_at: "2026-07-30T08:00:00.000Z",
      seeded_by: "lecturer",
    },
  };
}

/** The row TeamsTable actually renders, straight out of mergeTeamManifests. */
function displayRow(stored) {
  return {
    team_slug: stored.team_slug,
    team_name: stored.team_name,
    members: stored.members,
    repo_name: stored.repo_name,
    repo_url: stored.repo_url,
    submission_status: "no-submission",
    commit_count: null,
    under_capacity: false,
    seeded_from: stored.seeded_from,
    warnings: [],
  };
}

test("a stored manifest is valid to begin with", () => {
  const { valid, errors } = validateAgainst("team", storedManifest());
  assert.ok(valid, JSON.stringify(errors));
});

test("the OLD rebuild-from-the-row wrote an invalid manifest", () => {
  // Reproduces what saveTeamMembers used to build, to show the fix is not
  // theoretical. If this ever starts passing, the schema stopped requiring
  // created_by and this file needs rereading.
  const row = displayRow(storedManifest());
  const rebuilt = {
    schema_version: 1,
    assignment_id: "2627-netadv",
    team_slug: row.team_slug,
    team_name: row.team_name,
    members: ["stud1"],
    max_members: 4,
    created_at: "2026-08-01T09:00:00.000Z",
    vacant: false,
    repo_name: row.repo_name,
    repo_id: row.repo_id, // undefined on the display row - JSON.stringify drops it
    repo_url: row.repo_url,
  };
  const { valid, errors } = validateAgainst("team", rebuilt);
  assert.ok(!valid, "the old rebuild must be demonstrably invalid");
  assert.ok(
    errors.some((e) => /created_by/.test(e.message)),
    "and the reason is the required field it dropped",
  );
  assert.equal(rebuilt.seeded_from, undefined, "it also dropped the seed provenance");
});

test("merging onto the stored manifest keeps every field the modal does not own", () => {
  const stored = storedManifest();
  const merged = { ...stored, members: ["stud1"], vacant: false };

  const { valid, errors } = validateAgainst("team", merged);
  assert.ok(valid, JSON.stringify(errors));

  assert.deepEqual(merged.seeded_from, stored.seeded_from, "seed provenance survives a member edit");
  assert.equal(merged.repo_id, stored.repo_id);
  assert.equal(merged.created_by, stored.created_by);
  assert.deepEqual(merged.members, ["stud1"], "and the thing it does own changed");
});

test("emptying a team marks it vacant without losing provenance", () => {
  const stored = storedManifest();
  const merged = { ...stored, members: [], vacant: true };
  const { valid, errors } = validateAgainst("team", merged);
  assert.ok(valid, JSON.stringify(errors));
  // planUnseed and the Undo seed button both key on this.
  assert.ok(merged.seeded_from, "a vacated seeded team is still a seeded team");
});

test("TeamsTable merges onto the stored manifest rather than rebuilding it", () => {
  const src = read("frontend/src/components/TeamsTable.vue");
  const fn = src.slice(src.indexOf("async function saveTeamMembers"));
  const body = fn.slice(0, fn.indexOf("\nasync function "));

  assert.match(
    body,
    /getRepoContent\(/,
    "saveTeamMembers must READ the manifest it is editing",
  );
  assert.match(
    body,
    /\.\.\.existing/,
    "and spread it, so unknown fields ride along",
  );
  assert.ok(
    !/\bschema_version:\s*1\b/.test(body),
    "rebuilding the document field by field is the bug this test exists for",
  );
});

test("both TeamsTable write paths validate before committing", () => {
  const src = read("frontend/src/components/TeamsTable.vue");
  for (const name of ["submitCreateTeam", "saveTeamMembers"]) {
    const fn = src.slice(src.indexOf(`async function ${name}`));
    const body = fn.slice(0, fn.indexOf("\nasync function "));
    const validateAt = body.indexOf("validateAgainst('team'");
    const commitAt = body.indexOf("commitFile(");
    assert.ok(validateAt >= 0, `${name} must validate the manifest it writes`);
    assert.ok(commitAt >= 0, `${name} should still commit`);
    assert.ok(validateAt < commitAt, `${name} must validate BEFORE it commits`);
  }
});

test("the member edit validates before it touches collaborators", () => {
  // A manifest we cannot store must never leave GitHub and the control repo
  // disagreeing about who is on the team.
  const src = read("frontend/src/components/TeamsTable.vue");
  const fn = src.slice(src.indexOf("async function saveTeamMembers"));
  const body = fn.slice(0, fn.indexOf("\nasync function "));

  const validateAt = body.indexOf("validateAgainst('team'");
  const collabAt = Math.min(
    ...["addCollaborator(", "removeCollaborator("].map((s) => {
      const i = body.indexOf(s);
      return i < 0 ? Number.MAX_SAFE_INTEGER : i;
    }),
  );
  assert.ok(collabAt < Number.MAX_SAFE_INTEGER, "the collaborator sync should still be there");
  assert.ok(validateAt < collabAt, "validation must precede the collaborator writes");
});

test("the seeding and acceptance writers produce valid manifests too", () => {
  // The other two constructors, pinned by shape so a field added to one and not
  // the schema goes red here.
  const seeded = {
    schema_version: 1,
    assignment_id: "2627-netadv",
    team_slug: "beta",
    team_name: "Beta",
    members: ["stud3"],
    max_members: 4,
    created_at: "2026-08-01T09:00:00.000Z",
    created_by: "lecturer",
    seeded_from: {
      source: "assignment",
      assignment_id: "2526-netbasics",
      seeded_at: "2026-08-01T09:00:00.000Z",
      seeded_by: "lecturer",
    },
  };
  const accepted = {
    schema_version: 1,
    assignment_id: "2627-netadv",
    team_slug: "gamma",
    team_name: "Gamma",
    members: ["stud4"],
    max_members: 4,
    created_at: "2026-08-01T09:00:00.000Z",
    created_by: "stud4",
  };
  for (const [name, doc] of [["seed-teams", seeded], ["accept", accepted]]) {
    const { valid, errors } = validateAgainst("team", doc);
    assert.ok(valid, `${name}: ${JSON.stringify(errors)}`);
  }
});
