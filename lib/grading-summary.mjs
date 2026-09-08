// PXL Classroom - the shape of `grading/<id>/summary.json`.
//
// TWO SURFACES WRITE THIS FILE and the schema says so in its own description:
// `pxl-classroom grade` and the Admin Panel's read of GitHub Actions check
// runs. They built the envelope from two hand-written literals and the rows
// from two more, and the rows were not the same rows - the Admin Panel wrote
// `ci_status`, `ci_run_url` and `score_source`, and the CLI wrote none of the
// three even on the identical Actions path. Same file, same assignment, two
// shapes depending on which button a lecturer pressed.
//
// That is the defect `lib/report-csv.mjs` exists to have ended for the CSV
// exports, one document over: two lists that must agree with nothing deriving
// either from the other. So the builders live here and both callers import
// them.
//
// Dependency-free and isomorphic: the SPA bundles this, the CLI imports it
// from the repository root like the eight other shared modules it already uses.

/**
 * One graded student, as read from a GitHub Actions check run.
 *
 * `parsed` is `lib/check-run-score.mjs`'s verdict and `run` the check run it
 * came from; everything here is derived from those two rather than restated, so
 * a new field on the parse reaches both writers or neither.
 *
 * `fallbackTotal` covers a parse that found a score but no denominator - the
 * assignment's own total is a better answer than 0, and it is what both callers
 * already passed in.
 */
export function gradedRowFromCheckRun({ login, parsed, run, fallbackTotal = 0, gradedAt = null }) {
  return {
    login,
    earned_points: parsed.earned,
    total_points: parsed.total > 0 ? parsed.total : fallbackTotal,
    // The check run's own conclusion. Recorded because "0 out of 20" and "the
    // run never finished" are different facts and the student table shows them
    // differently.
    ci_status: run?.conclusion || run?.status || "completed",
    // Where the per-check breakdown lives, and nowhere else: check-run
    // annotations carry a grand total only.
    ci_run_url: run?.html_url || run?.details_url || null,
    // WHERE THE NUMBER CAME FROM. `conclusion` means nothing reported a score
    // and all that is known is whether the run went green - a legitimate answer
    // for a template workflow with no reporter in it, and also what a grading
    // job that died before reaching the student's code produces. The numbers
    // are identical; this is the only thing that separates them.
    score_source: parsed.source,
    graded_at: gradedAt || new Date().toISOString(),
  };
}

/**
 * One graded student, as measured by a runner on the lecturer's own machine.
 *
 * Deliberately sparser: there is no check run to describe, so the ci_* fields
 * and `score_source` are absent rather than filled with a plausible-looking
 * value. `runner` on the envelope already says which path produced the file.
 */
export function gradedRowFromLocalRun({ login, earnedPoints, totalPoints, gradedAt = null }) {
  return {
    login,
    earned_points: earnedPoints,
    total_points: totalPoints,
    graded_at: gradedAt || new Date().toISOString(),
  };
}

/**
 * The document itself.
 *
 * Callers still validate against `grading-summary.schema.json` before
 * committing - both of them now - because a builder can only guarantee the
 * shape it was given, and `students` arrives from a loop.
 */
export function buildGradingSummary({ assignmentId, gradedBy, runner, students, failed = [] }) {
  return {
    schema_version: 1,
    assignment_id: assignmentId,
    generated_at: new Date().toISOString(),
    graded_by: gradedBy ?? null,
    runner,
    students,
    failed,
  };
}
