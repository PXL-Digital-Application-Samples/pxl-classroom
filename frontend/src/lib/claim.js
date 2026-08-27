// Binding a GitHub account to an institutional email address, in the SPA.
//
// Re-exported rather than re-implemented, the same way `deadline.js` brings in
// `effective-deadline.mjs`. `lib/claim.mjs` is isomorphic on WebCrypto for
// exactly this reason: the browser seals a claim with the same module the hub
// opens it with, so the wire format cannot fork between them.
//
// Import from here, never from a hand-rolled encoder.

export {
  CLAIM_DEFAULT_DOMAINS,
  CLAIM_PUBLIC_KEY_LENGTH,
  encryptClaim,
  domainAllowed,
  emailDomain,
  hasWebCrypto,
  normalizeEmail,
  resolveClaimDomains,
} from '../../../lib/claim.mjs'

import claimKeys from '../../../acceptance/claim-keys.json'

/**
 * The hub public key new claims are sealed to, or null when none is configured.
 *
 * BUNDLED AT BUILD TIME rather than fetched. The alternative - reading it from
 * Pages when the student presses Accept - adds a network dependency to the one
 * control that matters, and a failure mode the page would then have to explain.
 * That is the rule the provisioning wait screen already carries: a page may not
 * guess why it is stuck. A rotation costs one redeploy, which
 * deploy-frontend.yml does on its own.
 *
 * Returns null rather than throwing, because this runs inside Vue computeds and
 * a throw there takes the pane down with the control that would fix it - the
 * `localToUtc` bug. The caller renders "claiming is not set up yet" instead.
 */
export function hubClaimKey() {
  // A deployment may supply the key at build time instead of committing it -
  // a fork whose key management lives outside this repository, and what the
  // e2e suite uses so the acceptance seam can be exercised end to end without
  // shipping a key whose private half nobody holds.
  //
  // Precedence, not a second source of truth: this function stays the only
  // reader, so the two places a key can come from cannot disagree about which
  // one is in force.
  const fromEnv = import.meta.env?.VITE_CLAIM_PUBLIC_KEY
  if (typeof fromEnv === 'string' && fromEnv.trim()) {
    return { kid: import.meta.env?.VITE_CLAIM_KID || 'env', publicKey: fromEnv.trim() }
  }

  const current = claimKeys?.current
  if (!current || typeof current !== 'string') return null
  const key = claimKeys?.keys?.[current]
  if (typeof key !== 'string' || !key) return null
  return { kid: current, publicKey: key }
}

/**
 * The body of an acceptance issue.
 *
 * ONE builder for both POST sites. The individual flow in AssignmentView and
 * the group flow in GroupAcceptanceCard each open their own issue, and the hub
 * reads one body with two readers (team fields and claim fields). Two callers
 * assembling that JSON by hand is exactly the shape that forked `diffRosters`
 * and the deadline rule; the fields a body may carry are decided here.
 *
 * Returns "" when there is nothing to say, which is what an individual
 * acceptance on a non-claim assignment sends today.
 */
export function buildAcceptanceBody({ team = null, claim = null } = {}) {
  const payload = {}

  if (team?.team_slug) {
    payload.team_slug = team.team_slug
    payload.team_name = team.team_name ?? ''
    payload.team_action = team.team_action ?? ''
  }

  if (claim?.payload) {
    payload.claim = claim.payload
    // Strictly boolean. The hub reads it as `=== true`, and sending anything
    // else would silently record every claim as unverified.
    payload.claim_verified = claim.verified === true
  }

  return Object.keys(payload).length ? JSON.stringify(payload) : ''
}
