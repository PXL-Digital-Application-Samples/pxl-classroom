// Is the thing a student would open actually there yet?
//
// Publishing an assignment dispatches a workflow and returns immediately, so
// the panel has to WATCH: the broker repository has to appear, the workflow has
// to mint an invitation into the control repo, and GitHub Pages has to serve
// the acceptance card built from it. None of that is instant and none of it is
// reported back, so this polls for up to eight minutes.
//
// Lifted out of AdminView, where five functions, six refs and a bare
// `let publishPollTimer` were spread through a 1,400-line script. Two things
// improve by moving it, beyond the line count:
//
// 1. THE TIMER IS CLEANED UP. `stopPublishWatch()` was called from three places
//    in the view - restarting the watch, and two edit-flow transitions - and
//    from NO unmount hook. Navigating away mid-publish left a 10-second poll
//    running for the life of the tab, hitting the GitHub API, mutating a form
//    on a component that no longer exists and eventually raising a success
//    toast for a page nobody is on. `onBeforeUnmount` is part of the behaviour,
//    so it belongs with the behaviour.
// 2. The two verification questions stay together. "Verified live" used to ask
//    whether the id appeared in assignments.json - which it does even when the
//    card 404s, because pages/generate.mjs writes `data/<org>/i/<sha>.json`
//    ONLY for an assignment carrying an invitation, then logs a warning and
//    indexes it anyway. Both halves are checked here, in one place.

import { onBeforeUnmount, ref } from 'vue'
import { getToken } from '../lib/auth.js'
import { getRepo, getRepoContent, ghApi } from '../lib/api.js'
import { config } from '../lib/config.js'
import { brokerRepoName } from '../../../lib/broker-repo.mjs'
import { assignmentPath } from '../../../lib/control-layout.mjs'
import { inviteDataUrl, parseInviteFields, linkSecretFrom } from '../lib/invite.js'
import { deployRunsPath, deploySince, newestRun, publishRunPath, publishStage } from '../lib/publish-progress.js'

/**
 * Thirty minutes: every 10s for the first five, then every 20s. It was eight,
 * which ended the watch while GitHub was still starting the publish during the
 * 2026-10-06 incident - the line can say what is happening now, so it may
 * keep saying it.
 */
const WATCH_MS = 30 * 60_000
const FIRST_TICK_MS = 5000
const TICK_MS = 10000
const SLOW_TICK_MS = 20000
const SLOW_AFTER_MS = 5 * 60_000

/**
 * @param {object} deps
 * @param {() => string} deps.org
 * @param {import('vue').Ref} deps.form            the editor's form state
 * @param {() => boolean} deps.hasUnsavedEdits
 * @param {() => void} deps.snapshotForm
 * @param {(msg: string) => void} deps.onReady     told once, when it is live
 */
