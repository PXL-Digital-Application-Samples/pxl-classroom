// Reading autograding scores back out of GitHub, in the SPA.
//
// Re-exported rather than re-implemented, the same way `check-run-score.js`
// brings in `lib/check-run-score.mjs`. The orchestration below - which commit
// to read, what a hand-in message changes, and the three refusals that stop a
// partial result being written over real grades - lived INSIDE
// AssignmentDetailView.vue, where nothing could import it and no test could run
// it. `scripts/grade-at-deadline.mjs` needs the same answers.
export { gradeCohort, gradeStudent, gradingCommitFor, readScoreAtCommit } from '../../../lib/grade-cohort.mjs'
