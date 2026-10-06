// PXL Classroom - the teams a public broker can show RIGHT NOW.
//
// The published teams file is written by a `regenerate-dashboard.yml` run that
// is dispatched after the acceptance finishes, so it trails an acceptance by
// one to two minutes. This module is what covers that window, and it was dead
// for months.
//
// WHAT WENT WRONG. The reconciliation lived inline in GroupAcceptanceCard.vue
// and matched issue TITLES: `issue.title.startsWith('team:')`. Two independent
// reasons that can never be true on the live path:
//
//   * The SPA opens `pxl-accept:<signature> team:<slug>`
//     (frontend/src/lib/invite.js), so the title has not STARTED with `team:`
//     since signed acceptance shipped. The bare `team:<slug>` form it was
//     written for is the legacy hand-written one.
//   * Seconds after dispatching, the broker rewrites the title to
//     "Acceptance (processed)" (acceptance/broker-workflow.yml). Redaction is
//     what protects the signed invitation on a public repository, so it is not
//     going away.
//
// So the fallback reconciled zero teams, every time, and the only surviving
// source was the one that lags. Measured on PXL-2TIW-DevOps-2627/
// groepsindeling on 2026-09-22: four people accepted inside 90 seconds, each
// saw an empty team list, and each created their own team - which is what a
// lecturer reported as "group work is broken".
//
// The BODY is never redacted, and it is the same text the hub itself parses
// (scripts/read-team-payload.mjs), so that is what is read here - through the
// SAME function, so the slug rule cannot drift from the one accept.mjs
// enforces.
//
// Extracted from the component on purpose: inline, there was nothing a test
// could call, which is why nothing caught it. Pure - takes issues, returns
// rows.

import { parseTeamPayload } from '../../../lib/team-payload.mjs'
import { sameLogin } from '../../../lib/github-login.mjs'
import { REJECTED_LABEL } from '../../../lib/acceptance-labels.mjs'
import { REJECTED_ISSUE_TITLE, notDelivered, issuePurpose, isAcceptanceIssueTitle } from '../../../lib/broker-issue-titles.mjs'

/**
 * Did the hub refuse this attempt? Read from the outcome label, the one thing
 * the hub says in public about an acceptance (lib/acceptance-labels.mjs).
 * GitHub sends labels as objects; a string is accepted too.
 */
function refused(issue) {
  return (issue?.labels || []).some((l) => (typeof l === 'string' ? l : l?.name) === REJECTED_LABEL)
}

/** Did the broker stop this attempt before the hub saw it (lib/broker-issue-titles.mjs)? */
function neverReachedHub(title) {
  return typeof title === 'string' && (title.trim() === REJECTED_ISSUE_TITLE || notDelivered(title))
}

/**
 * Team rows visible in a broker's issue list.
 *
 * One row per issue that names a team; the caller merges them, because the
 * capacity a row is judged against is the assignment's maximum as it is NOW
 * and belongs to the caller, not to a row.
 *
 * @param {Array<{body?: unknown, title?: unknown, user?: {login?: string}}>} issues
 * @returns {Array<{team_slug: string, team_name: string, members: string[]}>}
 */
export function teamsFromBrokerIssues(issues) {
  const rows = []
  for (const issue of issues || []) {
    // A REFUSED ATTEMPT FORMED NO TEAM. Counted, it put the refused student on
    // screen as the member of a team that exists nowhere - no team file, no
    // repository - and their next visit offered "You are already listed in
    // team-1" with a one-click join into it (testbed, 2026-10-03). An attempt
    // with no label yet still counts: in flight is what this fallback is for.
    // The broker says the same in the TITLE before the hub has run at all: a
    // link it would not take, and a request it could not pass on, formed no
    // team either.
    if (refused(issue) || neverReachedHub(issue?.title)) continue
    const { team_slug: slug, team_name: name } = parseTeamPayload({
      body: issue?.body,
      title: issue?.title,
    })
    if (!slug) continue
    // THE ISSUE'S AUTHOR, never a `github_login` read out of the body. Any
    // GitHub account can open an issue on a public broker, so a hand-written
    // body naming somebody else would show that person as a member of a team
    // they have never joined. This list is display only - the hub decides
    // membership - but a student chooses a team from what the screen says, so
    // it must not be forgeable.
    const member = issue?.user?.login
    rows.push({
      team_slug: slug,
      team_name: name || slug,
      members: member ? [member] : [],
    })
  }
  return rows
}

