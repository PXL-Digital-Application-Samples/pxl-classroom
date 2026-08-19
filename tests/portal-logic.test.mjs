import { test } from "node:test";
import assert from "node:assert/strict";

// Helper functions corresponding to HomeView.vue logic
function parseAssignmentLink(input) {
  if (!input) return null;
  const clean = input.trim();
  const m1 = clean.match(/(?:^|\/)([a-zA-Z0-9_-]+)\/a\/([a-zA-Z0-9_-]+)(?:$|\/|\?|#)/);
  if (m1) return { org: m1[1], assignmentId: m1[2] };
  const m2 = clean.match(/^([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+)$/);
  if (m2) return { org: m2[1], assignmentId: m2[2] };
  return null;
}

function matchStudentAssignments(allOrgAssignments, userLogin, userRepos, userInvites) {
  const normalizedLogin = (userLogin || "").toLowerCase();
  const matched = [];

  for (const a of allOrgAssignments) {
    const pattern = a.repository_name_pattern || `${a.id}-{github_login}`;
    const expectedName = pattern.replace("{github_login}", normalizedLogin).toLowerCase();

    // Check provisioned repo
    const existingRepo = userRepos.find(
      (r) => r.owner?.login?.toLowerCase() === a.org.toLowerCase() && r.name?.toLowerCase() === expectedName
    );
    if (existingRepo) {
      matched.push({
        ...a,
        repoUrl: existingRepo.html_url,
        repoFullName: existingRepo.full_name,
        stateStatus: "provisioned"
      });
      continue;
    }

    // Check pending invitation
    const existingInvite = userInvites.find(
      (inv) => inv.repository?.owner?.login?.toLowerCase() === a.org.toLowerCase() && inv.repository?.name?.toLowerCase() === expectedName
    );
    if (existingInvite) {
      matched.push({
        ...a,
        repoUrl: existingInvite.repository?.html_url,
        repoFullName: existingInvite.repository?.full_name,
        stateStatus: "invited"
      });
    }
  }

  return matched;
}

// -----------------------------------------------------------------------------
// Direct Link Parser Tests
// -----------------------------------------------------------------------------
test("parseAssignmentLink extracts org and assignmentId from full GitHub Pages URL", () => {
  const url = "https://pxl-digital-application-samples.github.io/pxl-classroom/pxl-digital-app-samples/a/linux-processes";
  const res = parseAssignmentLink(url);
  assert.deepEqual(res, { org: "pxl-digital-app-samples", assignmentId: "linux-processes" });
});

test("parseAssignmentLink extracts org and assignmentId with trailing slash, query, or hash", () => {
  const url = "https://pxl-digital-application-samples.github.io/pxl-classroom/pxl-course-org/a/lab-01/?ref=canvas#instructions";
  const res = parseAssignmentLink(url);
  assert.deepEqual(res, { org: "pxl-course-org", assignmentId: "lab-01" });
});

test("parseAssignmentLink extracts org and assignmentId from relative /:org/a/:id path", () => {
  const path = "pxl-course-org/a/exam-2026";
  const res = parseAssignmentLink(path);
  assert.deepEqual(res, { org: "pxl-course-org", assignmentId: "exam-2026" });
});

test("parseAssignmentLink extracts org and assignmentId from short :org/:id format", () => {
  const short = "pxl-course-org/exam-2026";
  const res = parseAssignmentLink(short);
  assert.deepEqual(res, { org: "pxl-course-org", assignmentId: "exam-2026" });
});

test("parseAssignmentLink returns null for invalid or empty inputs", () => {
  assert.equal(parseAssignmentLink(""), null);
  assert.equal(parseAssignmentLink("   "), null);
  assert.equal(parseAssignmentLink("just-a-slug"), null);
  assert.equal(parseAssignmentLink("https://github.com/org/repo"), null);
});

// -----------------------------------------------------------------------------
// Student Repository Matching Tests
// -----------------------------------------------------------------------------
test("matchStudentAssignments returns only the repositories accepted by the student", () => {
  const publishedAssignments = [
    { org: "PXL-Org", id: "lab-01", title: "Lab 1", repository_name_pattern: "lab-01-{github_login}" },
    { org: "PXL-Org", id: "lab-02", title: "Lab 2", repository_name_pattern: "lab-02-{github_login}" },
    { org: "PXL-Org", id: "unrelated-test", title: "Unrelated Test", repository_name_pattern: "unrelated-test-{github_login}" }
  ];

  const userRepos = [
    { owner: { login: "PXL-Org" }, name: "lab-01-alice", html_url: "https://github.com/PXL-Org/lab-01-alice", full_name: "PXL-Org/lab-01-alice" },
    { owner: { login: "Personal" }, name: "other-project", html_url: "https://github.com/Personal/other-project", full_name: "Personal/other-project" }
  ];

  const userInvites = [];

  const matched = matchStudentAssignments(publishedAssignments, "Alice", userRepos, userInvites);
  assert.equal(matched.length, 1);
  assert.equal(matched[0].id, "lab-01");
  assert.equal(matched[0].stateStatus, "provisioned");
  assert.equal(matched[0].repoFullName, "PXL-Org/lab-01-alice");
});

test("matchStudentAssignments recognizes pending repository invitations", () => {
  const publishedAssignments = [
    { org: "PXL-Org", id: "lab-02", title: "Lab 2", repository_name_pattern: "lab-02-{github_login}" }
  ];

  const userRepos = [];
  const userInvites = [
    {
      repository: {
        owner: { login: "PXL-Org" },
        name: "lab-02-bob",
        html_url: "https://github.com/PXL-Org/lab-02-bob",
        full_name: "PXL-Org/lab-02-bob"
      }
    }
  ];

  const matched = matchStudentAssignments(publishedAssignments, "Bob", userRepos, userInvites);
  assert.equal(matched.length, 1);
  assert.equal(matched[0].id, "lab-02");
  assert.equal(matched[0].stateStatus, "invited");
});

test("matchStudentAssignments returns empty list when student has not joined any assignments (zero leakage)", () => {
  const publishedAssignments = [
    { org: "PXL-Org", id: "secret-pe-exam", title: "In-Class Exam", repository_name_pattern: "secret-pe-exam-{github_login}" }
  ];

  const userRepos = [];
  const userInvites = [];

  const matched = matchStudentAssignments(publishedAssignments, "Eve", userRepos, userInvites);
  assert.equal(matched.length, 0, "Unaccepted assignments must NEVER be returned to the student");
});
