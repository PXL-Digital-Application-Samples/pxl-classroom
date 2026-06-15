<template>
  <div class="assignment-page">
    <header class="assignment-header">
      <div class="container">
        <div class="logo">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/>
            <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>
          </svg>
          <span>PXL Classroom</span>
        </div>
        <div v-if="user" class="user-badge">
          <img :src="user.avatar_url" :alt="user.login" class="avatar" />
          <span>{{ user.login }}</span>
          <button class="btn" @click="handleLogout" aria-label="Sign out">Sign out</button>
        </div>
      </div>
    </header>

    <main class="container">
      <!-- Loading state -->
      <div v-if="loading" class="center-card fade-in">
        <div class="spinner-lg spinner"></div>
        <p class="text-secondary">Loading assignment…</p>
      </div>

      <!-- Error state -->
      <div v-else-if="error" class="center-card fade-in">
        <div class="error-icon">⚠️</div>
        <h2>Something went wrong</h2>
        <p class="text-secondary">{{ error }}</p>
        <button class="btn btn-primary" @click="retry">Try again</button>
      </div>

      <!-- Assignment not found -->
      <div v-else-if="!assignment" class="center-card fade-in">
        <div class="error-icon">📋</div>
        <h2>Assignment not found</h2>
        <p class="text-secondary">The assignment "{{ assignmentId }}" does not exist or is not published.</p>
      </div>

      <!-- Assignment loaded -->
      <div v-else class="assignment-content fade-in">
        <div class="assignment-card card">
          <div class="assignment-meta">
            <span :class="['badge', stateBadgeClass]">{{ assignment.state }}</span>
            <span v-if="assignment.acceptance_mode" class="badge badge-info">{{ assignment.acceptance_mode }}</span>
          </div>

          <h1 class="assignment-title">{{ assignment.title }}</h1>
          <p v-if="assignment.description" class="assignment-desc">{{ assignment.description }}</p>

          <div class="assignment-dates">
            <div class="date-item">
              <span class="date-label">Opens</span>
              <time :datetime="assignment.opens_at">{{ formatDate(assignment.opens_at) }}</time>
            </div>
            <div class="date-item">
              <span class="date-label">Deadline</span>
              <time :datetime="assignment.deadline_at" :class="{ 'text-warning': isPastDeadline }">
                {{ formatDate(assignment.deadline_at) }}
              </time>
            </div>
          </div>
        </div>

        <!-- Not authenticated -->
        <div v-if="!user" class="auth-card card">
          <h2>Sign in with GitHub</h2>
          <p class="text-secondary">Authenticate with your GitHub account to accept this assignment.</p>

          <div v-if="!deviceFlow" class="auth-actions">
            <button class="btn btn-primary btn-lg" @click="startLogin" :disabled="authLoading">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
              </svg>
              Sign in with GitHub
            </button>
          </div>

          <!-- Device flow in progress -->
          <div v-else class="device-flow-panel">
            <div class="device-code-display">
              <p>Go to <a :href="deviceFlow.verification_uri" target="_blank" rel="noopener">{{ deviceFlow.verification_uri }}</a></p>
              <p class="device-code-label">and enter this code:</p>
              <div class="device-code" role="status" aria-live="polite">
                <code>{{ deviceFlow.user_code }}</code>
                <button class="btn" @click="copyCode" :aria-label="copied ? 'Copied' : 'Copy code'">
                  {{ copied ? '✓ Copied' : 'Copy' }}
                </button>
              </div>
            </div>
            <div class="device-flow-status">
              <div class="spinner"></div>
              <span class="text-secondary">Waiting for authorization…</span>
            </div>
            <button class="btn" @click="cancelLogin">Cancel</button>
          </div>
        </div>

        <!-- Authenticated — acceptance flow -->
        <div v-else class="acceptance-card card">
          <!-- Not yet accepted -->
          <div v-if="acceptState === 'ready'">
            <h2>Accept assignment</h2>
            <p class="text-secondary">
              You're signed in as <strong>{{ user.login }}</strong>.
              Click below to accept this assignment and get your repository.
            </p>
            <button class="btn btn-success btn-lg" @click="acceptAssignment" :disabled="accepting">
              <template v-if="accepting">
                <div class="spinner" style="width:18px;height:18px;border-width:2px"></div>
                Accepting…
              </template>
              <template v-else>✓ Accept assignment</template>
            </button>
          </div>

          <!-- Accepted, waiting for provisioning -->
          <div v-else-if="acceptState === 'pending'" class="pending-state">
            <div class="status-icon pulse">⏳</div>
            <h2>Setting up your repository…</h2>
            <p class="text-secondary">
              Your assignment has been accepted. GitHub Actions is provisioning your private repository.
              This usually takes less than a minute.
            </p>
            <div class="progress-bar">
              <div class="progress-bar-fill"></div>
            </div>
            <p class="text-muted">Checking every {{ pollInterval / 1000 }}s… (attempt {{ pollCount }})</p>
          </div>

          <!-- Repository ready -->
          <div v-else-if="acceptState === 'provisioned'" class="provisioned-state fade-in">
            <div class="status-icon">🎉</div>
            <h2>Your repository is ready!</h2>
            <div class="repo-link-card">
              <a :href="repoUrl" target="_blank" rel="noopener" class="repo-link">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65S8.93 17.38 9 18v4"/>
                  <path d="M9 18c-4.51 2-5-2-7-2"/>
                </svg>
                {{ repoFullName }}
              </a>
              <button class="btn" @click="copyRepoUrl" :aria-label="repoCopied ? 'Copied' : 'Copy URL'">
                {{ repoCopied ? '✓ Copied' : 'Copy URL' }}
              </button>
            </div>
            <p class="text-secondary">You have administrator access. Clone it and start working!</p>
          </div>

          <!-- Invitation pending -->
          <div v-else-if="acceptState === 'invited'" class="invited-state fade-in">
            <div class="status-icon">📬</div>
            <h2>Repository invitation pending</h2>
            <p class="text-secondary">
              Your repository has been created, but you need to accept the collaboration invitation first.
            </p>
            <button v-if="pendingInvitation" class="btn btn-primary btn-lg" @click="handleAcceptInvitation">
              Accept invitation
            </button>
            <a v-else href="https://github.com/notifications" target="_blank" class="btn btn-primary btn-lg">
              Check GitHub notifications
            </a>
          </div>

          <!-- Error state -->
          <div v-else-if="acceptState === 'error'">
            <div class="status-icon">❌</div>
            <h2>Something went wrong</h2>
            <p class="text-secondary">{{ acceptError }}</p>
            <button class="btn btn-primary" @click="retry">Try again</button>
          </div>
        </div>
      </div>
    </main>

    <footer class="assignment-footer">
      <div class="container">
        <router-link to="/dashboard" class="footer-link">Lecturer dashboard →</router-link>
      </div>
    </footer>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { config } from '../lib/config.js'
