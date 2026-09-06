// PXL Classroom - one spelling of an email address.
//
// Extracted from `lib/claim.mjs`, which re-exports it so no caller changed.
// It lived there because a claim is where an address is first read, and that
// was fine until `lib/cohort.mjs` needed it: cohort.mjs is on the graph of
// `scripts/scaffold-control-repo.mjs`, which `setup-org.yml` runs with NO
// `npm ci`, and pulling 470 lines of ECDH and AES-GCM onto that path for a trim
// and a lowercase is not what "dependency-free" was protecting.
//
// A second copy in cohort.mjs was the other option and the worse one. An
// address typed `A.Nother@Student.PXL.be` and one dispatched lowercase are one
// person, and two functions deciding that separately is how they come to
// disagree - the same reason `lib/github-login.mjs` exists as its own module
// rather than as a `.toLowerCase()` at each call site.

/**
 * An address, trimmed and lowercased, or "" when it cannot be one.
 *
 * DELIBERATELY LOOSE: one `@`, something either side, a dot in the domain, no
 * whitespace. Real validation is the roster match (under `claim`) or the domain
 * list (under `open`); this only rejects input that is not an address at all.
 * Tightening it here would refuse addresses that exist.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeEmail(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return "";
  return trimmed;
}
