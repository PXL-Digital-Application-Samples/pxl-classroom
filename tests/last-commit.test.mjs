// frontend/src/lib/last-commit.js: a repository whose commits were never read
// says so, never "No submission" or "no commits".
//
// PXL-2TIN-CloudEssentials-2627, proef-pe1, 2026-10-27: BjarneJans accepted
// at 12:58, pushed five commits by 13:12, and his row read "No submission",
// "no commits" beside a Score of 10/10 that Read all scores again had read
// live - because commits are read by the nightly and by Refresh, and neither
// had run since he accepted.

import { test } from "node:test";
import assert from "node:assert/strict";
import { commitsNotRead, statusNotRead, NOT_READ_LABEL, NOT_READ_TITLE } from "../frontend/src/lib/last-commit.js";

// The report row as report.mjs writes it for a student nobody has read yet.
const unread = {
  github_login: "BjarneJans",
  acceptance_state: "provisioned",
  repo_url: "https://github.com/Org/proef-pe1-BjarneJans",
  submission_status: "no-submission",
  latest_observed_sha: null,
  latest_observed_at: null,
  last_on_time_sha: null,
  commit_count: null,
};

test("a repository nobody has read is 'not read', and its status is not 'No submission'", () => {
  assert.equal(commitsNotRead(unread), true);
  assert.equal(statusNotRead(unread), true);
  assert.equal(NOT_READ_LABEL, "Not read yet");
  assert.match(NOT_READ_TITLE, /Refresh/, "says how to read it now");
});

test("once read, an empty repository is 'No submission' as before", () => {
  const read = { ...unread, latest_observed_at: "2026-10-28T00:31:00Z", commit_count: 1 };
  assert.equal(commitsNotRead(read), false);
  assert.equal(statusNotRead(read), false);
  // A reading that found no commit at all still counts as a reading.
  assert.equal(commitsNotRead({ ...unread, latest_observed_at: "2026-10-28T00:31:00Z" }), false);
});

test("any sign of a reading counts: a SHA or a count without the time (older rows)", () => {
  assert.equal(commitsNotRead({ ...unread, latest_observed_sha: "abc" }), false);
  assert.equal(commitsNotRead({ ...unread, last_on_time_sha: "abc" }), false);
  assert.equal(commitsNotRead({ ...unread, commit_count: 0 }), false, "zero is an answer");
});

test("no repository is not 'not read': there is nothing to read", () => {
  assert.equal(commitsNotRead({ ...unread, repo_url: null }), false);
  assert.equal(statusNotRead(null), false);
});

test("a status the report decided otherwise is never replaced", () => {
  for (const status of ["on-time", "late", "unknown"]) {
    assert.equal(statusNotRead({ ...unread, submission_status: status }), false, status);
  }
  assert.equal(statusNotRead({ ...unread, submission_status: undefined }), true, "absent is the report's default, no-submission");
});
