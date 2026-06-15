<template>
  <div class="dashboard-page">
    <header class="dashboard-header">
      <div class="container flex items-center justify-between">
        <div class="logo flex items-center gap-sm">
          <router-link to="/" class="logo-link">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
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
          <div v-if="user" class="user-badge flex items-center gap-sm">
            <img :src="user.avatar_url" :alt="user.login" class="avatar" />
            <span>{{ user.login }}</span>
            <button class="btn" @click="handleLogout">Sign out</button>
          </div>
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

        <div v-if="deviceFlow" class="device-flow-inline">
          <p>Go to <a :href="deviceFlow.verification_uri" target="_blank">{{ deviceFlow.verification_uri }}</a> and enter:</p>
          <code class="device-code-big">{{ deviceFlow.user_code }}</code>
          <div class="spinner" style="margin-top:12px"></div>
        </div>
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

      <!-- No assignments -->
      <div v-else-if="assignments.length === 0" class="center-card fade-in">
        <h2>No assignments found</h2>
        <p class="text-secondary">No assignments in {{ selectedOrg }}'s control repository, or the control repo doesn't exist yet.</p>
      </div>

      <!-- Assignment grid -->
      <div v-else class="assignment-grid fade-in">
        <div
          v-for="a in assignments"
          :key="a.id"
          class="assignment-card card"
          @click="$router.push({ name: 'assignment-detail', params: { org: selectedOrg, assignmentId: a.id } })"
          role="button"
          tabindex="0"
          @keyup.enter="$router.push({ name: 'assignment-detail', params: { org: selectedOrg, assignmentId: a.id } })"
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
    </main>
  </div>
</template>

<script setup>
import { ref, watch, onMounted } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { config } from '../lib/config.js'
import { startDeviceFlow, pollDeviceFlow, getToken, getUser, isAuthenticated, clearAuth, initAuth } from '../lib/auth.js'
import { getInstallations, getUserOrgs, getOrgMembership, getRepoContent } from '../lib/api.js'

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

onMounted(async () => {
  if (isAuthenticated()) {
    user.value = getUser()
    await loadOrgs()
  }
})

watch(selectedOrg, async (org) => {
  if (org) {
    if (route.params.org !== org) {
      router.replace({ name: 'dashboard', params: { org } })
    }
    await loadDashboard(org)
  }
})

function stateClass(state) {
  return { published: 'badge-success', closed: 'badge-warning', draft: 'badge-neutral', archived: 'badge-neutral' }[state] || 'badge-neutral'
}

function formatDate(iso) {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString('en-GB', {
      timeZone: config.timezone, month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
    })
  } catch { return iso }
}

async function loadOrgs() {
  const token = getToken()
  if (!token) return

  try {
    // Get installations accessible to this user token
    const installs = await getInstallations(token)
    if (!installs.ok) return

    const installOrgs = (installs.data.installations || [])
      .filter((i) => i.account?.type === 'Organization')
      .map((i) => i.account)

    // A GitHub App user-to-server token's installations already reflect what the user can access.
    if (installOrgs.length > 0) {
      orgs.value = installOrgs
    } else {
      console.warn("No installations found via API. Falling back to default config org.")
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

  const token = getToken()
  if (!token) { loadingData.value = false; return }

  try {
    const content = await getRepoContent(token, org, config.controlRepo, 'reports/dashboard.json')
    if (content) {
      const data = JSON.parse(content)
      assignments.value = Object.entries(data.assignments || {}).map(([id, a]) => ({ id, ...a }))
    }
  } catch (e) {
    console.error('Failed to load dashboard:', e)
  }

  loadingData.value = false
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
