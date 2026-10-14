// Whether students see a renamed team under its new name, from the page they
// are served (review 2026-10-14, PG12). It was said only in a toast.

import { test } from "node:test";
import assert from "node:assert/strict";
import { renamedTeamsServed, renamedTeamsLine } from "../frontend/src/lib/team-names-served.js";

const team = (slug, name, extra = {}) => ({ team_slug: slug, team_name: name, members: ["ann"], ...extra });
const ok = (teams) => ({ status: "ok", teams });

test("nothing renamed: nothing to say, whatever the page serves", () => {
  for (const served of [ok([]), { status: "missing" }, { status: "unreadable" }]) {
    const a = renamedTeamsServed([team("team-a", "Team A")], served);
    assert.equal(a.state, "none");
    assert.equal(renamedTeamsLine(a), "");
  }
});

test("served under the new slug and name: current", () => {
  const stored = [team("rockets", "Rockets", { renamed_from: ["team-a"] }), team("team-b", "Team B")];
  const a = renamedTeamsServed(stored, ok([team("rockets", "Rockets"), team("team-b", "Team B")]));
  assert.equal(a.state, "current");
  assert.equal(renamedTeamsLine(a), "Students see every renamed team under its new name.");
});

test("still served under the old slug: stale, naming what they see", () => {
  const stored = [team("rockets", "Rockets", { renamed_from: ["team-a"] })];
  const a = renamedTeamsServed(stored, ok([team("team-a", "Team A")]));
  assert.equal(a.state, "stale");
  assert.deepEqual(a.stale, [{ slug: "rockets", name: "Rockets", served: "Team A" }]);
  assert.equal(renamedTeamsLine(a), 'Students do not see "Rockets" yet, they see "Team A": the student pages have not been rebuilt since the rename.');
});

test("a name changed under the same slug, and a second renamed team, are both stale", () => {
  const stored = [
    team("team-a", "The A Team", { renamed_from: ["team-x"] }),
    team("rockets", "Rockets", { renamed_from: ["team-b"] }),
  ];
  const a = renamedTeamsServed(stored, ok([team("team-a", "Team A")]));
  assert.equal(a.state, "stale");
  assert.equal(a.stale.length, 2);
  assert.equal(a.stale[1].served, null, "not on the page at all");
  assert.match(renamedTeamsLine(a), /\(and 1 more renamed team\)/);
});

test("the name compared is the one the generator publishes", () => {
  // A name public text refuses is published as its slug (lib/public-text.mjs).
  const stored = [team("rockets", "mail me at ann@example.com", { renamed_from: ["team-a"] })];
  const a = renamedTeamsServed(stored, ok([team("rockets", "rockets")]));
  assert.equal(a.state, "current");
});

test("no teams file yet is behind; an unreadable one is unknown, never current", () => {
  const stored = [team("rockets", "Rockets", { renamed_from: ["team-a"] })];
  assert.equal(renamedTeamsServed(stored, { status: "missing" }).state, "stale");
  const u = renamedTeamsServed(stored, { status: "unreadable" });
  assert.equal(u.state, "unreadable");
  assert.match(renamedTeamsLine(u), /unknown/);
});

test("a team everybody left is not on the page and is not asked about", () => {
  const stored = [team("rockets", "Rockets", { renamed_from: ["team-a"], vacant: true, members: [] })];
  assert.equal(renamedTeamsServed(stored, ok([])).state, "none");
});
