<template>
  <div class="dashboard-page">
    <AppHeader :user="user" @logout="handleLogout">
      <template #left>
        <router-link to="/" class="app-header-logo-link" aria-label="PXL Classroom home">
          <img :src="logoUrl" alt="" class="header-logo" />
        </router-link>
        <div class="header-titles flex items-center gap-sm">
            <router-link to="/" class="app-header-title">PXL Classroom</router-link>
            <span class="app-header-sep">/</span>

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
                <Icon :name="orgDropdownOpen ? 'chevron-up' : 'chevron-down'" :size="12" class="dropdown-chevron" />
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
                  <Icon v-if="org.login === selectedOrg" name="check" :size="13" class="check-icon" />
                </div>
              </div>
            </div>

            <span class="lecturer-tag text-muted text-xs">Lecturer</span>
        </div>
      </template>
      <template #actions>
        <button
          v-if="selectedOrg"
          type="button"
          class="btn btn-ghost btn-icon"
          @click="showHealthModal = true"
          title="System health check"
          aria-label="System health check"
        >
          <Icon name="activity" :size="16" />
        </button>
      </template>
    </AppHeader>

    <main class="container">
      <!-- Not authenticated -->
      <AuthCard v-if="!user" title="Sign in to access the dashboard" @authenticated="onAuthenticated">
        Sign in with a GitHub account that owns an organization with PXL Classroom installed.
      </AuthCard>

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
        <template v-else-if="dashState === 'onboarding'">
          <div class="onboarding-readiness-card">
            <div class="onboarding-head">
              <Icon name="award" :size="24" class="text-blue" />
              <div>
                <h2>Welcome to {{ selectedOrg }}</h2>
                <p class="text-secondary">Your course organization is connected to PXL Classroom. Follow these simple steps to launch your first assignment:</p>
              </div>
            </div>

            <div class="onboarding-steps">
              <div class="onboarding-step is-complete">
                <div class="step-icon"><Icon name="check-circle" :size="16" class="text-green" /></div>
                <div class="step-body">
                  <strong>1. Course Organization Connected</strong>
                  <p>PXL Classroom Provisioner App is installed and active on <code>{{ selectedOrg }}</code>.</p>
                </div>
              </div>

              <div class="onboarding-step">
                <div class="step-icon"><Icon name="git-branch" :size="16" class="text-yellow" /></div>
                <div class="step-body">
                  <strong>2. Prepare Starter Code Template</strong>
                  <p>Have an exercise repository for students? Create a repo in <code>{{ selectedOrg }}</code> on GitHub and check <em>"Template repository"</em> under its Settings.</p>
                </div>
              </div>

              <div class="onboarding-step">
                <div class="step-icon"><Icon name="plus-circle" :size="16" class="text-blue" /></div>
                <div class="step-body">
                  <strong>3. Create &amp; Publish Assignment</strong>
                  <p>Open the Admin Panel, select your template, and generate the student invitation link.</p>
                </div>
              </div>
            </div>

            <div class="onboarding-actions">
              <router-link :to="{ name: 'admin', params: { org: selectedOrg }, query: { new: '1' } }" class="btn btn-primary btn-with-icon">
                <Icon name="plus" :size="14" />
                <span>Create Your First Assignment</span>
              </router-link>
              <button class="btn btn-with-icon" type="button" @click="showHealthModal = true">
                <Icon name="activity" :size="14" />
                <span>Check System Health</span>
              </button>
            </div>
          </div>
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
          <h2>No active assignments right now</h2>
          <p class="text-secondary">
            <span v-if="draftCount > 0">
              You have {{ draftCount }} draft{{ draftCount > 1 ? 's' : '' }} in the Admin Panel.
            </span>
            <span v-else>
              Assignments in this organization are closed or archived.
            </span>
          </p>
          <router-link :to="{ name: 'admin', params: { org: selectedOrg } }" class="btn btn-primary">Open Admin Panel</router-link>
        </template>
      </div>

      <!-- Assignment grid -->
      <div v-else class="fade-in">
        <div class="section-toolbar flex items-center justify-between">
          <div class="flex items-center gap-md">
            <h2 class="section-title">Assignments</h2>
            <span v-if="selectedOrg" class="status-indicator" :title="getOrgStatusTitle(selectedOrg)">
              <span class="status-dot" :class="`dot-${getOrgStatusDot(selectedOrg)}`"></span>
              <span class="text-secondary text-sm">{{ getOrgStatusLabel(selectedOrg) }}</span>
            </span>
            <label v-if="archivedCount > 0" class="archived-toggle flex items-center gap-xs text-sm text-secondary">
              <input type="checkbox" v-model="showArchived" />
              <span>Show archived ({{ archivedCount }})</span>
            </label>
          </div>
          <div class="flex items-center gap-sm">
            <router-link :to="{ name: 'admin', params: { org: selectedOrg }, query: { new: '1' } }" class="btn btn-primary btn-with-icon">
              <Icon name="plus" :size="14" />
              <span>New assignment</span>
            </router-link>
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
              <span class="status-indicator">
                <span class="status-dot" :class="a.state === 'published' ? 'dot-success' : (a.state === 'closed' ? 'dot-warning' : 'dot-neutral')"></span>
                <span class="status-text">{{ a.state === 'published' ? 'Accepting' : (a.state === 'closed' ? 'Closed' : a.state) }}</span>
              </span>
              <span class="text-muted text-xs mono">{{ a.id }}</span>
            </div>
            <h3 class="assignment-card-title">{{ a.title }}</h3>
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

      <!-- Unified Health Diagnostics Modal -->
      <SystemHealthModal
        :is-open="showHealthModal"
        :org="selectedOrg"
        @close="showHealthModal = false"
      />
    </main>
  </div>
