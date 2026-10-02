<template>
  <!-- NO `fade-in` here, for the reason AdminView gives: it leaves a transform
       on the element, and the health dialog is position: fixed. -->
  <div>
    <AppHeader :user="user" @logout="handleLogout">
      <template #left>
        <div class="app-header-crumbs flex items-center gap-sm">
          <router-link :to="{ name: 'dashboard', params: { org } }" class="back-link">
            <Icon name="arrow-left" :size="14" />
            <span>Dashboard</span>
          </router-link>
          <span class="app-header-sep">/</span>
          <router-link :to="{ name: 'dashboard', params: { org } }" class="crumb-link">{{ org }}</router-link>
          <span class="app-header-sep">/</span>
          <h1 class="app-header-heading">Organization</h1>
          <OrgSwitch v-if="user && access === null && !loading" :org="org" current="organization" />
        </div>
      </template>
    </AppHeader>

    <div class="org-page container">
      <AuthCard v-if="!user" title="Sign in to open the organization" @authenticated="onAuthenticated">
        Sign in with a GitHub account that owns <strong>{{ org }}</strong>.
        Sessions last 8 hours. If you were signed in earlier, it has expired.
      </AuthCard>

      <template v-else>
        <div v-if="loading" class="org-loading"><div class="spinner"></div></div>
        <ControlRepoUnreadable
          v-else-if="access"
          :org="org"
          :access="access"
          :viewer-login="user?.login || ''"
          @retry="load"
        />
        <div v-else-if="loadError" class="org-load-error">
          <p class="text-secondary">{{ loadError }}</p>
          <button class="btn btn-sm" type="button" @click="load">Retry</button>
        </div>

        <template v-else>
          <!-- WHAT NEEDS YOU, OR THAT NOTHING DOES (BETA-UX.md, 2026-10-02).
               One sentence first, and only things a lecturer can act on. The
               notices are never marked done - a repeat rewrites them - so this
               lists the RECENT ones and says that is what it lists. -->
          <section class="card org-needs" aria-labelledby="org-needs-title">
            <template v-if="noticesState === 'unreadable'">
              <h2 id="org-needs-title" class="org-needs-title">
                <span class="status-dot dot-warning"></span>
                Couldn't read the notifications.
              </h2>
              <p class="text-secondary">
                This is not "nothing needs you" - it is unknown.
                <a v-if="issueUrl" :href="issueUrl" target="_blank" rel="noopener">Open the notifications on GitHub</a>
              </p>
            </template>
            <template v-else-if="needsYou.length">
              <h2 id="org-needs-title" class="org-needs-title">
                <span class="status-dot dot-warning"></span>
                {{ needsYou.length === 1 ? '1 thing needs you' : `${needsYou.length} things need you` }}
              </h2>
              <p class="text-secondary text-sm">From the last {{ NEEDS_YOU_DAYS }} days.</p>
              <ul class="org-needs-list">
                <li v-for="n in needsYou" :key="n.key || n.at">
                  <div class="org-needs-head">
                    <router-link
                      v-if="assignmentIds.has(n.assignmentId)"
                      :to="{ name: 'assignment-detail', params: { org, assignmentId: n.assignmentId } }"
                    >{{ titleOf(n.assignmentId) }}</router-link>
                    <span class="text-muted text-xs">{{ fmt(n.at) }}</span>
                  </div>
                  <p class="org-needs-text">{{ plainDetails(n.details) }}</p>
                </li>
              </ul>
              <p class="text-muted text-sm">
                <a v-if="issueUrl" :href="issueUrl" target="_blank" rel="noopener">All notifications, on GitHub</a>
              </p>
            </template>
            <template v-else>
              <h2 id="org-needs-title" class="org-needs-title">
                <span class="status-dot dot-success"></span>
                All quiet - nothing needs you.
              </h2>
              <p class="text-secondary text-sm">
                <template v-if="lastNightly">
                  The nightly check last ran {{ formatRelative(lastNightly.at) }}
                  <template v-if="lastNightly.ok === false">and did not finish cleanly</template>.
                </template>
                <template v-else>Nothing has been reported in the last {{ NEEDS_YOU_DAYS }} days.</template>
              </p>
            </template>
          </section>

          <!-- Folded below: what the system did, how it is, what it costs, how
               it is connected. Expanded by a click, never alarming at a glance. -->
          <details class="card org-fold" open>
            <summary><h3>Course activity</h3></summary>
            <ul class="org-activity">
              <li v-for="row in activity" :key="row.id">
                <router-link :to="{ name: 'assignment-detail', params: { org, assignmentId: row.id } }" class="org-activity-title">{{ row.title }}</router-link>
                <span class="org-activity-text" :class="{ 'text-warning': row.attention }">{{ row.phrases.join(' · ') }}</span>
                <span v-if="row.checkedAt" class="text-muted text-xs">checked {{ formatRelative(row.checkedAt) }}</span>
              </li>
              <li v-if="!activity.length" class="text-secondary">No assignments yet.</li>
            </ul>

            <details class="org-technical">
              <summary>Technical details</summary>
              <p class="text-muted text-sm">
                Recent runs that can be tied to {{ org }}. A failed acceptance run is often a refusal the
                system handled; the course activity above is the reliable summary.
              </p>
              <ul class="org-runs">
                <li v-for="r in runs" :key="r.id">
                  <span class="status-dot" :class="runDot(r)"></span>
                  <a :href="r.html_url" target="_blank" rel="noopener">{{ r.label }}</a>
                  <span class="text-muted text-xs">{{ runOutcome(r) }} · {{ formatRelative(r.created_at) }}</span>
                </li>
                <li v-if="runsUnreadable" class="text-secondary">The run list could not be read.</li>
                <li v-else-if="!runs.length" class="text-secondary">No recent runs.</li>
              </ul>
            </details>
          </details>

          <!-- Not inside a folded card like its neighbours: the panel is a card
               with its own fold already, and a card in a card is DESIGN.md
               §1.1's box prison. -->
          <UsagePanel :org="org" />


          <details class="card org-fold">
            <summary><h3>Connection &amp; setup</h3></summary>
            <ul class="org-links">
              <li>
                <a :href="`https://github.com/${org}/${config.controlRepo}`" target="_blank" rel="noopener">The control repository</a>
                <span class="text-muted text-sm"> - where this organization's assignments, roster and records are kept</span>
              </li>
              <li>
                <a :href="`https://github.com/organizations/${org}/settings/installations`" target="_blank" rel="noopener">The GitHub App installation</a>
                <span class="text-muted text-sm"> - which repositories it can reach (it needs all of them)</span>
              </li>
              <li>
                <router-link :to="{ name: 'setup' }">Setup</router-link>
                <span class="text-muted text-sm"> - connecting another organization, or checking this one's setup</span>
              </li>
            </ul>
          </details>
        </template>

        <!-- OUTSIDE every state above, on purpose: checking what is wrong is
             most needed exactly when this page cannot load - GitHub not
             answering, a control repository this account cannot read - and a
             check that only appears once everything has loaded is never there
             when it is needed. -->
        <details class="card org-fold">
          <summary><h3>System health</h3></summary>
          <p class="text-secondary">
            Checks your sign-in, the GitHub App, the control repository, the assignments, their
            acceptance repositories and the published pages, and offers a fix where one exists.
          </p>
          <button class="btn btn-secondary btn-sm" type="button" @click="showHealth = true">Run the checks</button>
        </details>
      </template>
    </div>

    <SystemHealthModal :is-open="showHealth" :org="org" @close="showHealth = false" />
  </div>
