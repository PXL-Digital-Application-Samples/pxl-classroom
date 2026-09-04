// The grading workflow written into a lecturer's TEMPLATE repository, in the SPA.
//
// Re-exported rather than re-implemented, the same way `check-run-score.js`
// brings in the score parser. `lib/starter-workflow.mjs` depends on `yaml` and
// nothing else, which is a dependency of the SPA already.

export {
  STARTER_PATH,
  buildStarterWorkflow,
  isGradingWorkflow,
  readGateMessage,
} from '../../../lib/starter-workflow.mjs'
