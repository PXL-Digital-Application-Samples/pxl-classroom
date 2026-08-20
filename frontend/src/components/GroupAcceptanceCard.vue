<template>
  <div class="group-acceptance-card card fade-in">
    <!-- State: Already Provisioned -->
    <div v-if="acceptState === 'provisioned'" class="provisioned-state">
      <Icon name="check-circle" :size="48" class="status-icon status-icon-success" />
      <h2>Your team repository is ready!</h2>
      <div v-if="myCurrentTeam" class="team-badge-banner">
        <span>Team: <strong>{{ myCurrentTeam.team_name }}</strong> (<code>{{ myCurrentTeam.team_slug }}</code>)</span>
      </div>

      <div class="repo-link-card">
        <a :href="repoUrl" target="_blank" rel="noopener" class="repo-link">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65S8.93 17.38 9 18v4"/>
            <path d="M9 18c-4.51 2-5-2-7-2"/>
          </svg>
          {{ repoFullName }}
        </a>
        <button class="btn btn-with-icon" @click="copyRepoUrl" :aria-label="repoCopied ? 'Copied' : 'Copy URL'">
          <Icon v-if="repoCopied" name="check" :size="14" />
          <Icon v-else name="copy" :size="14" />
          <span>{{ repoCopied ? 'Copied' : 'Copy URL' }}</span>
        </button>
      </div>

      <!-- Teammates section -->
      <div v-if="myCurrentTeam && myCurrentTeam.members && myCurrentTeam.members.length" class="teammates-section">
        <span class="text-muted" style="font-size: 0.85rem;">Team members:</span>
        <div class="member-chips">
          <span v-for="m in myCurrentTeam.members" :key="m" class="member-chip" :class="{ 'is-me': m.toLowerCase() === user.login.toLowerCase() }">
            @{{ m }}
          </span>
        </div>
      </div>

      <div class="team-actions" style="margin-top: var(--space-md); border-top: 1px solid var(--border-default); padding-top: var(--space-sm);">
        <button class="btn btn-secondary btn-sm" @click="startSwitchTeam" :disabled="accepting">
          Switch to another team
        </button>
      </div>
    </div>

    <!-- State: Provisioning Pending -->
    <div v-else-if="acceptState === 'pending'" class="pending-state text-center">
      <Icon name="clock" :size="48" class="status-icon status-icon-pulse" />
      <h2>Setting up your team repository…</h2>
      <p class="text-secondary">
        Joining <strong>{{ targetTeamName }}</strong>. GitHub Actions is configuring collaborator access.
      </p>
      <div class="progress-bar">
        <div class="progress-bar-fill"></div>
      </div>
      <p class="text-muted">Checking every {{ pollInterval / 1000 }}s… (attempt {{ pollCount }})</p>

      <div v-if="pollCount >= 5 && invitationUrl" class="invitation-hint" role="status">
        <p class="text-secondary">
          Waiting on GitHub? You might need to accept an invitation to join the repository:
        </p>
        <a :href="invitationUrl" target="_blank" rel="noopener" class="btn btn-primary">
          Accept your repository invitation
        </a>
      </div>
    </div>

    <!-- State: Invitation Pending -->
    <div v-else-if="acceptState === 'invited'" class="invited-state text-center">
      <Icon name="inbox" :size="48" class="status-icon" />
      <h2>Team repository invitation pending</h2>
      <p class="text-secondary">
        Your team repository exists, but you need to accept the collaboration invitation.
      </p>
      <button v-if="pendingInvitation" class="btn btn-primary btn-lg" @click="handleAcceptInvitation">
        Accept invitation
      </button>
      <a v-else href="https://github.com/notifications" target="_blank" class="btn btn-primary btn-lg">
        Check GitHub notifications
      </a>
    </div>

    <!-- State: Timeout -->
    <div v-else-if="acceptState === 'timeout'" class="timeout-state text-center">
      <Icon name="timer" :size="48" class="status-icon status-icon-warn" />
      <h2>Invitation may be pending</h2>
      <p class="text-secondary">
        Please check your GitHub notifications or email for an invitation to the team repository.
      </p>
      <a v-if="invitationUrl" :href="invitationUrl" target="_blank" rel="noopener" class="btn btn-primary btn-lg" style="margin-bottom: var(--space-sm);">
        Open Repository Invitations
      </a>
      <br />
      <button class="btn btn-secondary" @click="checkExistingState">Check again</button>
    </div>

    <!-- State: Ready (Pick or Create Team) -->
    <div v-else class="team-selection-flow">
      <div class="flow-header">
        <h2>Group Assignment: Team Selection</h2>
        <p class="text-secondary">
          You are signed in as <strong>@{{ user.login }}</strong>. 
          Join an existing team or create a new team for this assignment (max {{ maxTeamSize }} members).
        </p>
      </div>

      <!-- Pre-Assigned Formation Mode Flow -->
      <div v-if="isPreAssignedMode" class="preassigned-flow text-center py-md">
        <div v-if="myCurrentTeam" class="card" style="padding: var(--space-lg); background: var(--bg-secondary);">
          <Icon name="users" :size="40" class="status-icon" />
          <h3>Pre-Assigned Team: {{ myCurrentTeam.team_name }}</h3>
          <p class="text-secondary">
            You are pre-assigned to team <code>{{ myCurrentTeam.team_slug }}</code>.
          </p>
          <div v-if="myCurrentTeam.members && myCurrentTeam.members.length" class="member-chips" style="justify-content: center; margin-bottom: var(--space-md);">
            <span v-for="m in myCurrentTeam.members" :key="m" class="member-chip" :class="{ 'is-me': m.toLowerCase() === user.login.toLowerCase() }">
              @{{ m }}
            </span>
          </div>
          <button class="btn btn-primary btn-lg" :disabled="accepting" @click="confirmJoinTeam(myCurrentTeam)">
            {{ accepting ? 'Joining…' : 'Accept & Join Team' }}
          </button>
        </div>
        <div v-else class="card text-center" style="padding: var(--space-lg); background: var(--bg-secondary);">
          <Icon name="alert-circle" :size="40" class="status-icon status-icon-warn" />
          <h3>No Pre-Assigned Team</h3>
          <p class="text-secondary">
            This assignment requires teams to be pre-assigned by your lecturer, but your account (<strong>@{{ user.login }}</strong>) is not yet mapped to a team.
          </p>
          <p class="text-muted text-sm">Please contact your instructor to be assigned to a group.</p>
        </div>
      </div>

      <!-- Self-Service Flow (Join or Create Team) -->
      <template v-else>
        <!-- Mode Selector -->
        <div class="tab-pill-selector">
          <button 
            class="tab-pill" 
            :class="{ active: tabMode === 'join' }" 
            @click="tabMode = 'join'"
          >
            Join Existing Team ({{ openTeamsCount }} open)
          </button>
          <button 
            v-if="allowTeamCreation"
            class="tab-pill" 
            :class="{ active: tabMode === 'create' }" 
            @click="tabMode = 'create'"
          >
            + Create New Team
          </button>
        </div>

      <!-- Tab 1: Join Existing Team -->
      <div v-if="tabMode === 'join'" class="tab-content">
        <div class="search-box">
          <input 
            v-model="teamSearchQuery" 
            type="text" 
            placeholder="Search teams or member username…" 
            class="input-search"
          />
        </div>

        <div v-if="loadingTeams" class="text-center py-md">
          <div class="spinner"></div>
          <span class="text-muted" style="margin-left: 8px;">Loading teams…</span>
        </div>

        <div v-else-if="filteredTeams.length === 0" class="empty-teams text-center py-md">
          <p class="text-muted">No matching open teams found.</p>
          <button v-if="allowTeamCreation" class="btn btn-secondary btn-sm" @click="tabMode = 'create'">
            Create a new team instead
          </button>
        </div>

        <div v-else class="teams-list">
          <div 
            v-for="team in filteredTeams" 
            :key="team.team_slug" 
            class="team-item-card"
            :class="{ 'is-selected': selectedTeam?.team_slug === team.team_slug, 'is-full': team.is_full }"
          >
            <div class="team-info">
              <div class="team-header-line">
                <strong class="team-name">{{ team.team_name }}</strong>
                <span class="team-slug-badge"><code>{{ team.team_slug }}</code></span>
                <span :class="['badge', team.is_full ? 'badge-neutral' : 'badge-success']" style="font-size: 0.75rem;">
                  {{ team.member_count }}/{{ team.max_members }} members
                </span>
              </div>
              <div class="team-members-list">
                <span v-for="m in team.members" :key="m" class="member-tag">@{{ m }}</span>
                <span v-if="team.members.length === 0" class="text-muted" style="font-size: 0.8rem;">Empty team</span>
              </div>
            </div>
            <div class="team-action-btn">
              <button 
                class="btn btn-primary btn-sm" 
                :disabled="team.is_full || accepting" 
                @click="confirmJoinTeam(team)"
              >
                {{ team.is_full ? 'Full' : 'Join Team' }}
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- Tab 2: Create New Team -->
      <div v-else-if="tabMode === 'create'" class="tab-content">
        <form @submit.prevent="submitCreateTeam" class="create-team-form">
          <div class="form-group">
            <label for="new-team-name">Team Name</label>
            <input 
              id="new-team-name"
              v-model="newTeamName" 
              type="text" 
              placeholder="e.g. The Code Crusaders" 
              class="input-text"
              maxlength="60"
              required
            />
            <span class="form-hint">
              Repository slug: <code>{{ computedSlug || 'team-name' }}</code>
            </span>
          </div>

          <div v-if="slugConflict" class="alert-warn" role="alert">
            A team with slug "<strong>{{ computedSlug }}</strong>" already exists. Please pick a different name or join that team.
          </div>

          <button 
            type="submit" 
            class="btn btn-success btn-lg" 
            :disabled="!computedSlug || slugConflict || accepting"
          >
            <span v-if="accepting">Creating…</span>
            <span v-else>Create & Join Team</span>
          </button>
        </form>
      </div>
      </template>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import Icon from './Icon.vue'
