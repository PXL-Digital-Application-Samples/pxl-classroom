// The deadline that applies to one student, in the SPA.
//
// Re-exported rather than re-implemented. `lib/effective-deadline.mjs` is
// dependency-free and isomorphic for exactly this reason, the same way
// `frontend/src/lib/invite.js` brings in `lib/invite-token-format.mjs`.
//
// It is re-exported because the SPA had forked the rule three ways. The backend
// takes the LAST entry of the append-only history; AdminView and
// AssignmentDetailView agreed (`.filter(...).pop()`), but AssignmentView and
// GroupAcceptanceCard used `.find()` - the FIRST. A student granted a second
// extension was shown, and counted down to, a deadline that had already been
// superseded: told they had less time than they did. AssignmentView also
// replaced the deadline with the override unconditionally, so a value earlier
// than the assignment's own would have shortened it on screen, which the shared
// rule refuses.
//
// Import from here, never from a hand-rolled filter.

export {
  DEADLINE_EXTENSION,
  effectiveDeadlineFor,
  extensionFrom,
  indexOverrides,
  latestEffectiveDeadline,
} from '../../../lib/effective-deadline.mjs'
