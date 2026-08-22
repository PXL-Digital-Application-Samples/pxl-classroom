<template>
  <div class="home-page">
    <!-- TOP HEADER -->
    <AppHeader :user="user" :sticky="false" @logout="handleLogout">
      <template #actions>
        <router-link v-if="isLecturer" :to="lecturerDashboardTarget" class="btn btn-sm btn-primary">
          Lecturer Dashboard
        </router-link>
      </template>
    </AppHeader>

    <!-- 1. SIGNED-OUT STATE -->
    <div v-if="!user" class="signed-out-section fade-in">
      <div class="hero">
        <div class="hero-glow"></div>
        <div class="container">
          <img :src="logoUrl" alt="PXL Classroom" class="hero-logo" />
          <h1>PXL Classroom</h1>
          <p class="subtitle">GitHub-native assignment distribution and evaluation for PXL</p>

          <p v-if="authError" class="auth-error" role="alert" style="max-width: 420px; margin: 0 auto var(--space-lg) auto;">
            {{ authError }} - try signing in again.
          </p>

          <div v-if="!deviceFlow" class="flex flex-col items-center gap-md">
            <button class="btn btn-primary btn-lg" @click="startLogin" :disabled="authLoading">
              <template v-if="authLoading">
                <span class="spinner spinner-sm"></span>
                Waiting…
              </template>
              <template v-else>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
                </svg>
                <span>Sign in with GitHub</span>
              </template>
            </button>
          </div>

          <DeviceFlowCard v-if="deviceFlow" :flow="deviceFlow" @cancel="cancelLogin" />
        </div>
      </div>

      <!-- DIRECT LINK JUMP BOX -->
      <div class="container direct-link-section">
        <div class="direct-link-card card">
          <div class="flex items-center gap-sm" style="margin-bottom: var(--space-xs);">
            <Icon name="link" :size="18" class="text-accent" />
            <h3 style="margin: 0; font-size: 1.1rem;">Have an assignment link?</h3>
          </div>
          <p class="text-secondary text-sm" style="margin-bottom: var(--space-md);">
            If your lecturer shared a direct link or assignment ID, paste it here:
          </p>
          <form class="jump-form flex gap-sm" @submit.prevent="jumpToAssignment">
            <input
              v-model="jumpInput"
              type="text"
              class="jump-input"
              placeholder="e.g. pxl-digital-app-samples/a/linux-processes or full URL"
              aria-label="Direct assignment link or ID"
            />
            <button type="submit" class="btn btn-primary" :disabled="!jumpInput.trim()">
              <span>Go to assignment</span>
              <Icon name="arrow-right" :size="14" />
            </button>
          </form>
          <p v-if="jumpError" class="text-danger text-sm" style="margin-top: var(--space-xs);">
            {{ jumpError }}
          </p>
        </div>
      </div>
    </div>

    <!-- 2. SIGNED-IN STATE -->
    <main v-else class="container student-portal fade-in">
      <!-- Loading Role or Assignments -->
      <div v-if="loadingRole || (loadingAssignments && !isLecturer)" class="center-card">
        <div class="spinner-lg spinner"></div>
        <p class="text-secondary">{{ loadingRole ? 'Checking permissions…' : 'Loading your accepted assignments…' }}</p>
      </div>

      <!-- Lecturer Redirect / Jump Card -->
      <div v-else-if="isLecturer" class="center-card card" style="max-width: 540px; margin: var(--space-2xl) auto; text-align: center;">
        <Icon name="check-circle" :size="48" class="status-icon-success" />
        <h2>Welcome, {{ user.name || user.login }}</h2>
        <p class="text-secondary">
          You are signed in as an organization administrator. Head to the Lecturer Dashboard to manage courses and monitor student submissions.
        </p>
        <router-link :to="lecturerDashboardTarget" class="btn btn-primary btn-lg" style="margin-top: var(--space-md);">
          <span>Open Lecturer Dashboard</span>
          <Icon name="arrow-right" :size="16" />
        </router-link>
      </div>

      <!-- Student "My Assignments" View -->
      <div v-else class="student-dashboard">
        <div class="dashboard-head flex items-center justify-between">
          <div>
            <h2>My Assignments</h2>
            <p class="subtitle-sm">Repositories and courses you have accepted</p>
          </div>
          <button class="btn btn-sm btn-with-icon" @click="refreshStudentAssignments" :disabled="loadingAssignments">
            <Icon name="refresh-cw" :size="14" :class="{ 'spin-icon': loadingAssignments }" />
            <span>Refresh</span>
          </button>
        </div>

        <!-- Load Error -->
        <div v-if="assignmentsError" class="center-card card text-danger">
          <p>{{ assignmentsError }}</p>
          <button class="btn btn-sm btn-primary" @click="refreshStudentAssignments">Retry</button>
        </div>

        <!-- Empty State: No Accepted Assignments Yet -->
        <div v-else-if="acceptedAssignments.length === 0" class="empty-assignments card center-card">
          <Icon name="clipboard" :size="48" class="status-icon" />
          <h3>No accepted assignments yet</h3>
          <p class="text-secondary" style="max-width: 480px; line-height: 1.5;">
            You have not accepted any course assignments yet. When your lecturer gives you an assignment link, open it to join.
          </p>

          <div class="direct-link-box" style="margin-top: var(--space-lg); width: 100%; max-width: 480px;">
            <p class="text-sm font-semibold" style="margin-bottom: var(--space-xs); text-align: left;">
              Have a link from your lecturer?
            </p>
            <form class="jump-form flex gap-sm" @submit.prevent="jumpToAssignment">
              <input
                v-model="jumpInput"
                type="text"
                class="jump-input"
                placeholder="Paste link or org/a/assignment-id"
                aria-label="Direct assignment link"
              />
              <button type="submit" class="btn btn-primary" :disabled="!jumpInput.trim()">
                Go
              </button>
            </form>
            <p v-if="jumpError" class="text-danger text-sm" style="margin-top: var(--space-xs); text-align: left;">
              {{ jumpError }}
            </p>
          </div>
        </div>

        <!-- Accepted Assignments Grid -->
        <div v-else class="my-assignments-grid">
          <div
            v-for="a in acceptedAssignments"
            :key="`${a.org}/${a.id}`"
            class="my-assignment-card card"
          >
            <div class="card-top flex items-center justify-between">
              <span class="org-badge">{{ a.org }}</span>
              <span v-if="a.stateStatus === 'invited'" class="badge badge-warning">Invitation pending</span>
              <span v-else-if="a.timeRemainingStr" :class="['badge', a.timeRemainingBadgeClass]">
                {{ a.timeRemainingStr }}
              </span>
            </div>

            <h3 class="assignment-title">{{ a.title || a.id }}</h3>
            
            <p class="deadline-row text-sm text-secondary" v-if="a.deadline_at">
              <span>Deadline:</span> <strong>{{ formatDate(a.deadline_at, a.timezone) }}</strong>
            </p>

            <!-- Tagged Submission Indicator -->
            <div v-if="a.submitTag" class="submit-tag-row text-xs flex items-center gap-xs">
              <Icon name="check-circle" :size="12" class="text-green" />
              <span>Tagged submission: <code>{{ a.submitTag }}</code></span>
            </div>

            <div class="card-actions flex items-center justify-between" style="margin-top: var(--space-md); padding-top: var(--space-sm); border-top: 1px solid var(--border-muted);">
              <router-link
                :to="{ name: 'assignment', params: { org: a.org, assignmentId: a.id } }"
                class="btn btn-sm"
              >
                Assignment details
              </router-link>

              <a
                v-if="a.repoUrl"
                :href="a.repoUrl"
                target="_blank"
                rel="noopener"
                class="btn btn-sm btn-primary btn-with-icon"
              >
                <span>Open on GitHub</span>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                  <polyline points="15 3 21 3 21 9"/>
                  <line x1="10" y1="14" x2="21" y2="3"/>
                </svg>
              </a>
            </div>
          </div>
        </div>
      </div>
    </main>
  </div>
