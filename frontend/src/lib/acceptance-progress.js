// Where a student's acceptance is, from what their browser can actually read.
//
// An acceptance is two GitHub Actions runs: the broker checks the invitation
// and passes the request on, the hub decides and sets up the repository. The
// page used to know only "a repository appeared" or "a label appeared", so a
// request GitHub never started, one the broker could not pass on, and one the
// hub stopped half way all looked the same - three minutes of spinner, then
// "your repository has not appeared". On 2026-10-02 two students sat through
// that four times each while their requests were cancelled behind a stuck run.
//
// Two public things say more, and the page already holds what finds them:
//
//   * the student's own broker issue. Its TITLE is the broker's progress: the
//     signed `pxl-accept:` title until the broker runs, then "Acceptance
//     (processed)" once it passed the request on, "Acceptance (not delivered)"
//     when it could not (lib/broker-issue-titles.mjs), or "Acceptance attempt
//     (rejected)" for a link it would not take.
//   * the hub run for that issue. The hub repository is public and names each
//     run after the attempt it handles (lib/acceptance-run-name.mjs), so its run
//     list says whether GitHub has started it, is running it, or stopped it.
//
// UNREADABLE IS NOT EVIDENCE. A title or a run list that could not be read
// gives `null`, and the page then behaves exactly as it did before any of this
// existed - waits, then times out. Only an answer GitHub actually gave moves the
// student to "did not go through".
//
// Pure, and shared by AssignmentView and GroupAcceptanceCard so the two pages
// cannot tell the same student two different things.

import { purposeForTitle } from '../../../lib/acceptance-signature.mjs'
import { HANDLED_TITLE_BY_PURPOSE, REJECTED_ISSUE_TITLE, notDelivered } from '../../../lib/broker-issue-titles.mjs'
import { acceptanceRunName } from '../../../lib/acceptance-run-name.mjs'

/** The broker usually starts in seconds; past this it is GitHub being slow. */
export const BROKER_SLOW_MS = 90_000

/** How long a student waits before "send it again" is offered. */
export const RETRY_OFFER_MS = 3 * 60_000

/**
 * A run that FINISHED leaves a repository, an invitation or a label within
 * seconds. Past this, a finished run with none of the three did not go through
 * - which is what `rejected:repo-unreadable` (GitHub could not say whether the
 * name is free) now looks like from here, by design: it carries no label.
 */
export const ANSWER_GRACE_MS = 90_000

/** The page stops asking after this, whatever GitHub says. */
export const GIVE_UP_MS = 30 * 60_000

/**
 * What the broker has done with the issue, from its title.
 *
 * @param {unknown} title
 * @returns {'sent'|'handed-over'|'not-delivered'|'link-refused'|null}
 *   null when the title is unreadable or not one the broker writes
 */
export function issueStage(title) {
  if (typeof title !== 'string') return null
  const t = title.trim()
  if (purposeForTitle(t)) return 'sent'
  if (notDelivered(t)) return 'not-delivered'
  if (t === REJECTED_ISSUE_TITLE) return 'link-refused'
  if (Object.values(HANDLED_TITLE_BY_PURPOSE).includes(t)) return 'handed-over'
  return null
}

/**
 * The hub run for this attempt, out of a run list - the newest, if GitHub ran
 * it twice (a delivery the broker retried).
 *
 * @param {unknown} runs `workflow_runs` from the hub's run list
 * @param {{org: string, broker: string, issue: number|string}} attempt
 */
export function findAttemptRun(runs, { org, broker, issue }) {
  if (!Array.isArray(runs) || !org || !broker || !issue) return null
  const name = acceptanceRunName(`${org}/${broker}`, issue)
  return (
    runs
      .filter((r) => r && (r.display_title === name || r.name === name))
      .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))[0] || null
  )
}

const WAITING = new Set(['queued', 'pending', 'waiting', 'requested'])

/**
 * One step for the page to show.
 *
 * @param {object} args
 * @param {string|null|undefined} args.title the issue's title, or null if unreadable
 * @param {{status?: string, conclusion?: string|null, updated_at?: string}|null|undefined} args.run
 *   this attempt's hub run; null when none is listed
 * @param {boolean} args.runsRead whether the hub's run list was actually read -
 *   an unread list says nothing about whether a run exists
 * @param {number} args.sentAt when the issue was opened (ms)
 * @param {number} [args.now]
 * @returns {{
 *   step: 'starting'|'not-started'|'queued'|'running'|'finishing'|'not-delivered'|'stopped'|'no-answer'|'link-refused'|'unknown',
 *   final: boolean,
 *   canRetry: boolean,
 * }}
 */
