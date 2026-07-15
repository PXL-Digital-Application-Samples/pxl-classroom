import { test } from "node:test";
import assert from "node:assert/strict";
import { validateAgainst } from "../lib/validate.mjs";

test("download-manifest schema - valid format passes validation", () => {
  const manifest = {
    schema_version: 1,
    org: "TestOrg",
    assignment_id: "hw-1",
    generated_at: "2026-07-15T02:00:00Z",
    students: [
      {
        login: "alice",
        archive_sha: "1234567890abcdef1234567890abcdef12345678",
        archive_branch: "preserved/hw-1/alice",
        archive_branch_url: "https://github.com/TestOrg/pxl-classroom-archive/tree/preserved%2Fhw-1%2Falice",
        downloaded_at: "2026-07-15T02:10:00Z"
      },
      {
        login: "bob",
        archive_sha: "abcdef1234567890abcdef1234567890abcdef12",
        archive_branch: "preserved/hw-1/bob",
        archive_branch_url: "https://github.com/TestOrg/pxl-classroom-archive/tree/preserved%2Fhw-1%2Fbob",
        downloaded_at: null
      }
    ]
  };

  const { valid, errors } = validateAgainst("download-manifest", manifest);
  assert.equal(valid, true, JSON.stringify(errors));
});

test("download-manifest schema - invalid structure fails validation", () => {
  const invalidManifest = {
    schema_version: 1,
    org: "TestOrg",
    assignment_id: "hw-1",
    generated_at: "invalid-date",
    students: [
      {
        login: "alice",
        // missing archive_sha, archive_branch, archive_branch_url
      }
    ]
  };

  const { valid, errors } = validateAgainst("download-manifest", invalidManifest);
  assert.equal(valid, false);
  assert.ok(errors.length > 0);
});
