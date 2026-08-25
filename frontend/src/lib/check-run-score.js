// Reading a grade out of a GitHub check run, in the SPA.
//
// Re-exported rather than re-implemented, the same way `deadline.js` brings in
// `lib/effective-deadline.mjs` and `invite.js` brings in
// `lib/invite-token-format.mjs`. `lib/check-run-score.mjs` is dependency-free
// for exactly this reason.
//
// It is re-exported because `AssignmentDetailView` and
// `cli/src/commands/grade.mjs` each held a byte-identical private copy of the
// parser, both of them looking for the score in `output.summary` - where a
// GitHub Actions check run never puts it. Import from here, never from a
// hand-rolled `Points X/Y` match.

export { parseCheckRunScore, pickAutogradeCheckRun } from '../../../lib/check-run-score.mjs'
export { fetchCheckRunAnnotations } from '../../../lib/check-run-annotations.mjs'
