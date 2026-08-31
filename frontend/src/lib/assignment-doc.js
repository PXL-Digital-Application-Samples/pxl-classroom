// The assignment document the Admin Panel writes, in the SPA.
//
// Re-exported rather than re-implemented, the same way
// `frontend/src/lib/archive-repo.js` brings in `lib/archive-repo.mjs`.
// `lib/assignment-doc.mjs` is isomorphic and reaches deployment.yml through
// `#deployment`, so the Admin Panel and `tests/contract-form-diagnostics.test.mjs`
// build the identical document - which is the whole point: that test used to
// carry a hand-maintained COPY of the builder, and the copy had quietly stopped
// emitting the signed-acceptance keypair, claim_domains, autograde and
// feedback_pr.
//
// Import from here, never re-derive it.

export {
  buildAssignmentDoc,
  localToUtc,
  utcToLocalInput,
  preserveOrLocal,
} from '../../../lib/assignment-doc.mjs'