</template>

<script setup>
// The organization's own page (BETA-UX.md, 2026-10-02). It replaced "Admin",
// which was a second list of every assignment beside the editor: the editor is
// each assignment's Settings tab now, and what was really the organization's -
// health, usage, connection - was scattered over a header button, the bottom of
// the assignment cards and a route of its own.

import { computed, ref, watch, onMounted } from 'vue'
import AppHeader from '../components/AppHeader.vue'
import AuthCard from '../components/AuthCard.vue'
import Icon from '../components/Icon.vue'
import OrgSwitch from '../components/OrgSwitch.vue'
import ControlRepoUnreadable from '../components/ControlRepoUnreadable.vue'
import SystemHealthModal from '../components/SystemHealthModal.vue'
import UsagePanel from '../components/UsagePanel.vue'
import { clearAuth, getToken, getUser, isAuthenticated } from '../lib/auth.js'
import { getRepo, getRepoContent, ghApi } from '../lib/api.js'
import { config } from '../lib/config.js'
import { classifyUnreadableControlRepo } from '../lib/control-repo-access.js'
import { loadAssignmentDocs } from '../lib/org-assignments.js'
import { readTrackingIssue } from '../lib/tracking-issue.js'
import { formatDate, formatRelative } from '../lib/format.js'
import { NEEDS_YOU_DAYS, noticesNeedingYou, plainDetails } from '../../../lib/org-notices.mjs'
import { activitySummary } from '../../../lib/course-activity.mjs'
import { rejectionCount, rejectionsForAssignment } from '../../../lib/rejection-notice.mjs'
import { DASHBOARD_PATH, lockdownRecordPath } from '../../../lib/control-layout.mjs'
import { RUN_NAME_PREFIX } from '../../../lib/acceptance-run-name.mjs'

