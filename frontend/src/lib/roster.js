// Where the roster lives, in the SPA.
//
// Re-exported rather than re-spelled, the same way `frontend/src/lib/deadline.js`
// and `frontend/src/lib/archive-repo.js` are: `lib/roster-entries.mjs` is
// dependency-free and isomorphic, so exactly one file decides the path.
//
// It was written out by hand in six places here and in four more across the
// backend, the CLI and diagnostics - including the acceptance gate, where the
// wrong path means either admitting the wrong students or rejecting every one
// of them. Import from here, never from a string literal.

export { ROSTER_PATH, ROSTER_SCHEMA_VERSION } from '../../../lib/roster-entries.mjs'
