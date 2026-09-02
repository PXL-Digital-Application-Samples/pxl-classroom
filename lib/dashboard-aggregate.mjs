// PXL Classroom - shared dashboard aggregation.
//
// Computes the per-assignment entry written to reports/dashboard.json.
// Imported by both the nightly report.mjs (Node) and the frontend's
// Live Status refresh (browser via Vite) - one source of truth.

/**
 * How many students have accepted.
 *
 * A report row exists for every student on the roster, accepted or not - which
 * is why this is a filter and not `students.length`. It was written out twice:
 * here, and again in AssignmentDetailView as
 *
 *     s.repo_name || s.acceptance_state === 'accepted' || s.status !== 'no-submission'
 *
 * The report schema has `submission_status` and is `additionalProperties: false`,
 * so `s.status` was never a field - `undefined !== 'no-submission'` is true, the
 * `||` chain short-circuited on every row, and the view's count was the whole
 * cohort. The same file wrote THIS number to reports/dashboard.json while
 * showing that one on screen, so one assignment had two accepted counts.
 *
 * Exported so there is one predicate rather than a rule people re-spell.
 */
export function countAccepted(students) {
  return (students || []).filter((s) => s.acceptance_state !== "not-accepted").length;
}

export function buildDashboardEntry(assignment, students) {
  return {
    title: assignment.title,
    state: assignment.state,
    opens_at: assignment.opens_at,
    deadline_at: assignment.deadline_at,
    timezone: assignment.timezone,
    // The cap, so a surface holding only this entry can tell "live" from "cap
    // reached" without re-reading the assignment YAML. An assignment with no cap
    // has no cap - null, never a substituted number.
    max_acceptances: assignment.max_acceptances ?? null,
    total_students: students.length,
    accepted: countAccepted(students),
    provisioned: students.filter((s) => s.repo_id).length,
    on_time: students.filter((s) => s.submission_status === "on-time").length,
    late: students.filter((s) => s.submission_status === "late").length,
    no_submission: students.filter((s) => s.submission_status === "no-submission").length,
    // ONLY the fault the detail view still shows, and the only one a lecturer
    // can act on. `accepted-not-provisioned` restates the acceptance column and
    // `late-activity-detected` fires only where the status already reads
    // `late`; both left the detail table on 2026-09-02, so counting them here
    // sent a lecturer to a page that had nothing to show them.
    with_repo_faults: students.filter((s) =>
      Array.isArray(s.warnings) && s.warnings.includes("missing-repo-id")).length,
    generated_at: new Date().toISOString(),
  };
}
