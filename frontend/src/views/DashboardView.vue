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
            <div class="org-dropdown-container" ref="orgDropdownRef">
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

                <div class="org-dropdown-divider" role="separator"></div>
                <a
                  :href="appInstallUrl"
                  target="_blank"
                  rel="noopener"
                  class="org-dropdown-item org-connect-item"
                  role="option"
                  aria-selected="false"
                  @click="onConnectClicked"
                >
                  <Icon name="plus" :size="13" />
                  <span class="org-item-text">Connect an organization</span>
                  <Icon name="external-link" :size="12" class="check-icon" />
                </a>
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
      <!-- GitHub's installation page has no route back here, so returning
           lecturers were left guessing. This stays until an org appears. -->
      <div v-if="connectPending && user" class="connect-pending card flex items-center justify-between gap-md">
        <div class="flex items-center gap-sm">
          <Icon name="info" :size="16" class="text-blue" />
          <span class="text-sm">Finished installing on GitHub?</span>
        </div>
        <div class="flex items-center gap-sm">
          <button class="btn btn-sm btn-with-icon" type="button" @click="refreshOrgsNow">
            <Icon name="refresh-cw" :size="13" />
            <span>Check now</span>
          </button>
          <button class="btn btn-sm btn-ghost" type="button" @click="connectPending = false">Dismiss</button>
        </div>
      </div>

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
      <!-- Two audiences land here: a lecturer whose org is not connected yet,
           and an actual student who followed a stray link. Name both paths
           instead of asserting which one they are - and give the lecturer an
           action rather than a RUNBOOK link. -->
      <div v-else-if="orgsLoaded && orgs.length === 0" class="center-card fade-in">
        <h2>No course organizations yet</h2>
        <p class="text-secondary">
          <strong>{{ user.login }}</strong> has no organization with PXL Classroom installed.
        </p>
        <a :href="appInstallUrl" target="_blank" rel="noopener" class="btn btn-primary btn-with-icon" @click="onConnectClicked">
          <Icon name="plus" :size="14" />
          <span>Connect an organization</span>
        </a>
        <p class="text-muted text-xs" style="max-width: 420px; line-height: 1.5;">
          GitHub will ask which organization to install it on - you will only see
          the ones you can install on. Come back here afterwards; it appears
          automatically.
        </p>
        <p class="text-secondary text-sm" style="margin-top: var(--space-md);">
          Enrolled in a course instead?
          <router-link to="/">View your assignments</router-link>.
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
          <!-- Was a dead end pointing at RUNBOOK §2. The org is already in the
               switcher, so the App IS installed - only the control repo is
               missing, and whether the lecturer can create it themselves
               depends on their hub access. -->
          <div class="setup-required-card">
            <div class="onboarding-head">
              <Icon name="zap" :size="24" class="text-blue" />
              <div>
                <h2>Almost there - {{ selectedOrg }} needs its control repository</h2>
                <p class="text-secondary">
                  One more step before you can create assignments. This runs once per organization.
                </p>
              </div>
            </div>

            <div class="onboarding-steps">
              <div class="onboarding-step" :class="{ 'is-complete': orgIsInstalled }">
                <div class="step-icon">
                  <Icon v-if="orgIsInstalled" name="check-circle" :size="16" class="text-green" />
                  <Icon v-else name="alert-triangle" :size="16" class="text-yellow" />
                </div>
                <div class="step-body">
                  <strong v-if="orgIsInstalled">PXL Classroom is installed on {{ selectedOrg }}</strong>
                  <strong v-else>PXL Classroom is not installed on {{ selectedOrg }} yet</strong>
                  <p v-if="orgIsInstalled">That is why this organization appears in your switcher.</p>
                  <p v-else>
                    Install it first - the step below cannot run until it is.
                    <a :href="appInstallUrl" target="_blank" rel="noopener">Install PXL Classroom</a>.
                  </p>
                </div>
              </div>

              <div class="onboarding-step">
                <div class="step-icon"><Icon name="inbox" :size="16" class="text-yellow" /></div>
                <div class="step-body">
                  <strong>Create the course control repository</strong>
                  <p v-if="hubWritable">
                    One click below creates it. Takes about a minute - this page
                    updates by itself when it is done.
                  </p>
                  <p v-else>
                    A hub admin runs <strong>Setup Organization</strong> for
                    <code>{{ selectedOrg }}</code> - you do not have write access to the hub
                    repository, so this one has to be run for you. It takes about a minute.
                  </p>
                </div>
              </div>
            </div>

            <div class="onboarding-actions">
              <!-- If they can dispatch it, do it FOR them: no hub repo to find,
                   no Actions tab, no branch to pick, no org name to type. -->
              <button
                v-if="hubWritable && orgIsInstalled"
                class="btn btn-primary btn-with-icon"
                type="button"
                :disabled="settingUp"
                @click="runSetupOrg"
              >
                <Icon name="zap" :size="14" :class="{ 'spin-icon': settingUp }" />
                <span>{{ settingUp ? 'Setting up…' : `Set up ${selectedOrg}` }}</span>
              </button>
              <a
                v-else-if="orgIsInstalled"
                :href="`https://github.com/${config.hubOwner}/${config.hubRepo}/actions/workflows/setup-org.yml`"
                target="_blank"
                rel="noopener"
                class="btn btn-primary btn-with-icon"
              >
                <Icon name="external-link" :size="14" />
                <span>Open Setup Organization</span>
              </a>
              <a
                v-else
                :href="appInstallUrl"
                target="_blank"
                rel="noopener"
                class="btn btn-primary btn-with-icon"
              >
                <Icon name="plus" :size="14" />
                <span>Install PXL Classroom</span>
              </a>
              <button class="btn btn-with-icon" type="button" :disabled="settingUp" @click="loadDashboard()">
                <Icon name="refresh-cw" :size="14" />
                <span>Recheck</span>
              </button>
            </div>
          </div>
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
import { getInstallations, getRepoContent, getRepo, listRepoDir, triggerWorkflow, explainDispatchFailure } from '../lib/api.js'
import { toast } from '../lib/toast.js'
import { APP_INSTALL_URL } from '../../../lib/audit.mjs'
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
const hubWritable = ref(false)
const settingUp = ref(false)
// Set when the lecturer leaves for GitHub's installation page, cleared as soon
// as an org appears. Without it, "install finished, now what?" has no answer
// in this UI at all.
const connectPending = ref(false)
function onConnectClicked() {
  connectPending.value = true
  orgDropdownOpen.value = false
}
async function refreshOrgsNow() {
  const before = orgs.value.length
  lastOrgRefresh = Date.now()
  await loadOrgs()
  if (orgs.value.length > before) {
    connectPending.value = false
    toast.success('Organization connected.')
  } else {
    toast.info('No new organization yet. Finish installing on GitHub, then try again.')
  }
}

