// `pxl-classroom teams seed` and `unseed`, RUN against a fake control
// repository rather than read for their wiring (review 2026-10-14, TA-2: the
// only test of them grepped the source). A write decided from what it read
// asks again of the commit it lands on, so each is driven with the repository
// changing between the read and the write.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";
import { stringify } from "yaml";
import { registerTeamsCommand } from "../src/commands/teams.mjs";
import { fakeControlRepo, install } from "./fake-control.mjs";
import { ROSTER_PATH } from "../../lib/roster-entries.mjs";

const groupYaml = (id, pattern) => stringify({
  id, title: id, state: "published", assignment_type: "group",
  group_config: { max_team_size: 4, formation_mode: "self-service", allow_team_creation: true },
  repository_name_pattern: pattern,
});
const team = (id, slug, members, extra = {}) => ({
  schema_version: 1, assignment_id: id, team_slug: slug, team_name: slug, members, max_members: 4, ...extra,
});
const seeded = (slug, members) => team("lab2", slug, members, {
  seeded_from: { source: "assignment", assignment_id: "lab1", seeded_at: "2026-10-14T08:00:00Z", seeded_by: "cli" },
});

function world(extra = {}) {
  return {
    "assignments/lab1.yml": groupYaml("lab1", "lab1-{team_slug}"),
    "assignments/lab2.yml": groupYaml("lab2", "lab2-{team_slug}"),
    [ROSTER_PATH]: stringify({ schema_version: 2, students: ["alice", "bob", "cy"].map((l, i) => ({ student_number: `S${i}`, full_name: l, github_login: l })) }),
    "teams/lab1/alpha.json": team("lab1", "alpha", ["alice", "bob"]),
    "teams/lab1/beta.json": team("lab1", "beta", ["cy"]),
    ...extra,
  };
}

async function run(fake, argv) {
  const io = install(fake);
  try {
    const program = new Command();
    program.exitOverride();
    registerTeamsCommand(program);
    await program.parseAsync(["node", "pxl", ...argv]);
    return { out: io.out(), err: io.err(), exitCode: io.exitCode() };
  } finally {
    io.restore();
  }
}

test("seed writes the planned teams in one commit", async () => {
  const fake = fakeControlRepo({ files: world() });
  const res = await run(fake, ["teams", "seed", "--org", "Org", "--to", "lab2", "--from", "lab1", "--yes", "--no-publish"]);
  assert.equal(res.exitCode ?? 0, 0, res.out + res.err);
  assert.deepEqual(fake.file("teams/lab2/alpha.json").members, ["alice", "bob"]);
  assert.deepEqual(fake.file("teams/lab2/beta.json").members, ["cy"]);
  assert.equal(fake.commitsByCommand().length, 1);
});

test("seed: a student who made a team between the plan and the commit is never overwritten, and nothing is written", async () => {
  // The change lands as the commit reads the branch head - after both plans,
  // so only the check at the commit it lands on can see it.
  let changed = false;
  const fake = fakeControlRepo({
    files: world(),
    onCall: (c) => {
      if (!changed && c.method === "GET" && c.path.endsWith("/git/ref/heads/main")) {
        changed = true;
        fake.writeAs({ "teams/lab2/alpha.json": team("lab2", "alpha", ["dave"], { repo_name: "Org/lab2-alpha" }) });
      }
    },
  });
  const res = await run(fake, ["teams", "seed", "--org", "Org", "--to", "lab2", "--from", "lab1", "--yes", "--no-publish"]);
  assert.equal(res.exitCode, 1, res.out + res.err);
  assert.match(res.err, /Nothing was written: alpha was made or joined since the plan was made/);
  assert.deepEqual(fake.file("teams/lab2/alpha.json").members, ["dave"], "the student's team is as they made it");
  assert.equal(fake.has("teams/lab2/beta.json"), false, "and nothing else was written either");
  assert.equal(fake.commitsByCommand().length, 0);
});

test("seed: teams that changed while it waited are planned again, and the old plan is not written", async () => {
  // Between the first plan and the one made just before writing: the second
  // listing of the target's teams already holds cy in a team of their own.
  let listings = 0;
  const fake = fakeControlRepo({
    files: world(),
    onCall: (c) => {
      if (c.method === "GET" && c.path.endsWith("/contents/teams/lab2") && ++listings === 2) {
        fake.writeAs({ "teams/lab2/solo.json": team("lab2", "solo", ["cy"]) });
      }
    },
  });
  const res = await run(fake, ["teams", "seed", "--org", "Org", "--to", "lab2", "--from", "lab1", "--yes", "--no-publish"]);
  assert.equal(res.exitCode, 1, res.out + res.err);
  assert.match(res.err, /changed while this waited\. Nothing was written/);
  assert.equal(fake.commitsByCommand().length, 0);
});

test("seed --dry-run writes nothing and dispatches nothing", async () => {
  const fake = fakeControlRepo({ files: world() });
  const res = await run(fake, ["teams", "seed", "--org", "Org", "--to", "lab2", "--from", "lab1", "--dry-run"]);
  assert.match(res.out, /Dry run - nothing was written/);
  assert.equal(fake.commitsByCommand().length, 0);
  assert.deepEqual(fake.dispatched, []);
});

test("unseed removes carried-over teams nobody accepted into, and asks again at the commit", async () => {
  const files = world({ "teams/lab2/alpha.json": seeded("alpha", ["alice", "bob"]), "teams/lab2/beta.json": seeded("beta", ["cy"]) });
  const fake = fakeControlRepo({ files });
  const res = await run(fake, ["teams", "unseed", "--org", "Org", "--assignment", "lab2", "--yes", "--no-publish"]);
  assert.equal(res.exitCode ?? 0, 0, res.out + res.err);
  assert.equal(fake.has("teams/lab2/alpha.json"), false);
  assert.equal(fake.has("teams/lab2/beta.json"), false);

  // A member who accepted while it waited: refused, both team files kept.
  let changed = false;
  const racing = fakeControlRepo({
    files,
    onCall: (c) => {
      if (!changed && c.method === "GET" && c.path.endsWith("/git/ref/heads/main")) {
        changed = true;
        racing.writeAs({ "acceptances/lab2/bob.json": { schema_version: 1, assignment_id: "lab2", github_login: "bob", status: "accepted", team_slug: "alpha" } });
      }
    },
  });
  const refused = await run(racing, ["teams", "unseed", "--org", "Org", "--assignment", "lab2", "--yes", "--no-publish"]);
  assert.equal(refused.exitCode, 1, refused.out + refused.err);
  assert.match(refused.err, /Nothing was removed: bob accepted since the teams were read/);
  assert.equal(racing.has("teams/lab2/alpha.json"), true);
  assert.equal(racing.has("teams/lab2/beta.json"), true);
});