export function usePublishWatch({ org, form, hasUnsavedEdits, snapshotForm, onReady }) {
  const publishWatch = ref('')
  const publishPollCount = ref(0)
  // The step GitHub is at (lib/publish-progress.js), read from the hub's runs.
  const publishProgress = ref({ step: 'unknown', minutes: 0, url: null })
  let watchStartedAt = 0
  // Minutes since the publish began - its run's own start where GitHub has
  // said, since a new assignment's page starts watching only after the save
  // and the move to its page.
  const publishMinutes = ref(0)
  let publishBeganAt = 0
  // The run the publish started, as GitHub named it when it was dispatched.
  let watchedRunId = null

  /**
   * Which step the publish is at: the run it started, then the Pages deploy
   * after it. A read that fails leaves the last answer standing - a failed
   * read is not a step.
   */
  async function readPublishProgress() {
    const token = getToken()
    if (!token) return
    // GitHub gave no run to follow: say so, never guess one from a list.
    if (!watchedRunId) {
      publishProgress.value = publishStage({ publishRun: null, deployRun: null, untracked: true })
      return
    }
    const where = { owner: config.hubOwner, repo: config.hubRepo }
    const publishRes = await ghApi(token, 'GET', publishRunPath({ ...where, runId: watchedRunId }))
    if (!publishRes.ok) return
    const publishRun = publishRes.data || null
    let deployRun = null
    if (publishRun?.status === 'completed' && publishRun.conclusion === 'success') {
      const deployRes = await ghApi(token, 'GET', deployRunsPath({ ...where, since: deploySince(publishRun) || watchStartedAt }))
      if (!deployRes.ok) return
      deployRun = newestRun(deployRes)
    }
    publishProgress.value = publishStage({ publishRun, deployRun })
    const runBegan = Date.parse(publishRun?.created_at || '')
    if (Number.isFinite(runBegan) && runBegan < publishBeganAt) publishBeganAt = runBegan
    publishMinutes.value = Math.floor((Date.now() - publishBeganAt) / 60_000)
    // A publish that did not finish will not go live by waiting: stop, and
    // stop spinning (it went on for the rest of the half hour).
    if (publishProgress.value.step === 'failed') {
      stopPublishWatch()
      publishWatch.value = 'failed'
    }
  }
  const liveCheckLoading = ref(false)
  const brokerExists = ref(null) // null = unchecked, true = exists, false = missing
  const pagesLive = ref(null)    // null = unchecked, true = live, false = not live

  let timer = null

  /**
   * Read the invitation the workflow has just written, back into the form.
   *
   * The three invite fields are SYSTEM-OWNED - a lecturer never edits them - so
   * filling them in must not make a clean form look unsaved and prompt
   * "Discard unsaved changes?" on the way out.
   */
  async function refreshInvitation(assignmentId) {
    const token = getToken()
    if (!token) return ''
    const yaml = await getRepoContent(token, org(), config.controlRepo, assignmentPath(assignmentId))
    const fields = parseInviteFields(yaml)
    if (!linkSecretFrom(fields)) return ''
    const wasClean = !hasUnsavedEdits()
    Object.assign(form.value, fields)
    if (wasClean) snapshotForm()
    return linkSecretFrom(fields)
  }

  /**
   * Is the page a student would open actually there?
   *
   * NOT "is the id in assignments.json". The student loads
   * `data/<org>/i/<sha256(token)>.json`, and pages/generate.mjs writes that file
   * only when the assignment carries an invitation - otherwise it warns,
   * continues, and still indexes the id. So an assignment published without one
   * reported "Verified Live" over a card that 404s for every student.
   * Diagnostics Tier 5 was corrected for exactly this in e594f4f; the publish
   * flow beside it was not.
   */
  async function acceptanceCardIsLive(inviteToken) {
    if (!inviteToken) return false
    try {
      const url = `${await inviteDataUrl(org(), inviteToken)}?t=${Date.now()}`
      const res = await fetch(url, { cache: 'no-store' })
      if (!res.ok) return false
      const data = await res.json().catch(() => null)
      return !!data?.assignment?.id
    } catch {
      return false
    }
  }

  /** A one-shot check, for the "Check status now" control and after a timeout. */
  async function verifyLiveInfrastructure(assignmentId) {
    if (!assignmentId || form.value.state !== 'published') {
      brokerExists.value = null
      pagesLive.value = null
      liveCheckLoading.value = false
      return
    }
    liveCheckLoading.value = true
    const token = getToken()
    const brokerRepo = brokerRepoName({ assignment: form.value, assignmentId })
    try {
      if (token) {
        const brokerRes = await getRepo(token, org(), brokerRepo)
        brokerExists.value = brokerRes.ok
      }
      const inviteToken = await refreshInvitation(assignmentId)
      pagesLive.value = await acceptanceCardIsLive(inviteToken)
    } catch (e) {
      console.warn('Failed to verify live infrastructure:', e)
    } finally {
      liveCheckLoading.value = false
    }
  }

  function stopPublishWatch() {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  /** @param {{runId?: string|number|null}} [opts] the publish run GitHub said it started */
  function startPublishWatch({ runId = null } = {}) {
    stopPublishWatch()
    publishWatch.value = 'watching'
    publishPollCount.value = 0
    publishProgress.value = { step: 'unknown', minutes: 0, url: null }
    watchStartedAt = Date.now()
    publishBeganAt = watchStartedAt
    publishMinutes.value = 0
    watchedRunId = runId ? String(runId) : null
    brokerExists.value = null
    pagesLive.value = null

    const tick = async () => {
      publishPollCount.value++
      publishMinutes.value = Math.floor((Date.now() - publishBeganAt) / 60_000)
      try {
        const token = getToken()
        const brokerRepo = brokerRepoName({ assignment: form.value })
        if (token && !brokerExists.value) {
          const brokerRes = await getRepo(token, org(), brokerRepo)
          if (brokerRes.ok) brokerExists.value = true
        }
        // Two things have to be true, and only one of them was being checked.
        // The workflow mints the invitation into the control repo while we
        // poll, so the form has never seen it - read it first, then ask whether
        // the page a student would open is actually there.
        const inviteToken = await refreshInvitation(form.value.id)
        if (inviteToken && (await acceptanceCardIsLive(inviteToken))) {
          brokerExists.value = true
          pagesLive.value = true
          publishWatch.value = 'ready'
          onReady?.('Published! The invitation link is live and ready to share.')
          return
        }
        await readPublishProgress()
      } catch {
        // A failed poll is not a failed publish; the next tick asks again.
      }
      // The read above may have ended the watch (a publish that failed).
      if (publishWatch.value !== 'watching') return
      const elapsed = Date.now() - watchStartedAt
      if (elapsed >= WATCH_MS) {
        publishWatch.value = 'timeout'
        // The workflow may well have finished and only Pages be lagging, so the
        // link is often already there. Show it rather than making the lecturer
        // press "Check Status Now" to find out.
        await verifyLiveInfrastructure(form.value.id)
        return
      }
      timer = setTimeout(tick, elapsed >= SLOW_AFTER_MS ? SLOW_TICK_MS : TICK_MS)
    }

    timer = setTimeout(tick, FIRST_TICK_MS)
  }

  // The reason this is a composable and not five loose functions.
  onBeforeUnmount(stopPublishWatch)

  return {
    publishWatch,
    publishPollCount,
    publishProgress,
    publishMinutes,
    liveCheckLoading,
    brokerExists,
    pagesLive,
    refreshInvitation,
    verifyLiveInfrastructure,
    startPublishWatch,
    stopPublishWatch,
  }
}
