// PXL Classroom - shared dashboard aggregation.
//
// Computes the per-assignment entry written to reports/dashboard.json.
// Imported by both the nightly report.mjs (Node) and the frontend's
// Live Status refresh (browser via Vite) - one source of truth.

import { assignmentIdFromFile, SCAFFOLD_KEEPFILE } from "./control-layout.mjs";

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

/**
 * The half of the entry that comes from the assignment DOCUMENT rather than
 * from a report row.
 *
 * Split out because the document can change without the report being
 * regenerated, and then `reports/dashboard.json` is simply wrong. Closing or
 * archiving an assignment from the Admin Panel writes the YAML and dispatches
 * nothing - only `publish-assignment.yml` asks for a regeneration - so an
 * archived cohort went on reading "accepting" on the overview, and the nightly
 * that would have corrected it disables itself once nothing is active. Nothing
 * was ever going to fix it (reported 2026-09-04).
 *
 * Whoever repairs an entry in place patches THESE fields and leaves the counts
 * alone, because the counts did not change. One list, so a field added to the
 * entry cannot be forgotten by the repair - `tests/dashboard-entry-inputs.test.mjs`
 * derives one from the other rather than keeping a second copy.
 */
export function assignmentFacts(assignment) {
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
  };
}

/**
 * Drop dashboard entries whose assignment no longer exists.
 *
 * `reports/dashboard.json` used to be append-only: every run added or updated
 * the entry for its own assignment and nothing removed one. Delete an
 * assignment and its card stayed on the lecturer's dashboard for ever, linking
 * to a detail page whose YAML and report both 404 - `phasea-live-sysex` on
 * PXL-Systems-Expert, and it took the page down before the view learned to
 * guard itself.
 *
 * The Admin Panel's own delete removes the entry in the same commit. This is
 * the net under everything else - a YAML deleted by hand, a half-finished
 * cleanup - and it lived inside `report.mjs`, which meant it ran only as a
 * SIDE EFFECT of generating some other assignment's report. `generate-interim-
 * reports.mjs` runs reports for `published` and `closed` assignments only, so
 * an organization whose remaining assignments are all draft or archived never
 * reconciled at all, and a stale card sat there indefinitely. Found on
 * pxl-classroom-testbed on 2026-09-07, whose one surviving assignment is
 * archived.
 *
 * UNREADABLE IS NOT EVIDENCE. Only a directory that was actually listed is
 * grounds for deciding an assignment is gone; a failed read would otherwise
 * delete every card in the organization, which is far worse than the stale card
 * this fixes. A caller that could not list passes null, and nothing is pruned.
 *
 * EMPTY IS A DIFFERENT ANSWER, and treating it as a second kind of unreadable
 * cost the organization that deletes its LAST assignment: one left and it
 * reconciled fine, zero and the card stayed for ever, because a listing with no
 * ids in it was refused exactly like a listing nobody could take. That is the
 * one case where the net is the only thing left - there is no other assignment
 * whose run would remove it.
 *
 * `.gitkeep` is what separates the two, which is why this takes the LISTING and
 * not a set of ids. `scripts/scaffold-control-repo.mjs` writes one into every
 * scaffold directory, so a control repo that can be read at all has one here:
 * present-and-empty carries the marker, and a listing that is empty AND carries
 * nothing at all is a read that told us nothing and prunes nothing. Failing
 * that way round means the worst an unforeseen empty listing can do is leave a
 * stale card, which is the state this function exists to improve on rather than
 * a new way to lose a live cohort's.
 *
 * @param {object} dashboard the parsed dashboard document
 * @param {Iterable<string>|null} listing the NAMES in `assignments/` as read
 *        (`<id>.yml` plus the scaffold's `.gitkeep`), or null if unread
 * @param {{keep?: string|null}} [opts] an id to keep regardless - the one a
 *        caller has just written, which is on disk by definition
 * @returns {{dashboard: object, pruned: string[]}}
 */
export function pruneMissingAssignments(dashboard, listing, { keep = null } = {}) {
  const entries = dashboard?.assignments;
  if (!entries || typeof entries !== "object") return { dashboard, pruned: [] };
  if (!listing) return { dashboard, pruned: [] };

  const names = [...listing];
  const present = new Set(names.map(assignmentIdFromFile).filter(Boolean));
  if (present.size === 0 && !names.includes(SCAFFOLD_KEEPFILE)) return { dashboard, pruned: [] };

  const pruned = Object.keys(entries).filter((id) => id !== keep && !present.has(id));
  if (pruned.length === 0) return { dashboard, pruned };

  const kept = { ...entries };
  for (const id of pruned) delete kept[id];
  return { dashboard: { ...dashboard, assignments: kept }, pruned };
}

export function buildDashboardEntry(assignment, students) {
  return {
    ...assignmentFacts(assignment),
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
