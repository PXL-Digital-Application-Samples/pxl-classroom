// PXL Classroom - the feedback pull request, shared by its three surfaces.
//
// `scripts/open-feedback-prs.mjs` (workflow), `pxl-classroom feedback open`
// (CLI) and `AssignmentDetailView` (SPA) each open the same pull request over a
// different HTTP stack. Only the transport should differ - and it did not: the
// CLI looked up an existing pull request with `state: "open"`, the script asked
// for `state=all` and took `[0]`, and the SPA had no adopt path at all and
// counted `422 already exists` as a failure. So the same student was adopted,
// mis-adopted or reported broken depending on which button was pressed.
//
// Dependency-free and isomorphic, like lib/seed-teams.mjs, so the SPA bundles it.

/**
 * Does this `POST /pulls` response mean "one is already open"?
 *
 * GitHub answers 422 with the message on `errors[0].message`, and the same 422
 * status carries genuinely different problems - `No commits between …` when the
 * student has not pushed, a disabled-drafts plan, a missing base branch. Keying
 * on the status alone would adopt the wrong thing; keying on the message is
 * what distinguishes them.
 *
 * A CLOSED pull request does not produce this - it does not block a new one,
 * confirmed live on 2026-08-25 - so "already exists" always means an OPEN one,
 * which is why every lookup behind this filters `state=open`.
 */
export function isAlreadyExists(status, data) {
  if (status !== 422) return false;
  const messages = [
    data?.message,
    ...(Array.isArray(data?.errors) ? data.errors.map((e) => e?.message) : []),
  ];
  return messages.some((m) => String(m ?? "").includes("A pull request already exists"));
}

/**
 * The other 422 worth naming: the student has pushed nothing, so `main` and the
 * baseline are the same commit. Not a failure - it is the state every student
 * is in until they start, and the whole reason the PR is opened lazily.
 */
export function isNoCommitsBetween(status, data) {
  if (status !== 422) return false;
  const messages = [
    data?.message,
    ...(Array.isArray(data?.errors) ? data.errors.map((e) => e?.message) : []),
  ];
  return messages.some((m) => /No commits between/i.test(String(m ?? "")));
}

/** Title of the feedback thread, identical on all three surfaces. */
export function feedbackPrTitle(assignment, assignmentId) {
  return `${assignment?.title || assignmentId} - Feedback`;
}

/**
 * Body of the feedback thread. `head` is the submission branch
 * (lib/submission-marker.mjs `submissionBranch`), never a spelled `main`: a
 * `master` template's compare answered 404 for every student, and a
 * full-history copy whose default branch is `develop` beside a `main` branch
 * opened the template's own `main` as every student's work (review
 * 2026-10-14, S1).
 */
export function feedbackPrBody(baseline, head = "main") {
  return [
    "PXL Classroom feedback thread.",
    "",
    `Head: \`${head}\` · Base: \`${baseline}\` (frozen at provisioning).`,
    "",
    `Lecturers leave inline review comments here; the student keeps pushing to \`${head}\`.`,
    "The baseline branch is protected against force-push and delete.",
  ].join("\n");
}