// Reaching this view by URL does not imply the App is on that org - the org
// switcher only lists installations, but /dashboard/<anything> is routable.
const orgIsInstalled = computed(() =>
  orgs.value.some((o) => o.login?.toLowerCase() === selectedOrg.value?.toLowerCase())
)
// Bumped on org switch and on unmount, so a poll in flight can tell that its
// answer is no longer wanted. Same reason SystemHealthModal carries one.
let setupGeneration = 0
// selectedOrg is initialised from the route param and then possibly CORRECTED
// by loadOrgs() when that org has no installation - so two loads can be in
// flight for different orgs. Without this, the slower one wins and the
// dashboard shows the abandoned org's state.
let dashGeneration = 0

// The whole point of the button: a beginner should not have to find the hub
// repo, open Actions, pick the workflow, choose a branch and type their own org
// name into a form field. Dispatch it for them, then watch for the outcome we
// actually care about - the control repository existing - and advance by
// itself. Never fire-and-forget (CLAUDE.md).
const SETUP_POLL_MS = 5000
const SETUP_TIMEOUT_MS = 4 * 60 * 1000

async function runSetupOrg() {
  const token = getToken()
  const org = selectedOrg.value
  if (!token || !org || settingUp.value) return

  // FIX 5: the workflow declares this required. Dispatching an empty string
  // would register a blank budget owner in participating-orgs.yml, and the
  // weekly usage report @-mentions that login.
  const budgetOwner = user.value?.login
  if (!budgetOwner) {
    toast.error('Could not determine your GitHub login. Sign in again, then retry.')
    return
  }

  const generation = ++setupGeneration
  settingUp.value = true
  try {
    const res = await triggerWorkflow(token, config.hubOwner, config.hubRepo, 'setup-org.yml', {
      target_org: org,
      budget_owner_login: budgetOwner,
    })
    if (!res.ok && res.status !== 204) {
      toast.error(explainDispatchFailure(res, 'Could not start Setup Organization'))
      settingUp.value = false
      return
    }
    toast.success(`Setting up ${org}. This takes about a minute.`)

    const deadline = Date.now() + SETUP_TIMEOUT_MS
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, SETUP_POLL_MS))
      // Superseded: the lecturer switched org or left. Stop silently rather
      // than reloading a dashboard they are not on and toasting about an org
      // they are no longer looking at.
      if (generation !== setupGeneration) return
      const repo = await getRepo(token, org, config.controlRepo)
      if (generation !== setupGeneration) return
      if (repo.ok) {
        toast.success(`${org} is ready.`)
        await loadDashboard(org)
        return
      }
    }
    if (generation !== setupGeneration) return
    toast.error(
      `Setup Organization is taking longer than expected for ${org}. ` +
        'Check the run in the hub repository, then use Recheck.',
      { link: { href: `https://github.com/${config.hubOwner}/${config.hubRepo}/actions/workflows/setup-org.yml`, text: 'View run' } }
    )
  } catch (e) {
    if (generation === setupGeneration) toast.error(`Could not start Setup Organization: ${e.message}`)
  } finally {
    if (generation === setupGeneration) settingUp.value = false
  }
}
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