</template>

<script setup>
import { ref, watch, onMounted, onUnmounted, computed } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { parse as parseYaml } from 'yaml'
import AppHeader from '../components/AppHeader.vue'
import AuthCard from '../components/AuthCard.vue'
import SystemHealthModal from '../components/SystemHealthModal.vue'
import UsagePanel from '../components/UsagePanel.vue'
import Icon from '../components/Icon.vue'
import logoUrl from '../assets/logo.png'
import { config } from '../lib/config.js'
import { getToken, getUser, isAuthenticated, clearAuth } from '../lib/auth.js'
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
const showHealthModal = ref(false)

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

function getOrgStatusDot(orgLogin) {
  const status = getOrgStatus(orgLogin)
  if (status === 'active') return 'success'
  if (status === 'inactive') return 'warning'
  return 'neutral'
}

function onOutsideClick(e) {
  if (orgDropdownRef.value && !orgDropdownRef.value.contains(e.target)) {
    orgDropdownOpen.value = false
  }
}

async function loadOrgStatuses(orgList) {
  const now = new Date()
  await Promise.all(
    orgList.map(async (org) => {
      const login = org.login.toLowerCase()
      try {
        // Zero API cost: read pre-built static Pages assignments JSON
        const res = await fetch(`${import.meta.env.BASE_URL}data/${org.login}/assignments.json`, { cache: 'no-cache' })
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
    // 1 single API call: Fetch aggregated dashboard report directly
    let reportData = null
    try {
      const content = await getRepoContent(token, org, config.controlRepo, 'reports/dashboard.json')
      if (content) {
        reportData = JSON.parse(content)
      }
    } catch (e) {
      // dashboard.json not found or parse failed
    }

    if (reportData?.assignments && Object.keys(reportData.assignments).length > 0) {
      const stateOrder = { published: 1, closed: 2, archived: 3 }
      const displayList = Object.entries(reportData.assignments)
        .map(([id, a]) => ({ id, ...a }))
        .filter(a => a.state !== 'draft')
        .sort((a, b) => {
          const diff = (stateOrder[a.state] || 99) - (stateOrder[b.state] || 99)
          if (diff !== 0) return diff
          return (a.id || '').localeCompare(b.id || '')
        })

      assignments.value = displayList
      const drafts = Object.values(reportData.assignments).filter(a => a.state === 'draft')
      draftCount.value = drafts.length

      const now = new Date()
      const hasActive = assignments.value.some((a) => {
        if (a.state !== 'published') return false
        if (a.opens_at && now < new Date(a.opens_at)) return false
        if (a.deadline_at && now > new Date(a.deadline_at)) return false
        return true
      })
      dashState.value = assignments.value.length === 0 ? (draftCount.value > 0 ? 'no-dashboard' : 'empty') : ''
      orgStatusMap.value.set(org.toLowerCase(), hasActive ? 'active' : (assignments.value.length > 0 ? 'inactive' : 'empty'))
      return
    }

    // Fallback only if dashboard.json is missing or empty (e.g. newly onboarded org before first cron)
    const repoRes = await getRepo(token, org, config.controlRepo)
    if (!repoRes.ok) {
      if (repoRes.status === 404) {
        dashState.value = 'no-control-repo'
        orgStatusMap.value.set(org.toLowerCase(), 'empty')
        return
      }
    }

    // Check if ANY assignment has been created in assignments/ folder
    let assignmentFiles = []
    try {
      assignmentFiles = await listRepoDir(token, org, config.controlRepo, 'assignments')
    } catch (e) {
      assignmentFiles = []
    }
    const ymls = (assignmentFiles || []).filter(f => f.type === 'file' && (f.name.endsWith('.yml') || f.name.endsWith('.yaml')))

    if (ymls.length === 0) {
      // Zero assignments created in this organization!
      // This is the beginning lecturer state - show the onboarding readiness card!
      dashState.value = 'onboarding'
      orgStatusMap.value.set(org.toLowerCase(), 'empty')
      return
    } else {
      // Assignments HAVE been created in this organization (e.g. drafts or awaiting dashboard.json generation)
      draftCount.value = ymls.length
      dashState.value = 'no-dashboard'
      orgStatusMap.value.set(org.toLowerCase(), 'empty')
      return
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

async function onAuthenticated(authedUser) {
  user.value = authedUser
  await loadOrgs()
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



.header-titles {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
}

.header-app-title:hover {
  text-decoration: none;
  color: var(--accent-blue);
}


.lecturer-tag {
  background: var(--bg-surface-hover);
  padding: 1px 6px;
  border-radius: var(--radius-xs);
  font-weight: 500;
  letter-spacing: 0.02em;
}

/* Custom Dropdown Container & Trigger */
.org-dropdown-container {
  position: relative;
  min-width: 200px;
}

.org-dropdown-btn {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-sm);
  background: var(--bg-canvas);
  border: 1px solid var(--border-default);
  color: var(--text-primary);
  padding: 3px 10px;
  border-radius: var(--radius-sm);
  font-size: 0.85rem;
  font-weight: 500;
  cursor: pointer;
  width: 100%;
  min-height: 28px;
  transition: border-color 0.12s, background-color 0.12s;
}

.org-dropdown-btn:hover {
  border-color: #8b949e;
  background: var(--bg-surface-hover);
}

.org-dropdown-btn:focus-visible {
  outline: 2px solid var(--accent-blue);
  outline-offset: 1px;
}

.org-dropdown-menu {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  min-width: 230px;
  background: var(--bg-surface-elevated);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-md);
  z-index: 100;
  max-height: 280px;
  overflow-y: auto;
  padding: 4px;
}

.org-dropdown-item {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  padding: 6px 10px;
  border-radius: var(--radius-xs);
  font-size: 0.85rem;
  color: var(--text-primary);
  cursor: pointer;
  transition: background-color 0.1s;
}

.org-dropdown-item:hover,
.org-dropdown-item:focus-visible {
  background: var(--bg-surface-hover);
  outline: none;
}

.org-dropdown-item.is-selected {
  font-weight: 600;
  color: var(--accent-blue);
}

.check-icon {
  margin-left: auto;
  color: var(--accent-blue);
}

.dropdown-chevron {
  color: var(--text-muted);
  flex-shrink: 0;
}

/* Status Lamp Indicators */
.status-lamp {
  display: inline-block;
  width: 7px;
  height: 7px;
  min-width: 7px;
  min-height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
  box-sizing: border-box;
}

.lamp-active {
  background-color: var(--accent-green);
  box-shadow: 0 0 5px rgba(63, 185, 80, 0.6);
}

.lamp-inactive {
  background-color: var(--accent-yellow);
  opacity: 0.85;
}

.lamp-empty {
  background-color: transparent;
  border: 1.5px solid #484f58;
  opacity: 0.7;
}

.lamp-unknown {
  background-color: #30363d;
  opacity: 0.5;
}

main {
  padding: var(--space-xl) 0;
}

.section-toolbar {
  margin-bottom: var(--space-lg);
  padding-bottom: var(--space-sm);
  border-bottom: 1px solid var(--border-muted);
}

.section-title {
  margin: 0;
  font-size: 1.2rem;
  font-weight: 600;
}

.archived-toggle {
  cursor: pointer;
  user-select: none;
}



.assignment-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: var(--space-md);
}

.assignment-card {
  cursor: pointer;
  transition: border-color var(--transition-fast), background-color var(--transition-fast);
}
.assignment-card:hover {
  border-color: #58a6ff;
  background: var(--bg-surface-elevated);
}

.card-header {
  margin-bottom: var(--space-sm);
}

.status-text {
  font-size: 0.78rem;
  font-weight: 500;
  color: var(--text-secondary);
}

.assignment-card-title {
  font-size: 1.05rem;
  font-weight: 600;
  margin-bottom: var(--space-xs);
}

.deadline-text {
  color: var(--text-muted);
  font-size: 0.82rem;
  margin-bottom: var(--space-md);
}

.stats-row {
  display: flex;
  gap: var(--space-md);
  padding-top: var(--space-sm);
  border-top: 1px solid var(--border-muted);
}

.stat {
  display: flex;
  flex-direction: column;
  align-items: center;
  min-width: 44px;
}

.stat-value {
  font-size: 1.15rem;
  font-weight: 600;
}
.stat-label {
  font-size: 0.68rem;
  text-transform: uppercase;
  color: var(--text-muted);
  letter-spacing: 0.03em;
}

.stat-green { color: var(--accent-green); }
.stat-yellow { color: var(--accent-yellow); }
.stat-red { color: var(--accent-red); }
.stat-orange { color: var(--accent-orange); }


/* ONBOARDING READINESS CARD */
.onboarding-readiness-card {
  background: var(--bg-surface);
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-md);
  padding: var(--space-xl);
  max-width: 680px;
  margin: var(--space-lg) auto;
  display: flex;
  flex-direction: column;
  gap: var(--space-lg);
}
.onboarding-head {
  display: flex;
  align-items: flex-start;
  gap: var(--space-md);
}
.onboarding-head h2 {
  margin: 0 0 var(--space-xs) 0;
  font-size: 1.15rem;
}
.onboarding-head p {
  margin: 0;
  font-size: 0.88rem;
  line-height: 1.4;
}
.onboarding-steps {
  display: flex;
  flex-direction: column;
  gap: var(--space-md);
  border-top: 1px solid var(--border-muted);
  border-bottom: 1px solid var(--border-muted);
  padding: var(--space-lg) 0;
}
.onboarding-step {
  display: flex;
  align-items: flex-start;
  gap: var(--space-sm);
}
.onboarding-step .step-icon {
  margin-top: 2px;
  flex-shrink: 0;
}
.onboarding-step .step-body strong {
  display: block;
  font-size: 0.9rem;
  margin-bottom: 2px;
}
.onboarding-step .step-body p {
  margin: 0;
  font-size: 0.82rem;
  color: var(--text-secondary);
  line-height: 1.35;
}
.onboarding-actions {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  flex-wrap: wrap;
}

@media (max-width: 640px) {
  .header-right { flex-direction: column; gap: var(--space-sm); align-items: stretch; }
  .health-btn { justify-content: center; }
  .onboarding-actions { flex-direction: column; align-items: stretch; }
  .section-toolbar { flex-direction: column; align-items: flex-start; gap: var(--space-sm); }
}
</style>
