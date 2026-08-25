// The feedback pull request, in the SPA.
//
// Re-exported rather than re-implemented, the same way `deadline.js` brings in
// `lib/effective-deadline.mjs`. This view had NO adopt path: a student who
// already had an open feedback PR the control repo did not know about was
// counted as a failure on every run and never recorded, while the CLI adopted
// them and the workflow script adopted the wrong one.

export {
  isAlreadyExists,
  isNoCommitsBetween,
  feedbackPrTitle,
  feedbackPrBody,
} from '../../../lib/feedback-pr.mjs'
