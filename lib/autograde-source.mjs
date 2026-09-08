// PXL Classroom - where an assignment's grading comes from.
//
// Its own module because THREE surfaces ask the same question and one of them
// is a workflow: the Admin Panel decides which controls to show, the per-row
// re-grade decides whether it is offered, and scripts/grade-at-deadline.mjs
// decides whether to read anything at all. Asking it differently in the
// workflow is how a nightly comes to name every student in a cohort as a
// grading failure on an assignment that grades nothing.
//
// Dependency-free and isomorphic: `frontend/src/lib/autograde.js` re-exports
// it, the way `deadline.js` re-exports lib/effective-deadline.mjs.

/**
 * Does this assignment grade in GitHub Actions, so that a control which READS a
 * check run means anything on it?
 *
 * ABSENT IS NOT "YES". The detail view asked `!localRunnerDeclared`, and
 * `localRunnerDeclared` can only be true when autograding is declared - so an
 * assignment with no autograding at all answered `true`, and every CI grading
 * control appeared on it. Pressing one read the check runs at every student's
 * commit, found none, and reported one failure per student over an assignment
 * that has never graded anything. A double negative asked of a tri-state.
 *
 * The document could not tell the two "off" states apart. AutogradeModal wrote
 * `enabled: false, tests: []` both for "the checks come with my template" and
 * for "remove all", discarding the answer the lecturer had just given.
 * `template_grades` records it now - a CHOICE, not a probe of the template,
 * which is why it is allowed to be stored where the editor's live look is not.
 *
 * For a document saved before that field existed, POSITIVE EVIDENCE decides:
 * something that exists only when there is a grading run to read. Never the
 * absence of a signal, which is the defect being fixed. The consequence is
 * deliberate and worth stating: a template-graded assignment in "on every push"
 * mode that has never been graded shows no control until it is re-saved or a
 * student's CI status is refreshed into view.
 *
 * @param {object} assignment  the assignment document
 * @param {object} evidence
 * @param {boolean} evidence.hasGrades      grading/<id>/summary.json has rows
 * @param {boolean} evidence.anyCiStatus    some student's row carries a check conclusion
 * @param {boolean} evidence.hasSubmissionMarker  readSubmissionMarker() found one
 * @returns {boolean}
 */
export function gradesInCi(assignment, { hasGrades = false, anyCiStatus = false, hasSubmissionMarker = false } = {}) {
  const autograde = assignment?.autograde
  const declared = autograde?.enabled === true

  // Graded off-platform. A definite no rather than an absence: the lecturer
  // runs these, and no check run will ever exist to read.
  if (declared && autograde?.execution_environment !== 'github_actions') return false
  if (declared) return true

  // The lecturer's own answer, once they have been asked. Top level, because
  // the autograde block means "checks defined here" and a template-graded
  // assignment has none to put in it. Three states: `false` is an answer and
  // ends it, `null`/absent means nobody was asked and falls through.
  if (assignment?.template_grades === true) return true
  if (assignment?.template_grades === false) return false

  // Older documents: only positive signals.
  if (hasGrades) return true
  // A hand-in message names the commit whose GRADING RUN to read. It has no
  // other purpose, so setting one says this assignment grades.
  if (hasSubmissionMarker) return true
  return Boolean(anyCiStatus)
}
