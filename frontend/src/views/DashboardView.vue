<template>
  <div class="dashboard-page">
    <header class="dashboard-header">
      <div class="container flex items-center justify-between">
        <div class="logo flex items-center gap-md">
          <router-link to="/" class="logo-link" aria-label="PXL Classroom home">
            <img :src="logoUrl" alt="PXL Classroom" class="header-logo" />
          </router-link>
          <div class="header-titles flex items-center gap-sm">
            <span class="header-app-title">PXL Classroom</span>
            <span class="lecturer-badge">Lecturer Dashboard</span>
          </div>
        </div>
        <div class="header-right flex items-center gap-sm">
          <!-- Custom Organization Selector with Styled Status Lights -->
          <div v-if="orgs.length > 0" class="org-dropdown-container" ref="orgDropdownRef">
            <button
              type="button"
              class="org-dropdown-btn"
              @click.stop="toggleOrgDropdown"
              :aria-expanded="orgDropdownOpen"
              aria-haspopup="listbox"
              aria-label="Select organization"
            >
              <span class="flex items-center gap-sm">
                <span
                  class="status-lamp"
                  :class="`lamp-${getOrgStatus(selectedOrg)}`"
                  :title="getOrgStatusTitle(selectedOrg)"
                ></span>
                <span class="org-label">{{ selectedOrg || 'Select organization…' }}</span>
              </span>
              <Icon :name="orgDropdownOpen ? 'chevron-up' : 'chevron-down'" :size="14" class="dropdown-chevron" />
            </button>

            <div
              v-if="orgDropdownOpen"
              class="org-dropdown-menu"
              role="listbox"
              aria-label="Organizations"
              tabindex="-1"
            >
              <div
                v-for="org in orgs"
                :key="org.login"
                class="org-dropdown-item"
                :class="{ 'is-selected': org.login === selectedOrg }"
                role="option"
                :aria-selected="org.login === selectedOrg"
                @click="selectOrg(org.login)"
                @keydown.enter.prevent="selectOrg(org.login)"
                @keydown.space.prevent="selectOrg(org.login)"
                tabindex="0"
              >
                <span
                  class="status-lamp"
                  :class="`lamp-${getOrgStatus(org.login)}`"
                  :title="getOrgStatusTitle(org.login)"
                ></span>
                <span class="org-item-text">{{ org.login }}</span>
                <Icon v-if="org.login === selectedOrg" name="check" :size="14" class="check-icon" />
              </div>
            </div>
          </div>

          <button
            v-if="selectedOrg"
            type="button"
            class="btn btn-icon health-btn"
            @click="showHealthModal = true"
            title="System health check"
            aria-label="System health check"
          >
            <Icon name="activity" :size="16" />
          </button>
          <UserBadge :user="user" @logout="handleLogout" />
        </div>
      </div>
    </header>

    <main class="container">
      <!-- Organization Title & Live Status Bar -->
      <div v-if="user && selectedOrg && !loadingData && !dashError && !orgsLoadError" class="org-header-bar flex items-center justify-between fade-in">
        <div class="org-info-group flex items-center gap-md">
          <h2 class="org-heading">{{ selectedOrg }}</h2>
          <span class="org-status-pill" :class="`pill-${getOrgStatus(selectedOrg)}`">
            <span class="status-lamp" :class="`lamp-${getOrgStatus(selectedOrg)}`"></span>
            <span>{{ getOrgStatusLabel(selectedOrg) }}</span>
          </span>
        </div>
        <div class="org-actions-group flex items-center gap-sm">
          <router-link :to="{ name: 'admin', params: { org: selectedOrg }, query: { new: '1' } }" class="btn btn-primary btn-with-icon">
            <Icon name="plus" :size="14" />
            <span>Assignment</span>
          </router-link>
        </div>
      </div>
      <!-- Not authenticated -->
      <div v-if="!user" class="center-card fade-in">
        <h2>Sign in to access the dashboard</h2>
        <p class="text-secondary">Sign in with a GitHub account that owns an organization with PXL Classroom installed.</p>
        <p v-if="authError" class="auth-error" role="alert">{{ authError }} - try signing in again.</p>
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

      <!-- Orgs load error -->
      <div v-else-if="orgsLoadError" class="center-card fade-in">
        <h2>Couldn't load your organizations</h2>
        <p class="text-secondary" role="alert" style="margin-bottom: var(--space-md);">
          {{ orgsLoadError }}
        </p>
        <button class="btn btn-primary" @click="loadOrgs">Retry</button>
      </div>

      <!-- Dashboard Load Error -->
      <div v-else-if="selectedOrg && dashError" class="center-card fade-in">
        <h2 class="text-danger">Failed to load dashboard</h2>
        <p class="text-secondary" style="margin-bottom: var(--space-md);">{{ dashError }}</p>
        <button class="btn btn-primary" @click="loadDashboard">Retry</button>
      </div>

      <!-- No installation visible to this account (Student or unconfigured lecturer) -->
      <div v-else-if="orgsLoaded && orgs.length === 0" class="center-card fade-in">
        <h2>Student Account Detected</h2>
        <p class="text-secondary">
          Your account (<strong>{{ user.login }}</strong>) does not administer any course organizations.
          If you are enrolled in a course, view your accepted repositories in the Student Portal.
        </p>
        <router-link to="/" class="btn btn-primary" style="margin-top: var(--space-xs);">
          Go to My Assignments
        </router-link>
        <p class="text-muted text-xs" style="margin-top: var(--space-lg); line-height: 1.4;">
          If you are a lecturer, ensure the PXL Classroom App is installed on your organization — see
          <a :href="`${runbookUrl}#21-install-the-app-on-the-new-org`" target="_blank" rel="noopener">RUNBOOK §2.1</a>.
        </p>
      </div>

      <!-- No org selected -->
      <div v-else-if="!selectedOrg" class="center-card fade-in">
        <h2>Select an organization</h2>
        <p class="text-secondary">Choose an organization from the dropdown above.</p>
      </div>

      <!-- No assignments - say WHY, each cause has a different remedy -->
      <div v-else-if="assignments.length === 0" class="center-card fade-in">
        <template v-if="dashState === 'no-control-repo'">
          <h2>{{ selectedOrg }} isn't onboarded yet</h2>
          <p class="text-secondary">
            There is no <code>{{ selectedOrg }}/pxl-classroom-control</code> repository (or you can't see it).
            A hub admin onboards the org by running the <strong>Setup Organization</strong> workflow - see
            <a :href="`${runbookUrl}#2-onboarding-a-new-organization-per-org`" target="_blank" rel="noopener">RUNBOOK §2</a>.
          </p>
        </template>
        <template v-else-if="dashState === 'no-dashboard'">
          <h2>No dashboard data yet</h2>
          <p class="text-secondary">
            The control repo exists, but <code>reports/dashboard.json</code> hasn't been generated yet.
            It appears when an assignment is published (and refreshes nightly).
            <span v-if="draftCount > 0" style="display: block; margin-top: var(--space-xs);">
              You have {{ draftCount }} draft{{ draftCount > 1 ? 's' : '' }} in the Admin Panel - publish to track them here.
            </span>
          </p>
          <router-link :to="{ name: 'admin', params: { org: selectedOrg } }" class="btn btn-primary">Open Admin Panel</router-link>
        </template>
        <template v-else>
          <h2>No assignments yet</h2>
          <p class="text-secondary">
            Create your first assignment in the Admin Panel.
            <span v-if="draftCount > 0" style="display: block; margin-top: var(--space-xs);">
              You have {{ draftCount }} draft{{ draftCount > 1 ? 's' : '' }} in the Admin Panel - publish to track them here.
            </span>
          </p>
          <router-link :to="{ name: 'admin', params: { org: selectedOrg } }" class="btn btn-primary">Open Admin Panel</router-link>
        </template>
      </div>

      <!-- Assignment grid -->
      <div v-else class="fade-in">
        <div class="flex items-center justify-between" style="margin-bottom: var(--space-md);">
          <div class="flex items-center gap-md">
            <h2 style="margin: 0; font-size: 1.25rem;">Assignments</h2>
            <label v-if="archivedCount > 0" class="flex items-center gap-xs text-sm text-secondary" style="cursor: pointer; user-select: none;">
              <input type="checkbox" v-model="showArchived" />
              <span>Show archived ({{ archivedCount }})</span>
            </label>
          </div>
        </div>
        
        <div v-if="visibleAssignments.length === 0" class="center-card text-secondary" style="padding: var(--space-xl); margin-top: var(--space-lg);">
          No active assignments right now.
        </div>
        <div v-else class="assignment-grid">
          <router-link
            v-for="a in visibleAssignments"
            :key="a.id"
            :to="{ name: 'assignment-detail', params: { org: selectedOrg, assignmentId: a.id } }"
            class="assignment-card card"
            style="text-decoration: none; color: inherit; display: block;"
          >
            <div class="card-header flex items-center justify-between">
              <span :class="['badge', stateClass(a.state)]">{{ a.state }}</span>
              <span class="text-muted text-sm">{{ a.id }}</span>
            </div>
            <h3>{{ a.title }}</h3>
            <p class="deadline-text">Deadline: {{ formatDate(a.deadline_at, a.timezone) }}</p>
            <div class="stats-row">
              <div class="stat">
                <span class="stat-value">{{ a.accepted ?? '-' }}</span>
                <span class="stat-label">Accepted</span>
              </div>
              <div class="stat">
                <span class="stat-value stat-green">{{ a.on_time ?? '-' }}</span>
                <span class="stat-label">On-time</span>
              </div>
              <div class="stat">
                <span class="stat-value stat-yellow">{{ a.late ?? '-' }}</span>
                <span class="stat-label">Late</span>
              </div>
              <div class="stat">
                <span class="stat-value stat-red">{{ a.no_submission ?? '-' }}</span>
                <span class="stat-label">No sub</span>
              </div>
              <div class="stat" v-if="a.with_warnings">
                <span class="stat-value stat-orange">{{ a.with_warnings }}</span>
                <span class="stat-label">Warnings</span>
              </div>
            </div>
          </router-link>
        </div>
      </div>

      <!-- Embedded Resource Usage & Limits Section -->
      <UsagePanel v-if="user && selectedOrg && !loadingData && !dashError && !orgsLoadError && dashState !== 'no-control-repo'" :org="selectedOrg" />

      <!-- Health Diagnostics Modal -->
      <div v-if="showHealthModal" class="modal-overlay" @click.self="showHealthModal = false">
        <div class="modal health-modal" role="dialog" aria-modal="true" :aria-label="`System Health for ${selectedOrg}`">
          <header class="modal-head">
            <div class="flex items-center gap-sm">
              <Icon name="activity" :size="18" />
              <h3 style="margin: 0;">System Health: <code>{{ selectedOrg }}</code></h3>
            </div>
            <button class="modal-close" type="button" @click="showHealthModal = false" aria-label="Close">×</button>
          </header>
          <div class="modal-body">
            <SystemHealth :org="selectedOrg" />
          </div>
        </div>
      </div>
    </main>
  </div>
</template>

<script setup>
import { ref, watch, onMounted, onUnmounted, computed } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { parse as parseYaml } from 'yaml'
import UserBadge from '../components/UserBadge.vue'
import SystemHealth from '../components/SystemHealth.vue'
import UsagePanel from '../components/UsagePanel.vue'
import DeviceFlowCard from '../components/DeviceFlowCard.vue'
import Icon from '../components/Icon.vue'
import logoUrl from '../assets/logo.png'
import { config } from '../lib/config.js'
import { startDeviceFlow, pollDeviceFlow, getToken, getUser, isAuthenticated, clearAuth } from '../lib/auth.js'
import { getInstallations, getRepoContent, getRepo, listRepoDir } from '../lib/api.js'
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
const authError = ref(null)
const deviceFlow = ref(null)
const showHealthModal = ref(false)
let pollAbort = null

// Custom Dropdown State & Status Lights
const orgDropdownOpen = ref(false)
const orgDropdownRef = ref(null)
const orgStatusMap = ref(new Map())

function toggleOrgDropdown() {
  orgDropdownOpen.value = !orgDropdownOpen.value
}

function selectOrg(orgLogin) {
  selectedOrg.value = orgLogin
  orgDropdownOpen.value = false
}

function getOrgStatus(orgLogin) {
  if (!orgLogin) return 'unknown'
  return orgStatusMap.value.get(orgLogin.toLowerCase()) || 'unknown'
}

function getOrgStatusTitle(orgLogin) {
  const status = getOrgStatus(orgLogin)
  if (status === 'active') return 'Active: at least one open assignment available'
  if (status === 'inactive') return 'Inactive: assignments exist, but none currently open'
  if (status === 'empty') return 'Empty: no assignments in this organization'
  return 'Loading organization status…'
}

function getOrgStatusLabel(orgLogin) {
  const status = getOrgStatus(orgLogin)
  if (status === 'active') return 'Open Assignments Active'
  if (status === 'inactive') return 'All Assignments Closed'
  if (status === 'empty') return 'No Assignments'
  return 'Loading Status…'
}

function onOutsideClick(e) {
  if (orgDropdownRef.value && !orgDropdownRef.value.contains(e.target)) {
    orgDropdownOpen.value = false
  }
}

async function loadOrgStatuses(orgList, token) {
  const now = new Date()
  await Promise.all(
    orgList.map(async (org) => {
      const login = org.login.toLowerCase()
      if (token) {
        try {
          const files = await listRepoDir(token, org.login, config.controlRepo, 'assignments')
          const ymls = files.filter(f => f.type === 'file' && (f.name.endsWith('.yml') || f.name.endsWith('.yaml')))
          if (ymls.length === 0) {
            orgStatusMap.value.set(login, 'empty')
            return
          }
          const docs = await Promise.all(
            ymls.map(async (f) => {
              try {
                const text = await getRepoContent(token, org.login, config.controlRepo, f.path)
                return text ? parseYaml(text) : null
              } catch {
                return null
              }
            })
          )
          const list = docs.filter(Boolean)
          if (list.length === 0) {
            orgStatusMap.value.set(login, 'empty')
            return
          }
          const hasActive = list.some((a) => {
            if (a.state !== 'published') return false
            if (a.opens_at && now < new Date(a.opens_at)) return false
            if (a.deadline_at && now > new Date(a.deadline_at)) return false
            return true
          })
          orgStatusMap.value.set(login, hasActive ? 'active' : 'inactive')
          return
        } catch (e) {
          // fall through to public pages check
        }
      }

      try {
        // 1. Try public Pages data
        const res = await fetch(`${import.meta.env.BASE_URL}data/${org.login}/assignments.json`)
        if (res.ok) {
          let data = null
          try { data = await res.json() } catch { /* ignore */ }
          const list = Object.values(data?.assignments || {})
          if (list.length === 0) {
            orgStatusMap.value.set(login, 'empty')
            return
          }
          const hasActive = list.some((a) => {
            if (a.state !== 'published') return false
            if (a.opens_at && now < new Date(a.opens_at)) return false
            if (a.deadline_at && now > new Date(a.deadline_at)) return false
            return true
          })
          orgStatusMap.value.set(login, hasActive ? 'active' : 'inactive')
          return
        }
      } catch (e) {
        // fallback
      }

      orgStatusMap.value.set(login, 'empty')
    })
  )
}

// Why the assignment list is empty: '' | 'no-control-repo' | 'no-dashboard' | 'empty'
const dashState = ref('')
const dashError = ref(null)

const draftCount = ref(0)
const showArchived = ref(false)

const archivedCount = computed(() => {
  return assignments.value.filter(a => a.state === 'archived').length
})

const visibleAssignments = computed(() => {
  return assignments.value.filter(a => {
    if (a.state === 'archived' && !showArchived.value) return false
    return true
  })
})

// True once /user/installations has answered - gates the "no installation
// visible" empty state so it can't flash during the initial load.
const orgsLoaded = ref(false)
const orgsLoadError = ref(null)

const runbookUrl = `https://github.com/${config.hubOwner}/${config.hubRepo}/blob/main/RUNBOOK.md`

function onGlobalKeydown(e) {
  if (e.key === 'Escape') {
    showHealthModal.value = false
    orgDropdownOpen.value = false
  }
}

onMounted(async () => {
  window.addEventListener('click', onOutsideClick)
  window.addEventListener('keydown', onGlobalKeydown)
  if (isAuthenticated()) {
    user.value = getUser()
    await loadOrgs()
  }
})

onUnmounted(() => {
  window.removeEventListener('click', onOutsideClick)
  window.removeEventListener('keydown', onGlobalKeydown)
})

const LAST_ORG_KEY = 'pxl_last_selected_org'

// immediate so navigating back to /dashboard/<org> from the breadcrumb
// triggers loadDashboard even when selectedOrg is already set from the URL
// param at init (re-assigning the same value doesn't fire a normal watcher).
watch(selectedOrg, async (org) => {
  if (org) {
    try { localStorage.setItem(LAST_ORG_KEY, org) } catch { /* ignore */ }
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

  orgsLoadError.value = null
  orgsLoaded.value = false
  try {
    const installs = await getInstallations(token)
    if (!installs.ok) {
      orgsLoadError.value = `Failed to load installations (HTTP ${installs.status})`
      return
    }

    const installOrgs = (installs.data.installations || [])
      .filter((i) => i.account?.type === 'Organization')
      .map((i) => i.account)

    orgs.value = installOrgs
    loadOrgStatuses(installOrgs, token)

    // Auto-select based on URL param, remembered localStorage, or single-org fallback
    const savedOrg = localStorage.getItem(LAST_ORG_KEY)
    if (props.org && orgs.value.some(o => o.login.toLowerCase() === props.org.toLowerCase())) {
      selectedOrg.value = props.org
    } else if (savedOrg && orgs.value.some(o => o.login.toLowerCase() === savedOrg.toLowerCase())) {
      selectedOrg.value = savedOrg
    } else if (orgs.value.length === 1) {
      selectedOrg.value = orgs.value[0].login
    }
  } catch (e) {
    console.error('Failed to load orgs:', e)
    orgsLoadError.value = `Failed to load installations: ${e.message || 'unknown error'}`
  } finally {
    orgsLoaded.value = true
  }
}

async function loadDashboard(org) {
  loadingData.value = true
  assignments.value = []
  dashState.value = ''
  draftCount.value = 0

  const token = getToken()
  if (!token) { loadingData.value = false; return }

  dashError.value = null
  try {
    // Distinguish "org not onboarded" from "no dashboard yet" from "empty" -
    // each empty state points the lecturer at a different remedy.
    const repoRes = await getRepo(token, org, config.controlRepo)
    if (!repoRes.ok) {
      if (repoRes.status === 404) {
        dashState.value = 'no-control-repo'
        orgStatusMap.value.set(org.toLowerCase(), 'empty')
        return
      }
      const e = new Error(repoRes.data?.message || `Failed to read repository (HTTP ${repoRes.status})`)
      e.status = repoRes.status
      throw e
    }

    let yamlAssignments = []
    try {
      const files = await listRepoDir(token, org, config.controlRepo, 'assignments')
      const ymls = files.filter(f => f.type === 'file' && (f.name.endsWith('.yml') || f.name.endsWith('.yaml')))
      
      const loaded = await Promise.all(
        ymls.map(async (f) => {
          try {
            const text = await getRepoContent(token, org, config.controlRepo, f.path)
            if (!text) return null
            const doc = parseYaml(text)
            const id = doc.id || f.name.replace(/\.ya?ml$/, '')
            return { ...doc, id }
          } catch {
            return null
          }
        })
      )
      yamlAssignments = loaded.filter(Boolean)
      draftCount.value = yamlAssignments.filter(a => a.state === 'draft').length
    } catch (e) {
      // ignore
    }

    let reportData = null
    try {
      const content = await getRepoContent(token, org, config.controlRepo, 'reports/dashboard.json')
      if (content) {
        reportData = JSON.parse(content)
      }
    } catch (e) {
      // ignore
    }

    const mergedMap = new Map()
    if (reportData?.assignments) {
      for (const [id, a] of Object.entries(reportData.assignments)) {
        mergedMap.set(id, { id, ...a })
      }
    }

    for (const ya of yamlAssignments) {
      const existing = mergedMap.get(ya.id) || {}
      mergedMap.set(ya.id, {
        ...existing,
        ...ya,
        // Live state, title, and dates from repository YAMLs are always authoritative
        state: ya.state || existing.state || 'draft',
        title: ya.title || existing.title || ya.id,
        deadline_at: ya.deadline_at || existing.deadline_at,
        opens_at: ya.opens_at || existing.opens_at,
        timezone: ya.timezone || existing.timezone,
      })
    }

    const stateOrder = { published: 1, closed: 2, archived: 3 }
    const displayList = Array.from(mergedMap.values())
      .filter(a => a.state !== 'draft')
      .sort((a, b) => {
        const diff = (stateOrder[a.state] || 99) - (stateOrder[b.state] || 99)
        if (diff !== 0) return diff
        return (a.id || '').localeCompare(b.id || '')
      })

    assignments.value = displayList

    const now = new Date()
    const hasActive = assignments.value.some((a) => {
      if (a.state !== 'published') return false
      if (a.opens_at && now < new Date(a.opens_at)) return false
      if (a.deadline_at && now > new Date(a.deadline_at)) return false
      return true
    })

    if (assignments.value.length === 0) {
      dashState.value = yamlAssignments.length === 0 && !reportData ? 'no-dashboard' : 'empty'
      orgStatusMap.value.set(org.toLowerCase(), 'empty')
    } else {
      dashState.value = ''
      orgStatusMap.value.set(org.toLowerCase(), hasActive ? 'active' : 'inactive')
    }
  } catch (e) {
    console.error('Failed to load dashboard:', e)
    if (e instanceof SyntaxError) {
      dashError.value = `Dashboard data is corrupted (JSON parse error). Run RUNBOOK §9.5 recovery.`
    } else {
      dashError.value = `Failed to load dashboard: ${e.message || String(e)}`
    }
  } finally {
    loadingData.value = false
  }
}

async function startLogin() {
  authError.value = null
  if (!config.clientId) {
    authError.value = 'GitHub App Client ID is not configured. Set VITE_GITHUB_CLIENT_ID.'
    return
  }
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
    // Sign-in failures render inside the auth card - never silently.
    if (e.message !== 'Cancelled') authError.value = e.message
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
  orgsLoaded.value = false
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

.header-titles {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
}

.header-app-title {
  font-size: 1.15rem;
  font-weight: 700;
  color: var(--text-primary);
  letter-spacing: -0.01em;
}

.lecturer-badge {
  font-size: 0.72rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding: 2px 8px;
  border-radius: var(--radius-full, 9999px);
  background: rgba(88, 166, 255, 0.15);
  color: var(--accent-blue, #58a6ff);
  border: 1px solid rgba(88, 166, 255, 0.3);
}

/* Organization Header Banner */
.org-header-bar {
  background: var(--bg-surface, #161b22);
  border: 1px solid var(--border-default, #30363d);
  border-radius: var(--radius-lg, 8px);
  padding: var(--space-md) var(--space-lg);
  margin-bottom: var(--space-xl);
}

.org-heading {
  margin: 0;
  font-size: 1.35rem;
  font-weight: 700;
  color: var(--text-primary);
}

.org-status-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 0.8rem;
  font-weight: 500;
  padding: 3px 10px;
  border-radius: var(--radius-full, 9999px);
  border: 1px solid var(--border-default, #30363d);
}

.pill-active {
  background: rgba(46, 160, 67, 0.12);
  border-color: rgba(46, 160, 67, 0.35);
  color: var(--accent-green, #3fb950);
}

.pill-inactive {
  background: rgba(176, 101, 0, 0.12);
  border-color: rgba(176, 101, 0, 0.35);
  color: #d29922;
}

.pill-empty {
  background: rgba(110, 118, 129, 0.12);
  border-color: rgba(110, 118, 129, 0.25);
  color: var(--text-secondary, #8b949e);
}

.pill-unknown {
  background: transparent;
  color: var(--text-muted);
}

/* Custom Dropdown Container & Trigger */
.org-dropdown-container {
  position: relative;
  min-width: 220px;
}

.org-dropdown-btn {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-sm);
  background: var(--bg-surface, #161b22);
  border: 1px solid var(--border-default, #30363d);
  color: var(--text-primary, #c9d1d9);
  padding: 5px 12px;
  border-radius: var(--radius-md, 6px);
  font-size: var(--font-size-sm, 13px);
  font-weight: 500;
  cursor: pointer;
  width: 100%;
  min-height: 32px;
  transition: border-color 0.15s, background-color 0.15s;
}

.org-dropdown-btn:hover {
  border-color: var(--border-hover, #8b949e);
  background: var(--bg-surface-hover, #21262d);
}

.org-dropdown-btn:focus-visible {
  outline: 2px solid var(--color-accent, #58a6ff);
  outline-offset: 1px;
}

.org-dropdown-menu {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  min-width: 240px;
  background: var(--bg-surface, #161b22);
  border: 1px solid var(--border-default, #30363d);
  border-radius: var(--radius-md, 6px);
  box-shadow: 0 8px 24px rgba(1, 4, 9, 0.6);
  z-index: 100;
  max-height: 280px;
  overflow-y: auto;
  padding: 4px;
}

.org-dropdown-item {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  padding: 7px 10px;
  border-radius: var(--radius-sm, 4px);
  font-size: var(--font-size-sm, 13px);
  color: var(--text-primary, #c9d1d9);
  cursor: pointer;
  transition: background-color 0.12s;
}

.org-dropdown-item:hover,
.org-dropdown-item:focus-visible {
  background: var(--bg-surface-hover, #21262d);
  outline: none;
}

.org-dropdown-item.is-selected {
  font-weight: 600;
  color: var(--color-accent, #58a6ff);
}

.check-icon {
  margin-left: auto;
  color: var(--color-accent, #58a6ff);
}

.dropdown-chevron {
  color: var(--text-secondary, #8b949e);
  flex-shrink: 0;
}

/* Status Lamp Indicators */
.status-lamp {
  display: inline-block;
  width: 8px;
  height: 8px;
  min-width: 8px;
  min-height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  box-sizing: border-box;
}

/* Green Light: Active Open Assignment */
.lamp-active {
  background-color: #2ea043;
  box-shadow: 0 0 6px rgba(46, 160, 67, 0.85);
}

/* Dim Orange Light: Assignments present, none open */
.lamp-inactive {
  background-color: #b06500;
  opacity: 0.85;
}

/* Extinguished Light: 0 assignments in org */
.lamp-empty {
  background-color: transparent;
  border: 1.5px solid #484f58;
  opacity: 0.7;
}

/* Loading / Unknown */
.lamp-unknown {
  background-color: #30363d;
  opacity: 0.5;
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

.auth-error {
  color: var(--accent-red);
  border: 1px solid var(--accent-red);
  border-radius: var(--radius-md);
  padding: var(--space-sm) var(--space-md);
  font-size: 0.9rem;
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

.health-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border-radius: var(--radius-md);
  border: 1px solid var(--border-default);
  background: var(--bg-secondary);
  color: var(--text-primary);
  cursor: pointer;
  transition: all 0.15s ease;
  flex-shrink: 0;
}
.health-btn:hover {
  background: var(--bg-tertiary);
  border-color: var(--border-hover, var(--border-default));
}

.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.65);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  padding: var(--space-md);
  backdrop-filter: blur(4px);
}
.modal {
  background: var(--bg-secondary);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  width: 100%;
  max-width: 620px;
  max-height: 85vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.health-modal .modal-head {
  padding: var(--space-md) var(--space-lg);
  border-bottom: 1px solid var(--border-default);
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: var(--bg-tertiary);
}
.health-modal .modal-head h3 {
  font-size: 1rem;
  font-weight: 600;
}
.health-modal .modal-head code {
  background: var(--bg-primary);
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 0.85rem;
}
.modal-close {
  background: none;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 1.4rem;
  line-height: 1;
  padding: 0 var(--space-xs);
}
.modal-close:hover {
  color: var(--text-primary);
}
.health-modal .modal-body {
  padding: var(--space-lg);
  overflow-y: auto;
}

@media (max-width: 640px) {
  .header-right { flex-direction: column; gap: var(--space-sm); align-items: stretch; }
  .org-select { min-width: 160px; width: 100%; }
  .health-btn { justify-content: center; }
}
</style>
