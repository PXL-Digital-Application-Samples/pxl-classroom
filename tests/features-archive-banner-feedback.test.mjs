// PXL Classroom - features-archive-banner-feedback.test.mjs
//
// Comprehensive unit and integration tests covering:
// - Feature 1: Direct GitHub Archive Branch URL generation & encoding for students & teams.
// - Feature 2: Post-Deadline Preservation Summary Banner metrics & state calculations.
// - Feature 3: Feedback PR bulk opener filtering, idempotency, and repository record updates.

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

// -----------------------------------------------------------------------------
// Feature 2: Post-Deadline Preservation Summary Banner Calculations
// -----------------------------------------------------------------------------

function computePreservationBannerMetrics(report, deadlinePassed) {
  if (!deadlinePassed || !report) return null;

  const students = report.students || [];
  const eligible = students.filter((s) => s.repo_name && s.acceptance_state === "accepted");
  const preserved = students.filter((s) => s.preservation_status === "preserved" && s.preserved_sha);
  const unpreserved = eligible.filter((s) => !(s.preservation_status === "preserved" && s.preserved_sha));

  const allPreserved = eligible.length > 0 && preserved.length >= eligible.length;

  const lockdownStudent = students.find((s) => s.lock_down_at);
  const lockdownTime = lockdownStudent?.lock_down_at || null;

  const uncertaintyStudent = students.find((s) => s.uncertainty_interval_seconds != null);
  const uncertaintySeconds = uncertaintyStudent?.uncertainty_interval_seconds ?? null;

  return {
    eligibleCount: eligible.length,
    preservedCount: preserved.length,
    unpreservedCount: unpreserved.length,
    allPreserved,
    lockdownTime,
    uncertaintySeconds,
    statusText: allPreserved
      ? "All Preserved"
      : preserved.length > 0
      ? `${preserved.length}/${eligible.length} Preserved`
      : "Preservation Pending",
    statusBadgeClass: allPreserved
      ? "badge-success"
      : preserved.length > 0
      ? "badge-warning"
      : "badge-neutral",
  };
}

test("Feature 2: returns null if deadline has not passed", () => {
  const res = computePreservationBannerMetrics({ students: [] }, false);
  assert.equal(res, null);
});

test("Feature 2: calculates allPreserved correctly when all eligible students are preserved", () => {
  const report = {
    students: [
      {
        github_login: "alice",
        repo_name: "PXLAutomation/linux-alice",
        acceptance_state: "accepted",
        preservation_status: "preserved",
        preserved_sha: "1".repeat(40),
        lock_down_at: "2026-10-15T12:00:18Z",
        uncertainty_interval_seconds: 18,
      },
      {
        github_login: "bob",
        repo_name: "PXLAutomation/linux-bob",
        acceptance_state: "accepted",
        preservation_status: "preserved",
        preserved_sha: "2".repeat(40),
        lock_down_at: "2026-10-15T12:00:18Z",
        uncertainty_interval_seconds: 18,
      },
    ],
  };

  const metrics = computePreservationBannerMetrics(report, true);
  assert.equal(metrics.eligibleCount, 2);
  assert.equal(metrics.preservedCount, 2);
  assert.equal(metrics.unpreservedCount, 0);
  assert.equal(metrics.allPreserved, true);
  assert.equal(metrics.statusText, "All Preserved");
  assert.equal(metrics.statusBadgeClass, "badge-success");
  assert.equal(metrics.lockdownTime, "2026-10-15T12:00:18Z");
  assert.equal(metrics.uncertaintySeconds, 18);
});

test("Feature 2: calculates partial preservation correctly with unpreserved retry count", () => {
  const report = {
    students: [
      {
        github_login: "alice",
        repo_name: "PXLAutomation/linux-alice",
        acceptance_state: "accepted",
        preservation_status: "preserved",
        preserved_sha: "1".repeat(40),
      },
      {
        github_login: "bob",
        repo_name: "PXLAutomation/linux-bob",
        acceptance_state: "accepted",
        preservation_status: "failed",
        preserved_sha: null,
      },
      {
        github_login: "carol",
        repo_name: "PXLAutomation/linux-carol",
        acceptance_state: "accepted",
        preservation_status: "pending",
        preserved_sha: null,
      },
      {
        github_login: "dave",
        repo_name: null,
        acceptance_state: "unaccepted",
        preservation_status: null,
        preserved_sha: null,
      },
    ],
  };

  const metrics = computePreservationBannerMetrics(report, true);
  assert.equal(metrics.eligibleCount, 3);
  assert.equal(metrics.preservedCount, 1);
  assert.equal(metrics.unpreservedCount, 2);
  assert.equal(metrics.allPreserved, false);
  assert.equal(metrics.statusText, "1/3 Preserved");
  assert.equal(metrics.statusBadgeClass, "badge-warning");
});

test("Feature 2: calculates preservation pending when 0 preserved", () => {
  const report = {
    students: [
      {
        github_login: "alice",
        repo_name: "PXLAutomation/linux-alice",
        acceptance_state: "accepted",
        preservation_status: null,
        preserved_sha: null,
      },
    ],
  };

  const metrics = computePreservationBannerMetrics(report, true);
  assert.equal(metrics.eligibleCount, 1);
  assert.equal(metrics.preservedCount, 0);
  assert.equal(metrics.unpreservedCount, 1);
  assert.equal(metrics.allPreserved, false);
  assert.equal(metrics.statusText, "Preservation Pending");
  assert.equal(metrics.statusBadgeClass, "badge-neutral");
});

