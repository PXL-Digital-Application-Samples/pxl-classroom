// The sentence behind a submission status, executed rather than described.
//
// THE TOOLTIP THIS TESTS IS A CHECK ON THE LABEL BESIDE IT.
//
// `submission_status` is one word and a lecturer cannot tell whether it is
// right. On PXL-Automation-II/2526-examen-aut2-ek2 two students read `late`
// whose last commits were 6h50m and 54m BEFORE the deadline (2026-09-02), and
// nothing on screen contradicted it. This is the text that would have.

import { test } from "node:test";
import assert from "node:assert/strict";

import { describeSubmission } from "../frontend/src/lib/submission-detail.js";

test("a commit before the deadline says BEFORE - the exam's two rows", () => {
  // The precise rows that were mislabelled. The tooltip has to contradict the
  // word `late` beside it, or it is not a check on anything.
  assert.equal(
    describeSubmission({
      deadline: "2026-08-30T20:00:00Z",
      latestCommitDate: "2026-08-30T13:10:30Z",
    }),
    "Last commit 6h 49m before the deadline.",
  );
  assert.equal(
    describeSubmission({
      deadline: "2026-08-30T20:00:00Z",
      latestCommitDate: "2026-08-30T19:05:41Z",
    }),
    "Last commit 54m before the deadline.",
  );
});

test("a commit after the deadline says AFTER", () => {
  assert.equal(
    describeSubmission({
      deadline: "2026-08-30T20:00:00Z",
      latestCommitDate: "2026-09-02T00:42:20Z",
    }),
    "Last commit 2d 4h after the deadline.",
  );
});

test("the late commit count is appended when it is known", () => {
  const out = describeSubmission({
    deadline: "2026-08-30T20:00:00Z",
    latestCommitDate: "2026-09-02T00:42:20Z",
    lateCommitCount: 3,
  });
  assert.match(out, /after the deadline\./);
  assert.match(out, /3 commits after the deadline\./);
});

test("one late commit is singular", () => {
  const out = describeSubmission({
    deadline: "2026-08-30T20:00:00Z",
    latestCommitDate: "2026-09-02T00:42:20Z",
    lateCommitCount: 1,
  });
  assert.match(out, /1 commit after the deadline\./);
});

test("zero is 'none', and null is SILENCE - they are different answers", () => {
  // The rule this file exists to hold. A count of 0 is evidence that nothing
  // landed late. A count of null is the ABSENCE of evidence - an assignment
  // collected before the field existed, or a request GitHub would not answer -
  // and saying "No commits after the deadline" there is a green light nobody
  // earned. Unreadable is not evidence.
  const zero = describeSubmission({
    deadline: "2026-08-30T20:00:00Z",
    latestCommitDate: "2026-08-30T13:10:30Z",
    lateCommitCount: 0,
  });
  assert.match(zero, /No commits after the deadline\./);

  const unknown = describeSubmission({
    deadline: "2026-08-30T20:00:00Z",
    latestCommitDate: "2026-08-30T13:10:30Z",
    lateCommitCount: null,
  });
  assert.doesNotMatch(unknown, /commits after the deadline/);
  assert.match(unknown, /before the deadline\./, "the distance is still said");
});

test("a commit exactly on the deadline is before it, not after", () => {
  // countdownParts treats diff <= 0 as passed, and a hand-in at the stroke of
  // the deadline is on time. The wording must not accuse it.
  assert.match(
    describeSubmission({
      deadline: "2026-08-30T20:00:00Z",
      latestCommitDate: "2026-08-30T20:00:00Z",
    }),
    /before the deadline\./,
  );
});

test("nothing truthful to say is an empty string, not a guess", () => {
  assert.equal(describeSubmission({}), "");
  assert.equal(describeSubmission({ deadline: "2026-08-30T20:00:00Z" }), "");
  assert.equal(describeSubmission({ latestCommitDate: "2026-08-30T13:10:30Z" }), "");
  assert.equal(
    describeSubmission({ deadline: "nonsense", latestCommitDate: "2026-08-30T13:10:30Z" }),
    "",
    "an unparseable deadline yields no sentence rather than NaN",
  );
});
