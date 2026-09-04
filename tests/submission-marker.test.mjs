// PXL Classroom - lib/submission-marker.mjs
//
// The fixtures are the live shapes from PXL-2TIN-CloudEssentials-2627's
// `proef-pe1` on 2026-09-04: a template whose grading job is gated on
// `github.event.head_commit.message == 'einde examen'`, one student with two
// commits, and a check run at each of them - `skipped` at "Initial commit",
// `success` at "einde examen".

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  readSubmissionMarker,
  submissionBranch,
  messageMatchesMarker,
  findMarkedCommit,
} from "../lib/submission-marker.mjs";
import { validateAgainst } from "../lib/validate.mjs";
import { buildAssignmentDoc } from "../lib/assignment-doc.mjs";

const MARKER = { type: "commit_message", value: "einde examen" };

function commit(sha, message, date = "2026-09-02T07:50:04Z") {
  return { sha, commit: { message, committer: { date } } };
}

// -----------------------------------------------------------------------------
// What counts as a marker
// -----------------------------------------------------------------------------

test("an assignment without a marker has none, and that is not a failure", () => {
  // Every assignment written before the field existed. Absent means "every push
  // grades", which is the ordinary GitHub Classroom workflow - there is nothing
  // to fail closed about.
  assert.equal(readSubmissionMarker({}), null);
  assert.equal(readSubmissionMarker(undefined), null);
  assert.equal(readSubmissionMarker({ submission_marker: null }), null);
});

test("an empty or unknown-typed marker is no marker", () => {
  // A blank value would match a commit with an empty message. An unknown type
  // is a marker this code does not know how to look for, and guessing that it
  // means "commit message" would grade the wrong commit.
  assert.equal(readSubmissionMarker({ submission_marker: { type: "commit_message", value: "  " } }), null);
  assert.equal(readSubmissionMarker({ submission_marker: { type: "tag", value: "submit/1" } }), null);
  assert.equal(readSubmissionMarker({ submission_marker: { value: "einde examen" } }), null);
});

test("the marker is read whole and trimmed", () => {
  const marker = readSubmissionMarker({ submission_marker: { type: "commit_message", value: " einde examen " } });
  assert.deepEqual(marker, { type: "commit_message", value: "einde examen", multiple: true });
});

test("handing in again is allowed unless the assignment says otherwise", () => {
  // ABSENT IS `true`, deliberately the opposite direction from the fail-closed
  // defaults elsewhere. A student who hands in, spots a mistake and hands in
  // again has done what handing in again is for; reading an absent field as
  // "only the first counts" would silently grade the version they went back
  // and fixed.
  const read = (multiple) =>
    readSubmissionMarker({ submission_marker: { type: "commit_message", value: "einde examen", multiple } });
  assert.equal(read(undefined).multiple, true);
  assert.equal(read(true).multiple, true);
  assert.equal(read(false).multiple, false);
  // Only an explicit `false` closes it - not a stray falsy value.
  assert.equal(read(0).multiple, true);
});

// -----------------------------------------------------------------------------
// Matching, which has to agree with the workflow's `==`
// -----------------------------------------------------------------------------

test("matching is exact, because the workflow's comparison is", () => {
  assert.equal(messageMatchesMarker("einde examen", MARKER), true);
  // git stores the trailing newline the push payload does not carry.
  assert.equal(messageMatchesMarker("einde examen\n", MARKER), true);

  // Every one of these is a commit the workflow did NOT grade. Matching them
  // here would send the reader to a commit with no grading run on it and
  // report "the workflow was skipped" pointing at the commit the lecturer
  // believes is the hand-in.
  assert.equal(messageMatchesMarker("Einde examen", MARKER), false);
  assert.equal(messageMatchesMarker("einde examen!", MARKER), false);
  assert.equal(messageMatchesMarker("einde examen\n\nfixed the vpc", MARKER), false);
  assert.equal(messageMatchesMarker("", MARKER), false);
  assert.equal(messageMatchesMarker("einde examen", null), false);
});

test("submissionBranch reads the ref, and defaults to main", () => {
  assert.equal(submissionBranch({ submission_ref: "refs/heads/main" }), "main");
  assert.equal(submissionBranch({ submission_ref: "refs/heads/exam/final" }), "exam/final");
  assert.equal(submissionBranch({}), "main");
});

// -----------------------------------------------------------------------------
// The walk
// -----------------------------------------------------------------------------

/** A fake `request(path)`, recording what it was asked. */
function pager(pages, { status = 200 } = {}) {
  const calls = [];
  const request = async (path) => {
    calls.push(path);
    if (status !== 200) return { status, data: null };
    const page = Number(new URL(`https://x${path}`).searchParams.get("page"));
    return { status: 200, data: pages[page - 1] ?? [] };
  };
  return { request, calls };
}

