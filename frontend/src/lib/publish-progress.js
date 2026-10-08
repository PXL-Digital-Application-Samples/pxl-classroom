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

/** How long a finished run ran, in seconds, or null when GitHub did not say. */
export function runSeconds(run) {
  if (run?.status !== 'completed') return null
  const start = Date.parse(run.run_started_at || run.created_at || '')
  const end = Date.parse(run.updated_at || '')
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? Math.round((end - start) / 1000) : null
}

/** The deploys that can carry this publish: any started since it began. */
export function deploySince(publishRun) {
  return Date.parse(publishRun?.created_at || '') || null
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
 * @returns {{step: string, minutes: number, url: string|null, publishSeconds?: number|null, deploySeconds?: number|null}}
 */
export function publishStage({ publishRun, deployRun, untracked = false, now = Date.now() }) {
  const stage = stepOf({ publishRun, deployRun, untracked, now })
  // How long each finished step took, for the step list (publishSteps).
  return { ...stage, publishSeconds: runSeconds(publishRun), deploySeconds: runSeconds(deployRun) }
}

function stepOf({ publishRun, deployRun, untracked, now }) {
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

/**
 * Start to "the student site has it", measured on the hub (2026-10-08): 2 min
 * 40 s, 3 min 58 s and 4 min 7 s for three ordinary publishes. Said so a
 * lecturer knows how long to wait; one waited without knowing, and nearly
 * pressed again.
 */
export const USUAL_WAIT = '3 to 4 minutes'

const took = (s) => (s == null ? '' : s < 90 ? `${s} s` : `${Math.round(s / 60)} min`)

/**
 * The four steps of a publish, in the order a lecturer sees them, for the list
 * at the top of the editor: each `{ key, label, state, detail }`, state one of
 * `done`, `active`, `failed`, `todo`. `ready`: the watch found the student page
 * itself, so every step is done. Null where nothing says where it is (GitHub
 * named no run): no list then, rather than a guessed step.
 *
 * @param {{step: string, publishSeconds?: number|null, deploySeconds?: number|null}} stage
 * @param {{ready?: boolean}} [opts]
 */
export function publishSteps(stage, { ready = false } = {}) {
  const s = stage?.step || 'unknown'
  if (!ready && s === 'untracked') return null
  const onGithub = ['unknown', 'waiting-start', 'publishing'].includes(s)
  const pageBuilt = ['deployed', 'deployed-without-page'].includes(s)
  const github = ready || !(onGithub || s === 'failed') ? 'done' : s === 'failed' ? 'failed' : 'active'
  const site = ready || pageBuilt ? 'done' : ['waiting-deploy', 'deploying', 'deploy-failed'].includes(s) ? 'active' : 'todo'
  const live = ready ? 'done' : pageBuilt ? 'active' : 'todo'
  return [
    { key: 'saved', label: 'Saved', state: 'done', detail: '' },
    { key: 'github', label: 'Set up on GitHub', state: github, detail: github === 'done' ? took(stage?.publishSeconds) : '' },
    { key: 'site', label: 'Student site updated', state: site, detail: site === 'done' ? took(stage?.deploySeconds) : '' },
    { key: 'live', label: 'Live', state: live, detail: '' },
  ]
}

/**
 * The short version, for the bar at the bottom of the window where Save &
 * publish was pressed: which step of how many, and how long so far.
 *
 * @param {{step: string}} stage
 * @param {{ready?: boolean, minutesSoFar?: number}} [opts]
 */
export function publishBarText(stage, { ready = false, minutesSoFar = 0 } = {}) {
  if (ready) return 'Published, and the student page is live.'
  if (stage?.step === 'failed') return 'The publish did not finish on GitHub.'
  const steps = publishSteps(stage)
  const so = minutesSoFar >= 1 ? ` (${minutesSoFar} min so far)` : ''
  if (!steps) return `Publishing${so}.`
  const at = steps.findIndex((x) => x.state === 'active')
  const doing = { github: 'setting it up on GitHub', site: 'updating the student site', live: 'checking the student page' }
  return at === -1 ? `Publishing${so}.` : `Publishing, step ${at + 1} of ${steps.length}: ${doing[steps[at].key]}${so}.`
}
