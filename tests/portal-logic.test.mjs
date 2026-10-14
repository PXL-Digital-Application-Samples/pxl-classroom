import { test } from "node:test";
import assert from "node:assert/strict";

// The real parser, not a copy. A local re-implementation here kept passing
// against logic the view no longer had.
import { parseInvitationLink } from "../frontend/src/lib/invite.js";
import { signInviteToken, generateKeyPair } from "../lib/invite-token.mjs";
// The student home's own matching, not a copy (review 2026-10-14, P2-22): a
// copy here kept the login-only rule after PG5 taught the page team names.
import { matchStudentAssignments as match, timeRemaining } from "../frontend/src/lib/student-assignments.js";

const matchStudentAssignments = (all, login, repos, invites) => match(all, { login, repos, invites });

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
  assert.deepEqual(res, { org: "pxl-course-org", inviteToken: TOKEN, kind: "accept" });
});

test("parseInvitationLink tolerates a trailing slash, query, or hash", () => {
  const res = parseInvitationLink(`pxl-course-org/i/${TOKEN}/?ref=canvas#instructions`);
  assert.deepEqual(res, { org: "pxl-course-org", inviteToken: TOKEN, kind: "accept" });
});

test("parseInvitationLink accepts the bare org/token form", () => {
  assert.deepEqual(parseInvitationLink(`pxl-course-org/${TOKEN}`), {
    org: "pxl-course-org",
    inviteToken: TOKEN,
    // No route segment, so it cannot say which page it means. Accept is the
    // right guess: it is what a student is handed by default.
    kind: "accept",
  });
});

test("parseInvitationLink recognises a CONFIRM link, and says which it is", () => {
  // A student handed a `/c/` link and told to "paste your link here" would
  // otherwise be told it is not a link at all - which is the worst possible
  // answer, because it is one, and the box is the only thing on the page.
  assert.deepEqual(
    parseInvitationLink(
      `https://pxl-digital-application-samples.github.io/pxl-classroom/pxl-course-org/c/${TOKEN}`,
    ),
    { org: "pxl-course-org", inviteToken: TOKEN, kind: "confirm" },
  );
  assert.deepEqual(parseInvitationLink(`pxl-course-org/c/${TOKEN}/?ref=canvas`), {
    org: "pxl-course-org",
    inviteToken: TOKEN,
    kind: "confirm",
  });
});

test("…and no OTHER single letter becomes a route", () => {
  // `([ic])`, not `(.)`. A wildcard here would turn every one-segment path into
  // an invitation and send students to a page that can only say "not found".
  for (const seg of ["a", "x", "ii", "C"]) {
    assert.equal(
      parseInvitationLink(`pxl-course-org/${seg}/${TOKEN}`),
      null,
      `expected null for /${seg}/`,
    );
  }
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

test("PG5: a team assignment is found by any name its pattern makes, a pending team invitation too - and not in another org", () => {
  const all = [
    { org: "PXL-Org", id: "grp-lab", title: "Group Lab", repository_name_pattern: "grp-lab-{team_slug}" },
    { org: "PXL-Org", id: "grp-exam", title: "Group Exam", repository_name_pattern: "grp-exam-{team_slug}" },
  ];
  const repos = [{ owner: { login: "PXL-Org" }, name: "grp-lab-krusty-krabs", html_url: "u1", full_name: "PXL-Org/grp-lab-krusty-krabs" }];
  const invites = [{ repository: { owner: { login: "PXL-Org" }, name: "grp-exam-rockets", html_url: "u2", full_name: "PXL-Org/grp-exam-rockets" } }];
  const matched = matchStudentAssignments(all, "Ann", repos, invites);
  assert.deepEqual(matched.map((m) => [m.id, m.stateStatus, m.repoFullName]), [
    ["grp-lab", "provisioned", "PXL-Org/grp-lab-krusty-krabs"],
    ["grp-exam", "invited", "PXL-Org/grp-exam-rockets"],
  ]);
  // The same name in another organization is not this assignment's.
  const elsewhere = [{ owner: { login: "Other-Org" }, name: "grp-lab-krusty-krabs", html_url: "x", full_name: "Other-Org/grp-lab-krusty-krabs" }];
  assert.deepEqual(matchStudentAssignments(all, "Ann", elsewhere, []), []);
});

test("PG5: a more specific assignment in the org explains a name before a team pattern claims it", () => {
  // `grp-{team_slug}` also makes `grp-lab-x`; the assignment whose pattern is
  // `grp-lab-{team_slug}` is the one it belongs to (lib/assignment-collision.mjs).
  const all = [
    { org: "PXL-Org", id: "grp", repository_name_pattern: "grp-{team_slug}" },
    { org: "PXL-Org", id: "grp-lab", repository_name_pattern: "grp-lab-{team_slug}" },
  ];
  const repos = [{ owner: { login: "PXL-Org" }, name: "grp-lab-x", html_url: "u", full_name: "PXL-Org/grp-lab-x" }];
  assert.deepEqual(matchStudentAssignments(all, "Ann", repos, []).map((m) => m.id), ["grp-lab"]);
});

test("the time-left badge", () => {
  const now = new Date("2026-10-14T12:00:00Z");
  assert.deepEqual(timeRemaining(null, now), { text: "", badgeClass: "badge-neutral" });
  assert.deepEqual(timeRemaining("2026-10-14T11:00:00Z", now), { text: "Closed", badgeClass: "badge-error" });
  assert.deepEqual(timeRemaining("2026-10-14T12:30:00Z", now), { text: "30m left", badgeClass: "badge-warning" });
  assert.deepEqual(timeRemaining("2026-10-14T17:00:00Z", now), { text: "5h left", badgeClass: "badge-warning" });
  assert.deepEqual(timeRemaining("2026-10-17T12:00:00Z", now), { text: "3d left", badgeClass: "badge-success" });
});