test("the newest marked commit wins, and the walk stops there", async () => {
  const { request, calls } = pager([[
    commit("f".repeat(40), "fix the vpc"),
    commit("4".repeat(40), "einde examen"),
    commit("9".repeat(40), "Initial commit"),
  ]]);

  const res = await findMarkedCommit(request, {
    repoFullName: "Org/proef-pe1-d-ries",
    branch: "main",
    marker: MARKER,
  });

  assert.equal(res.ok, true);
  assert.equal(res.commit.sha, "4".repeat(40));
  assert.equal(res.complete, true);
  assert.equal(calls.length, 1, "one page held the answer");
});

test("a student who pushed after handing in still keeps the hand-in commit", async () => {
  // The whole reason the walk exists. The report names the head commit, the
  // workflow was skipped there, and the score sits two commits back.
  const { request } = pager([[
    commit("a".repeat(40), "oops, typo in the readme"),
    commit("b".repeat(40), "einde examen"),
  ]]);
  const res = await findMarkedCommit(request, { repoFullName: "Org/r", branch: "main", marker: MARKER });
  assert.equal(res.commit.sha, "b".repeat(40));
});

test("the branch is read whole, and the deadline is applied here", async () => {
  // NOT `until=` on the request. Filtering at GitHub would make a late hand-in
  // invisible, and "this student never handed in" and "this student handed in
  // late" are different things to tell a lecturer.
  const { request, calls } = pager([[
    commit("c".repeat(40), "einde examen", "2026-09-02T09:30:00Z"),
    commit("b".repeat(40), "einde examen", "2026-09-02T07:50:04Z"),
  ]]);
  const res = await findMarkedCommit(request, {
    repoFullName: "Org/r",
    branch: "main",
    marker: MARKER,
    until: "2026-09-02T08:00:00.000Z",
  });

  assert.match(calls[0], /sha=main/);
  assert.ok(!calls[0].includes("until="), "the deadline is not GitHub's filter to apply");
  assert.equal(res.commit.sha, "b".repeat(40), "the last hand-in ON OR BEFORE the deadline");
  assert.equal(res.lateCommit.sha, "c".repeat(40), "and the late one is reported, not hidden");
});

test("only a late hand-in is not a hand-in, and says which", async () => {
  const { request } = pager([[commit("c".repeat(40), "einde examen", "2026-09-02T09:30:00Z")]]);
  const res = await findMarkedCommit(request, {
    repoFullName: "Org/r",
    branch: "main",
    marker: MARKER,
    until: "2026-09-02T08:00:00.000Z",
  });
  assert.equal(res.commit, null, "nothing to grade");
  assert.equal(res.lateCommit.sha, "c".repeat(40));
  assert.equal(res.complete, true);
});

test("a hand-in with no readable timestamp cannot be shown to be on time", async () => {
  // Fail closed: guessing in the student's favour would let an unparseable
  // date past the deadline.
  const { request } = pager([[{ sha: "d".repeat(40), commit: { message: "einde examen" } }]]);
  const res = await findMarkedCommit(request, {
    repoFullName: "Org/r",
    branch: "main",
    marker: MARKER,
    until: "2026-09-02T08:00:00.000Z",
  });
  assert.equal(res.commit, null);
  assert.equal(res.lateCommit.sha, "d".repeat(40));
});

test("with no deadline on record, every hand-in counts", async () => {
  const { request } = pager([[commit("c".repeat(40), "einde examen", "2099-01-01T00:00:00Z")]]);
  const res = await findMarkedCommit(request, { repoFullName: "Org/r", branch: "main", marker: MARKER });
  assert.equal(res.commit.sha, "c".repeat(40));
  assert.equal(res.lateCommit, null);
});

// -----------------------------------------------------------------------------
// Handing in more than once
// -----------------------------------------------------------------------------

const THREE_HAND_INS = [
  commit("3".repeat(40), "einde examen", "2026-09-02T07:55:00Z"),
  commit("f".repeat(40), "fix the vpc", "2026-09-02T07:52:00Z"),
  commit("2".repeat(40), "einde examen", "2026-09-02T07:50:00Z"),
  commit("1".repeat(40), "einde examen", "2026-09-02T07:40:00Z"),
];

test("by default the LAST hand-in before the deadline is the one graded", async () => {
  // The point of handing in again: a student who spots a mistake, fixes it and
  // hands in a second time is graded on the fix.
  const { request } = pager([THREE_HAND_INS]);
  const res = await findMarkedCommit(request, {
    repoFullName: "Org/r",
    branch: "main",
    marker: MARKER,
    until: "2026-09-02T08:00:00.000Z",
  });
  assert.equal(res.commit.sha, "3".repeat(40));
  assert.equal(res.complete, true);
});

test("multiple: false grades the FIRST hand-in, and a later one does not replace it", async () => {
  const { request } = pager([THREE_HAND_INS]);
  const res = await findMarkedCommit(request, {
    repoFullName: "Org/r",
    branch: "main",
    marker: { ...MARKER, multiple: false },
    until: "2026-09-02T08:00:00.000Z",
  });
  assert.equal(res.commit.sha, "1".repeat(40));
});

