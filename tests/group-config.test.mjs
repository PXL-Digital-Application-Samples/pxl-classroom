// One default for `group_config`, not seven.
//
// `max_team_size` is optional, so every reader had to decide what its absence
// means - and seven of them wrote `|| 3` by hand: the acceptance gate, the
// planner, the student's card, the lecturer's team table (three times) and the
// Admin Panel form.
//
// lib/seed-teams.mjs did export a DEFAULT_MAX_TEAM_SIZE, whose own comment said
// it was "used everywhere group_config.max_team_size is absent" - and it was
// used in exactly one file. That is worse than no constant: changing it, which
// is the obvious move given the name, would have made the planner seed teams
// one member larger than accept.mjs is willing to admit, and the last member of
// every seeded team would have been turned away with `rejected:team-full`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_MAX_TEAM_SIZE,
  DEFAULT_MIN_TEAM_SIZE,
  maxTeamSize,
  minTeamSize,
} from "../lib/group-config.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

test("the code default and the schema default are the same number", () => {
  // lib/validate.mjs runs AJV with useDefaults:true, so a VALIDATED assignment
  // arrives with the schema's default already filled in while an unvalidated
  // one falls back to the code's. If the two disagree, the same document means
  // different things depending on which route it took.
  const schema = JSON.parse(readFileSync(join(root, "schemas", "assignment.schema.json"), "utf8"));
  const gc = schema.properties.group_config.properties;

  assert.equal(gc.max_team_size.default, DEFAULT_MAX_TEAM_SIZE);
  assert.ok(
    gc.max_team_size.minimum <= DEFAULT_MAX_TEAM_SIZE,
    "the default must itself be a legal value",
  );
});

test("absent, empty and junk all mean the default; a real value wins", () => {
  // `Number(...) || DEFAULT` rather than `??`, because this arrives from YAML a
  // human edits: `max_team_size: ""` and a missing key must both mean the
  // default, and 0 is not a legal team size.
  assert.equal(maxTeamSize(undefined), DEFAULT_MAX_TEAM_SIZE);
  assert.equal(maxTeamSize(null), DEFAULT_MAX_TEAM_SIZE);
  assert.equal(maxTeamSize({}), DEFAULT_MAX_TEAM_SIZE);
  assert.equal(maxTeamSize({ max_team_size: "" }), DEFAULT_MAX_TEAM_SIZE);
  assert.equal(maxTeamSize({ max_team_size: 0 }), DEFAULT_MAX_TEAM_SIZE);
  assert.equal(maxTeamSize({ max_team_size: "nonsense" }), DEFAULT_MAX_TEAM_SIZE);

  assert.equal(maxTeamSize({ max_team_size: 5 }), 5);
  assert.equal(maxTeamSize({ max_team_size: "5" }), 5, "YAML may hand back a string");
});

test("the under-capacity threshold defaults to 0, not 1", () => {
  // It only drives the dashboard's "under capacity" warning. Defaulting it to 1
  // would flag every team that has anybody in it at all.
  assert.equal(DEFAULT_MIN_TEAM_SIZE, 0);
  assert.equal(minTeamSize({}), 0);
  assert.equal(minTeamSize({ min_team_size: 2 }), 2);
});

test("nothing decides the team-size default on its own any more", () => {
  // The guard against re-forking. A hand-written `|| 3` returning anywhere
  // means the gate, the planner and the page can disagree about capacity - and
  // the one that loses is the student, refused at the button by a server that
  // counted differently from the page they were looking at.
  const dirs = ["lib", "acceptance", "frontend/src", "cli/src", "scripts"];
  const files = [];
  for (const d of dirs) {
    (function walk(p) {
      let entries;
      try { entries = readdirSync(p, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const full = join(p, e.name);
        if (e.isDirectory()) { if (!/node_modules|dist/.test(full)) walk(full); }
        else if (/\.(mjs|js|vue)$/.test(e.name)) files.push(full);
      }
    })(join(root, d));
  }
  assert.ok(files.length > 40, `expected to scan the tree, saw ${files.length} files`);

  const offenders = [];
  for (const f of files) {
    const rel = f.replace(root, "").replace(/\\/g, "/").replace(/^\//, "");
    if (rel === "lib/group-config.mjs") continue;
    const code = readFileSync(f, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/<!--[\s\S]*?-->/g, "");
    if (/max_team_size\s*(\|\||\?\?)\s*\d/.test(code)) offenders.push(rel);
  }
  assert.deepEqual(
    offenders,
    [],
    "these invent the team-size default instead of asking lib/group-config.mjs:\n" +
      offenders.map((o) => `  ${o}`).join("\n"),
  );
});