</template>

<script setup>
import { ref, onMounted, computed } from 'vue'
import { useRouter } from 'vue-router'
import AppHeader from '../components/AppHeader.vue'
import DeviceFlowCard from '../components/DeviceFlowCard.vue'
import Icon from '../components/Icon.vue'
import logoUrl from '../assets/logo.png'
import { config } from '../lib/config.js'
import { startDeviceFlow, pollDeviceFlow, getToken, getUser, isAuthenticated, clearAuth } from '../lib/auth.js'
import { getInstallations, getInvitations, ghApi } from '../lib/api.js'
import { formatDate } from '../lib/format.js'

const router = useRouter()

// Auth State
const user = ref(getUser())
const authLoading = ref(false)
const authError = ref(null)
const deviceFlow = ref(null)
let pollAbort = null

// Role State
const loadingRole = ref(false)
const isLecturer = ref(false)

const lecturerDashboardTarget = computed(() => {
  try {
    const lastOrg = localStorage.getItem('pxl_last_selected_org')
    if (lastOrg) {
      return { name: 'dashboard', params: { org: lastOrg } }
    }
  } catch { /* ignore */ }
  return { name: 'dashboard' }
})

// Student Assignments State
const loadingAssignments = ref(false)
const assignmentsError = ref(null)
const acceptedAssignments = ref([])

