// A repository invitation the page cannot see is still a repository invitation.
//
// PXL-Automation-II/test-pe3, 3 Sep 2026. The student accepted, the repository
// was created, and GitHub held a pending invitation for them:
//
//     GET /repos/PXL-Automation-II/test-pe3-tomccargo/invitations
//     -> [{ invitee: "tomccargo", permissions: "admin",
//           created_at: "2026-09-03T08:53:01Z" }]
//
// Signed in as that same account, `GET /user/repository_invitations` answered
// 200 without it. The acceptance page read that as "there is no invitation",
// told the student "GitHub has no repository for you and no invitation
// waiting", and the diagnostics modal called the invitation check "Clear".
//
// So the premise the old code reasoned from - that an answer without a match
// means there is nothing to accept - is false, and every conclusion the page
// drew from it was wrong in the one direction that strands a student.
//
// These tests pin the replacement: A MATCH IS THE ONLY PROOF.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  invitationEvidence,
  mayOfferInvitationLink,
} from "../frontend/src/lib/invitation-evidence.js";

const ORG = "PXL-Automation-II";
const REPO = "test-pe3-tomccargo";

const inv = (owner, name) => ({
  id: 331548511,
  repository: {
    name,
    full_name: `${owner}/${name}`,
    html_url: `https://github.com/${owner}/${name}`,
    owner: { login: owner },
  },
});

const answered = (list) => ({ ok: true, status: 200, data: list });

test("a match is proof, and is handed back whole", () => {
  const res = answered([inv("other-org", "something-else"), inv(ORG, REPO)]);
  const e = invitationEvidence(res, { org: ORG, repo: REPO });
  assert.equal(e.proven, true);
  assert.equal(e.answered, true);
  assert.equal(e.invitation.id, 331548511);
  assert.equal(e.invitation.repository.full_name, `${ORG}/${REPO}`);
});

test("THE INCIDENT: an answer with no match proves nothing", () => {
  // The whole fix. `proven` false must be read as "unknown", never as "none" -
  // this is the exact response the live page got while the invitation above
  // was sitting unaccepted.
  const e = invitationEvidence(answered([]), { org: ORG, repo: REPO });
  assert.equal(e.invitation, null);
  assert.equal(e.proven, false, "an empty list is not evidence that no invitation exists");
  // `answered` records what happened; it is deliberately NOT a conclusion, and
  // nothing may branch on it to claim there is no invitation.
  assert.equal(e.answered, true);
});

test("an unmatched answer and a failed read reach the same conclusion", () => {
  // They differ in what happened and agree in what may be said, which is the
  // property the old three-branch reasoning did not have.
  const empty = invitationEvidence(answered([]), { org: ORG, repo: REPO });
  const failed = invitationEvidence({ ok: false, status: 403, data: { message: "Forbidden" } }, {
    org: ORG,
    repo: REPO,
  });
  assert.equal(empty.proven, failed.proven);
  assert.equal(empty.invitation, failed.invitation);
  assert.equal(failed.answered, false);
});

test("a list of other people's invitations proves nothing about this one", () => {
  const res = answered([inv("other", "other-course-1"), inv("other", "other-course-2")]);
  assert.equal(invitationEvidence(res, { org: ORG, repo: REPO }).proven, false);
});

test("owner and repository name are matched case-insensitively", () => {
  // GitHub hands back whichever spelling the surface that answered happens to
  // use, and a login is compared lowercased everywhere in this repo. Matching
  // the raw strings would have turned a real invitation into "none" - the same
  // wrong answer by a different route.
  const res = answered([inv("pxl-automation-ii", "TEST-pe3-TomCcargo")]);
  const e = invitationEvidence(res, { org: ORG, repo: REPO });
  assert.equal(e.proven, true, "PXL-Automation-II and pxl-automation-ii are one org");
});

test("a missing target does not match a malformed invitation", () => {
  // Both sides empty must not compare equal - that would be a match invented
  // out of two absences.
  const res = answered([{ repository: { name: "", owner: { login: "" } } }]);
  assert.equal(invitationEvidence(res, { org: "", repo: "" }).proven, false);
});

test("junk in, no crash and no proof", () => {
  for (const res of [null, undefined, {}, { ok: true, data: null }, { ok: true, data: "nope" }]) {
    const e = invitationEvidence(res, { org: ORG, repo: REPO });
    assert.equal(e.proven, false);
    assert.equal(e.answered, false);
  }
});

test("the guessed link is offered exactly while nothing is proven", () => {
  const url = `https://github.com/${ORG}/${REPO}/invitations`;
  assert.equal(mayOfferInvitationLink(false, url), true, "unknown is when the link is worth having");
  assert.equal(
    mayOfferInvitationLink(true, url),
    false,
    "a proven invitation is held in-app with a real Accept button - the guess would be a worse copy of it",
  );
  for (const missing of [null, undefined, ""]) {
    assert.equal(mayOfferInvitationLink(false, missing), false, "nowhere to send them");
  }
});
