// PXL Classroom - features-archive-banner-feedback.test.mjs
//
// Direct GitHub archive branch URLs for students and teams.
//
// This file also held "Feature 2" (the preservation banner's numbers) and
// "Feature 3" (the feedback PR candidates), each asserting a function the file
// defined itself. Both copies kept rules the product had since dropped -
// candidates "with any observed commit", a PR head of `main` - and passed
// against themselves while the page and the script did otherwise (review
// 2026-10-14, P2-12). Removed: the page's feedback PR press is
// tests/e2e/113-open-feedback-prs.spec.mjs, the script is
// tests/open-feedback-prs.test.mjs, and the preservation status is
// lib/preservation-status.mjs with tests/preservation-status.test.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { archiveBranchUrl } from "../lib/archive-repo.mjs";

// -----------------------------------------------------------------------------
// Feature 1: Direct Archive Branch URLs
// -----------------------------------------------------------------------------
//
// This block used to define `buildStudentArchiveBranchUrl` and
// `buildTeamArchiveBranchUrl` HERE and assert on them - a builder that existed
// nowhere in the product, so the tests passed against themselves while the real
// URL was hand-written in eight other places. Deleting the SPA's link entirely
// would not have turned any of this red. It drives lib/archive-repo.mjs now;
// the naming and per-assignment rules live in tests/archive-repo.test.mjs.
//
// The preserved/sha gate stays at the call site, where it belongs: it decides
// whether to render a link at all, not what the link says.

test("Feature 1: a preserved student's archive URL is encoded", () => {
  const url = archiveBranchUrl({
    org: "PXLAutomation",
    assignmentId: "linux-processes",
    login: "alice",
    recorded: "PXLAutomation/pxl-classroom-archive-linux-processes",
  });
  assert.equal(url, "https://github.com/PXLAutomation/pxl-classroom-archive-linux-processes/tree/preserved%2Flinux-processes%2Falice");
});

test("Feature 1: a submission archived before per-assignment archives still resolves", () => {
  const url = archiveBranchUrl({ org: "PXLAutomation", assignmentId: "linux-processes", login: "alice" });
  assert.equal(url, "https://github.com/PXLAutomation/pxl-classroom-archive/tree/preserved%2Flinux-processes%2Falice");
});

test("Feature 1: special characters in an assignment ID or login are encoded", () => {
  const url = archiveBranchUrl({ org: "PXLAutomation", assignmentId: "devops_lab-1", login: "student.name+test" });
  assert.equal(url, "https://github.com/PXLAutomation/pxl-classroom-archive/tree/preserved%2Fdevops_lab-1%2Fstudent.name%2Btest");
});

test("Feature 1: a group's archive URL uses the team slug, not a member login", () => {
  // A team shares one repository and is preserved under its slug. The SPA
  // reconstructed the login unconditionally, so every group submission linked
  // to a branch that does not exist.
  const url = archiveBranchUrl({
    org: "PXLAutomation",
    assignmentId: "project-2026",
    login: "alice",
    teamSlug: "team-alpha-1",
    recorded: "PXLAutomation/pxl-classroom-archive-project-2026",
  });
  assert.equal(url, "https://github.com/PXLAutomation/pxl-classroom-archive-project-2026/tree/preserved%2Fproject-2026%2Fteam-alpha-1");
});

test("Feature 1: nothing to link to is null, so no dead link renders", () => {
  assert.equal(archiveBranchUrl({ org: "PXLAutomation", assignmentId: "linux-processes" }), null);
  assert.equal(archiveBranchUrl({ assignmentId: "linux-processes", login: "alice" }), null);
});