import { getToken, getUser } from '../lib/auth.js'
import { getRepo, getInvitations, acceptInvitation, ghApi } from '../lib/api.js'
import { toast } from '../lib/toast.js'

const props = defineProps({
  assignment: { type: Object, required: true },
  org: { type: String, required: true },
  user: { type: Object, required: true },
})

const tabMode = ref('join')
const teamSearchQuery = ref('')
const newTeamName = ref('')
const teams = ref([])
const loadingTeams = ref(true)
const selectedTeam = ref(null)
const myCurrentTeam = ref(null)
const targetTeamName = ref('')
const acceptState = ref('ready') // ready | pending | provisioned | invited | timeout | error
const accepting = ref(false)
const repoUrl = ref(null)
const repoFullName = ref(null)
const repoCopied = ref(false)
const pendingInvitation = ref(null)
const isSwitching = ref(false)

const pollInterval = ref(3000)
const pollCount = ref(0)
let pollTimer = null

const isPreAssignedMode = computed(() => props.assignment.group_config?.formation_mode === 'pre-assigned')
const maxTeamSize = computed(() => props.assignment.group_config?.max_team_size || 3)
const allowTeamCreation = computed(() => props.assignment.group_config?.allow_team_creation !== false)

const computedSlug = computed(() => {
  if (!newTeamName.value) return ''
  return newTeamName.value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
})