test("the last hand-in is the last ON-TIME one, not the last one", async () => {
  const { request } = pager([[
    commit("9".repeat(40), "einde examen", "2026-09-02T08:40:00Z"),
    ...THREE_HAND_INS,
  ]]);
  const res = await findMarkedCommit(request, {
    repoFullName: "Org/r",
    branch: "main",
    marker: MARKER,
    until: "2026-09-02T08:00:00.000Z",
  });
  assert.equal(res.commit.sha, "3".repeat(40), "the 08:40 hand-in is after the deadline");
  assert.equal(res.lateCommit.sha, "9".repeat(40));
});

test("multiple: false must see the whole branch before it can answer", async () => {
  // The oldest hand-in can always be one page deeper, so a walk that hits its
  // cap has not found it - `complete: false` is what stops the caller
  // recording the oldest one it happened to see.
  const full = Array.from({ length: 100 }, (_, i) => commit(String(i).padStart(40, "0"), `work ${i}`));
  const { request } = pager([[commit("1".repeat(40), "einde examen"), ...full.slice(1)], full, full, full]);
  const res = await findMarkedCommit(request, {
    repoFullName: "Org/r",
    branch: "main",
    marker: { ...MARKER, multiple: false },
  });
  assert.equal(res.complete, false);
  assert.equal(res.commit.sha, "1".repeat(40), "what it saw is still returned - it is just not the answer");
});

test("no marked commit anywhere is a complete answer", async () => {
  const { request } = pager([[commit("9".repeat(40), "Initial commit")]]);
  const res = await findMarkedCommit(request, { repoFullName: "Org/r", branch: "main", marker: MARKER });
  assert.equal(res.ok, true);
  assert.equal(res.commit, null);
  assert.equal(res.complete, true, "a short page is the end of the branch");
});

test("a failed read is not an empty history", async () => {
  // Unreadable is not evidence. `ok: false` is what stops the caller writing
  // "this student never handed in" off a 403.
  const { request } = pager([], { status: 403 });
  const res = await findMarkedCommit(request, { repoFullName: "Org/r", branch: "main", marker: MARKER });
  assert.equal(res.ok, false);
  assert.equal(res.status, 403);
  assert.equal(res.commit, null);
  assert.equal(res.complete, false);
});

test("a walk that hits its cap reports itself incomplete", async () => {
  // 100 unmarked commits per page, three pages, and the cap is three - so this
  // ends without an answer and must not claim one. `complete: false` is what
  // makes the caller say "not found in the N most recent commits".
  const full = Array.from({ length: 100 }, (_, i) => commit(String(i).padStart(40, "0"), `work ${i}`));
  const { request, calls } = pager([full, full, full, full]);
  const res = await findMarkedCommit(request, { repoFullName: "Org/r", branch: "main", marker: MARKER });
  assert.equal(res.ok, true);
  assert.equal(res.commit, null);
  assert.equal(res.complete, false);
  assert.equal(res.scanned, 300);
  assert.equal(calls.length, 3, "the cap is a cap, not a suggestion");
});

// -----------------------------------------------------------------------------
// The field survives the Admin Panel
// -----------------------------------------------------------------------------

test("a marker saved by the Admin Panel validates and round-trips", () => {
  // buildAssignmentDoc rebuilds the document field by field, so a field it does
  // not carry is deleted by the next save of anything else - the invite_token
  // bug. tests/admin-lifecycle-ui.test.mjs enforces the general rule; this
  // checks that what it writes is the shape the reader accepts.
  const doc = buildAssignmentDoc({
    id: "proef-pe1",
    title: "proef PE1",
    organization: "PXL-2TIN-CloudEssentials-2627",
    template: "PXL-2TIN-CloudEssentials-2627/template_proef_PE1",
    repository_name_pattern: "proef-pe1-{github_login}",
    opens_at_local: "2026-09-02T09:37",
    deadline_at_local: "2027-02-28T09:37",
    student_permission: "admin",
    acceptance_mode: "self-service",
    roster_mode: "open",
    max_acceptances: 150,
    late_policy: "report",
    state: "published",
    submission_marker_value: " einde examen ",
  });

  // `multiple` is written explicitly, both ways: the reader defaults an absent
  // field to `true`, so a `false` that is not on the document quietly re-allows
  // handing in again on the next read.
  assert.deepEqual(doc.submission_marker, { type: "commit_message", value: "einde examen", multiple: true });
  const { valid, errors } = validateAgainst("assignment", doc);
  assert.equal(valid, true, `the saved document must validate: ${JSON.stringify(errors)}`);
  assert.deepEqual(readSubmissionMarker(doc), { ...MARKER, multiple: true });
});

test("only-once survives the save, which is the whole point of writing it down", () => {
  const doc = buildAssignmentDoc({
    id: "one-shot",
    title: "One Shot",
    submission_marker_value: "einde examen",
    submission_marker_multiple: false,
  });
  assert.equal(doc.submission_marker.multiple, false);
  assert.equal(readSubmissionMarker(doc).multiple, false);
});

test("a blank field writes no marker at all", () => {
  // Not `{ type: 'commit_message', value: '' }`: absent means every push
  // grades, and the schema's minLength would refuse the empty one anyway.
  const doc = buildAssignmentDoc({ id: "x", title: "x", submission_marker_value: "   " });
  assert.equal("submission_marker" in doc, false);
});
