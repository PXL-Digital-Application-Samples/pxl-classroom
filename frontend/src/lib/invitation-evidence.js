// What the acceptance page is entitled to conclude from an invitations read.
//
// THE ONLY PROOF IS A MATCH. An empty answer is not evidence that no
// invitation exists, and neither is a failure.
//
// MEASURED, PXL-Automation-II/test-pe3, 3 Sep 2026. A student accepted, the
// repository `test-pe3-tomccargo` was created, and GitHub had a pending
// invitation for them the whole time:
//
//     GET /repos/PXL-Automation-II/test-pe3-tomccargo/invitations
//     -> [{ invitee: "tomccargo", permissions: "admin",
//           created_at: "2026-09-03T08:53:01Z" }]
//
// The page, signed in AS tomccargo, polled `GET /user/repository_invitations`
// for two and a half minutes. It answered 200 with the invitation absent. So
// the page took the "we asked and there is nothing" branch and told the student
// "GitHub has no repository for you and no invitation waiting, so setup did not
// finish" - beside a repository that existed, holding an invitation with their
// name on it. The diagnostics modal, reading the same signal, reported
// "Repository Collaboration Invitation: Clear" and "All diagnostic checks look
// healthy".
//
// CONFIRMED FROM THE STUDENT'S OWN TOKEN, same day, in the browser holding the
// session - not inferred from how the page behaved:
//
//     GET /user/repository_invitations          -> 200 []
//     GET /user/memberships/orgs/{org}          -> 403
//         "You do not have access to this organization membership."
//
// The second line kills the obvious next idea, so do not spend an afternoon on
// it: org membership would settle this by implication, because a non-member
// granted a private repository is ALWAYS invited. The App declares
// `members: write` (lib/audit.mjs), and GitHub's "Permissions required for
// GitHub Apps" reference lists `GET /user/memberships/orgs/{org}` under
// Organization -> Members at `read`, token type UAT - a user access token,
// exactly what this page holds. Both checks say it should work. It does not.
//
// What answers instead is the HUB. `provisioning/provision.mjs` gets 201 from
// the collaborator grant when GitHub sends an invitation, and posts
// `provisioned:invited` to the student's own broker issue - see
// scripts/publish-acceptance-outcome.mjs. That is the only evidence of a
// pending invitation this page can ever read, and it arrives in seconds.
//
// The mechanism is not certain and this module does not depend on which it is.
// The documented rule for GitHub App user access tokens is that they reach only
// what BOTH the user and the App can reach, and a student holding nothing but a
// pending invitation does not yet have access to that repository - so the
// intersection may be empty by construction. We sign in through the App's
// device flow (`startDeviceFlow` takes the App's client id; OAuth scopes are an
// OAuth-App concept and a GitHub App ignores the parameter), so this call may
// simply never be able to see what it is being asked about.
//
// What IS certain is the observation: a 200 that omitted a real invitation. So
// the rule is the repo's own - unreadable is not evidence, and absent and empty
// are different answers. A match promotes the page to `invited`, where it holds
// the real invitation and an in-app Accept button. Everything else leaves the
// question open, and the page must say so rather than pick the answer it can
// render most confidently.
//
// The previous rule - "the API answered and named nothing, therefore there is
// nothing" - is preserved in the git history and in tests/student-wait-copy.
// It was sound reasoning from a premise that turned out to be false.

import { normalizeLogin } from '../../../lib/github-login.mjs'

/**
 * Pick the student's invitation out of an invitations response.
 *
 * @param {{ok?: boolean, data?: any}} res - what `getInvitations` returned
 * @param {{org: string, repo: string}} target - the repository being waited on
 * @returns {{invitation: object|null, proven: boolean, answered: boolean}}
 *   `invitation` is the match, or null. `proven` is the only thing a caller may
 *   treat as knowledge: true means an invitation is definitely waiting. FALSE
 *   MEANS UNKNOWN, never "there is none" - see above. `answered` says whether
 *   the read came back at all, and exists for wording, not for conclusions.
 */
export function invitationEvidence(res, { org, repo }) {
  const answered = Boolean(res?.ok) && Array.isArray(res?.data)
  if (!answered) return { invitation: null, proven: false, answered: false }

  // Repository names are case-insensitive on GitHub and the owner is a login,
  // which this repo compares through one helper rather than by hand.
  const wantRepo = String(repo || '').toLowerCase()
  const invitation =
    res.data.find(
      (inv) =>
        String(inv?.repository?.name || '').toLowerCase() === wantRepo &&
        wantRepo !== '' &&
        normalizeLogin(inv?.repository?.owner?.login) === normalizeLogin(org),
    ) || null

  return { invitation, proven: Boolean(invitation), answered: true }
}

/**
 * May the page offer the guessed /<org>/<repo>/invitations link?
 *
 * Once an unmatched read stopped counting as proof, this is simply "we have not
 * proven there is one, and we have somewhere to send them". It stays a named
 * function because the claim is the thing worth naming: the link is offered
 * BECAUSE the page cannot tell, and its copy has to say that.
 *
 * @param {boolean} proven - from `invitationEvidence`
 * @param {string|null|undefined} url - the guessed invitation URL
 */
export function mayOfferInvitationLink(proven, url) {
  return proven !== true && Boolean(url)
}
