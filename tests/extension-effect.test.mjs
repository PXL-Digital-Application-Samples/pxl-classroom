// frontend/src/lib/extension-effect.js: what an extension does for a student,
// from what holds them now (review 2026-10-16, R7-16). The toasts said "their
// lock and grading use the new deadline anyway", which is false after a lock.

import { test } from "node:test";
import assert from "node:assert/strict";
import { extensionEffect, extensionGrantedMessage } from "../frontend/src/lib/extension-effect.js";

const record = (row) => ({ results: [{ github_login: "Alice", ...row }] });

test("extensionEffect: a lock holds them, a reopen lets them in, otherwise the lock follows", () => {
  assert.equal(extensionEffect({ record: record({ lock_method: "org-ruleset" }), login: "alice" }), "locked");
  assert.equal(extensionEffect({ record: record({ lock_method: "demotion" }), login: "alice" }), "locked");
  assert.equal(extensionEffect({ record: record({ lock_method: "org-ruleset" }), login: "alice", reopened: true }), "reopened");
  assert.equal(extensionEffect({ record: record({ lock_method: null, reopened_at: "2026-10-16T10:00:00Z" }), login: "alice" }), "open");
  assert.equal(extensionEffect({ record: record({ deferred_until: "2030-01-01T00:00:00Z" }), login: "alice" }), "open", "deferred: not locked yet");
  assert.equal(extensionEffect({ record: record({ lock_method: "none" }), login: "alice" }), "open", "an assignment that locks nothing");
  assert.equal(extensionEffect({ record: null, login: "alice" }), "open", "before the lock");
  assert.equal(extensionEffect({ record: record({ lock_method: "org-ruleset" }), login: "bob" }), "open", "somebody else's row");
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
