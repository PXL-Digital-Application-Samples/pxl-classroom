// Re-exported, not re-implemented - same as `frontend/src/lib/cohort.js`.
//
// The decision lives in `lib/assignment-collision.mjs` because the rules it
// encodes are facts about provision.mjs and preserve.mjs, not about the form.

export {
  repoNameMatcher,
  patternSpecificity,
  collidingRepoNames,
  clashingAssignments,
  assignmentCollisions,
  describeCollisions,
  blockingFindings,
  noteFindings,
  reposInRetiredReport,
  COLLISION_LEAD,
  COLLISION_CONSEQUENCE,
  COLLISION_WARNING_LEAD,
} from '../../../lib/assignment-collision.mjs'
