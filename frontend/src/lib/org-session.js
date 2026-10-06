// What every page of an organization shares, for the one top bar they share
// (OrgShell.vue, BETA-UX.md 2026-10-03): the organizations this account's App
// installations reach, a status light for each, and whether this session has
// already seen the account act as staff in one.
//
// It lived inside DashboardView while the org picker was the dashboard's own,
// which is why the picker existed on one page only. Module state, so it
// survives moving between pages: the picker does not refetch, and the tabs do
// not wait for a check this session already passed.

import { ref } from 'vue'
import { getInstallations, getRepoContent, listRepoDir } from './api.js'
import { readTrackingIssue } from './tracking-issue.js'
import { TIMED_OUT, withDeadline } from './section-deadline.js'
import { normalizeLogin } from '../../../lib/github-login.mjs'
import { assignmentsToSettle, noticesForLecturer, provisionedLogins } from '../../../lib/org-notices.mjs'
import { ASSIGNMENTS_DIR, assignmentIdFromFile, reportPath } from '../../../lib/control-layout.mjs'

export const orgs = ref([])
export const orgsLoaded = ref(false)
export const orgsLoadError = ref(null)
// org (normalized) -> 'active' | 'inactive' | 'empty' | 'no-access'
export const orgStatusMap = ref(new Map())
// Set when the lecturer leaves for GitHub's installation page, cleared as soon
// as an org appears. Without it, "install finished, now what?" has no answer
// in this UI at all.
export const connectPending = ref(false)

export const LAST_ORG_KEY = 'pxl_last_selected_org'

export function rememberOrg(org) {
  try { localStorage.setItem(LAST_ORG_KEY, org) } catch { /* private window: nothing to remember */ }
}
export function rememberedOrg() {
  try { return localStorage.getItem(LAST_ORG_KEY) } catch { return null }
}

export function setOrgStatus(org, status) {
  if (!org) return
  const next = new Map(orgStatusMap.value)
  next.set(normalizeLogin(org), status)
  orgStatusMap.value = next
}

export function orgStatus(org) {
  if (!org) return 'unknown'
  return orgStatusMap.value.get(normalizeLogin(org)) || 'unknown'
}

export function orgStatusTitle(org) {
  const status = orgStatus(org)
  if (status === 'active') return 'Active: at least one open assignment available'
  if (status === 'inactive') return 'Inactive: assignments exist, but none currently open'
  if (status === 'empty') return 'Empty: no assignments in this organization'
  // "no assignments here" and "you cannot see this organization's course data"
  // are different facts, and the second must not render as the first.
  if (status === 'no-access') return 'No access: this account is not staff on this organization'
  return 'Loading organization status…'
}

export function orgStatusLabel(org) {
  const status = orgStatus(org)
  if (status === 'active') return 'Open Assignments Active'
  if (status === 'inactive') return 'All Assignments Closed'
  if (status === 'empty') return 'No Assignments'
  if (status === 'no-access') return 'No Access'
  return 'Loading Status…'
}

export function orgStatusDot(org) {
  const status = orgStatus(org)
  if (status === 'active') return 'success'
  if (status === 'inactive') return 'warning'
  return 'neutral'
}

export const isInstalled = (org) => !!org && orgs.value.some((o) => normalizeLogin(o.login) === normalizeLogin(org))

/**
 * A light per organization, from the static Pages index - no API cost. Only
 * fills an org the dashboard has not already lit from its own fuller read.
 */
