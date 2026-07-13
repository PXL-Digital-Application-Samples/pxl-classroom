<template>
  <div class="dashboard-page">
    <header class="dashboard-header">
      <div class="container flex items-center justify-between">
        <div class="logo flex items-center gap-sm">
          <router-link to="/" class="logo-link" aria-label="PXL Classroom home">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/>
              <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>
            </svg>
          </router-link>
          <h1>Dashboard</h1>
        </div>
        <div class="header-right flex items-center gap-md">
          <select v-if="orgs.length > 0" v-model="selectedOrg" class="org-select" aria-label="Select organization">
            <option value="">Select organization…</option>
            <option v-for="org in orgs" :key="org.login" :value="org.login">{{ org.login }}</option>
          </select>
          <UserBadge :user="user" @logout="handleLogout" />
        </div>
      </div>
    </header>

    <main class="container">
      <!-- Not authenticated -->
      <div v-if="!user" class="center-card fade-in">
        <h2>Sign in to access the dashboard</h2>
        <p class="text-secondary">Sign in with a GitHub account that owns an organization with PXL Classroom installed.</p>
        <button class="btn btn-primary btn-lg" @click="startLogin" :disabled="authLoading">
          <template v-if="authLoading">
            <div class="spinner" style="width:18px;height:18px;border-width:2px"></div>
            Waiting…
          </template>
          <template v-else>Sign in with GitHub</template>
        </button>

        <DeviceFlowCard v-if="deviceFlow" :flow="deviceFlow" @cancel="cancelLogin" />
      </div>

      <!-- Loading -->
      <div v-else-if="loadingData" class="center-card fade-in">
        <div class="spinner-lg spinner"></div>
        <p class="text-secondary">Loading dashboard data…</p>
      </div>

      <!-- No org selected -->
      <div v-else-if="!selectedOrg" class="center-card fade-in">
        <h2>Select an organization</h2>
        <p class="text-secondary">Choose an organization from the dropdown above.</p>
      </div>

      <!-- No assignments — say WHY, each cause has a different remedy -->
      <div v-else-if="assignments.length === 0" class="center-card fade-in">
        <template v-if="dashState === 'no-control-repo'">
          <h2>{{ selectedOrg }} isn't onboarded yet</h2>
          <p class="text-secondary">
            There is no <code>{{ selectedOrg }}/pxl-classroom-control</code> repository (or you can't see it).
            A hub admin onboards the org by running the <strong>Setup Organization</strong> workflow — see RUNBOOK §2.
          </p>
        </template>
        <template v-else-if="dashState === 'no-dashboard'">
          <h2>No dashboard data yet</h2>
          <p class="text-secondary">
            The control repo exists, but <code>reports/dashboard.json</code> hasn't been generated yet.
            It appears when an assignment is published (and refreshes nightly).
          </p>
          <router-link :to="{ name: 'admin', params: { org: selectedOrg } }" class="btn btn-primary">Open Admin Panel</router-link>
        </template>
        <template v-else>
          <h2>No assignments yet</h2>
          <p class="text-secondary">Create your first assignment in the Admin Panel.</p>
          <router-link :to="{ name: 'admin', params: { org: selectedOrg } }" class="btn btn-primary">Open Admin Panel</router-link>
        </template>
      </div>

      <!-- Assignment grid -->
      <div v-else class="fade-in">
        <SystemHealth :org="selectedOrg" />

        <div class="flex items-center justify-between" style="margin-bottom: var(--space-md);">
          <h2 style="margin: 0; font-size: 1.25rem;">Assignments</h2>
          <div class="flex items-center gap-sm">
            <router-link :to="{ name: 'usage-org', params: { org: selectedOrg } }" class="btn" style="padding: var(--space-xs) var(--space-md); font-size: 0.9rem;">
              Usage
            </router-link>
            <router-link :to="{ name: 'admin', params: { org: selectedOrg } }" class="btn btn-primary" style="padding: var(--space-xs) var(--space-md); font-size: 0.9rem;">
              Admin Panel
            </router-link>
          </div>
        </div>
        <div class="assignment-grid">
          <div
          v-for="a in assignments"
          :key="a.id"
          class="assignment-card card"
          @click="$router.push({ name: 'assignment-detail', params: { org: selectedOrg, assignmentId: a.id } })"
          role="button"
          tabindex="0"
          @keyup.enter="$router.push({ name: 'assignment-detail', params: { org: selectedOrg, assignmentId: a.id } })"
          @keydown.space.prevent="$router.push({ name: 'assignment-detail', params: { org: selectedOrg, assignmentId: a.id } })"
        >
          <div class="card-header flex items-center justify-between">
            <span :class="['badge', stateClass(a.state)]">{{ a.state }}</span>
            <span class="text-muted text-sm">{{ a.id }}</span>
          </div>
          <h3>{{ a.title }}</h3>
          <p class="deadline-text">Deadline: {{ formatDate(a.deadline_at) }}</p>
          <div class="stats-row">
            <div class="stat">
              <span class="stat-value">{{ a.accepted ?? '—' }}</span>
              <span class="stat-label">Accepted</span>
            </div>
            <div class="stat">
              <span class="stat-value stat-green">{{ a.on_time ?? '—' }}</span>
              <span class="stat-label">On-time</span>
            </div>
            <div class="stat">
              <span class="stat-value stat-yellow">{{ a.late ?? '—' }}</span>
              <span class="stat-label">Late</span>
            </div>
            <div class="stat">
              <span class="stat-value stat-red">{{ a.no_submission ?? '—' }}</span>
              <span class="stat-label">No sub</span>
            </div>
            <div class="stat" v-if="a.with_warnings">
              <span class="stat-value stat-orange">{{ a.with_warnings }}</span>
              <span class="stat-label">Warnings</span>
            </div>
          </div>
        </div>
        </div>
      </div>
    </main>
  </div>
</template>

<script setup>
import { ref, watch, onMounted } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import UserBadge from '../components/UserBadge.vue'
import SystemHealth from '../components/SystemHealth.vue'
import DeviceFlowCard from '../components/DeviceFlowCard.vue'
import { config } from '../lib/config.js'
import { startDeviceFlow, pollDeviceFlow, getToken, getUser, isAuthenticated, clearAuth, initAuth } from '../lib/auth.js'
import { getInstallations, getUserOrgs, getOrgMembership, getRepoContent, getRepo } from '../lib/api.js'
import { formatDate } from '../lib/format.js'

const props = defineProps({
  org: { type: String, required: false }
})

const router = useRouter()
const route = useRoute()

const user = ref(getUser())
const orgs = ref([])
const selectedOrg = ref(props.org || '')
const assignments = ref([])
const loadingData = ref(false)
const authLoading = ref(false)
const deviceFlow = ref(null)
let pollAbort = null

// Why the assignment list is empty: '' | 'no-control-repo' | 'no-dashboard' | 'empty'
const dashState = ref('')

onMounted(async () => {
  if (isAuthenticated()) {
    user.value = getUser()
    await loadOrgs()
  }
})

// immediate so navigating back to /dashboard/<org> from the breadcrumb
// triggers loadDashboard even when selectedOrg is already set from the URL
// param at init (re-assigning the same value doesn't fire a normal watcher).
watch(selectedOrg, async (org) => {
  if (org) {
    if (route.params.org !== org) {
      router.replace({ name: 'dashboard', params: { org } })
    }
    await loadDashboard(org)
  }
}, { immediate: true })

function stateClass(state) {
  return { published: 'badge-success', closed: 'badge-warning', draft: 'badge-neutral', archived: 'badge-neutral' }[state] || 'badge-neutral'
}



async function loadOrgs() {
  const token = getToken()
  if (!token) return

  try {
    // Get installations accessible to this user token.
    // For GitHub Apps, /user/installations already filters to installations the
    // user can access — which for org installations means the user is an org
    // admin (or the install grants user-level repo access). No further
    // membership check is needed; /user/memberships/orgs/{org} requires the
    // org-administration scope which our user-to-server tokens don't have,
    // and the call would 403.
    const installs = await getInstallations(token)
    if (!installs.ok) return

    const installOrgs = (installs.data.installations || [])
      .filter((i) => i.account?.type === 'Organization')
      .map((i) => i.account)

    if (installOrgs.length > 0) {
      orgs.value = installOrgs
    } else {
      console.warn('No App installations found for this user. Falling back to default config org.')
      orgs.value = [{ login: config.defaultOrg, avatar_url: '' }]
    }

    // Auto-select based on URL param or fallback
    if (props.org && orgs.value.some(o => o.login === props.org)) {
      selectedOrg.value = props.org
    } else if (orgs.value.length === 1) {
      selectedOrg.value = orgs.value[0].login
    }
  } catch (e) {
    console.error('Failed to load orgs:', e)
  }
}

async function loadDashboard(org) {
  loadingData.value = true
  assignments.value = []
  dashState.value = ''

  const token = getToken()
  if (!token) { loadingData.value = false; return }

  try {
    // Distinguish "org not onboarded" from "no dashboard yet" from "empty" —
    // each empty state points the lecturer at a different remedy.
    const repoRes = await getRepo(token, org, config.controlRepo)
    if (!repoRes.ok) {
      dashState.value = 'no-control-repo'
      return
    }
    const content = await getRepoContent(token, org, config.controlRepo, 'reports/dashboard.json')
    if (!content) {
      dashState.value = 'no-dashboard'
      return
    }
    const data = JSON.parse(content)
    assignments.value = Object.entries(data.assignments || {}).map(([id, a]) => ({ id, ...a }))
    if (assignments.value.length === 0) dashState.value = 'empty'
  } catch (e) {
    console.error('Failed to load dashboard:', e)
    dashState.value = 'no-dashboard'
  } finally {
    loadingData.value = false
  }
}

async function startLogin() {
  if (!config.clientId) return
  authLoading.value = true
  try {
    const flow = await startDeviceFlow(config.clientId)
    deviceFlow.value = flow
    pollAbort = new AbortController()
    const result = await pollDeviceFlow(config.clientId, flow.device_code, flow.interval, pollAbort.signal)
    user.value = result.user
    deviceFlow.value = null
    await loadOrgs()
  } catch (e) {
    if (e.message !== 'Cancelled') console.error(e)
    deviceFlow.value = null
  }
  authLoading.value = false
}

function cancelLogin() {
  if (pollAbort) pollAbort.abort()
  deviceFlow.value = null
  authLoading.value = false
}

function handleLogout() {
  clearAuth()
  user.value = null
  orgs.value = []
  selectedOrg.value = ''
  assignments.value = []
}
</script>

<style scoped>
.dashboard-page {
  min-height: 100vh;
}

.dashboard-header {
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border-default);
  padding: var(--space-md) 0;
  position: sticky;
  top: 0;
  z-index: 10;
  backdrop-filter: blur(10px);
}

