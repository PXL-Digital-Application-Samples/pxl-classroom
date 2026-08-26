// PXL Classroom - invitation links, browser side.
//
// The SPA never verifies anything: verification belongs on the broker, which is
// the thing with something to protect. What it does now is SIGN.
//
// The old link carried a bearer token that the student pasted into the issue
// title - and a title lands in a public event that GH Archive keeps forever, so
// the credential was world-readable (CLAIM_PLAN Phase A). The link now carries a
// private key instead, and the browser signs a fresh assertion naming this
// student's own account. Only the signature is published, and it is useless to
// anyone else.
//
// The crypto lives in lib/acceptance-signature.mjs, shared with the broker and
// the hub. A second copy here would be a format that forks in half the first
// time either side changed.

import { TOKEN_PATTERN, inviteFileName } from '../../../lib/invite-token-format.mjs'
import {
  signAcceptanceTitle,
  ACCEPTANCE_KEY_LENGTH,
  MAX_TITLE_LENGTH,
} from '../../../lib/acceptance-signature.mjs'

export { TOKEN_PATTERN }

// A format version rather than a key id: the keypair is per assignment, so
// there is nothing to select between. It exists so a future change to what is
// signed can be told apart from this one.
export const ACCEPTANCE_FORMAT = 'a1'

// Re-exported rather than re-implemented. Reading the invitation back out of an
// assignment document has broken three times now, always the same way: a second
// copy of the parse drifts from the writer. There is one copy, it lives beside
// scripts/set-assignment-invite.mjs's writer, and both views import it.
export { parseInviteFields, linkSecretFrom } from '../../../lib/invite-token-format.mjs'

// resolveAssignmentFromToken, tokenExpiry and isInviteToken lived here and had
// ZERO consumers. The first is the interesting one: it existed to match a
// token's embedded subject against candidate assignments, and nothing ever
// needed to, because the acceptance card is found by hashing the URL secret and
// already carries the assignment. That is why the new link can be a bare key
// with no subject in it.

/**
 * The issue title the broker parses, SIGNED.
 *
 * The old form pasted the invitation itself into the title - and the title
 * lands in a public event that GH Archive keeps forever, so the credential was
 * world-readable (CLAIM_PLAN Phase A; measured live 2026-08-25 with one
 * unauthenticated curl). Now the link carries a private key, the browser signs
 * a fresh assertion naming THIS student's account, and only the signature is
 * published. Replaying it requires being that account.
 *
 * Everything the broker needs is still in the title: it never reads the body of
 * an issue on a repository holding App credentials, and the `pxl-accept:`
 * prefix is its job-level filter, evaluated before a runner is allocated.
 */
export async function signedAcceptanceIssueTitle({ inviteSecret, assignmentId, githubId, teamSlug }) {
  // MIGRATION IS PER ASSIGNMENT, AND THE LINK IS WHAT SAYS WHICH.
  //
  // A link handed out before Phase A carries a 122-character bearer token, not
  // a key. Signing with it does not fail politely - `fromBase64Url` rejects the
  // `.` separator and throws "not base64url", which the accept button renders
  // verbatim. Every assignment live today is in that state, so without this
  // branch the deploy that ships signing breaks acceptance for all of them at
  // once, with a message about base64.
  //
  // Those assignments still have brokers that verify the old way, so the old
  // title is the CORRECT one for them until a republish migrates both halves
  // together. The two shapes cannot be confused: `<35>.<86>` with a dot, versus
  // a fixed-length key without one.
  if (TOKEN_PATTERN.test(inviteSecret)) return acceptanceIssueTitle(inviteSecret, teamSlug)

  // The signature names this account, and the broker refuses it unless it
  // matches the issue's author - so an absent id is not a detail, it is an
  // acceptance that cannot succeed. Said here, in words a student can act on:
  // the module below throws too, but "not a usable GitHub account id" reads
  // like a problem with their link.
  if (!Number.isInteger(githubId) || githubId <= 0) {
    throw new Error(
      'Your GitHub account id is missing from this session, so this acceptance cannot be signed. ' +
        'Sign out and sign in again, then try once more.',
    )
  }

  const title = await signAcceptanceTitle({
    privateKey: inviteSecret,
    kid: ACCEPTANCE_FORMAT,
    subject: assignmentId,
    githubId,
    nonce: randomNonce(),
  })
  if (!teamSlug) return title

  // The team hint is appended AFTER signing - it is a concurrency key, never an
  // authoritative value, and the hub re-derives the real team from the issue
  // body. That means signAcceptanceTitle's own length check has not seen it, so
  // the combined title is checked here or GitHub rejects the issue at 256.
  const withTeam = `${title} team:${teamSlug}`
  if (withTeam.length > MAX_TITLE_LENGTH) {
    throw new Error(
      `acceptance title is ${withTeam.length} characters with the team hint, over GitHub's ${MAX_TITLE_LENGTH} limit`,
    )
  }
  return withTeam
}