const slugConflict = computed(() => {
  if (!computedSlug.value) return false
  return teams.value.some((t) => t.team_slug.toLowerCase() === computedSlug.value.toLowerCase())
})

const filteredTeams = computed(() => {
  const q = teamSearchQuery.value.toLowerCase().trim()
  if (!q) return teams.value
  return teams.value.filter(
    (t) =>
      t.team_name.toLowerCase().includes(q) ||
      t.team_slug.toLowerCase().includes(q) ||
      (t.members || []).some((m) => m.toLowerCase().includes(q))
  )
})

const openTeamsCount = computed(() => teams.value.filter((t) => !t.is_full).length)

const invitationUrl = computed(() => {
  if (!targetTeamName.value && !myCurrentTeam.value) return null
  const slug = myCurrentTeam.value?.team_slug || selectedTeam.value?.team_slug || computedSlug.value
  const pattern = props.assignment.repository_name_pattern || `${props.assignment.id}-{team_slug}`
  const repo = pattern.replace('{team_slug}', slug).replace('{github_login}', props.user.login)
  return `https://github.com/${props.org}/${repo}/invitations`
})

onMounted(async () => {
  await loadTeams()
  await checkExistingState()
})

onUnmounted(() => {
  if (pollTimer) clearTimeout(pollTimer)
})