const props = defineProps({
  org: { type: String, required: true },
})

const user = ref(null)
const loading = ref(true)
const loadError = ref('')
const access = ref(null)
const showHealth = ref(false)

const docs = ref([])
const dashboard = ref(null)
const locks = ref(new Map())
const comments = ref([])
const noticesState = ref('ok')
const issueUrl = ref(null)
const runs = ref([])
const runsUnreadable = ref(false)
const lastNightly = ref(null)

const fmt = (iso) => (iso ? formatDate(iso) : '')
const assignmentIds = computed(() => new Set(docs.value.map((d) => d.id)))
function titleOf(id) {
  return docs.value.find((d) => d.id === id)?.title || id
}

const needsYou = computed(() => noticesNeedingYou(comments.value))

const activity = computed(() => {
  const entries = dashboard.value?.assignments || {}
  return docs.value
    .filter((d) => d.state !== 'archived')
    .map((d) => {
      const entry = entries[d.id] ? { ...entries[d.id], state: d.state, deadline_at: d.deadline_at || entries[d.id].deadline_at } : (d.state === 'draft' ? { state: 'draft' } : null)
      const summary = activitySummary({
        entry,
        lock: locks.value.get(d.id) || null,
        refused: rejectionCount(rejectionsForAssignment(comments.value, d.id)),
      })
      return { id: d.id, title: d.title || d.id, ...summary }
    })
})

function runDot(r) {
  if (r.status !== 'completed') return 'dot-info'
  return r.conclusion === 'success' ? 'dot-success' : r.conclusion === 'failure' ? 'dot-warning' : 'dot-neutral'
}
function runOutcome(r) {
  if (r.status !== 'completed') return r.status === 'queued' ? 'waiting for GitHub to start it' : 'running'
  return r.conclusion === 'success' ? 'finished' : r.conclusion === 'cancelled' ? 'stopped' : r.conclusion === 'failure' ? 'failed' : r.conclusion || 'finished'
}

let generation = 0

async function loadRuns(token) {
  const hub = `${config.hubOwner}/${config.hubRepo}`
  const [acceptance, nightly] = await Promise.all([
    ghApi(token, 'GET', `/repos/${hub}/actions/workflows/acceptance-handler.yml/runs?per_page=100`),
    ghApi(token, 'GET', `/repos/${hub}/actions/workflows/daily-activity.yml/runs?per_page=5`),
  ])
  if (!acceptance.ok || !nightly.ok) {
    runsUnreadable.value = true
    return
  }
  // An acceptance run is named after its attempt, `acceptance <org>/<broker>#<n>`
  // (lib/acceptance-run-name.mjs), which is what ties it to this organization.
  const mine = (acceptance.data?.workflow_runs || [])
    .filter((r) => String(r.display_title || '').startsWith(`${RUN_NAME_PREFIX}${props.org}/`))
    .slice(0, 15)
    .map((r) => ({ ...r, label: `Acceptance ${String(r.display_title).slice(RUN_NAME_PREFIX.length + props.org.length + 1)}` }))
  const nights = (nightly.data?.workflow_runs || []).map((r) => ({ ...r, label: 'Nightly check (all organizations)' }))
  runs.value = [...mine, ...nights].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
  const lastNight = nights.find((r) => r.status === 'completed')
  lastNightly.value = lastNight ? { at: lastNight.created_at, ok: lastNight.conclusion === 'success' } : null
}

