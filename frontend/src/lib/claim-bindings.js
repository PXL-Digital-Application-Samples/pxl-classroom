// Who is bound to whom, in the SPA.
//
// Re-exported rather than re-implemented. `lib/claim-bindings.mjs` is
// dependency-free and isomorphic for exactly this reason, the same way
// `frontend/src/lib/deadline.js` brings in `lib/effective-deadline.mjs` and
// `frontend/src/lib/claim.js` brings in `lib/claim.mjs`.
//
// The join between a claim and a roster entry is the email address, and it is
// read on four surfaces at once - this tab's binding column, `roster list`, the
// unclaimed diagnostic and `roster promote`. Four readers of one rule is the
// shape that forked `diffRosters` into two implementations disagreeing on key
// order, and that one is a sibling of this file.
//
// Import from here, never from a hand-rolled email comparison.

export {
  BINDING_STATES,
  indexClaims,
  bindingForEntry,
  rosterBindings,
  orphanClaims,
  claimSummary,
  describeBinding,
} from '../../../lib/claim-bindings.mjs'
