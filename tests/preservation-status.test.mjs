// lib/preservation-status.mjs - whether a student's deadline snapshot is in
// the archive, which Reopen is gated on.
//
// 2026-10-14 review: preserve.mjs writes preservation.json only after a
// verified push, so a push that FAILED left no file, the report said
// "not-required", and Reopen - which refuses only pending and failed - reopened
// a repository whose deadline snapshot was in no archive.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { preservationStatus, preservesSnapshot } from "../lib/preservation-status.mjs";
import { unlockability } from "../lib/repo-unlock.mjs";

// R7-3 (review 2026-10-16): a student locked again after a reopen has a second
// snapshot, and "verified" alone read the first one's archive as the second's.
test("preservesSnapshot: verified, and of THIS snapshot", () => {
  const p = { verified: true, source_sha: "a".repeat(40) };
  assert.equal(preservesSnapshot(p, "a".repeat(40)), true);
  assert.equal(preservesSnapshot(p, "b".repeat(40)), false, "the first snapshot's archive is not the second's");
  assert.equal(preservesSnapshot(p, null), true, "nothing to compare: the flag");
  assert.equal(preservesSnapshot({ verified: true }, "b".repeat(40)), true, "a record from before source_sha: the flag");
  assert.equal(preservesSnapshot({ verified: false, source_sha: "a".repeat(40) }, "a".repeat(40)), false);
  assert.equal(preservesSnapshot(null, "a".repeat(40)), false);
});

test("preservationStatus: locked again with a new snapshot is pending, not preserved", () => {
  const preservation = { verified: true, source_sha: "a".repeat(40) };
  assert.equal(preservationStatus({ preservation, lockdownRow: { snapshot_sha: "b".repeat(40) } }), "pending");
  assert.equal(preservationStatus({ preservation, lockdownRow: { snapshot_sha: "a".repeat(40) } }), "preserved");
  // R7-40: reopened and deferred to their deadline, they are archived again
  // then (R7-3), so a copy is still owed - "preserved" told the Progress strip
  // and the delete dialog the work was kept while they were still working.
  assert.equal(preservationStatus({ preservation, lockdownRow: { snapshot_sha: null, deferred_until: "2030-01-01T00:00:00Z", reopened_at: "2026-10-16T10:00:00Z" } }), "deferred",
    "reopened and deferred to their deadline: owed the copy taken then");
  assert.equal(preservationStatus({ preservation, lockdownRow: { snapshot_sha: null, deferred_until: "2030-01-01T00:00:00Z" } }), "deferred",
    "deferred after an earlier snapshot was archived");
});

const SHA = "a".repeat(40);

test("preserved only when the archive push was verified", () => {
  assert.equal(preservationStatus({ preservation: { verified: true }, lockdownRow: { snapshot_sha: SHA } }), "preserved");
  assert.equal(preservationStatus({ preservation: { verified: false }, lockdownRow: { snapshot_sha: SHA } }), "failed");
});

test("locked with a snapshot that is in no archive: pending, never not-required", () => {
  assert.equal(preservationStatus({ preservation: null, lockdownRow: { snapshot_sha: SHA } }), "pending");
});

test("locked with no snapshot and no reason for it: failed - the snapshot was never read", () => {
  // A 502 at the deadline: lockdown recorded the row with snapshot_sha null.
  assert.equal(preservationStatus({ preservation: null, lockdownRow: { snapshot_sha: null } }), "failed");
});

test("no snapshot FOR A REASON, or nothing locked yet: not-required", () => {
  assert.equal(preservationStatus({ preservation: null, lockdownRow: { snapshot_sha: null, no_submission: true } }), "not-required");
  assert.equal(preservationStatus({ preservation: null, lockdownRow: { snapshot_sha: null, reconstructed: true } }), "not-required");
  assert.equal(preservationStatus({ preservation: null, lockdownRow: null }), "not-required");
});

test("R6-15: still inside an extension is owed a copy later - deferred, never not-required", () => {
  // Read as not-required, the Progress strip said all work was archived and
  // the delete dialog that each submission was kept, over students still working.
  assert.equal(preservationStatus({ preservation: null, lockdownRow: { snapshot_sha: null, deferred_until: "2026-10-20T10:00:00Z" } }), "deferred");
});

test("so Reopen is refused for every case where a snapshot is owed and not archived", () => {
  const lockRow = { repo_name: "Org/lab-ann", lock_method: "ruleset", snapshot_sha: SHA, github_login: "ann" };
  const row = (lockdownRow) => ({ github_login: "ann", preservation_status: preservationStatus({ preservation: null, lockdownRow }) });
  assert.equal(unlockability({ row: row(lockRow), lockdownRow: lockRow }).can, false, "pending");
  const unread = { ...lockRow, snapshot_sha: null };
  assert.equal(unlockability({ row: row(unread), lockdownRow: unread }).can, false, "failed");
});

test("P2-28: reopened with nothing frozen owes nothing - not 'failed', which offered Try again", () => {
  // The row lockdown writes for a reopened student carries `reopened_at` and
  // whatever was frozen, and not `no_submission` (lockdown/lockdown.mjs).
  assert.equal(preservationStatus({ preservation: null, lockdownRow: { snapshot_sha: null, reopened_at: "2026-10-14T12:00:00Z" } }), "not-required");
  // A reopened student with a snapshot still owes it.
  assert.equal(preservationStatus({ preservation: null, lockdownRow: { snapshot_sha: SHA, reopened_at: "2026-10-14T12:00:00Z" } }), "pending");
  // And an unread snapshot that was never reopened is still a failure.
  assert.equal(preservationStatus({ preservation: null, lockdownRow: { snapshot_sha: null } }), "failed");
});

test("the report asks this function, and spells no status of its own", () => {
  const src = readFileSync(new URL("../report/report.mjs", import.meta.url), "utf8");
  assert.match(src, /preservation_status: preservationStatus\(\{ preservation, lockdownRow \}\)/);
  assert.doesNotMatch(src, /:\s*"not-required"/, "no second spelling of the decision");
});
