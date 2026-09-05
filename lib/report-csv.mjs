// PXL Classroom - the columns of a report CSV, decided once.
//
// TWO SURFACES EXPORT THE SAME REPORT and each kept its own header list:
// `report.mjs` writes the nightly `reports/<id>.csv`, and the Assignment detail
// view's Export CSV writes what is on screen. Both were 35 columns and they
// were not the same 35 - the SPA silently dropped `claimed_email`,
// `claim_verified`, `claim_domain_allowed`, `archive_repo` and `archive_ref`,
// all of them declared report-row fields. ARCHITECTURE said the claim fields
// "reach reports/<id>.json and the CSV export", which was true of the file
// nobody opens and false of the button lecturers press. On an open assignment
// with email confirmation the address is the only record of who accepted.
//
// So the list lives here and both import it. The SPA adds RENDER_JOIN_COLUMNS
// on the end, which is legitimate: those values are not on a report row at all,
// they are joined at render from `grading/<id>/summary.json` and the feedback
// pull-request lookup, and the nightly has nothing to write into them.
//
// EXCLUDED_ROW_COLUMNS is the third of the three, and it is the reason this
// module can be checked rather than trusted: every field the report schema
// declares on a student row is in exactly one of the two lists, so a field
// added to the schema fails `tests/report-csv-columns.test.mjs` until somebody
// says which it is. Ten fields were in neither export and nothing recorded that
// as a decision - it was simply two lists nobody had compared.
//
// Pure and dependency-free: report.mjs imports it directly, the SPA through
// `../../../lib/`.

/**
 * Columns both exports write, in the order the nightly has always used.
 *
 * Order is deliberate rather than alphabetical: identity first, then the cohort
 * and acceptance columns, then the submission evidence in the order a dispute
 * is read - what was on time, what came late, what was last seen, and who the
 * commit says wrote it.
 */
export const REPORT_ROW_COLUMNS = Object.freeze([
  "github_login",
  "team_slug",
  "team_name",
  "student_number",
  "full_name",
  "class_group",
  "acceptance_state",
  "claimed_email",
  "claim_verified",
  "claim_domain_allowed",
  "submission_status",
  "effective_deadline_at",
  "override_applied",
  "override_reason",
  "repo_name",
  "repo_url",
  "last_on_time_sha",
  "last_on_time_observed_at",
  "first_late_sha",
  "first_late_observed_at",
  "latest_observed_sha",
  "latest_observed_at",
  "commit_count",
  // WHO AND WHEN, ACCORDING TO THE COMMIT. The three fields a lecturer wants
  // when a student disputes a submission time, and they were in neither export
  // although collect.mjs has gathered them on every scheduled run for months.
  // `commit_date` is the commit's OWN timestamp - the one deadline
  // classification compares against - not when the collector looked.
  "commit_date",
  "author_name",
  "author_email",
  "uncertainty_interval_seconds",
  "tagged_submission_tag",
  "tagged_submission_sha",
  "tagged_submission_observed_at",
  "tagged_submission_declared_at",
  "lock_down_at",
  "lockdown_delay_seconds",
  "preservation_status",
  "preserved_sha",
  "archive_repo",
  "archive_ref",
  "warnings",
]);

/**
 * Columns only the SPA can write, appended after the row columns.
 *
 * None of these is a report-row field. Grades live in
 * `grading/<id>/summary.json` because two surfaces write them and neither owns
 * the report, and the detail view joins them by login at load time; the
 * feedback pull-request numbers are looked up the same way. The nightly has
 * nothing to put in these, so it does not offer the columns rather than
 * offering them empty.
 */
export const RENDER_JOIN_COLUMNS = Object.freeze([
  "ci_status",
  "earned_points",
  "total_points",
  "feedback_pr_number",
  "feedback_pr_url",
]);

/**
 * Declared student-row fields that are deliberately in neither export.
 *
 * Listed so the omission is a decision with a reason rather than the state both
 * lists were already in. The test pairs this with REPORT_ROW_COLUMNS against
 * the schema, so a new row field cannot quietly join this set.
 */
export const EXCLUDED_ROW_COLUMNS = Object.freeze({
  // Internal GitHub id. `repo_name` and `repo_url` are the two a human uses.
  repo_id: "internal id; repo_name and repo_url are the usable forms",
  // The roster's own column, and the roster has its own CSV export.
  email: "roster field; exported by the Roster tab, and claimed_email is here",
  // Free text, and the SHA beside it is what identifies a commit.
  commit_message: "free text; the sha identifies the commit",
  latest_commit_message: "free text; latest_observed_sha identifies the commit",
  // A near-duplicate of a column already present.
  latest_commit_date: "near-duplicate of commit_date and latest_observed_at",
  // Derived from the late columns already exported.
  late_commit_count: "derived; first_late_sha already says there was late activity",
  // The lock's own result, which belongs to the lockdown record.
  lock_down_outcome: "belongs to the lockdown record; lock_down_at is the report's half",
});