import { startDeviceFlow, pollDeviceFlow, getToken, getUser, isAuthenticated, clearAuth } from '../lib/auth.js'
import { starRepo, isStarred, getRepo, getInvitations, acceptInvitation } from '../lib/api.js'

const props = defineProps({
  assignmentId: { type: String, required: true },
})

// State
const loading = ref(true)
const error = ref(null)
const assignment = ref(null)
const user = ref(getUser())
const acceptState = ref('ready')  // ready | pending | provisioned | invited | error
const accepting = ref(false)
const acceptError = ref(null)
const repoUrl = ref(null)
const repoFullName = ref(null)
const pendingInvitation = ref(null)
const copied = ref(false)
const repoCopied = ref(false)

// Device flow
const deviceFlow = ref(null)
const authLoading = ref(false)
let pollAbort = null

// Polling
const pollInterval = ref(3000)
const pollCount = ref(0)
let pollTimer = null

const isPastDeadline = computed(() => {
  if (!assignment.value?.deadline_at) return false
  return new Date() > new Date(assignment.value.deadline_at)
})

const stateBadgeClass = computed(() => {
  const map = { published: 'badge-success', closed: 'badge-warning', draft: 'badge-neutral', archived: 'badge-neutral' }
  return map[assignment.value?.state] || 'badge-neutral'
})

// Lifecycle
onMounted(async () => {
  await loadAssignment()
  if (isAuthenticated()) {
    user.value = getUser()
    await checkExistingState()
  }
})

onUnmounted(() => {
  if (pollAbort) pollAbort.abort()
  if (pollTimer) clearTimeout(pollTimer)
})

// Format date in assignment timezone
function formatDate(iso) {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString('en-GB', {
      timeZone: assignment.value?.timezone || config.timezone,
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
      timeZoneName: 'short',
    })
  } catch {
    return new Date(iso).toISOString()
  }
}

