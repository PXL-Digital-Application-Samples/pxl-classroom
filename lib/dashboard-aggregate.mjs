// PXL Classroom — shared dashboard aggregation.
//
// Computes the per-assignment entry written to reports/dashboard.json.
// Imported by both the nightly report.mjs (Node) and the frontend's
// Live Status refresh (browser via Vite) — one source of truth.

export function buildDashboardEntry(assignment, students) {
  return {
    title: assignment.title,
    state: assignment.state,
    opens_at: assignment.opens_at,
    deadline_at: assignment.deadline_at,
    total_students: students.length,
    accepted: students.filter((s) => s.acceptance_state !== "not-accepted").length,
    provisioned: students.filter((s) => s.repo_id).length,
    on_time: students.filter((s) => s.submission_status === "on-time").length,
    late: students.filter((s) => s.submission_status === "late").length,
    no_submission: students.filter((s) => s.submission_status === "no-submission").length,
    with_warnings: students.filter((s) => Array.isArray(s.warnings) && s.warnings.length > 0).length,
    generated_at: new Date().toISOString(),
  };
}