async function loadOrgStatuses(list) {
  const now = new Date()
  await Promise.all(list.map(async (org) => {
    if (orgStatusMap.value.has(normalizeLogin(org.login))) return
    let status = 'empty'
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}data/${org.login}/assignments.json`, { cache: 'no-cache' })
      if (res.ok) {
        let data = null
        try { data = await res.json() } catch { /* unparseable: no assignments known */ }
        const listed = Object.values(data?.assignments || {})
        if (listed.length) {
          const hasActive = listed.some((a) => {
            if (a.state !== 'published') return false
            if (a.opens_at && now < new Date(a.opens_at)) return false
            if (a.deadline_at && now > new Date(a.deadline_at)) return false
            return true
          })
          status = hasActive ? 'active' : 'inactive'
        }
      }
    } catch {
      // unreachable: leave it empty, which is what it said before
    }
    if (!orgStatusMap.value.has(normalizeLogin(org.login))) setOrgStatus(org.login, status)
  }))
}

let inFlight = null
// Bumped by forgetOrgSession. A read started for the account that signed out
// finishes after it, and wrote that account's organizations into the list the
// next one to sign in, in the same tab, was then served from cache.
let session = 0
/**
 * The App installations this account can see, as organizations. Resolves to
 * the list; `force` refetches (returning from GitHub's install page).
 */
export function loadOrgs(token, { force = false } = {}) {
  if (!token) return Promise.resolve(orgs.value)
  if (inFlight) return inFlight
  if (orgsLoaded.value && !force && !orgsLoadError.value) return Promise.resolve(orgs.value)
  const mine = session
  const promise = (async () => {
    orgsLoadError.value = null
    try {
      const installs = await getInstallations(token)
      if (mine !== session) return []
      if (!installs.ok) {
        orgsLoadError.value = `Failed to load installations (HTTP ${installs.status})`
        return orgs.value
      }
      const list = (installs.data.installations || [])
        .filter((i) => i.account?.type === 'Organization')
        .map((i) => i.account)
      orgs.value = list
      loadOrgStatuses(list)
      return list
    } catch (e) {
      if (mine !== session) return []
      orgsLoadError.value = `Failed to load installations: ${e.message || 'unknown error'}`
      return orgs.value
    } finally {
      if (mine === session) {
        orgsLoaded.value = true
        inFlight = null
      }
    }
  })()
  inFlight = promise
  return promise
}

// ------------------------------------------------------------- staff, so far

// org (normalized) -> true | false. Set by the page that READ the answer -
// the control repository and control-repo-access.js - never assumed: a staff
// surface is gated on demonstrated capability (CLAUDE.md). Absent is unknown,
// and unknown shows no tabs.
export const staffIn = ref(new Map())

export function markStaff(org, isStaff) {
  if (!org) return
  const key = normalizeLogin(org)
  if (staffIn.value.get(key) === isStaff) return
  const next = new Map(staffIn.value)
  next.set(key, isStaff)
  staffIn.value = next
}

export const knownStaff = (org) => !!org && staffIn.value.get(normalizeLogin(org)) === true

// ------------------------------------------------------- what needs you, a count

// org (normalized) -> number. The Organization tab carries it on every page of
// the org (OrgSwitch.vue), so a notice is seen where the lecturer already is
// rather than only by someone who opens that tab. Absent is unknown, and
// unknown shows nothing - never a zero it did not count.
export const needsYouIn = ref(new Map())
const needsYouReading = new Set()

export function setNeedsYou(org, count) {
  if (!org) return
  const next = new Map(needsYouIn.value)
  if (Number.isInteger(count) && count >= 0) next.set(normalizeLogin(org), count)
  else next.delete(normalizeLogin(org))
  needsYouIn.value = next
}

export const needsYouCount = (org) => (org ? needsYouIn.value.get(normalizeLogin(org)) ?? null : null)

/**
 * Who has a repository in each of these assignments, from their reports: what
 * settles a notice about one student (lib/org-notices.mjs `noticesForLecturer`).
 * An assignment whose report cannot be read is left out, so its notices stay -
 * unknown is not settled. One read per assignment, and only for those with
 * such a notice (`assignmentsToSettle`), which is usually none.
 *
 * @returns {Promise<Map<string, Set<string>>>}
 */
export async function readProvisioned(token, org, controlRepo, ids) {
  const map = new Map()
  await Promise.all((ids || []).map(async (id) => {
    try {
      const text = await getRepoContent(token, org, controlRepo, reportPath(id))
      if (text) map.set(id, provisionedLogins(JSON.parse(text)?.students))
    } catch {
      // unread: its notices stay
    }
  }))
  return map
}

/**
 * The count for one organization, read once per session: its notices and the
 * names of its assignment files, through the rule the Organization page lists
 * them by (`noticesForLecturer`, lib/org-notices.mjs) - so the tab and the page
 * cannot disagree. Three requests. A read that fails leaves it unknown. The
 * Organization page sets it again from its own read.
 */
export async function loadNeedsYou(token, org, controlRepo) {
  const key = normalizeLogin(org || '')
  if (!token || !key || needsYouIn.value.has(key) || needsYouReading.has(key)) return
  needsYouReading.add(key)
  const mine = session
  try {
    const [tracking, files] = await Promise.all([
      withDeadline(readTrackingIssue(token, { org, controlRepo }))
        .then((t) => (t === TIMED_OUT ? { state: 'unreadable' } : t)),
      listRepoDir(token, org, controlRepo, ASSIGNMENTS_DIR).catch((e) => (e?.status === 404 ? [] : null)),
    ])
    if (mine !== session) return
    if (tracking.state === 'unreadable' || tracking.state === 'no-repo' || !files) return
    const ids = new Set(files.map((f) => assignmentIdFromFile(f.name)).filter(Boolean))
    const comments = tracking.state === 'ok' ? tracking.comments : []
    const provisioned = await readProvisioned(token, org, controlRepo, assignmentsToSettle(comments).filter((id) => ids.has(id)))
    if (mine !== session) return
    setNeedsYou(org, noticesForLecturer(comments, { assignmentIds: ids, provisioned }).length)
  } catch {
    // A read that timed out or failed: the count stays unknown, and the tab
    // shows nothing rather than a number it did not count.
  } finally {
    needsYouReading.delete(key)
  }
}

/** Signed out: nothing about the last account carries over. */
export function forgetOrgSession() {
  session++
  inFlight = null
  orgs.value = []
  orgsLoaded.value = false
  orgsLoadError.value = null
  orgStatusMap.value = new Map()
  staffIn.value = new Map()
  needsYouIn.value = new Map()
  connectPending.value = false
}