async function load() {
  const mine = ++generation
  loading.value = true
  loadError.value = ''
  access.value = null
  const token = getToken()
  try {
    const repoRes = await getRepo(token, props.org, config.controlRepo)
    if (mine !== generation) return
    if (!repoRes.ok) {
      if (repoRes.status === 404) {
        access.value = await classifyUnreadableControlRepo(
          (method, path) => ghApi(token, method, path),
          { org: props.org, hubOwner: config.hubOwner, hubRepo: config.hubRepo },
        )
      } else {
        loadError.value = `Couldn't read ${props.org}'s control repository (HTTP ${repoRes.status}).`
      }
      return
    }
    const [assignmentDocs, dash, tracking] = await Promise.all([
      loadAssignmentDocs(token, props.org),
      getRepoContent(token, props.org, config.controlRepo, DASHBOARD_PATH).catch(() => null),
      readTrackingIssue(token, { org: props.org, controlRepo: config.controlRepo }),
    ])
    if (mine !== generation) return
    docs.value = assignmentDocs
    try {
      dashboard.value = dash ? JSON.parse(dash) : null
    } catch {
      dashboard.value = null
    }
    noticesState.value = tracking.state === 'unreadable' ? 'unreadable' : 'ok'
    comments.value = tracking.state === 'ok' ? tracking.comments : []
    issueUrl.value = tracking.issueUrl || null

    // The deadline's lock record, only for assignments whose deadline passed.
    const past = assignmentDocs.filter((d) => d.deadline_at && Date.parse(d.deadline_at) < Date.now() && d.state !== 'draft')
    const read = await Promise.all(past.map(async (d) => {
      const text = await getRepoContent(token, props.org, config.controlRepo, lockdownRecordPath(d.id)).catch(() => null)
      try {
        return [d.id, text ? JSON.parse(text) : null]
      } catch {
        return [d.id, null]
      }
    }))
    if (mine !== generation) return
    locks.value = new Map(read.filter(([, rec]) => rec))
    await loadRuns(token).catch(() => { runsUnreadable.value = true })
  } catch (e) {
    if (mine !== generation) return
    console.error('Failed to load the organization page', e)
    loadError.value = `Couldn't load ${props.org}${e?.status ? ` (HTTP ${e.status})` : ''}.`
  } finally {
    if (mine === generation) loading.value = false
  }
}

function onAuthenticated(authedUser) {
  user.value = authedUser
  load()
}

function handleLogout() {
  clearAuth()
  user.value = null
}

watch(() => props.org, () => { if (user.value) load() })

onMounted(() => {
  if (!isAuthenticated()) { loading.value = false; return }
  user.value = getUser()
  load()
})
</script>

<style scoped>
.org-page { padding-top: var(--space-xl); padding-bottom: var(--space-2xl); max-width: 1100px; }
.org-loading { display: flex; justify-content: center; padding: var(--space-xl); }
.org-load-error { text-align: center; padding: var(--space-lg); }
.org-needs { padding: var(--space-lg); margin-bottom: var(--space-md); }
.org-needs-title { display: flex; align-items: center; gap: var(--space-sm); font-size: 1.1rem; margin: 0 0 var(--space-xs); }
.org-needs-list { list-style: none; padding: 0; margin: var(--space-md) 0; display: flex; flex-direction: column; gap: var(--space-md); }
.org-needs-head { display: flex; align-items: baseline; gap: var(--space-sm); flex-wrap: wrap; }
.org-needs-text { margin: var(--space-xs) 0 0; white-space: pre-line; color: var(--text-secondary); font-size: 0.9rem; }
.org-fold { padding: var(--space-md) var(--space-lg); margin-bottom: var(--space-md); }
.org-fold > summary { cursor: pointer; list-style-position: outside; }
.org-fold > summary h3 { display: inline; font-size: 1rem; margin: 0; }
.org-activity, .org-runs, .org-links { list-style: none; padding: 0; margin: var(--space-md) 0 0; display: flex; flex-direction: column; gap: var(--space-sm); }
.org-activity li { display: flex; gap: var(--space-sm); align-items: baseline; flex-wrap: wrap; }
.org-activity-title { font-weight: 600; }
.org-activity-text { color: var(--text-secondary); }
.org-technical { margin-top: var(--space-md); }
.org-technical > summary { cursor: pointer; color: var(--text-secondary); font-size: 0.9rem; }
.org-runs li { display: flex; gap: var(--space-sm); align-items: center; flex-wrap: wrap; }
</style>
