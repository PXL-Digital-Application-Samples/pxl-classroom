// An organization owner cannot be frozen, and that is not an error.
//
// THE COHORT THIS COST: PXL-2TIN-DevOps-2627/test-opdracht, 2026-09-03. An
// accepted account owned the organization, so demoting their collaborator grant
// to `pull` left them on admin - GitHub grants the highest applicable
// permission, and nothing lockdown can do changes that. Lockdown treated it as
// an error, the step failed, and `3. Preserve` was SKIPPED: nobody in that
// cohort had their work archived. Three nights, then find-finalizable hit its
// ceiling and the assignment never finalized.
//
// It is not an exotic case. Owning the course organization is what MAKES
// somebody a lecturer here, and accepting your own assignment is the only way
// to see what a student sees - so the people most likely to trip it are the
// ones running the course.
//
// The rule these tests pin: `true` requires evidence. Excusing a student from a
// deadline on a read that did not happen is the failure mode worth designing
// against, so an unreadable owner list excuses nobody.

import { test } from "node:test";
import assert from "node:assert/strict";

import { fetchOrgOwners, isKnownOwner } from "../lib/org-owners.mjs";

/** A request stub: pages of logins, or a status for a page that fails. */
function stub(pages) {
  return async (_method, path) => {
    const page = Number(/[?&]page=(\d+)/.exec(path)?.[1] ?? 1);
    const entry = pages[page - 1];
    if (entry === undefined) return { ok: true, data: [] };
    if (typeof entry === "number") return { ok: false, status: entry };
    return { ok: true, data: entry.map((login) => ({ login })) };
  };
}

test("a short page ends the walk and the list is complete", async () => {
  const res = await fetchOrgOwners(stub([["alice", "bob"]]), "Org");
  assert.deepEqual(res.owners, ["alice", "bob"]);
  assert.equal(res.complete, true);
});

test("a full page is followed by another request", async () => {
  // One page is not the list. A cohort's owner sitting on page two must be
  // found, or lockdown fails a student it should have excused.
  const first = Array.from({ length: 100 }, (_, i) => `owner${i}`);
  const res = await fetchOrgOwners(stub([first, ["late-owner"]]), "Org");
  assert.equal(res.owners.length, 101);
  assert.ok(res.owners.includes("late-owner"));
  assert.equal(res.complete, true);
});

test("nothing read at all is null, NOT an empty list", async () => {
  // The distinction the deadline turns on. An empty list means "nobody is an
  // owner", which would make every failed freeze an error again - including the
  // one that is genuinely unfreezable.
  const res = await fetchOrgOwners(stub([500]), "Org");
  assert.equal(res.owners, null);
  assert.equal(res.complete, false);
});

test("a page failing after a good one is a truncated read, and keeps its matches", async () => {
  const first = Array.from({ length: 100 }, (_, i) => `owner${i}`);
  const res = await fetchOrgOwners(stub([first, 500]), "Org");
  assert.equal(res.owners.length, 100);
  assert.equal(res.complete, false, "a truncated read must not claim to be complete");
});

test("isKnownOwner requires evidence, and an unreadable list is not evidence", () => {
  assert.equal(isKnownOwner(["alice"], "alice"), true);
  assert.equal(isKnownOwner(["alice"], "bob"), false);
  // null is the unreadable case. Answering `true` here would excuse a student
  // from the deadline because a request failed.
  assert.equal(isKnownOwner(null, "alice"), false);
  assert.equal(isKnownOwner(undefined, "alice"), false);
});

test("a login is matched case-insensitively, like every other login here", () => {
  // GitHub logins compare lowercased - lib/github-login.mjs exists for this -
  // and an owner typed with different capitalisation is the same account.
  assert.equal(isKnownOwner(["Alice-Example"], "alice-example"), true);
  assert.equal(isKnownOwner(["alice-example"], "Alice-Example"), true);
});

test("an absent login matches nothing", () => {
  assert.equal(isKnownOwner(["alice"], ""), false);
  assert.equal(isKnownOwner(["alice"], null), false);
});
