// frontend/src/lib/extension-effect.js: what an extension does for a student,
// from what holds them now (review 2026-10-16, R7-16). The toasts said "their
// lock and grading use the new deadline anyway", which is false after a lock.

import { test } from "node:test";
import assert from "node:assert/strict";
import { extensionEffect, extensionGrantedMessage } from "../frontend/src/lib/extension-effect.js";

const SHA = "f".repeat(40);
const record = (row) => ({ results: [{ github_login: "Alice", snapshot_sha: SHA, lockdown_at: "2026-10-15T22:00:00Z", ...row }] });
const reopen = { unlocked_at: "2026-10-16T08:00:00Z" };

test("extensionEffect: a lock holds them, a reopen lets them in, otherwise the lock follows", () => {
  assert.equal(extensionEffect({ record: record({ lock_method: "org-ruleset" }), login: "alice" }), "locked");
  assert.equal(extensionEffect({ record: record({ lock_method: "demotion" }), login: "alice" }), "locked");
  assert.equal(extensionEffect({ record: record({ lock_method: "org-ruleset" }), login: "alice", reopen }), "reopened");
  assert.equal(extensionEffect({ record: record({ lock_method: null, reopened_at: "2026-10-16T10:00:00Z" }), login: "alice" }), "open");
  assert.equal(extensionEffect({ record: record({ deferred_until: "2030-01-01T00:00:00Z" }), login: "alice" }), "open", "deferred: not locked yet");
  assert.equal(extensionEffect({ record: record({ lock_method: "none" }), login: "alice" }), "open", "an assignment that locks nothing");
  assert.equal(extensionEffect({ record: null, login: "alice" }), "open", "before the lock");
  assert.equal(extensionEffect({ record: record({ lock_method: "org-ruleset" }), login: "bob" }), "open", "somebody else's row");
});

// R7-24: "locked" is lockdown's own predicate (lib/lock-rows.mjs).
test("extensionEffect: locked since the reopen is locked, and any taken lock counts", () => {
  const relocked = record({ lock_method: "org-ruleset", lockdown_at: "2026-10-16T12:00:00Z", relocked_after: reopen.unlocked_at });
  assert.equal(extensionEffect({ record: relocked, login: "alice", reopen }), "locked", "the re-lock is not undone by more time");
  assert.equal(extensionEffect({ record: record({ lock_method: "org-ruleset", snapshot_sha: null, no_submission: true, verified: true }), login: "alice" }), "locked", "locked with nothing handed in");
  assert.equal(extensionEffect({ record: record({ lock_method: "org-ruleset", snapshot_sha: null, snapshot_unread: "HTTP 502" }), login: "alice" }), "locked", "locked, its snapshot unread");
  assert.equal(extensionEffect({ record: record({ lock_method: "org-ruleset", snapshot_sha: null }), login: "alice" }), "open", "no lock taken");
  assert.equal(extensionEffect({ record: null, login: "alice", reopen }), "reopened", "reopened, nothing locked since");
});

// R7-36: a record that could not be read, or not yet, is not "nothing locked".
test("extensionEffect: unread is unknown, and the toast says what to do if they are locked", () => {
  assert.equal(extensionEffect({ record: null, login: "alice", known: false }), "unknown");
  assert.equal(extensionEffect({ record: record({ lock_method: "org-ruleset" }), login: "alice", known: false }), "unknown");
  const msg = extensionGrantedMessage({ login: "alice", when: "20/10/2026, 23:59", effect: "unknown" });
  assert.match(msg, /^Extension granted to alice until 20\/10\/2026, 23:59\. Whether their repository is already locked could not be read: if it is, more time does not reopen it, and Reopen lets them push until then\./);
  assert.doesNotMatch(msg, /follow it/);
});

test("extensionGrantedMessage says what the time does, then whether their page was told", () => {
  const when = "20/10/2026, 23:59";
  assert.equal(extensionGrantedMessage({ login: "alice", when, effect: "open" }),
    "Extension granted to alice until 20/10/2026, 23:59; their lock and grading follow it. Their own page shows it. The Progress tab shows it after the next nightly run or a Refresh.");
  const locked = extensionGrantedMessage({ login: "alice", when, effect: "locked" });
  assert.match(locked, /already locked at the deadline, and more time does not reopen it\. Reopen them to let them push until .*; they are locked again then\./);
  assert.doesNotMatch(locked, /follow it|use the new deadline anyway/);
  assert.match(extensionGrantedMessage({ login: "alice", when, effect: "reopened" }), /stays open and is locked again at/);
  assert.match(extensionGrantedMessage({ login: "alice", when, effect: "open", noRepoYet: true }), /Their page shows it once they accept\. The Progress tab shows it after the next nightly run or a Refresh\.$/);
  assert.match(extensionGrantedMessage({ login: "alice", when, effect: "open", notTold: "HTTP 403" }), /could not be told: HTTP 403\. Open their actions to send it again\.$/);
});