// Load assignment from public metadata or URL params
async function loadAssignment() {
  loading.value = true
  error.value = null
  try {
    // Try fetching from public assignments.json
    if (config.assignmentsUrl) {
      const res = await fetch(config.assignmentsUrl)
      if (res.ok) {
        const data = await res.json()
        assignment.value = data.assignments?.find((a) => a.id === props.assignmentId) || null
        loading.value = false
        return
      }
    }
    // Fallback: construct minimal assignment data from the ID
    // In production, this data comes from the public Pages JSON
    assignment.value = {
      id: props.assignmentId,
      title: props.assignmentId.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
      state: 'published',
      acceptance_mode: 'self-service',
      organization: config.defaultOrg,
      broker_repo: `broker-${props.assignmentId}`,
      timezone: config.timezone,
    }
  } catch (e) {
    error.value = e.message
  }
  loading.value = false
}

// Check if the user already has a repo for this assignment
async function checkExistingState() {
  const token = getToken()
  if (!token || !assignment.value) return

  const org = assignment.value.organization || config.defaultOrg
  const expectedName = `${props.assignmentId}-${user.value.login}`

  // Check if repo exists
  const repo = await getRepo(token, org, expectedName)
  if (repo.ok) {
    repoUrl.value = repo.data.html_url
    repoFullName.value = repo.data.full_name
    acceptState.value = 'provisioned'
    return
  }

  // Check for pending invitation
  const invites = await getInvitations(token)
  if (invites.ok && Array.isArray(invites.data)) {
    const match = invites.data.find(
      (inv) => inv.repository?.name === expectedName && inv.repository?.owner?.login === org
    )
    if (match) {
      pendingInvitation.value = match
      repoUrl.value = match.repository.html_url
      repoFullName.value = match.repository.full_name
      acceptState.value = 'invited'
      return
    }
  }

  // Check if already starred the broker
  const brokerRepo = assignment.value.broker_repo || `broker-${props.assignmentId}`
  const starred = await isStarred(token, org, brokerRepo)
  if (starred) {
    // Already starred — provisioning might be in progress
    acceptState.value = 'pending'
    startPolling()
    return
  }

  acceptState.value = 'ready'
}

// Auth
async function startLogin() {
  if (!config.clientId) {
    error.value = 'GitHub App Client ID is not configured. Set VITE_GITHUB_CLIENT_ID.'
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
    await checkExistingState()
  } catch (e) {
    if (e.message !== 'Cancelled') {
      error.value = e.message
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
  acceptState.value = 'ready'
  deviceFlow.value = null
}

// Accept assignment (star the broker)
async function acceptAssignment() {
  accepting.value = true
  acceptError.value = null
  try {
    const token = getToken()
    const org = assignment.value.organization || config.defaultOrg
    const brokerRepo = assignment.value.broker_repo || `broker-${props.assignmentId}`

    const result = await starRepo(token, org, brokerRepo)
    if (result.status !== 204) {
      throw new Error(`Failed to accept assignment (HTTP ${result.status}). Make sure the broker repo exists.`)
    }

    acceptState.value = 'pending'
    startPolling()
  } catch (e) {
    acceptState.value = 'error'
    acceptError.value = e.message
  }
  accepting.value = false
}

// Poll for repo provisioning
function startPolling() {
  pollCount.value = 0
  
  const tick = async () => {
    pollCount.value++
    const token = getToken()
    if (!token) return

    const org = assignment.value.organization || config.defaultOrg
    const expectedName = `${props.assignmentId}-${user.value.login}`

    // Check repo
    const repo = await getRepo(token, org, expectedName)
    if (repo.ok) {
      repoUrl.value = repo.data.html_url
      repoFullName.value = repo.data.full_name
      acceptState.value = 'provisioned'
      return
    }

    // Check invitation
    const invites = await getInvitations(token)
    if (invites.ok && Array.isArray(invites.data)) {
      const match = invites.data.find(
        (inv) => inv.repository?.name === expectedName
      )
      if (match) {
        pendingInvitation.value = match
        repoUrl.value = match.repository.html_url
        repoFullName.value = match.repository.full_name
        acceptState.value = 'invited'
        return
      }
    }

    // Increase poll interval after many attempts (after ~1 minute, slow down to 10s)
    if (pollCount.value > 20) {
      pollInterval.value = 10000
    }
    
    // Continue polling if not aborted
    if (acceptState.value === 'pending') {
      pollTimer = setTimeout(tick, pollInterval.value)
    }
  }
  
  pollTimer = setTimeout(tick, pollInterval.value)
}

// Accept invitation
async function handleAcceptInvitation() {
  if (!pendingInvitation.value) return
  const token = getToken()
  const result = await acceptInvitation(token, pendingInvitation.value.id)
  if (result.ok) {
    acceptState.value = 'provisioned'
  }
}

// Copy helpers
function copyCode() {
  if (deviceFlow.value?.user_code) {
    navigator.clipboard.writeText(deviceFlow.value.user_code)
    copied.value = true
    setTimeout(() => { copied.value = false }, 2000)
  }
}

function copyRepoUrl() {
  if (repoUrl.value) {
    navigator.clipboard.writeText(repoUrl.value)
    repoCopied.value = true
    setTimeout(() => { repoCopied.value = false }, 2000)
  }
}

function retry() {
  error.value = null
  acceptState.value = 'ready'
  acceptError.value = null
  loadAssignment()
}
</script>

<style scoped>
.assignment-page {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}

.assignment-header {
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border-default);
  padding: var(--space-md) 0;
}
.assignment-header .container {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.logo {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  font-weight: 700;
  font-size: 1.125rem;
  color: var(--text-primary);
}

.user-badge {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  font-size: 0.875rem;
}

.avatar {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  border: 2px solid var(--border-default);
}

main {
  flex: 1;
  padding: var(--space-2xl) var(--space-lg);
  max-width: 640px;
  margin: 0 auto;
  width: 100%;
}

.center-card {
  text-align: center;
  padding: var(--space-2xl);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-md);
}

.error-icon, .status-icon {
  font-size: 3rem;
  margin-bottom: var(--space-sm);
}

.assignment-content {
  display: flex;
  flex-direction: column;
  gap: var(--space-lg);
}

.assignment-meta {
  display: flex;
  gap: var(--space-sm);
  margin-bottom: var(--space-md);
}

.assignment-title {
  font-size: 1.75rem;
  font-weight: 700;
  line-height: 1.3;
  margin-bottom: var(--space-sm);
}

.assignment-desc {
  color: var(--text-secondary);
  font-size: 1rem;
  margin-bottom: var(--space-md);
}

.assignment-dates {
  display: flex;
  gap: var(--space-xl);
  padding-top: var(--space-md);
  border-top: 1px solid var(--border-muted);
}

.date-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.date-label {
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-muted);
  font-weight: 600;
}

