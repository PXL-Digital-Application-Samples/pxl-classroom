// Where a publish actually is, for the line the editor shows while it waits.
//
// 2026-10-06, during a GitHub incident: a lecturer read "Publishing: the
// student page goes live in a minute or two. (checked 45x)" for half an hour.
// The page counted its own checks and could not say what it was waiting for -
// GitHub not having started the publish at all, a publish that had finished
// and a Pages deploy that had failed, or a deploy not yet started. All of that
// is in the hub's own workflow runs, which a signed-in lecturer can read: so
// the line says the step that is true, and only where GitHub is the one slow
// does it point at GitHub's status page (DESIGN.md §1.5 - what the page
// computed, never a guess at why).
//
// Pure: run objects in, a step out. usePublishWatch.js reads the runs.

/** A run GitHub has accepted but not started - the wait an incident makes long. */
const NOT_STARTED = new Set(['queued', 'pending', 'waiting', 'requested'])

/** Minutes past which a wait for GitHub to start is GitHub being slow. */
export const SLOW_START_MINUTES = 3

/**
 * Minutes after a deploy finished past which this assignment's page not being
 * on the site is a fact to say, not the CDN catching up.
 */
export const PAGE_MISSING_MINUTES = 3

export const GITHUB_STATUS_URL = 'https://www.githubstatus.com'

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')

/**
 * The publish run this click started, by the id GitHub gave when it was
 * dispatched (`dispatchWorkflowRun`). It was "this lecturer's newest publish
 * run", which is any publish of theirs - another tab's, another
 * organization's, a failed one a minute earlier - so the line could report
 * someone else's run as this one's (review 2026-10-07).
 */
export function publishRunPath({ owner, repo, runId }) {
  return `/repos/${owner}/${repo}/actions/runs/${encodeURIComponent(runId)}`
}

/**
 * A run id as it travels in the address (`?publishing=<id>`), or null. GitHub's
 * run ids are in the billions; `1` is the flag the address carries when GitHub
 * named no run (and carried before it named any), never an id.
 */
export function publishRunIdFrom(value) {
  return typeof value === 'string' && /^[1-9]\d{3,19}$/.test(value) ? value : null
}

/** Pages deploys created since the publish finished. */
export function deployRunsPath({ owner, repo, since }) {
  const q = new URLSearchParams({ created: `>=${iso(since)}`, per_page: '10' })
  return `/repos/${owner}/${repo}/actions/workflows/deploy-frontend.yml/runs?${q}`
}

/** The newest run in a list response, or null - an unreadable list included. */
export function newestRun(res) {
  const runs = res?.ok && Array.isArray(res.data?.workflow_runs) ? res.data.workflow_runs : []
  return [...runs].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0] || null
}

const minutesSince = (stamp, now) => {
  const at = Date.parse(stamp || '')
  return Number.isFinite(at) ? Math.max(0, Math.floor((now - at) / 60_000)) : 0
}

/**
 * The step a publish is at.
 *
 * Called only while this assignment's page is NOT yet on the site (the watch
 * checks that first), so a finished deploy is a deploy without it once the
 * CDN has had its minute.
 *
 * @param {object} args
 * @param {object|null} args.publishRun  the publish run this click started, or null
 * @param {boolean} [args.untracked]     GitHub gave no run id to follow
 * @param {object|null} args.deployRun   newest Pages deploy since it finished, or null
 * @param {number} [args.now]
 * @returns {{step: string, minutes: number, url: string|null}}
 */
export function publishStage({ publishRun, deployRun, untracked = false, now = Date.now() }) {
  if (!publishRun) return { step: untracked ? 'untracked' : 'unknown', minutes: 0, url: null }
  const url = publishRun.html_url || null
  if (NOT_STARTED.has(publishRun.status)) {
    return { step: 'waiting-start', minutes: minutesSince(publishRun.created_at, now), url }
  }
  if (publishRun.status !== 'completed') return { step: 'publishing', minutes: 0, url }
  if (publishRun.conclusion !== 'success') return { step: 'failed', minutes: 0, url }
  if (!deployRun) return { step: 'waiting-deploy', minutes: minutesSince(publishRun.updated_at, now), url }
  const deployUrl = deployRun.html_url || url
  if (NOT_STARTED.has(deployRun.status)) {
    return { step: 'waiting-deploy', minutes: minutesSince(deployRun.created_at, now), url: deployUrl }
  }
  if (deployRun.status !== 'completed') return { step: 'deploying', minutes: 0, url: deployUrl }
  if (deployRun.conclusion === 'success') {
    // It said "on its way" for the rest of the half hour, also when the
    // deploy could not read this organization and kept its old pages.
    const since = minutesSince(deployRun.updated_at, now)
    return since >= PAGE_MISSING_MINUTES
      ? { step: 'deployed-without-page', minutes: since, url: deployUrl }
      : { step: 'deployed', minutes: 0, url: deployUrl }
  }
  // A cancelled deploy was replaced by a newer one, which the next read finds;
  // one that failed is tried again by the watchdog (pagesRedeployDue).
  return { step: deployRun.conclusion === 'cancelled' ? 'waiting-deploy' : 'deploy-failed', minutes: 0, url: deployUrl }
}

/**
 * What the line says, and whether GitHub's status page belongs beside it -
 * only for a wait on GitHub to START something, past SLOW_START_MINUTES.
 *
 * @param {{step: string, minutes: number}} stage
 * @returns {{text: string, slow: boolean}}
 */
export function publishStageMessage(stage) {
  const waited = (m) => (m >= 1 ? ` (${m} min)` : '')
  const slow = stage.minutes >= SLOW_START_MINUTES
  switch (stage.step) {
    case 'waiting-start':
      return { text: `Waiting for GitHub to start the publish${waited(stage.minutes)}.`, slow }
    case 'publishing':
      return { text: 'Publishing: GitHub is setting up the assignment.', slow: false }
    case 'failed':
      return { text: 'The publish did not finish on GitHub.', slow: false }
    case 'waiting-deploy':
      return { text: `Published. Waiting for GitHub to start putting the student page live${waited(stage.minutes)}.`, slow }
    case 'deploying':
      return { text: 'Published. Putting the student page live.', slow: false }
    case 'deploy-failed':
      return { text: 'Published, but GitHub could not put the student page live. It is tried again automatically.', slow: false }
    case 'deployed':
      return { text: 'Published. The student page is on its way - it can take a minute to appear.', slow: false }
    case 'deployed-without-page':
      return { text: `Published, but the student pages were updated ${stage.minutes} min ago without this assignment's page.`, slow: false }
    case 'untracked':
      return { text: 'Publishing. GitHub did not say which run it started, so this page only checks for the student page.', slow: false }
    default:
      return { text: 'Publishing: checking with GitHub.', slow: false }
  }
}