async function loadTeams() {
  loadingTeams.value = true
  try {
    const url = `${import.meta.env.BASE_URL}data/${props.org}/teams/${props.assignment.id}.json`
    const res = await fetch(url)
    if (res.ok) {
      const data = await res.json()
      teams.value = data.teams || []
      
      // Check if user is already in a team
      const found = teams.value.find((t) =>
        (t.members || []).some((m) => m.toLowerCase() === props.user.login.toLowerCase())
      )
      if (found) {
        myCurrentTeam.value = found
      }
    }
  } catch (e) {
    console.error('Failed to load teams list:', e)
  }
  loadingTeams.value = false
}

async function checkExistingState() {
  const token = getToken()
  if (!token) return

  if (myCurrentTeam.value) {
    const pattern = props.assignment.repository_name_pattern || `${props.assignment.id}-{team_slug}`
    const expectedName = pattern
      .replace('{team_slug}', myCurrentTeam.value.team_slug)
      .replace('{github_login}', props.user.login)

    const repo = await getRepo(token, props.org, expectedName)
    if (repo.ok) {
      repoUrl.value = repo.data.html_url
      repoFullName.value = repo.data.full_name
      acceptState.value = 'provisioned'
      return
    }

    const invites = await getInvitations(token)
    if (invites.ok && Array.isArray(invites.data)) {
      const match = invites.data.find(
        (inv) => inv.repository?.name === expectedName && inv.repository?.owner?.login === props.org
      )
      if (match) {
        pendingInvitation.value = match
        repoUrl.value = match.repository.html_url
        repoFullName.value = match.repository.full_name
        acceptState.value = 'invited'
        return
      }
    }
  }
}

async function confirmJoinTeam(team) {
  selectedTeam.value = team
  targetTeamName.value = team.team_name
  await executeTeamAcceptance(team.team_slug, team.team_name, isSwitching.value ? 'switch' : 'join')
}

async function submitCreateTeam() {
  if (!computedSlug.value || slugConflict.value) return
  targetTeamName.value = newTeamName.value
  await executeTeamAcceptance(computedSlug.value, newTeamName.value, isSwitching.value ? 'switch' : 'create')
}

async function executeTeamAcceptance(teamSlug, teamName, teamAction) {
  accepting.value = true
  try {
    const token = getToken()
    const brokerRepo = props.assignment.broker_repo || `broker-${props.assignment.id}`

    // Issue dispatch payload on public broker repo
    const issueRes = await ghApi(token, 'POST', `/repos/${props.org}/${brokerRepo}/issues`, {
      title: `team:${teamSlug}`,
      body: JSON.stringify({
        team_slug: teamSlug,
        team_name: teamName,
        team_action: teamAction,
        github_login: props.user.login,
      }),
    })

    if (!issueRes.ok) {
      const msg = issueRes.data?.message || `HTTP ${issueRes.status}`
      if (issueRes.status === 404) {
        throw new Error(`Broker repository "${brokerRepo}" not found. Ask your lecturer to publish the assignment.`)
      }
      throw new Error(`Failed to submit team registration (${msg}). Ensure the broker repository exists and issues are enabled.`)
    }

    // Also trigger star as redundant signal
    try {
      await ghApi(token, 'PUT', `/user/starred/${props.org}/${brokerRepo}`)
    } catch {
      // non-critical
    }

    acceptState.value = 'pending'
    startPolling(teamSlug)
  } catch (e) {
    toast.error(`Could not join team: ${e.message}`)
  } finally {
    accepting.value = false
  }
}

function startPolling(teamSlug) {
  pollCount.value = 0
  const pattern = props.assignment.repository_name_pattern || `${props.assignment.id}-{team_slug}`
  const expectedName = pattern
    .replace('{team_slug}', teamSlug)
    .replace('{github_login}', props.user.login)

  const tick = async () => {
    pollCount.value++
    const token = getToken()
    if (!token) return

    const repo = await getRepo(token, props.org, expectedName)
    if (repo.ok) {
      repoUrl.value = repo.data.html_url
      repoFullName.value = repo.data.full_name
      acceptState.value = 'provisioned'
      await loadTeams()
      return
    }

    const invites = await getInvitations(token)
    if (invites.ok && Array.isArray(invites.data)) {
      const match = invites.data.find(
        (inv) => inv.repository?.name === expectedName && inv.repository?.owner?.login === props.org
      )
      if (match) {
        pendingInvitation.value = match
        repoUrl.value = match.repository.html_url
        repoFullName.value = match.repository.full_name
        acceptState.value = 'invited'
        return
      }
    }

    if (pollCount.value > 20) {
      pollInterval.value = 10000
    }
    if (pollCount.value > 30) {
      acceptState.value = 'timeout'
      return
    }

    if (acceptState.value === 'pending') {
      pollTimer = setTimeout(tick, pollInterval.value)
    }
  }

  pollTimer = setTimeout(tick, pollInterval.value)
}