// Direct Link Jump State
const jumpInput = ref('')
const jumpError = ref('')

onMounted(async () => {
  if (isAuthenticated()) {
    user.value = getUser()
    await checkRoleAndLoad()
  }
})

async function checkRoleAndLoad() {
  const token = getToken()
  if (!token) return

  loadingRole.value = true
  try {
    const installs = await getInstallations(token)
    if (installs.ok && Array.isArray(installs.data?.installations)) {
      const orgInstalls = installs.data.installations.filter(i => i.account?.type === 'Organization')
      if (orgInstalls.length > 0) {
        isLecturer.value = true
        loadingRole.value = false
        return
      }
    }
    isLecturer.value = false
  } catch (e) {
    console.error('Failed to check user installations:', e)
    isLecturer.value = false
  } finally {
    loadingRole.value = false
  }

  // If student, load accepted assignments
  if (!isLecturer.value) {
    await loadStudentAssignments()
  }
}

async function loadStudentAssignments() {
  const token = getToken()
  if (!token || !user.value) return

  loadingAssignments.value = true
  assignmentsError.value = null
  acceptedAssignments.value = []

  try {
    // 1. Fetch public index data to discover participating orgs
    const indexRes = await fetch(`${import.meta.env.BASE_URL}data/index.json`)
    if (!indexRes.ok) {
      loadingAssignments.value = false
      return
    }

    let indexData = null
    try { indexData = await indexRes.json() } catch { /* ignore */ }
    const orgs = indexData?.orgs || []
    if (orgs.length === 0) {
      loadingAssignments.value = false
      return
    }

    // 2. Fetch assignments.json for each org in parallel
    const allOrgAssignments = []
    await Promise.all(
      orgs.map(async (org) => {
        try {
          const res = await fetch(`${import.meta.env.BASE_URL}data/${org.login}/assignments.json`)
          if (res.ok) {
            let data = null
            try { data = await res.json() } catch { /* ignore */ }
            if (data?.assignments) {
              Object.entries(data.assignments).forEach(([id, a]) => {
                allOrgAssignments.push({
                  org: org.login,
                  id,
                  ...a
                })
              })
            }
          }
        } catch (e) {
          console.error(`Failed to load assignments for ${org.login}:`, e)
        }
      })
    )

    if (allOrgAssignments.length === 0) {
      loadingAssignments.value = false
      return
    }

    // 3. Batch query user repos and invites (2 GitHub API calls total)
    const [reposRes, invitesRes] = await Promise.all([
      ghApi(token, 'GET', '/user/repos?affiliation=owner,collaborator&per_page=100'),
      getInvitations(token)
    ])

    const userRepos = (reposRes.ok && Array.isArray(reposRes.data)) ? reposRes.data : []
    const userInvites = (invitesRes.ok && Array.isArray(invitesRes.data)) ? invitesRes.data : []

    const userLogin = user.value.login.toLowerCase()
    const now = new Date()

    // 4. Match student repos with assignments
    const matched = []
    for (const a of allOrgAssignments) {
      const pattern = a.repository_name_pattern || `${a.id}-{github_login}`
      const expectedName = pattern.replace('{github_login}', userLogin).toLowerCase()

      // Calculate time remaining
      let timeRemainingStr = ''
      let timeRemainingBadgeClass = 'badge-neutral'
      if (a.deadline_at) {
        const diffMs = new Date(a.deadline_at) - now
        if (diffMs <= 0) {
          timeRemainingStr = 'Closed'
          timeRemainingBadgeClass = 'badge-error'
        } else {
          const diffMins = Math.floor(diffMs / 60000)
          const diffHours = Math.floor(diffMins / 60)
          const diffDays = Math.floor(diffHours / 24)
          if (diffDays > 0) {
            timeRemainingStr = `${diffDays}d left`
          } else if (diffHours > 0) {
            timeRemainingStr = `${diffHours}h left`
          } else {
            timeRemainingStr = `${diffMins}m left`
          }
          timeRemainingBadgeClass = diffHours < 24 ? 'badge-warning' : 'badge-success'
        }
      }

      // Check provisioned repo
      const existingRepo = userRepos.find(
        (r) => r.owner?.login?.toLowerCase() === a.org.toLowerCase() && r.name?.toLowerCase() === expectedName
      )
      if (existingRepo) {
        matched.push({
          ...a,
          repoUrl: existingRepo.html_url,
          repoFullName: existingRepo.full_name,
          stateStatus: 'provisioned',
          timeRemainingStr,
          timeRemainingBadgeClass,
          submitTag: null
        })
        continue
      }

      // Check pending invitation
      const existingInvite = userInvites.find(
        (inv) => inv.repository?.owner?.login?.toLowerCase() === a.org.toLowerCase() && inv.repository?.name?.toLowerCase() === expectedName
      )
      if (existingInvite) {
        matched.push({
          ...a,
          repoUrl: existingInvite.repository?.html_url,
          repoFullName: existingInvite.repository?.full_name,
          stateStatus: 'invited',
          timeRemainingStr,
          timeRemainingBadgeClass,
          submitTag: null
        })
      }
    }

    acceptedAssignments.value = matched
  } catch (e) {
    console.error('Failed to load student assignments:', e)
    assignmentsError.value = 'Failed to load your accepted assignments.'
  } finally {
    loadingAssignments.value = false
  }
}

