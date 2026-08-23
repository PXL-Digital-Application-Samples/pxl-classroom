import { test } from "node:test";
import assert from "node:assert/strict";

// The real parser, not a copy. A local re-implementation here kept passing
// against logic the view no longer had.
import { parseInvitationLink } from "../frontend/src/lib/invite.js";
import { signInviteToken, generateKeyPair } from "../lib/invite-token.mjs";

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
const KP = generateKeyPair();
const TOKEN = signInviteToken({
  org: "pxl-course-org",
  assignmentId: "exam-2026",
  expiresAt: new Date(Date.now() + 86400000).toISOString(),
  nonce: "abcdef01",
  privateKeyPem: KP.privateKeyPem,
});

test("parseInvitationLink extracts org and token from a full Pages URL", () => {
  const res = parseInvitationLink(
    `https://pxl-digital-application-samples.github.io/pxl-classroom/pxl-course-org/i/${TOKEN}`
  );
  assert.deepEqual(res, { org: "pxl-course-org", inviteToken: TOKEN });
});

test("parseInvitationLink tolerates a trailing slash, query, or hash", () => {
  const res = parseInvitationLink(`pxl-course-org/i/${TOKEN}/?ref=canvas#instructions`);
  assert.deepEqual(res, { org: "pxl-course-org", inviteToken: TOKEN });
});

test("parseInvitationLink accepts the bare org/token form", () => {
  assert.deepEqual(parseInvitationLink(`pxl-course-org/${TOKEN}`), {
    org: "pxl-course-org",
    inviteToken: TOKEN,
  });
});

test("parseInvitationLink rejects anything that is not an invitation", () => {
  for (const bad of [
    "",
    null,
    undefined,
    "   ",
    "just-some-text",
    // The pre-token student URL. It has to fail: without a signed invitation
    // the broker rejects, so sending the student there would strand them.
    "pxl-course-org/a/exam-2026",
    // Right shape, wrong length.
    `pxl-course-org/i/${TOKEN.slice(0, 60)}`,
  ]) {
    assert.equal(parseInvitationLink(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
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
