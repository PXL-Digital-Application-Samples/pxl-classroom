// frontend/src/lib/team-edit.js: what a Teams-tab change tells the lecturer.
// Every sentence is computed from the case in hand; these pin one case each.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  moveConfirmation,
  deleteConfirmation,
  memberStatus,
  revokeOutcome,
  notAnAccountNote,
  membersEdited,
} from "../frontend/src/lib/team-edit.js";

const withRepo = (slug) => ({
  team_slug: slug,
  team_name: slug[0].toUpperCase() + slug.slice(1),
  repo_name: `org/demo-${slug}`,
  repo_id: 42,
});
const noRepo = (slug) => ({ team_slug: slug, team_name: slug[0].toUpperCase() + slug.slice(1) });
const move = (over) =>
  moveConfirmation({ login: "ann", org: "org", accepted: true, draft: false, ...over });

test("accepted, both teams have a repository: loses one, is invited to the other", () => {
  const c = move({ from: withRepo("alpha"), to: withRepo("bravo") });
  assert.equal(c.title, "Move @ann to Bravo?");
  assert.equal(c.confirmLabel, "Move @ann");
  assert.equal(c.destructive, true);
  assert.deepEqual(c.paragraphs, [
    "@ann loses access to demo-alpha now.",
    "They get an invitation to demo-bravo, and can push there once they accept it on GitHub.",
  ]);
});

test("accepted, into a team with no repository: has to accept again", () => {
  const c = move({ from: withRepo("alpha"), to: noRepo("delta") });
  assert.match(c.paragraphs[1], /^Delta has no repository yet, so @ann has no team repository until they open the invitation link and accept again\.$/);
});

test("never accepted: nothing to remove, and nothing promised that will not happen", () => {
  const c = move({ accepted: false, from: withRepo("alpha"), to: noRepo("delta") });
  assert.equal(c.destructive, false, "nobody loses anything");
  assert.deepEqual(c.paragraphs, [
    "@ann has not accepted yet, so there is no access to remove.",
    "Delta has no repository yet. @ann gets access to it when they accept.",
  ]);
});

test("a team row with a name but no repo_id has no repository - the record planner's own test", () => {
  const c = move({ from: { ...withRepo("alpha"), repo_id: undefined }, to: noRepo("delta") });
  assert.doesNotMatch(c.paragraphs.join(" "), /loses access/);
});

test("on a draft no access changes, and it says so", () => {
  const c = move({ draft: true, from: withRepo("alpha"), to: withRepo("bravo") });
  assert.equal(c.destructive, false);
  assert.match(c.paragraphs[0], /draft, so nobody has a repository yet and no access changes/);
});

test("delete names the team and says what is removed", () => {
  const c = deleteConfirmation(noRepo("echo"));
  assert.equal(c.title, "Delete team Echo?");
  assert.equal(c.confirmLabel, "Delete team");
  assert.deepEqual(c.paragraphs, ["Echo has no members. It is removed from this assignment."]);
});

test("member status follows the pending-pill rule", () => {
  assert.equal(memberStatus({ draft: true, known: true, accepted: false, teamHasRepo: false }), null);
  assert.equal(memberStatus({ draft: false, known: false, accepted: false, teamHasRepo: true }), null);
  assert.deepEqual(memberStatus({ draft: false, known: true, accepted: false, teamHasRepo: true }), { tone: "warning", text: "has not accepted yet" });
  assert.deepEqual(memberStatus({ draft: false, known: true, accepted: true, teamHasRepo: true }), { tone: "success", text: "has the team repository" });
});

test("a 403 is a failure unless the username is known not to be an account", () => {
  assert.equal(revokeOutcome({ ok: true, status: 204 }), "removed");
  assert.equal(revokeOutcome({ ok: false, status: 404 }), "removed");
  assert.equal(revokeOutcome({ ok: false, status: 403 }, false), "not-an-account");
  assert.equal(revokeOutcome({ ok: false, status: 403 }, true), "failed", "a real account the App cannot remove is a real failure");
  assert.equal(revokeOutcome({ ok: false, status: 403 }, null), "failed", "GitHub did not say: not evidence");
  assert.equal(revokeOutcome({ ok: false, status: 500 }, false), "failed");
});

test("the not-an-account note is neutral and names everyone", () => {
  assert.equal(notAnAccountNote([]), "");
  assert.equal(notAnAccountNote(["x"]), "@x is not a GitHub account, so there was no access to remove.");
  assert.equal(notAnAccountNote(["x", "y"]), "@x, @y are not GitHub accounts, so there was no access to remove.");
});

test("TS-5: a member edit is any difference in who is listed, and a login's spelling is not one", () => {
  assert.equal(membersEdited(["ann", "bob"], ["ann", "bob"]), false);
  assert.equal(membersEdited(["ann", "bob"], ["bob", "ann"]), false, "order is not an edit");
  assert.equal(membersEdited(["Ann"], ["ann"]), false, "the same account spelled differently");
  assert.equal(membersEdited(["ann", "bob"], ["ann"]), true, "a removal");
  assert.equal(membersEdited(["ann"], ["ann", "bob"]), true, "an addition");
  assert.equal(membersEdited(["ann", "bob"], ["ann", "cid"]), true, "a swap keeps the count");
  // Same length, every shown one listed before, but one opened member missing.
  assert.equal(membersEdited(["ann", "bob"], ["ann", "ann"]), true, "a duplicate hiding a removal");
  assert.equal(membersEdited(undefined, []), false);
  assert.equal(membersEdited([], undefined), false);
});