async function refreshStudentAssignments() {
  await loadStudentAssignments()
}

// Jump to Assignment
function jumpToAssignment() {
  jumpError.value = ''
  const input = jumpInput.value.trim()
  if (!input) return

  // Match /:org/a/:id or URL
  const m1 = input.match(/(?:^|\/)([a-zA-Z0-9_-]+)\/a\/([a-zA-Z0-9_-]+)(?:$|\/|\?|#)/)
  if (m1) {
    router.push({ name: 'assignment', params: { org: m1[1], assignmentId: m1[2] } })
    return
  }

  // Match :org/:assignmentId
  const m2 = input.match(/^([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+)$/)
  if (m2) {
    router.push({ name: 'assignment', params: { org: m2[1], assignmentId: m2[2] } })
    return
  }

  jumpError.value = 'Invalid link format. Expected "org/a/assignment-id" or a direct URL.'
}

// Auth methods
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
    await checkRoleAndLoad()
  } catch (e) {
    if (e.message !== 'Cancelled') {
      authError.value = e.message
    }
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
  isLecturer.value = false
  acceptedAssignments.value = []
  deviceFlow.value = null
  authError.value = null
}
</script>

<style scoped>
/* .center-card is now global at 480px; this card holds a paste-a-link form and
   needs the room it had when the class was only defined locally. */
.empty-assignments {
  max-width: 620px;
}
.home-page {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}


.brand-title {
  font-weight: 700;
  font-size: 1.1rem;
  color: var(--text-primary);
}

.hero {
  text-align: center;
  padding: var(--space-2xl) var(--space-lg);
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 45vh;
  overflow: hidden;
}

.hero-glow {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 400px;
  height: 400px;
  background: radial-gradient(circle, var(--tint-accent-subtle) 0%, transparent 70%);
  pointer-events: none;
}

.hero-icon {
  color: var(--accent-blue);
  margin-bottom: var(--space-md);
  filter: drop-shadow(0 0 20px var(--tint-accent-emphasis));
}

h1 {
  font-size: 2.75rem;
  font-weight: 700;
  letter-spacing: -0.02em;
  margin-bottom: var(--space-xs);
  background: linear-gradient(135deg, var(--text-primary) 0%, var(--accent-blue) 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

.subtitle {
  color: var(--text-secondary);
  font-size: 1.1rem;
  margin-bottom: var(--space-xl);
  max-width: 560px;
}

.subtitle-sm {
  color: var(--text-secondary);
  font-size: 0.9rem;
  margin-top: 2px;
}

.direct-link-section {
  max-width: 600px;
  margin: var(--space-lg) auto var(--space-2xl) auto;
  padding: 0 var(--space-md);
}

.direct-link-card {
  padding: var(--space-lg);
}

.jump-form {
  display: flex;
  gap: var(--space-sm);
}

.jump-input {
  flex: 1;
  padding: var(--space-sm) var(--space-md);
  border-radius: var(--radius-md);
  border: 1px solid var(--border-default);
  background: var(--bg-primary);
  color: var(--text-primary);
  font-size: 0.9rem;
}
.jump-input:focus {
  outline: none;
  border-color: var(--accent-blue);
  box-shadow: 0 0 0 2px var(--tint-accent-muted);
}

.student-portal {
  flex: 1;
  padding: var(--space-xl) var(--space-lg);
  max-width: 900px;
  margin: 0 auto;
  width: 100%;
}

.dashboard-head {
  margin-bottom: var(--space-xl);
  border-bottom: 1px solid var(--border-default);
  padding-bottom: var(--space-md);
}

.dashboard-head h2 {
  font-size: 1.5rem;
  font-weight: 700;
  margin: 0;
}


.status-icon {
  color: var(--text-secondary);
}
.status-icon-success {
  color: var(--accent-green);
}

.my-assignments-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: var(--space-lg);
}

.my-assignment-card {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  padding: var(--space-lg);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-lg);
  background: var(--bg-secondary);
  transition: all var(--transition-normal);
}

.my-assignment-card:hover {
  border-color: var(--accent-blue);
  box-shadow: var(--ring-focus);
}

.org-badge {
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.assignment-title {
  font-size: 1.2rem;
  font-weight: 600;
  margin: var(--space-xs) 0;
  color: var(--text-primary);
}

.deadline-row {
  margin-bottom: var(--space-xs);
}

.submit-tag-row {
  background: var(--bg-tertiary);
  padding: 4px 8px;
  border-radius: var(--radius-sm);
  margin-top: var(--space-xs);
}

.text-accent {
  color: var(--accent-blue);
}
.text-green {
  color: var(--accent-green);
}
.text-danger {
  color: var(--accent-red);
}

.spin-icon {
  animation: spin 1s linear infinite;
}
@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

@media (max-width: 640px) {
  h1 { font-size: 2rem; }
  .jump-form { flex-direction: column; }
}
</style>
