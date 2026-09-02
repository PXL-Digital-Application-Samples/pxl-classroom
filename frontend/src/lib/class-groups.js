// Which cohort may accept an assignment, in the SPA.
//
// Re-exported rather than re-implemented, the same way
// `frontend/src/lib/roster.js` and `frontend/src/lib/archive-repo.js` are.
// `lib/class-groups.mjs` is dependency-free and isomorphic precisely so the
// admin form and the acceptance gate cannot disagree about who is admitted -
// a form that showed one answer while the gate applied another would be the
// worst possible version of this feature.

export {
  normalizeClassGroup,
  assignmentClassGroups,
  restrictsByClassGroup,
  assignmentAdmitsClassGroup,
  assignmentAdmitsStudent,
  rosterClassGroups,
  studentsExcludedByClassGroup,
} from '../../../lib/class-groups.mjs'