export function attemptProgress({ title, run = null, runsRead = false, sentAt, now = Date.now() }) {
  const waited = Number.isFinite(sentAt) ? now - sentAt : 0
  const offer = waited >= RETRY_OFFER_MS
  const stage = issueStage(title)

  if (stage === 'not-delivered') return { step: 'not-delivered', final: true, canRetry: true }
  if (stage === 'link-refused') return { step: 'link-refused', final: true, canRetry: false }
  if (stage === 'sent') {
    return waited < BROKER_SLOW_MS
      ? { step: 'starting', final: false, canRetry: false }
      : { step: 'not-started', final: false, canRetry: offer }
  }

  // Handed over - or a title we could not read, in which case a run, if we
  // have one, still tells us the rest. Without either we know nothing new.
  if (run && typeof run === 'object') {
    if (WAITING.has(run.status)) return { step: 'queued', final: false, canRetry: offer }
    if (run.status === 'in_progress') return { step: 'running', final: false, canRetry: false }
    if (run.status === 'completed') {
      if (run.conclusion && run.conclusion !== 'success') return { step: 'stopped', final: true, canRetry: true }
      const finished = Date.parse(run.updated_at || '')
      if (Number.isFinite(finished) && now - finished >= ANSWER_GRACE_MS) {
        return { step: 'no-answer', final: true, canRetry: true }
      }
      return { step: 'finishing', final: false, canRetry: false }
    }
  }
  if (stage === 'handed-over' && runsRead) {
    // Passed on, and GitHub lists no run for it yet: it has not been started.
    return { step: 'queued', final: false, canRetry: offer }
  }
  return { step: 'unknown', final: false, canRetry: false }
}

/**
 * The three steps a student sees, and how far along they are.
 *
 * @param {string} step from attemptProgress
 * @returns {Array<{label: string, state: 'done'|'current'|'todo'|'failed'}>}
 */
export function progressSteps(step) {
  const at = {
    starting: 1, 'not-started': 1, 'link-refused': 1, 'not-delivered': 1,
    queued: 2, running: 2, finishing: 2, stopped: 2, 'no-answer': 2,
  }[step]
  if (at === undefined) return []
  const failed = ['link-refused', 'not-delivered', 'stopped', 'no-answer'].includes(step)
  return ['Request sent', 'Invitation checked', 'Setting up'].map((label, i) => ({
    label,
    state: i < at ? 'done' : i === at ? (failed ? 'failed' : 'current') : 'todo',
  }))
}

/**
 * What to tell the student, in their words. `null` for a step that needs no
 * sentence beyond the ordinary "setting up" copy.
 *
 * @param {string} step
 * @returns {string|null}
 */
export function progressMessage(step) {
  switch (step) {
    case 'not-started':
      return 'GitHub has not started on your request yet. That happens when GitHub is busy.'
    case 'queued':
      return 'Your request is waiting for GitHub to start it. GitHub is slow right now - nothing is lost by waiting.'
    case 'running':
    case 'finishing':
      return 'GitHub is working on it now.'
    case 'not-delivered':
      return 'GitHub had a problem passing your request on, so nothing was set up. Send it again.'
    case 'stopped':
      return 'GitHub stopped your request before it finished. Send it again - that is safe.'
    case 'no-answer':
      return 'Your request finished without setting anything up. Send it again - that is safe. If it happens again, tell your lecturer.'
    case 'link-refused':
      return 'Your invitation link was not accepted. Ask your lecturer for the current link.'
    default:
      return null
  }
}

/**
 * The hub's run list for acceptances started since this attempt, as a path for
 * the page's GitHub client. Bounded in time, so a busy hub answers with this
 * student's run on the first page.
 *
 * @param {{owner: string, repo: string, sentAt: number}} args
 */
export function hubRunsPath({ owner, repo, sentAt }) {
  const since = new Date((Number.isFinite(sentAt) ? sentAt : Date.now()) - 2 * 60_000)
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
  const q = new URLSearchParams({ event: 'repository_dispatch', created: `>=${since}`, per_page: '100' })
  return `/repos/${owner}/${repo}/actions/workflows/acceptance-handler.yml/runs?${q}`
}
