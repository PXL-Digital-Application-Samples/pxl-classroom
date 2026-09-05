// Class groups in the SPA: a roster property, and the picker's filter.
//
// Re-exported rather than re-implemented, the same way
// `frontend/src/lib/roster.js` and `frontend/src/lib/archive-repo.js` are.
//
// The gate that used to live behind this shim is in `frontend/src/lib/cohort.js`
// now. Class groups decide nothing; they are how a lecturer finds the students
// they want to tick.

export {
  normalizeClassGroup,
  rosterClassGroups,
  studentInClassGroup,
  classGroupCounts,
} from '../../../lib/class-groups.mjs'
