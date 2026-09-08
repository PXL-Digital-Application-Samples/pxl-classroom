// A REOPENED STUDENT KEEPS A ROW.
//
// They used to be dropped from `lockdowns/<id>/lockdown-record.json` entirely on
// the next finalize pass: the run counted them in `reopened_count` and then
// wrote nothing about them, so the document a grade dispute is read from lost
// that they had ever been locked, what their snapshot was, and when. The only
// surviving statement was `unlocked/<login>.json`, which no reader of the record
// joins.
//
// A DEFERRED student has always kept a row saying why. This is the same answer
// for the other reason a repository is not locked, and the asymmetry was the
// defect.
import { test } from "node:test";
import assert from "node:assert/strict";
import { unlockability } from "../lib/repo-unlock.mjs";
import { validateAgainst } from "../lib/validate.mjs";

const reopenedRow = (over = {}) => ({
  github_login: "ada",
  repo_name: "TestOrg/lab-1-ada",
  repo_id: 11,
  snapshot_sha: "a".repeat(40),
  snapshot_ref: "refs/heads/main",
  lockdown_at: null,
  lock_method: null,
  reopened_at: "2026-09-12T09:15:00.000Z",
  permission_after: null,
  verified: false,
  uncertainty_seconds: null,
  ...over,
});

test("the row the pass writes for a reopened student validates", () => {
  const record = {
    schema_version: 1,
    assignment_id: "lab-1",
    executed_at: "2026-09-13T00:30:00.000Z",
    lock_method: "org-ruleset",
    reopened_count: 1,
    results: [reopenedRow()],
  };
  const v = validateAgainst("lockdown-record", record);
  assert.equal(v.valid, true, JSON.stringify(v.errors));
});

test("IT SAYS ALREADY REOPENED, not that the record is broken", () => {
  // Without this the row falls into "the record does not say how this repository
  // was locked", which is true and useless: it reads as a broken record rather
  // than as work already done, and sends a lecturer to GitHub to do it by hand.
  const v = unlockability({
    row: { preservation_status: "preserved" },
    lockdownRow: reopenedRow(),
    assignment: { student_permission: "admin" },
  });
  assert.equal(v.can, false);
  assert.match(v.reason, /already reopened on 2026-09-12/);
  assert.doesNotMatch(v.reason, /does not say how/);
});

test("a row that was never reopened is unaffected", () => {
  const v = unlockability({
    row: { preservation_status: "preserved" },
    lockdownRow: reopenedRow({ reopened_at: undefined, lock_method: "org-ruleset", verified: true }),
    assignment: { student_permission: "admin" },
  });
  assert.equal(v.can, true, v.reason);
  assert.equal(v.method, "org-ruleset");
});

test("the snapshot survives the reopen, so the record still says what was frozen", () => {
  // Carried from the reopen record onto the row. Dropping it would leave the
  // report's preservation join with nothing to match, which is how the reopened
  // student came to read `no-submission` in the first place.
  assert.equal(reopenedRow().snapshot_sha, "a".repeat(40));
  const v = validateAgainst("lockdown-record", {
    schema_version: 1, assignment_id: "lab-1", executed_at: "2026-09-13T00:30:00.000Z",
    results: [reopenedRow()],
  });
  assert.equal(v.valid, true, JSON.stringify(v.errors));
});
