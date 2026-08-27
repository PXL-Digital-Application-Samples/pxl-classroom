// PXL Classroom CLI - ajv schema validator.
//
// Re-exported rather than re-implemented, the way the SPA's
// `frontend/src/lib/*.js` bring in the isomorphic modules. This file used to
// hold its own copy of `validateAgainst`, byte-identical to the one in
// `lib/validate.mjs` except for the relative path it walked to reach
// `schemas/` - and both walks landed in the SAME directory, so the two were
// one function maintained in two places. That is the shape that forked
// `diffRosters` into two implementations disagreeing on key order.
//
// The CLI already imports eight modules from the repo root (`lib/audit.mjs`,
// `lib/archive-repo.mjs`, `lib/promote-roster.mjs` and the rest), so there was
// never a packaging reason for a second copy: the package is `private: true`
// and its schema reads already resolve outside its own directory.
//
// Import from here or from `lib/validate.mjs` - they are the same function,
// the same ajv instance and the same compiled-schema cache.

export { validateAgainst } from "../../../lib/validate.mjs";