/**
 * The student's own acceptance issue, or null.
 *
 * MATCHED ON THE AUTHOR, not the title, for the redaction reason above: a title
 * match found this only in the seconds before the broker rewrote it, so a
 * student who closed the tab and came back could read neither their rejection
 * reason nor the invitation notice - which is precisely the student it exists
 * for. Every issue on a broker is an acceptance attempt by construction, and
 * GitHub lists newest first, so the first one they authored is the current
 * attempt.
 *
 * @param {Array<{user?: {login?: string}}>} issues newest first
 * @param {string} login
 */
export function ownAcceptanceIssue(issues, login) {
  if (!login) return null
  // An ACCEPTANCE of theirs - not their address confirmation, which the same
  // broker carries, and not an issue they wrote by hand (see recentAttempt).
  return (issues || []).find((i) => sameLogin(i?.user?.login, login) && isAcceptanceAttempt(i?.title)) || null
}

/** Is this title one of ours, and not an address confirmation? */
function isAcceptanceAttempt(title) {
  return isAcceptanceIssueTitle(title) && issuePurpose(title) !== 'confirm'
}

/**
 * How recent an attempt has to be to still be the one in flight.
 *
 * One spelling. It was written out twice - `RECENT_ATTEMPT_MS` in
 * GroupAcceptanceCard.vue and a bare `15 * 60 * 1000` in AssignmentView.vue -
 * for the same decision about the same issue list.
 */
export const RECENT_ATTEMPT_MS = 15 * 60 * 1000

/**
 * The student's acceptance attempt, if one is still in flight.
 *
 * Only a RECENT one counts. We reach this only when there is no repository and
 * no invitation, so an older issue is an acceptance that never completed and
 * the student should be offered Accept again rather than dropped into a
 * three-minute poll for an answer that is not coming.
 *
 * NEVER BY THE `pxl-accept:` PREFIX ALONE. The caller asks GitHub for
 * `?creator=<login>`, so the list is already the student's own, and requiring
 * the prefix was the redaction bug: the broker rewrites `pxl-accept:...` within
 * seconds, so it found the issue only inside that window - and never for the
 * returning student this exists for, who is by definition looking later.
 *
 * But the student's own list is not only acceptances. The same broker carries
 * their ADDRESS CONFIRMATION (the confirm link), which sets nothing up, so a
 * student who confirmed and then opened the invitation was told "Your request
 * did not go through" before pressing anything. And an issue they wrote by
 * hand ("I clicked accept and nothing happened") is not an attempt at all. So
 * the title must be one of ours (lib/broker-issue-titles.mjs, every title the
 * broker leaves included), and not a confirmation. A refusal is titled the same
 * whatever it asked, so it still counts: its reason is worth showing.
 *
 * @param {Array<{created_at?: string, title?: string}>} issues
 * @param {{now?: number, maxAgeMs?: number}} [opts]
 */
export function recentAttempt(issues, { now = Date.now(), maxAgeMs = RECENT_ATTEMPT_MS } = {}) {
  const cutoff = now - maxAgeMs
  return (
    (issues || []).find((issue) => {
      if (!isAcceptanceAttempt(issue?.title)) return false
      const at = Date.parse(issue?.created_at ?? '')
      return Number.isFinite(at) && at > cutoff
    }) || null
  )
}