/**
 * Distinct per acceptance, so two attempts by one student differ.
 *
 * Four bytes, matching the payload's nonce field. It is not a security value -
 * replay is stopped by binding the signature to the account - so the width is
 * chosen for the title budget, not for collision resistance.
 */
function randomNonce() {
  const bytes = new Uint8Array(4)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * The PRE-MIGRATION issue title: the invitation itself, pasted in.
 *
 * Reached only through signedAcceptanceIssueTitle, for an assignment that has
 * not been republished since Phase A. Its broker still verifies a bearer token
 * and this is the only title it accepts, so this is the right answer there -
 * not a fallback, and not something to remove until no live assignment is on
 * the old form.
 *
 * The `pxl-accept:` prefix is the broker's job-level filter, which GitHub
 * evaluates before allocating a runner.
 */
export function acceptanceIssueTitle(token, teamSlug) {
  return teamSlug ? `pxl-accept:${token} team:${teamSlug}` : `pxl-accept:${token}`
}

/** The link a lecturer hands out. */
export function invitationUrl(org, token, base = import.meta.env.BASE_URL) {
  return `${window.location.origin}${base}${org}/i/${token}`
}

/**
 * Parse whatever a student pastes into the "have a link?" box.
 *
 * Accepts a full Pages URL, a `/:org/i/:token` path, or `org/token`. Lives here
 * rather than inside HomeView because the test suite needs the real thing: the
 * previous parser was re-implemented inside portal-logic.test.mjs, so the test
 * kept passing against a copy that no longer matched the view.
 *
 * @returns {{org: string, inviteToken: string} | null}
 */
export function parseInvitationLink(input) {
  if (typeof input !== 'string') return null
  const clean = input.trim()
  if (!clean) return null

  // Regex literals, not strings: building these with `new RegExp` swallowed the
  // backslashes in \. and \?, which turned the separator into a bare quantifier.
  //
  // BOTH shapes are accepted, deliberately. The new secret is a bare base64url
  // key; the old one is `<35>.<86>`. Migration is per assignment, so during it
  // a student may hold either - and refusing the old shape here would tell them
  // their link is not a link at all, when it is simply out of date. The page
  // they land on is what explains that (it looks the card up and finds it
  // superseded); this function's job is only to get them there.
  // Strict on BOTH shapes: the new key is a fixed-length PKCS#8 export and the
  // old token is `<35>.<86>`. A truncated link therefore still fails here and
  // is told it is not a link, rather than being sent to a page whose only
  // answer would be "not found". ACCEPTANCE_KEY_LENGTH is asserted at mint
  // time, so the parser and the generator cannot drift apart.
  const SECRET =
    `(?:[A-Za-z0-9_-]{35}\\.[A-Za-z0-9_-]{86}|[A-Za-z0-9_-]{${ACCEPTANCE_KEY_LENGTH}})`

  const withSegment = clean.match(
    new RegExp(`(?:^|/)([a-zA-Z0-9_-]+)/i/(${SECRET})(?:$|/|\\?|#)`),
  )
  if (withSegment) return { org: withSegment[1], inviteToken: withSegment[2] }

  const bare = clean.match(new RegExp(`^([a-zA-Z0-9_-]+)/(${SECRET})$`))
  if (bare) return { org: bare[1], inviteToken: bare[2] }

  return null
}

/**
 * Where this invitation's assignment metadata lives on Pages.
 *
 * Named by the digest of the token, so the file can only be found by someone
 * holding the link - the org-wide index no longer carries the acceptance card
 * (ARCHITECTURE §4.3.3). Same rule as pages/generate.mjs, via the shared
 * format module, because a mismatch here is a 404 for every student.
 */
export async function inviteDataUrl(org, token, base = import.meta.env.BASE_URL) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  return `${base}data/${org}/i/${inviteFileName(digest)}.json`
}

/** Companion teams file for a group assignment, behind the same digest. */
export async function inviteTeamsUrl(org, token, base = import.meta.env.BASE_URL) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  return `${base}data/${org}/i/${inviteFileName(digest)}.teams.json`
}