const appInstallUrl = APP_INSTALL_URL

// "Connect an organization" opens github.com in a new tab, so the install
// completes somewhere this app cannot observe. Re-checking when the tab regains
// focus makes the new org simply appear, instead of leaving the lecturer on a
// stale page wondering whether it worked. Only refetches when the answer could
// have changed - a signed-in lecturer with the dashboard in front of them.
let lastOrgRefresh = 0
const ORG_REFRESH_MIN_GAP_MS = 3000

async function refreshOrgsOnReturn() {
  if (document.visibilityState !== 'visible') return
  if (!isAuthenticated()) return
  // Deliberately unconditional. An earlier version only refetched when the
  // current view "could change", which excluded the normal case - a lecturer
  // on a healthy dashboard adding a SECOND org - so returning from GitHub did
  // nothing and the new org only appeared after a manual reload. One request
  // on tab focus is cheap; being stranded is not.
  if (Date.now() - lastOrgRefresh < ORG_REFRESH_MIN_GAP_MS) return
  lastOrgRefresh = Date.now()
  const before = orgs.value.length
  await loadOrgs()
  if (orgs.value.length > before) {
    connectPending.value = false
    toast.success('Organization connected.')
  }
}

onMounted(async () => {
  // GitHub appends ?installation_id=N&setup_action=install when the App's
  // Setup URL points back here. Treat that as "just connected" and clear the
  // params so a reload does not repeat it.
  if (route.query.setup_action === 'install') {
    connectPending.value = true
    router.replace({ query: { ...route.query, setup_action: undefined, installation_id: undefined } })
  }
  window.addEventListener('click', onOutsideClick)
  window.addEventListener('keydown', onGlobalKeydown)
  document.addEventListener('visibilitychange', refreshOrgsOnReturn)
  if (isAuthenticated()) {
    user.value = getUser()
    await loadOrgs()
  }
})

onUnmounted(() => {
  window.removeEventListener('click', onOutsideClick)
  window.removeEventListener('keydown', onGlobalKeydown)
  document.removeEventListener('visibilitychange', refreshOrgsOnReturn)
  setupGeneration++
})

const LAST_ORG_KEY = 'pxl_last_selected_org'

