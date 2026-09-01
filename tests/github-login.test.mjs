// lib/github-login.mjs exists because of a real incident, and three of its four
// exported functions were never named in a test.
//
// CLAUDE.md: "A GitHub login is compared and indexed lowercased -
// lib/github-login.mjs, never a hand-written .toLowerCase(). The spelling a
// lecturer types into a roster CSV and the one GitHub dispatches are the same
// account; four indexes in report.mjs keyed the raw string and a single student
// became two rows."
//
// `indexByLogin` is the fix for that, and `report.mjs` and `lockdown/lockdown.mjs`
// both depend on it. Nothing asserted what it does.
import { test } from "node:test";
import assert from "node:assert/strict";

import { normalizeLogin, sameLogin, indexByLogin, displayLogins } from "../lib/github-login.mjs";

test("normalizeLogin trims as well as lowercases", () => {
  // The trim is the half a hand-written `.toLowerCase()` misses, and it is what
  // separates this from the nine deliberate ones left in accept.mjs: a roster
  // hand-edited to `github_login: "alice "` matches here and does not there.
  assert.equal(normalizeLogin("Alice"), "alice");
  assert.equal(normalizeLogin("  Alice  "), "alice");
  assert.equal(normalizeLogin("ALICE-PXL"), "alice-pxl");
});

test("normalizeLogin gives ONE falsy answer for anything that is not a string", () => {
  // "so callers get one falsy answer rather than three" - a caller branching on
  // the result must not have to tell null from undefined from a number.
  for (const bad of [null, undefined, 42, {}, [], true]) {
    assert.equal(normalizeLogin(bad), "", `${JSON.stringify(bad)} must normalise to ""`);
  }
});

test("sameLogin matches across spellings, and empty never matches empty", () => {
  assert.equal(sameLogin("Alice", "alice"), true);
  assert.equal(sameLogin(" alice ", "ALICE"), true);
  assert.equal(sameLogin("alice", "bob"), false);
  // The property a raw `===` does not have: two records that are both missing a
  // login are not the same student.
  assert.equal(sameLogin("", ""), false);
  assert.equal(sameLogin(null, null), false);
  assert.equal(sameLogin(undefined, ""), false);
});

test("indexByLogin keys on the normalised login, so one student is one entry", () => {
  // The incident: four indexes keyed the raw string and a single student became
  // two rows. Same account, three spellings, one entry - and the LAST wins, so
  // a later record updates rather than duplicating.
  const index = indexByLogin([
    { github_login: "Alice", n: 1 },
    { github_login: "  alice  ", n: 2 },
    { github_login: "ALICE", n: 3 },
    { github_login: "bob", n: 4 },
  ]);
  assert.equal(index.size, 2);
  assert.equal(index.get("alice").n, 3);
  assert.equal(index.get("bob").n, 4);
});

test("indexByLogin skips records with no usable login rather than keying them on ''", () => {
  // A record with no login is not a student; keying it on "" would make every
  // such record the same one, and a lookup for a genuinely missing login would
  // find it.
  const index = indexByLogin([
    { github_login: null },
    { github_login: "   " },
    {},
    { github_login: "carol" },
  ]);
  assert.deepEqual([...index.keys()], ["carol"]);
});

test("indexByLogin takes a custom reader, because not every record spells it the same", () => {
  const index = indexByLogin([{ login: "Dave" }], (r) => r?.login);
  assert.deepEqual([...index.keys()], ["dave"]);
});

test("displayLogins keeps the FIRST source's spelling, best source first", () => {
  // "a login GitHub gave us beats one a lecturer typed" - the point is which
  // spelling a human sees, so the order of the arguments is the whole contract.
  const display = displayLogins(["Alice-PXL", "Bob"], ["alice-pxl", "carol"]);
  assert.equal(display.get("alice-pxl"), "Alice-PXL", "the authoritative spelling wins");
  assert.equal(display.get("bob"), "Bob");
  assert.equal(display.get("carol"), "carol", "a key only the later source has is still kept");
});

test("displayLogins trims the spelling it shows and skips unusable entries", () => {
  const display = displayLogins(["  Erin  ", "", null, 7]);
  assert.equal(display.get("erin"), "Erin");
  assert.equal(display.size, 1);
});

test("displayLogins and indexByLogin agree on the key", () => {
  // They are used together - one to find the record, the other to name it - so
  // a key that differs between them is a lookup that silently misses.
  const records = [{ github_login: " Frank " }];
  const index = indexByLogin(records);
  const display = displayLogins(records.map((r) => r.github_login));
  assert.deepEqual([...index.keys()], [...display.keys()]);
});