.text-secondary { color: var(--text-secondary); }
.text-muted { color: var(--text-muted); font-size: 0.875rem; }
.text-warning { color: var(--accent-yellow); }

.auth-card, .acceptance-card {
  text-align: center;
}
.auth-card h2, .acceptance-card h2 {
  margin-bottom: var(--space-sm);
}
.auth-card p, .acceptance-card p {
  margin-bottom: var(--space-lg);
}

.auth-actions {
  padding-top: var(--space-md);
}

.device-flow-panel {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-lg);
}

.device-code-display {
  text-align: center;
}
.device-code-label {
  margin: var(--space-sm) 0;
  color: var(--text-secondary);
}
.device-code {
  display: flex;
  align-items: center;
  gap: var(--space-md);
  justify-content: center;
  margin-top: var(--space-sm);
}
.device-code code {
  font-family: var(--font-mono);
  font-size: 2rem;
  font-weight: 700;
  letter-spacing: 0.15em;
  color: var(--accent-blue);
  background: var(--bg-tertiary);
  padding: var(--space-sm) var(--space-lg);
  border-radius: var(--radius-md);
  border: 1px solid var(--border-default);
}

.device-flow-status {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
}

.pending-state, .provisioned-state, .invited-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-md);
}

.progress-bar {
  width: 100%;
  height: 4px;
  background: var(--bg-tertiary);
  border-radius: var(--radius-full);
  overflow: hidden;
}
.progress-bar-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--accent-blue), var(--accent-purple));
  border-radius: var(--radius-full);
  animation: progress 2s ease-in-out infinite;
}
@keyframes progress {
  0% { width: 0%; margin-left: 0; }
  50% { width: 60%; margin-left: 20%; }
  100% { width: 0%; margin-left: 100%; }
}

.repo-link-card {
  display: flex;
  align-items: center;
  gap: var(--space-md);
  background: var(--bg-tertiary);
  padding: var(--space-md) var(--space-lg);
  border-radius: var(--radius-md);
  border: 1px solid var(--border-default);
}

.repo-link {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  font-family: var(--font-mono);
  font-size: 1rem;
  font-weight: 600;
  color: var(--accent-blue);
}
.repo-link:hover {
  color: #79c0ff;
}

.assignment-footer {
  padding: var(--space-lg) 0;
  text-align: center;
}
.footer-link {
  font-size: 0.875rem;
  color: var(--text-muted);
}
.footer-link:hover {
  color: var(--text-secondary);
}

@media (max-width: 640px) {
  .assignment-dates {
    flex-direction: column;
    gap: var(--space-md);
  }
  .device-code code {
    font-size: 1.5rem;
  }
  .repo-link-card {
    flex-direction: column;
  }
}
</style>