// immediate so navigating back to /dashboard/<org> from the breadcrumb
// triggers loadDashboard even when selectedOrg is already set from the URL
// param at init (re-assigning the same value doesn't fire a normal watcher).
watch(selectedOrg, async (org) => {
  setupGeneration++
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

async function loadDashboard(orgArg) {
  // Callers include @click handlers, which pass a PointerEvent as the first
  // argument, and runSetupOrg, which passes nothing. Anything that is not a
  // non-empty string means "whichever org is selected".
  const org = typeof orgArg === 'string' && orgArg ? orgArg : selectedOrg.value
  if (!org) { loadingData.value = false; return }

  const generation = ++dashGeneration
  const superseded = () => generation !== dashGeneration

  loadingData.value = true
  assignments.value = []
  dashState.value = ''
  draftCount.value = 0
  hubWritable.value = false

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
      if (superseded()) return
      dashState.value = assignments.value.length === 0 ? (draftCount.value > 0 ? 'no-dashboard' : 'empty') : ''
      orgStatusMap.value.set(org.toLowerCase(), hasActive ? 'active' : (assignments.value.length > 0 ? 'inactive' : 'empty'))
      return
    }

    // Fallback only if dashboard.json is missing or empty (e.g. newly onboarded org before first cron)
    const repoRes = await getRepo(token, org, config.controlRepo)
    if (!repoRes.ok) {
      if (repoRes.status === 404) {
        if (superseded()) return
        dashState.value = 'no-control-repo'
        orgStatusMap.value.set(org.toLowerCase(), 'empty')
        // Setup Organization is a workflow_dispatch on the HUB, which needs
        // write there (RUNBOOK §2.4). A lecturer who has just been made an org
        // owner usually does not have it yet, so find out before offering a
        // button that would only 403.
        try {
          const hub = await getRepo(token, config.hubOwner, config.hubRepo)
          hubWritable.value = Boolean(hub.ok && hub.data?.permissions?.push)
        } catch {
          hubWritable.value = false
        }
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
      if (superseded()) return
      dashState.value = 'onboarding'
      orgStatusMap.value.set(org.toLowerCase(), 'empty')
      return
    } else {
      // Assignments HAVE been created in this organization (e.g. drafts or awaiting dashboard.json generation)
      draftCount.value = ymls.length
      if (superseded()) return
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
  min-width: 0;
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
.connect-pending {
  padding: var(--space-sm) var(--space-md);
  margin-top: var(--space-md);
  border-color: var(--tint-accent-emphasis);
  background: var(--tint-accent-subtle);
}

.org-dropdown-divider {
  height: 1px;
  background: var(--border-muted);
  margin: var(--space-xs) 0;
}
/* Distinguished from the org rows: this one leaves the app. */
.org-connect-item {
  color: var(--accent-blue);
  text-decoration: none;
  font-weight: 500;
}
.org-connect-item:hover {
  text-decoration: none;
}

.org-dropdown-container {
  position: relative;
  /* No hard floor: this sits in the header, so a fixed min-width forces the
     whole bar wider than a narrow viewport. The org name truncates instead. */
  min-width: 0;
  max-width: 240px;
}

.org-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.org-dropdown-btn {
  min-width: 0;
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
  border-color: var(--text-muted);
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
  box-shadow: 0 0 5px var(--tint-success-emphasis);
}

.lamp-inactive {
  background-color: var(--accent-yellow);
  opacity: 0.85;
}

.lamp-empty {
  background-color: transparent;
  border: 1.5px solid var(--border-strong);
  opacity: 0.7;
}

.lamp-unknown {
  background-color: var(--border-default);
  opacity: 0.5;
}

/* padding-top/bottom, NOT the shorthand: `main` here is a scoped element
   selector and out-specifies .container, so `padding: X 0` silently wiped
   the horizontal padding and content sat flush to the viewport edge on
   anything narrower than the 1240px max-width. */
main {
  padding-top: var(--space-xl);
  padding-bottom: var(--space-xl);
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
  border-color: var(--accent-blue);
  background: var(--bg-surface-elevated);
}

.card-header {
  margin-bottom: var(--space-sm);
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
.onboarding-readiness-card,
.setup-required-card {
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
  /* Decorative first: the tag says nothing the dashboard does not, and the
     wordmark duplicates the logo, which still links home. */
  .lecturer-tag { display: none; }
  .header-right { flex-direction: column; gap: var(--space-sm); align-items: stretch; }
  .health-btn { justify-content: center; }
  .onboarding-actions { flex-direction: column; align-items: stretch; }
}

@media (max-width: 520px) {
  .header-titles .app-header-title,
  .header-titles .app-header-sep { display: none; }
  .section-toolbar { flex-direction: column; align-items: flex-start; gap: var(--space-sm); }
}
</style>
