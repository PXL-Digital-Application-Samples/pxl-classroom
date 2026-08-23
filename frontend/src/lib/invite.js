// PXL Classroom - invitation links, browser side.
//
// The SPA never verifies a token: verification belongs on the broker, which is
// the thing with something to protect. Here the token is only a bearer string
// to carry into the acceptance issue, plus enough of the wire format to work
// out WHICH assignment a link refers to - the subject is a hash, so the id is
// not readable from the link.
//
// The format module is shared with the broker and the hub deliberately. A
// second copy of the subject rule here would be a token format that forks in
// half the first time either side changed.

import {
  TOKEN_PATTERN,
  parseToken,
  subjectInput,
  subjectFromDigest,
  subjectsMatch,
} from '../../../lib/invite-token-format.mjs'

export { TOKEN_PATTERN }

export function isInviteToken(value) {
  return typeof value === 'string' && TOKEN_PATTERN.test(value)
}

async function subjectFor(org, assignmentId) {
  const bytes = new TextEncoder().encode(subjectInput(org, assignmentId))
  return subjectFromDigest(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
}

/**
 * Find which of an org's published assignments a token was minted for.
 *
 * The token carries sha256("<org>/<id>") truncated to 16 bytes, so the id
 * cannot be read back out - it has to be matched against the candidates. That
 * is the point: a link does not advertise what it opens.
 *
 * @returns the matching assignment, or null.
 */
export async function resolveAssignmentFromToken(token, org, assignments) {
  const parsed = parseToken(token)
  if (!parsed?.canonical) return null

  const candidates = Array.isArray(assignments) ? assignments : Object.values(assignments || {})
  for (const assignment of candidates) {
    if (!assignment?.id) continue
    if (subjectsMatch(await subjectFor(org, assignment.id), parsed.payload.subject)) {
      return assignment
    }
  }
  return null
}

/** Expiry is readable without the key; it is a claim, not a secret. */
export function tokenExpiry(token) {
  return parseToken(token)?.payload?.expiresAt ?? null
}

/**
 * The issue title the broker parses.
 *
 * Everything the broker needs lives in the title, so it never has to read the
 * issue body - the body is attacker-controlled text, and reading it on a
 * repository that holds App credentials is what ARCHITECTURE §4.3.1 forbids.
 * The `pxl-accept:` prefix is also the broker's job-level filter, which GitHub
 * evaluates before allocating a runner.
 */
export function acceptanceIssueTitle(token, teamSlug) {
  return teamSlug ? `pxl-accept:${token} team:${teamSlug}` : `pxl-accept:${token}`
}

/** The link a lecturer hands out. */
export function invitationUrl(org, token, base = import.meta.env.BASE_URL) {
  return `${window.location.origin}${base}${org}/i/${token}`
}
