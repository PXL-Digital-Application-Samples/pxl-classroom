// Do students see what is saved? The page asks the facts every time it opens,
// after every save, and again while an update is under way - so the answer
// survives a refresh, and is the same on every tab (lib/student-page-status.js).
//
// Four reads, all cheap: the assignment file's newest commit (when it was
// saved), the card students are served (the student site itself, not an API),
// and the student-site updates since. Re-read every 15 seconds while updating,
// every minute while stuck, never once students see it.

import { onBeforeUnmount, ref, watch } from 'vue'
import { getToken } from '../lib/auth.js'
import { ghApi } from '../lib/api.js'
import { config } from '../lib/config.js'
import { inviteDataUrl, linkSecretFrom } from '../lib/invite.js'
import { republishStudentPages } from '../lib/student-pages.js'
import { deployRunsPath, newestRun } from '../lib/publish-progress.js'
import { studentPageStatus } from '../lib/student-page-status.js'
import { hasStudentCard, studentCard } from '../../../lib/student-card.mjs'
import { assignmentPath } from '../../../lib/control-layout.mjs'

const UPDATING_TICK_MS = 15_000
const STUCK_TICK_MS = 60_000

/**
 * @param {object} deps
 * @param {() => string} deps.org
 * @param {() => string} deps.assignmentId
 * @param {import('vue').Ref<object|null>} deps.assignment  the stored document, reloaded after each save
 */
export function useStudentPageStatus({ org, assignmentId, assignment }) {
  const status = ref({ state: 'none' })
  // Starting the update failed in this tab: kept until the page agrees.
  const failure = ref(null)
  // A request to update made here after the save ("Update the student page
  // now"): an update since THEN is the one that counts.
  let requestedAt = 0
  let timer = null
  let run = 0

  function clear() {
    if (timer) clearTimeout(timer)
    timer = null
  }

  async function savedAt(token) {
    const path = `/repos/${org()}/${config.controlRepo}/commits?path=${encodeURIComponent(assignmentPath(assignmentId()))}&per_page=1`
    const res = await ghApi(token, 'GET', path)
    const at = res.ok && Array.isArray(res.data) ? Date.parse(res.data[0]?.commit?.committer?.date || '') : NaN
    return Number.isFinite(at) ? at : null
  }

  async function servedCard(def) {
    const secret = linkSecretFrom(def)
    if (!secret) return { status: 'missing' }
    try {
      const res = await fetch(`${await inviteDataUrl(org(), secret)}?t=${Date.now()}`, { cache: 'no-store' })
      if (res.status === 404) return { status: 'missing' }
      if (!res.ok) return { status: 'unreadable' }
      const data = await res.json().catch(() => null)
      return data?.assignment ? { status: 'ok', card: data.assignment } : { status: 'unreadable' }
    } catch {
      return { status: 'unreadable' }
    }
  }

  async function check() {
    clear()
    const mine = ++run
    const def = assignment.value
    const token = getToken()
    // No link, no page to compare with: the card is filed under the link's
    // digest, and the generator writes none for an assignment without one.
    // Saying nothing beats a guess (the editor reports a missing link itself).
    if (!def || !token || !hasStudentCard(def) || !linkSecretFrom(def)) {
      status.value = { state: 'none' }
      return
    }
    const saved = studentCard(def, { timezone: config.timezone })
    const [at, served] = await Promise.all([savedAt(token), servedCard(def)])
    const since = Math.max(at || 0, requestedAt) || null
    let deploy = null
    if (since) {
      const res = await ghApi(token, 'GET', deployRunsPath({ owner: config.hubOwner, repo: config.hubRepo, since }))
      deploy = res.ok ? newestRun(res) : null
    }
    if (mine !== run) return
    const next = studentPageStatus({ saved, served, since, deploy, failure: failure.value })
    if (next.state === 'current') failure.value = null
    status.value = next
    if (next.state === 'updating' || next.state === 'failed') timer = setTimeout(check, UPDATING_TICK_MS)
    else if (next.state === 'stuck') timer = setTimeout(check, STUCK_TICK_MS)
  }

  /** "Update the student page now" / "Try again": the rebuild, asked again. */
  async function updateNow() {
    failure.value = null
    requestedAt = Date.now()
    status.value = { ...status.value, state: 'updating', minutes: 0, failure: null }
    const ok = await republishStudentPages({ token: getToken(), org: org(), failure: 'Starting the student page update failed' })
    if (!ok) failure.value = 'GitHub refused to start it'
    await check()
  }

  /** The editor's own start of the update failed (it already said why, once). */
  function reportFailure(reason) {
    failure.value = reason || 'GitHub refused to start it'
    check()
  }

  watch(assignment, () => check(), { immediate: true })
  onBeforeUnmount(clear)

  return { studentPage: status, checkStudentPage: check, updateStudentPage: updateNow, reportStudentPageFailure: reportFailure }
}