.logo-link {
  color: var(--accent-blue);
  display: flex;
}

h1 {
  font-size: 1.25rem;
  font-weight: 600;
}

.org-select {
  min-width: 200px;
}

.avatar {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  border: 2px solid var(--border-default);
}

main {
  padding: var(--space-xl) var(--space-lg);
}

.center-card {
  max-width: 480px;
  margin: var(--space-2xl) auto;
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-md);
}

.device-flow-inline {
  margin-top: var(--space-lg);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-sm);
}
.device-code-big {
  font-family: var(--font-mono);
  font-size: 1.75rem;
  font-weight: 700;
  color: var(--accent-blue);
  letter-spacing: 0.1em;
}

.assignment-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: var(--space-lg);
}

.assignment-card {
  cursor: pointer;
  transition: all var(--transition-normal);
}
.assignment-card:hover {
  border-color: var(--accent-blue);
  box-shadow: var(--shadow-glow);
  transform: translateY(-2px);
}

.card-header {
  margin-bottom: var(--space-sm);
}

.assignment-card h3 {
  font-size: 1.125rem;
  font-weight: 600;
  margin-bottom: var(--space-xs);
}

.deadline-text {
  color: var(--text-secondary);
  font-size: 0.875rem;
  margin-bottom: var(--space-md);
}

.stats-row {
  display: flex;
  gap: var(--space-md);
  padding-top: var(--space-md);
  border-top: 1px solid var(--border-muted);
}

.stat {
  display: flex;
  flex-direction: column;
  align-items: center;
  min-width: 48px;
}

.stat-value {
  font-size: 1.25rem;
  font-weight: 700;
}
.stat-label {
  font-size: 0.7rem;
  text-transform: uppercase;
  color: var(--text-muted);
  letter-spacing: 0.03em;
}

.stat-green { color: var(--accent-green); }
.stat-yellow { color: var(--accent-yellow); }
.stat-red { color: var(--accent-red); }
.stat-orange { color: var(--accent-orange); }

.text-sm { font-size: 0.8rem; }
.text-secondary { color: var(--text-secondary); }
.text-muted { color: var(--text-muted); }

@media (max-width: 640px) {
  .header-right { flex-direction: column; gap: var(--space-sm); }
  .org-select { min-width: 160px; }
}
</style>