async function handleAcceptInvitation() {
  if (!pendingInvitation.value) return
  const token = getToken()
  const result = await acceptInvitation(token, pendingInvitation.value.id)
  if (result.ok) {
    acceptState.value = 'provisioned'
    await loadTeams()
  } else {
    toast.error(`Could not accept invitation (HTTP ${result.status}). Check github.com/notifications.`)
  }
}

function startSwitchTeam() {
  isSwitching.value = true
  acceptState.value = 'ready'
}

function copyRepoUrl() {
  if (repoUrl.value) {
    navigator.clipboard.writeText(repoUrl.value).then(
      () => {
        repoCopied.value = true
        setTimeout(() => { repoCopied.value = false }, 2000)
      },
      () => {
        toast.error('Could not copy repository URL')
      }
    )
  }
}
</script>

<style scoped>
.group-acceptance-card {
  padding: var(--space-xl);
  display: flex;
  flex-direction: column;
  gap: var(--space-md);
}

.flow-header h2 {
  font-size: 1.35rem;
  margin-bottom: var(--space-xs);
}

.tab-pill-selector {
  display: flex;
  gap: var(--space-sm);
  margin-bottom: var(--space-md);
  border-bottom: 1px solid var(--border-default);
  padding-bottom: var(--space-sm);
}

.tab-pill {
  background: none;
  border: 1px solid transparent;
  padding: 6px 14px;
  border-radius: 20px;
  color: var(--text-secondary);
  font-size: 0.875rem;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s ease;
}

.tab-pill:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.tab-pill.active {
  background: var(--bg-active);
  border-color: var(--border-muted);
  color: var(--accent-primary, #58a6ff);
}

.search-box {
  margin-bottom: var(--space-md);
}

.input-search {
  width: 100%;
  padding: 8px 12px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  color: var(--text-primary);
}

.teams-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
  max-height: 380px;
  overflow-y: auto;
}

.team-item-card {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: var(--space-md);
  background: var(--bg-secondary);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  transition: border-color 0.15s ease;
}

.team-item-card:hover:not(.is-full) {
  border-color: var(--accent-primary, #58a6ff);
}

.team-item-card.is-full {
  opacity: 0.65;
}

.team-header-line {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  margin-bottom: 4px;
  flex-wrap: wrap;
}

.team-slug-badge code {
  font-size: 0.75rem;
  background: var(--bg-tertiary);
  padding: 2px 6px;
  border-radius: 4px;
}

.team-members-list {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.member-tag {
  font-size: 0.75rem;
  color: var(--text-secondary);
  background: var(--bg-primary);
  padding: 1px 6px;
  border-radius: 4px;
  border: 1px solid var(--border-default);
}

.team-badge-banner {
  background: var(--bg-secondary);
  border: 1px solid var(--border-default);
  padding: 8px 12px;
  border-radius: 6px;
  margin-bottom: var(--space-md);
  text-align: center;
}

.member-chips {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 4px;
}

.member-chip {
  font-size: 0.8rem;
  background: var(--bg-secondary);
  border: 1px solid var(--border-default);
  padding: 2px 8px;
  border-radius: 12px;
}

.member-chip.is-me {
  border-color: var(--accent-primary, #58a6ff);
  color: var(--accent-primary, #58a6ff);
}

.create-team-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-md);
  padding: var(--space-md) 0;
}

.input-text {
  width: 100%;
  padding: 10px 12px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  color: var(--text-primary);
  font-size: 1rem;
}

.form-hint {
  display: block;
  font-size: 0.8rem;
  color: var(--text-muted);
  margin-top: 4px;
}

.alert-warn {
  background: rgba(210, 153, 34, 0.15);
  border: 1px solid rgba(210, 153, 34, 0.4);
  color: #d29922;
  padding: 8px 12px;
  border-radius: 6px;
  font-size: 0.85rem;
}
</style>
