// Re-exported, not re-implemented - same as `frontend/src/lib/cohort.js`.
//
// The decision lives in `lib/repo-unlock.mjs`, and the operation it drives is
// `lib/submission-lock.mjs`'s own `ensureSubmissionLock` - the module that
// applied the lock in the first place, passed in as a parameter rather than
// re-written here. A second implementation of "flip this ruleset" is exactly
// the fork this repository keeps paying for.

export {
  lockdownRowFor,
  unlockability,
  unlockRecord,
  applyUnlock,
} from '../../../lib/repo-unlock.mjs'
