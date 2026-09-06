// Re-exported, not re-implemented - same as `frontend/src/lib/cohort.js`.
//
// The rules live in `lib/roster-harvest.mjs`: what counts as a hint, what may
// be written, and the difference between the two.

export {
  addsInformation,
  emailLocalPart,
  looksLikeEmail,
  harvestFromReports,
  harvestPlan,
  applyHarvest,
} from '../../../lib/roster-harvest.mjs'
