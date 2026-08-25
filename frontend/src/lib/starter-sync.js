// Planning a starter code sync, in the SPA.
//
// Re-exported rather than re-implemented, the same way `deadline.js` brings in
// `lib/effective-deadline.mjs`. The pre-flight scan in `StarterSyncModal` has
// to classify a student exactly as `scripts/sync-starter.mjs` will, or the
// modal promises one thing and the workflow does another - which is how the
// file checkboxes ended up decorative while the operation merged the whole
// template tree.

export {
  changedPaths,
  resolveSelection,
  planStarterSync,
  outcomeFor,
} from '../../../lib/starter-sync.mjs'
