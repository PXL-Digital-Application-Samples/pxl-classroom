// Who an assignment is for, in the SPA.
//
// Re-exported rather than re-implemented, the same way
// `frontend/src/lib/roster.js` and `frontend/src/lib/archive-repo.js` are.
// `lib/cohort.mjs` is dependency-free and isomorphic precisely so the picker and
// the acceptance gate cannot disagree about who is admitted - a form that showed
// one answer while the gate applied another would be the worst possible version
// of this feature.

export {
  rosterIdentities,
  cohortIdentity,
  assignmentCohort,
  normalizeCohortEntry,
  restrictsCohort,
  assignmentAdmitsStudent,
  cohortStudents,
  danglingCohortEntries,
} from '../../../lib/cohort.mjs'
