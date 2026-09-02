// Where a preserved submission lives, in the SPA.
//
// Re-exported rather than re-implemented. `lib/archive-repo.mjs` is
// dependency-free and isomorphic for exactly this reason, the same way
// `frontend/src/lib/deadline.js` brings in `lib/effective-deadline.mjs`.
//
// Before it existed, `https://github.com/${org}/pxl-classroom-archive/tree/...`
// was hand-built in eight places across two components, the CLI and a test that
// re-implemented the builder locally to assert on it. Archives are per
// assignment now, and the repository an existing preservation lives in is read
// off the record rather than derived - neither rule survives being written out
// eight times.
//
// Import from here, never from a hand-rolled template literal.

export {
  LEGACY_ARCHIVE_REPO,
  ARCHIVE_REPO_PREFIX,
  MAX_REPO_NAME_LENGTH,
  archiveRepoName,
  resolveArchiveRepo,
  archiveBranchName,
  archiveRepoUrl,
  archiveBranchesUrl,
  archiveBranchUrl,
  reportArchiveRepo,
} from '../../../lib/archive-repo.mjs'