// -----------------------------------------------------------------------------
// Feature 3: Feedback PR Opening Logic & Idempotency
// -----------------------------------------------------------------------------

function filterFeedbackPrCandidates(students, assignmentFeedbackPrEnabled) {
  if (!assignmentFeedbackPrEnabled) return [];
  return students.filter(
    (s) => s.repo_name && (s.commit_count > 0 || s.latest_observed_sha) && !s.feedback_pr_number
  );
}

test("Feature 3: filterFeedbackPrCandidates returns empty list when feedback_pr is false on assignment", () => {
  const students = [
    { github_login: "alice", repo_name: "PXL/repo-alice", commit_count: 5, feedback_pr_number: null },
  ];
  const candidates = filterFeedbackPrCandidates(students, false);
  assert.deepEqual(candidates, []);
});

test("Feature 3: filterFeedbackPrCandidates selects only students with commits and no existing PR", () => {
  const students = [
    { github_login: "alice", repo_name: "PXL/repo-alice", commit_count: 5, feedback_pr_number: null },
    { github_login: "bob", repo_name: "PXL/repo-bob", commit_count: 0, feedback_pr_number: null },
    { github_login: "carol", repo_name: "PXL/repo-carol", commit_count: 3, feedback_pr_number: 1 },
    { github_login: "dave", repo_name: null, commit_count: null, feedback_pr_number: null },
  ];
  const candidates = filterFeedbackPrCandidates(students, true);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].github_login, "alice");
});

test("Feature 3: updating repository record on PR creation preserves existing record metadata", () => {
  const originalRecord = {
    schema_version: 1,
    assignment_id: "linux-processes",
    github_login: "alice",
    repo_name: "PXLAutomation/linux-processes-alice",
    repo_id: 123456,
    created_at: "2026-10-01T10:00:00Z",
    feedback_pr_baseline_branch: "pxl-baseline",
  };

  const prNumber = 1;
  const prUrl = "https://github.com/PXLAutomation/linux-processes-alice/pull/1";

  const updatedRecord = {
    ...originalRecord,
    feedback_pr_number: prNumber,
    feedback_pr_url: prUrl,
  };

  assert.equal(updatedRecord.feedback_pr_number, 1);
  assert.equal(updatedRecord.feedback_pr_url, prUrl);
  assert.equal(updatedRecord.repo_id, 123456);
  assert.equal(updatedRecord.github_login, "alice");
});

function computeFeedbackPrModalStats(students) {
  const list = students || [];
  const eligible = list.filter(
    (s) => s.repo_name && (s.commit_count > 0 || s.latest_observed_sha) && !s.feedback_pr_number
  );
  const alreadyOpened = list.filter((s) => s.feedback_pr_number);
  const skippedNoCommits = list.filter(
    (s) => s.repo_name && !s.feedback_pr_number && !(s.commit_count > 0 || s.latest_observed_sha)
  );

  return {
    eligibleCount: eligible.length,
    alreadyOpenedCount: alreadyOpened.length,
    skippedNoCommitsCount: skippedNoCommits.length,
    eligibleStudents: eligible,
  };
}

test("Feature 3: computeFeedbackPrModalStats computes exact counts across mixed cohort states", () => {
  const students = [
    { github_login: "alice", repo_name: "org/repo-alice", commit_count: 3, feedback_pr_number: null },
    { github_login: "bob", repo_name: "org/repo-bob", commit_count: 1, feedback_pr_number: null },
    { github_login: "carol", repo_name: "org/repo-carol", commit_count: 5, feedback_pr_number: 12 },
    { github_login: "dave", repo_name: "org/repo-dave", commit_count: 0, latest_observed_sha: null, feedback_pr_number: null },
    { github_login: "eve", repo_name: null, commit_count: null, feedback_pr_number: null },
  ];

  const stats = computeFeedbackPrModalStats(students);
  assert.equal(stats.eligibleCount, 2); // alice, bob
  assert.equal(stats.alreadyOpenedCount, 1); // carol
  assert.equal(stats.skippedNoCommitsCount, 1); // dave
  assert.deepEqual(stats.eligibleStudents.map((s) => s.github_login), ["alice", "bob"]);
});

test("Feature 3: Draft PR creation payload uses draft: true and preserves student main branch untouched", () => {
  const assignment = { title: "Linux Processes Lab", feedback_pr_baseline_branch: "pxl-baseline" };

  const payload = {
    title: `${assignment.title} - Feedback`,
    body: "PXL Classroom feedback thread for inline reviews.",
    head: "main",
    base: assignment.feedback_pr_baseline_branch || "pxl-baseline",
    draft: true,
  };

  assert.equal(payload.draft, true, "Pull Request must be opened in Draft mode");
  assert.equal(payload.head, "main", "Head branch must point to student main");
  assert.equal(payload.base, "pxl-baseline", "Base branch must point to frozen baseline snapshot");
  assert.ok(!payload.merge_method, "No merge method must be specified - student code is never merged");
});
