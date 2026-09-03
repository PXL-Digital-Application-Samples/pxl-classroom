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

      <!-- Team Submission Status & Deadline Countdown Card -->
      <div class="team-status-card card flex flex-col gap-sm" style="margin-top: var(--space-md); padding: 14px; background: var(--bg-surface); border: 1px solid var(--border-default); border-radius: 8px; text-align: left;">
        <!-- Active Extension Announcement -->
        <div v-if="teamOverride" class="override-alert-banner flex items-center gap-xs">
          <Icon name="check-circle" :size="16" class="stat-green" />
          <span class="text-xs font-semibold text-primary">
            🎉 Deadline Extended to {{ new Date(teamOverride.value).toLocaleString() }} ({{ teamOverride.reason || 'Approved extension' }})
          </span>
        </div>

        <div class="flex justify-between items-center flex-wrap gap-xs">
          <div class="flex items-center gap-xs">
            <span class="text-xs font-semibold text-secondary">Team Submission:</span>
            <span :class="['badge', teamSubmissionStatus === 'on-time' ? 'badge-success' : teamSubmissionStatus === 'late' ? 'badge-warning' : 'badge-neutral']">
              {{ teamSubmissionStatus === 'on-time' ? 'Submitted on-time' : teamSubmissionStatus === 'late' ? 'Submitted late' : 'No commits pushed' }}
            </span>
          </div>

          <div v-if="deadlineCountdown" class="deadline-countdown flex items-center gap-xs text-xs">
            <Icon name="clock" :size="14" :class="isPastDeadline ? 'stat-red' : 'stat-blue'" />
            <span :class="isPastDeadline ? 'stat-red font-semibold' : 'text-secondary'">
              {{ deadlineCountdown }}
            </span>
          </div>
        </div>

        <div v-if="teamLatestCommit" class="latest-commit-info text-xs text-muted flex items-center gap-xs">
          <span>Latest team commit:</span>
          <code class="mono">{{ teamLatestCommit.sha.slice(0, 7) }}</code>
          <span v-if="teamLatestCommit.date">· {{ teamLatestCommit.date }}</span>
        </div>
      </div>

      <div class="team-actions">
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
        Joining <strong>{{ targetTeamName }}</strong>. GitHub Actions is configuring collaborator
        access, which usually takes <strong>20 to 40 seconds</strong> - longer when GitHub is busy.
      </p>
      <div class="progress-bar">
        <div class="progress-bar-fill"></div>
      </div>
      <p class="text-muted">Waiting {{ waitedSeconds }}s…</p>

      <!-- Reassurance rather than a guessed cause; see AssignmentView for the
           reasoning, which this card had a verbatim copy of. -->
      <p v-if="pollCount >= 5" class="text-secondary">
        Still going, and that is normal. Leave this page open - it updates by itself.
      </p>

      <!-- Held back past the ordinary provisioning window; see AssignmentView. -->
      <div v-if="pollCount >= 20 && showInvitationGuess" class="invitation-hint" role="status">
        <p class="text-secondary">
          This page cannot see your GitHub invitations. If <strong>{{ org }}</strong> invited you
          rather than adding you directly, your team repository is waiting behind that invitation:
        </p>
        <a :href="invitationUrl" target="_blank" rel="noopener" class="btn btn-primary">
          Look for a repository invitation
        </a>
        <p class="text-muted" style="margin-top: var(--space-xs);">
          A "404" there just means the repository is not ready yet - come back to this page.
        </p>
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
      <!-- We know one exists because the hub said so, but this token cannot
           list it - so there is nothing to accept in-app, and the link is the
           whole affordance. Safe here: the same message proves the repository
           exists. -->
      <a
        v-else-if="invitationUrl"
        :href="invitationUrl"
        target="_blank"
        rel="noopener"
        class="btn btn-primary btn-lg"
      >
        Accept your invitation on GitHub
      </a>
      <a v-else href="https://github.com/notifications" target="_blank" rel="noopener" class="btn btn-primary btn-lg">
        Check GitHub notifications
      </a>
    </div>

    <!-- State: Timeout -->
    <div v-else-if="acceptState === 'timeout'" class="timeout-state text-center">
      <Icon name="timer" :size="48" class="status-icon status-icon-warn" />
      <!-- ONE headline. The page cannot see pending invitations, so it may not
           split on "we asked and there was none" - see AssignmentView. -->
      <h2>Your team repository has not appeared</h2>
      <!-- One block: the explanation is about the link, and dangles without it. -->
      <template v-if="showInvitationGuess">
        <p class="text-secondary">
          Either there is a team repository invitation you still need to accept, or setup did not
          finish. This page cannot tell which - it is not able to see your pending invitations -
          but you can, in one click:
        </p>
        <a
          :href="invitationUrl"
          target="_blank"
          rel="noopener"
          class="btn btn-primary btn-lg"
          style="margin-bottom: var(--space-sm);"
        >
          Check for a repository invitation
        </a>
        <p class="text-muted" style="margin-bottom: var(--space-sm);">
          If that page offers you an invitation, accept it, then press <strong>Check again</strong>.
          If it shows a "404", there is no invitation for you to accept - tell your lecturer.
        </p>
      </template>
      <p v-else class="text-secondary">
        Setup did not finish - tell your lecturer.
      </p>
      <button class="btn btn-secondary" @click="checkExistingState">Check again</button>
    </div>

    <!-- State: Assignment Closed / Past Deadline -->
    <div v-else-if="assignment && (assignment.state === 'closed' || (assignment.deadline_at && new Date() > new Date(assignment.deadline_at)))" class="text-center py-lg">
      <Icon name="lock" :size="48" class="status-icon" />
      <h2>Assignment closed</h2>
      <p class="text-secondary">
        New registrations and team memberships for this assignment are currently closed.
      </p>
    </div>

    <!-- State: Not Open Yet -->
    <div v-else-if="assignment && (assignment.state === 'draft' || (assignment.opens_at && new Date() < new Date(assignment.opens_at)))" class="text-center py-lg">
      <Icon name="clock" :size="48" class="status-icon" />
      <h2>Assignment not open yet</h2>
      <p class="text-secondary">
        {{ assignment.state === 'draft' ? 'This assignment is currently in draft mode.' : `Opens ${assignment.opens_at}` }}
      </p>
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

      <!-- Asked once, above the team UI. The claim binds the ACCOUNT and is
           org-scoped, so it is orthogonal to which team is picked - putting it
           on each team action instead would ask the same question three times
           in three places. -->
      <ClaimAddressCard
        v-if="needsClaim"
        :assignment="assignment"
        :org="org"
        :token="claimToken"
        @update:claim="claim = $event"
      />
      <p v-if="needsClaim && !claimKeyReady" class="text-sm claim-unavailable">
        Claiming is not set up for this course yet. Ask your lecturer to finish
        setting up the assignment.
      </p>

      <!-- The group you are already in: pre-assigned, or carried over from an
           earlier assignment. One click confirms it; switching stays open
           unless the lecturer pre-assigned the groups. -->
      <div v-if="myCurrentTeam && !showAlternatives" class="preassigned-flow text-center py-md">
        <div class="card" style="padding: var(--space-lg); background: var(--bg-secondary);">
          <Icon name="users" :size="40" class="status-icon" />
          <h3>{{ myGroupHeading }}</h3>
          <p class="text-secondary">
            <template v-if="seededFromLabel">
              Carried over from <strong>{{ seededFromLabel }}</strong> — you are in
              <code>{{ myCurrentTeam.team_slug }}</code>.
            </template>
            <template v-else-if="isPreAssignedMode">
              You are pre-assigned to team <code>{{ myCurrentTeam.team_slug }}</code>.
            </template>
            <template v-else>
              You are already listed in <code>{{ myCurrentTeam.team_slug }}</code>.
            </template>
          </p>
          <div v-if="myCurrentTeam.members && myCurrentTeam.members.length" class="member-chips" style="justify-content: center; margin-bottom: var(--space-md);">
            <span v-for="m in myCurrentTeam.members" :key="m" class="member-chip" :class="{ 'is-me': m.toLowerCase() === user.login.toLowerCase() }">
              @{{ m }}
            </span>
          </div>
          <button class="btn btn-primary btn-lg" :disabled="accepting || claimBlocked" @click="confirmJoinTeam(myCurrentTeam)">
            {{ accepting ? 'Joining…' : 'Accept & Join Team' }}
          </button>
          <div v-if="canChooseAnother" class="alt-group-action">
            <button class="btn btn-link" type="button" :disabled="accepting" @click="showAlternatives = true">
              Choose a different group
            </button>
          </div>
        </div>
      </div>

      <!-- Pre-assigned, unassigned, and the lecturer has not opened the fallback -->
      <div v-else-if="isPreAssignedMode && !unassignedFallbackOpen" class="preassigned-flow text-center py-md">
        <div class="card text-center" style="padding: var(--space-lg); background: var(--bg-secondary);">
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
        <div v-if="myCurrentTeam && showAlternatives" class="back-to-group">
          <button class="btn btn-link" type="button" @click="showAlternatives = false">
            ← Back to my group ({{ myCurrentTeam.team_name }})
          </button>
        </div>
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
                class="btn btn-sm"
                :class="isMyTeam(team) ? 'btn-primary' : 'btn-secondary'"
                :disabled="(team.is_full && !isMyTeam(team)) || accepting || claimBlocked"
                @click="confirmJoinTeam(team)"
              >
                {{ isMyTeam(team) ? 'My group' : team.is_full ? 'Full' : 'Join Team' }}
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
            class="btn btn-primary btn-lg"
            :disabled="!computedSlug || slugConflict || accepting || claimBlocked"
          >
            <span v-if="accepting">Creating…</span>
            <span v-else>Create & Join Team</span>
          </button>
        </form>
      </div>
      </template>
    </div>

    <!-- Student Diagnostics Modal (1.A) -->
    <StudentDiagnosticsModal
      :show="showDiagnosticsModal"
      :user="user"
      :assignment="assignment"
      :accept-state="acceptState"
      :pending-invitation="pendingInvitation"
      :roster-status="rosterStatus"
      @close="showDiagnosticsModal = false"
    />
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import Icon from './Icon.vue'
import StudentDiagnosticsModal from './StudentDiagnosticsModal.vue'
import { getToken } from '../lib/auth.js'
import { config } from '../lib/config.js'
import { getRepo, getInvitations, acceptInvitation, ghApi, getRepoContent } from '../lib/api.js'
import { toast } from '../lib/toast.js'
import { copyText } from '../lib/clipboard.js'
import { signedAcceptanceIssueTitle, inviteTeamsUrl } from '../lib/invite.js'
import { invitationEvidence, mayOfferInvitationLink } from '../lib/invitation-evidence.js'
import { outcomeFromComments, announcesInvitation } from '../lib/acceptance-outcome.js'
import { sameLogin } from '../../../lib/github-login.mjs'
import { INSTITUTION } from '../lib/deployment.js'
import { effectiveDeadlineFor } from '../lib/deadline.js'
import { formatDeadlineCountdown } from '../lib/countdown.js'
import { buildAcceptanceBody, hubClaimKey, encryptClaim } from '../lib/claim.js'
import { normalizeRosterMode } from '../../../lib/roster-mode.mjs'
import { brokerRepoName } from '../../../lib/broker-repo.mjs'
import { overridePath } from '../../../lib/control-layout.mjs'
import { maxTeamSize as teamMaxSize } from '../../../lib/group-config.mjs'
import ClaimAddressCard from './ClaimAddressCard.vue'

const props = defineProps({
  assignment: { type: Object, required: true },
  org: { type: String, required: true },
  user: { type: Object, required: true },
  // The signed invitation from the route. Acceptance carries it in the issue
  // title; without it the broker rejects before touching a credential.
  inviteToken: { type: String, default: '' },
})

// Under `claim` a group student proves an address exactly as an individual one
// does - the claim binds the ACCOUNT to a person and is org-scoped, so it is
// orthogonal to which team they join.
const claim = ref(null)
const needsClaim = computed(() => normalizeRosterMode(props.assignment?.roster_mode) === 'claim')
const claimKeyReady = computed(() => Boolean(hubClaimKey()))
const claimBlocked = computed(() => needsClaim.value && (!claim.value || !claimKeyReady.value))
const claimToken = ref('')

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
// Set when the student explicitly asks to leave their carried-over group.
const showAlternatives = ref(false)

// Student Diagnostics (1.A)
const showDiagnosticsModal = ref(false)
const rosterStatus = ref('enrolled')

// 3s, deliberately. See AssignmentView: polling less often only adds dead time
// after the repository appears.
const pollInterval = ref(3000)
const pollCount = ref(0)
const waitedMs = ref(0)
let pollStartedAt = 0
const waitedSeconds = computed(() => Math.max(0, Math.round(waitedMs.value / 1000)))
let pollTimer = null

const isPreAssignedMode = computed(() => props.assignment.group_config?.formation_mode === 'pre-assigned')
const unassignedFallbackOpen = computed(
  () => props.assignment.group_config?.unassigned_fallback === 'self-service'
)
// Pre-assigned groups are the lecturer's: accept.mjs rejects a student-initiated
// switch, so offering one here would only produce a confusing failure.
const canChooseAnother = computed(() => !isPreAssignedMode.value)
const seededFromLabel = computed(() => {
  const from = myCurrentTeam.value?.seeded_from
  if (!from) return ''
  return from.assignment_title || from.assignment_id || ''
})
const myGroupHeading = computed(() => {
  if (!myCurrentTeam.value) return ''
  if (isPreAssignedMode.value && !seededFromLabel.value) {
    return `Pre-Assigned Team: ${myCurrentTeam.value.team_name}`
  }
  return `Your group: ${myCurrentTeam.value.team_name}`
})

function isMyTeam(team) {
  return (
    !!team &&
    (team.members || []).some((m) => m.toLowerCase() === props.user.login.toLowerCase())
  )
}
const maxTeamSize = computed(() => teamMaxSize(props.assignment?.group_config))
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

// A GUESS at the invitation page, and it 404s until the repository exists.
// Offered whenever no invitation has been PROVEN, because this page cannot see
// the student's pending invitations - see lib/invitation-evidence.js for the
// measurement, and AssignmentView for the same reasoning at length.
const invitationUrl = computed(() => {
  if (!targetTeamName.value && !myCurrentTeam.value) return null
  const slug = myCurrentTeam.value?.team_slug || selectedTeam.value?.team_slug || computedSlug.value
  const pattern = props.assignment.repository_name_pattern || `${props.assignment.id}-{team_slug}`
  const repo = pattern.replace('{team_slug}', slug).replace('{github_login}', props.user.login)
  return `https://github.com/${props.org}/${repo}/invitations`
})

const invitationProven = ref(false)
const showInvitationGuess = computed(() =>
  mayOfferInvitationLink(invitationProven.value, invitationUrl.value),
)

// The broker issue this team registration was filed on. The hub answers there -
// it is the only surface a student can read - and this page cannot see its own
// pending invitation any other way.
const acceptanceIssue = ref(null)

/** What the hub said, if anything. Null when it has not answered or we cannot read. */
async function readTeamAcceptanceOutcome() {
  if (!acceptanceIssue.value) return null
  const brokerRepo = brokerRepoName({ assignment: props.assignment, assignmentId: props.assignment?.id })
  try {
    const res = await ghApi(
      getToken(), 'GET',
      `/repos/${props.org}/${brokerRepo}/issues/${acceptanceIssue.value}/comments?per_page=20`,
    )
    if (!res.ok) return null
    return outcomeFromComments(res.data)
  } catch {
    return null
  }
}

onMounted(async () => {
  claimToken.value = getToken() || ""
  await loadTeams()
  await checkExistingState()
})

onUnmounted(() => {
  if (pollTimer) clearTimeout(pollTimer)
})

async function loadTeams() {
  loadingTeams.value = true
  const token = getToken()
  const brokerRepo = brokerRepoName({ assignment: props.assignment })
  const maxTeamCap = maxTeamSize.value || 3
  const teamsMap = new Map() // slug -> teamObject

  // Helper to upsert team
  function upsertTeam(slug, name, members = [], maxMembers = maxTeamCap, seededFrom = null) {
    if (!slug) return
    const cleanSlug = slug.toLowerCase().trim()
    const existing = teamsMap.get(cleanSlug) || {
      team_slug: cleanSlug,
      team_name: name || cleanSlug,
      members: [],
      max_members: maxMembers || maxTeamCap,
    }
    if (name && name !== cleanSlug) existing.team_name = name
    if (maxMembers) existing.max_members = maxMembers
    if (seededFrom && !existing.seeded_from) existing.seeded_from = seededFrom
    for (const m of members) {
      if (m && !existing.members.some(em => em.toLowerCase() === m.toLowerCase())) {
        existing.members.push(m)
      }
    }
    existing.member_count = existing.members.length
    existing.is_full = existing.members.length >= existing.max_members
    teamsMap.set(cleanSlug, existing)
  }

  // 1. Try fetching from Pages CDN static data
  try {
    const url = `${await inviteTeamsUrl(props.org, props.inviteToken)}?_t=${Date.now()}`
    const res = await fetch(url)
    if (res.ok) {
      const data = await res.json()
      for (const t of (data.teams || [])) {
        upsertTeam(t.team_slug, t.team_name, t.members || [], t.max_members, t.seeded_from)
      }
    }
  } catch (e) {
    console.warn('Could not load static teams file:', e.message)
  }

  // 2. Try fetching from control repo public data via GitHub API (if token present)
  if (token) {
    try {
      const ctlRes = await ghApi(token, 'GET', `/repos/${props.org}/${config.controlRepo}/contents/public/teams/${props.assignment.id}.json`)
      if (ctlRes.ok && ctlRes.data?.content) {
        const raw = atob(ctlRes.data.content.replace(/\n/g, ''))
        const parsed = JSON.parse(raw)
        for (const t of (parsed.teams || [])) {
          upsertTeam(t.team_slug, t.team_name, t.members || [], t.max_members, t.seeded_from)
        }
      }
    } catch {
      // ignore if student does not have read access to control repo
    }
  }

  // 3. Reconcile with live issues on public broker repository (Real-time live fallback)
  try {
    // ONE PAGE IS NOT THE LIST. This read `per_page=100` and stopped, so on a
    // cohort past a hundred acceptances - and one acceptance is one issue, so
    // a 200-student group assignment is 200 issues - every team formed after
    // the hundredth was invisible here. A student would then see a team as
    // having room, or not existing at all, and create a duplicate.
    //
    // Bounded rather than unbounded: this is a fallback behind the Pages teams
    // file and the control repo, and a student's own rate limit pays for it.
    // Five pages covers any cohort this system is designed for, and a short
    // page ends the walk early in the ordinary case - most brokers never reach
    // the second request.
    const MAX_PAGES = 5
    const issues = []
    let complete = true
    for (let page = 1; page <= MAX_PAGES; page++) {
      const path = `/repos/${props.org}/${brokerRepo}/issues?state=all&per_page=100&page=${page}`
      const res = token
        ? await ghApi(token, 'GET', path)
        : await fetch(`https://api.github.com${path}`).then(r => r.json().then(data => ({ ok: r.ok, data })))
      if (!res.ok || !Array.isArray(res.data)) { complete = false; break }
      issues.push(...res.data)
      if (res.data.length < 100) break
      if (page === MAX_PAGES) complete = false
    }
    if (!complete) {
      // Said out loud rather than swallowed: the team list below is built from
      // what was read, and a truncated read is not evidence a team is absent.
      console.warn('[teams] broker issue list was truncated; the live team reconciliation may be incomplete')
    }

    // The student's OWN acceptance issue, taken from a list we already have in
    // hand. It is skipped by the loop below - its title is `pxl-accept:`, not
    // `team:` - but it is the address the hub answers on, and without it a
    // student who closed the tab and came back can read neither the rejection
    // reason nor the invitation notice. Newest first, so the first match is the
    // current attempt.
    const mine = issues.find(
      (i) => typeof i.title === 'string' &&
        i.title.startsWith('pxl-accept:') &&
        sameLogin(i.user?.login, props.user?.login),
    )
    if (mine) acceptanceIssue.value = mine.number

    {
      for (const issue of issues) {
        if (!issue.title || !issue.title.startsWith('team:')) continue
        try {
          const bodyData = typeof issue.body === 'string' ? JSON.parse(issue.body) : (issue.body || {})
          const slug = bodyData.team_slug || issue.title.replace(/^team:/, '').trim()
          const name = bodyData.team_name || slug
          const member = bodyData.github_login || issue.user?.login
          
          if (slug) {
            upsertTeam(slug, name, member ? [member] : [], maxTeamCap)
          }
        } catch {
          const slug = issue.title.replace(/^team:/, '').trim()
          const member = issue.user?.login
          if (slug) {
            upsertTeam(slug, slug, member ? [member] : [], maxTeamCap)
          }
        }
      }
    }
  } catch (e) {
    console.warn('Could not query broker issues for live teams:', e.message)
  }

  // Final teams array
  teams.value = Array.from(teamsMap.values())

  // Check if user is already in a team
  const found = teams.value.find((t) =>
    (t.members || []).some((m) => m.toLowerCase() === props.user.login.toLowerCase())
  )
  if (found) {
    myCurrentTeam.value = found
  }

  loadingTeams.value = false
}

const teamLatestCommit = ref(null)
const teamOverride = ref(null)

const effectiveDeadline = computed(() => {
  if (teamOverride.value?.value) {
    return new Date(teamOverride.value.value)
  }
  return props.assignment?.deadline_at ? new Date(props.assignment.deadline_at) : null
})

const isPastDeadline = computed(() => {
  if (!effectiveDeadline.value) return false
  return new Date() > effectiveDeadline.value
})

const deadlineCountdown = computed(() => formatDeadlineCountdown(effectiveDeadline.value))

const teamSubmissionStatus = computed(() => {
  if (!teamLatestCommit.value) return 'no-submission'
  if (!effectiveDeadline.value) return 'on-time'
  const commitTime = new Date(teamLatestCommit.value.date)
  return commitTime <= effectiveDeadline.value ? 'on-time' : 'late'
})

async function refreshTeamSubmissionMeta(org, repoName) {
  const token = getToken()
  if (!token) return
  try {
    const res = await ghApi(token, 'GET', `/repos/${org}/${repoName}/commits?per_page=1`)
    if (res.ok && Array.isArray(res.data) && res.data.length > 0) {
      const c = res.data[0]
      teamLatestCommit.value = {
        sha: c.sha,
        date: c.commit?.author?.date || c.commit?.committer?.date,
        message: c.commit?.message,
      }
    }
  } catch (e) {
    console.error('Failed to fetch team latest commit:', e)
  }

  // Load student or team override if exists. Same rule as the backend
  // (lib/effective-deadline.mjs): the last grant in the append-only history
  // wins, and an extension only ever extends.
  try {
    const overrideFile = await getRepoContent(token, props.org, config.controlRepo, overridePath(props.assignment.id, props.user.login))
    if (overrideFile) {
      const eff = effectiveDeadlineFor(props.assignment, props.user.login, {
        overrides: [JSON.parse(overrideFile)],
      })
      if (eff.extended) {
        teamOverride.value = { value: eff.deadline.toISOString(), reason: eff.reason }
      }
    }
  } catch {
    // optional override
  }
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
      await refreshTeamSubmissionMeta(props.org, expectedName)
      return
    }

    // A match is the only outcome that settles anything - see
    // lib/invitation-evidence.js.
    const invites = await getInvitations(token)
    const evidence = invitationEvidence(invites, { org: props.org, repo: expectedName })
    invitationProven.value = evidence.proven
    if (evidence.invitation) {
      const match = evidence.invitation
      pendingInvitation.value = match
      repoUrl.value = match.repository.html_url
      repoFullName.value = match.repository.full_name
      acceptState.value = 'invited'
      return
    }

    // The hub is the only party that can see the invitation - see
    // lib/invitation-evidence.js. No poll-count gate here: this runs once, on
    // mount, and the answer may already have been posted while the tab was
    // closed. That student is exactly the one with nothing else to go on.
    if (announcesInvitation(await readTeamAcceptanceOutcome())) {
      acceptState.value = 'invited'
      return
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
    const brokerRepo = brokerRepoName({ assignment: props.assignment })

    // The TITLE carries the signed invitation and the team slug, because that
    // is all the broker reads - it holds App credentials and must never parse
    // the body (ARCHITECTURE §4.3.1). The body carries the rest, and the HUB
    // fetches and validates it (scripts/read-team-payload.mjs).
    const title = await signedAcceptanceIssueTitle({
      inviteSecret: props.inviteToken,
      assignmentId: props.assignment.id,
      githubId: props.user?.id,
      teamSlug,
    })

    // One builder for both acceptance flows: the hub reads a single body with
    // two readers (team fields and claim fields), and two callers assembling
    // that JSON by hand is the shape that forked diffRosters.
    let claimField = null
    if (needsClaim.value) {
      const hubKey = hubClaimKey()
      if (!hubKey) {
        throw new Error(
          'Claiming is not set up for this course yet. Ask your lecturer to finish setting up the assignment.',
        )
      }
      if (!claim.value) {
        throw new Error(`Confirm your ${INSTITUTION} email address before joining a team.`)
      }
      claimField = {
        payload: await encryptClaim({
          publicKey: hubKey.publicKey,
          email: claim.value.email,
          githubId: props.user?.id,
          assignmentId: props.assignment.id,
        }),
        verified: claim.value.verified,
      }
    }

    const issueRes = await ghApi(token, 'POST', `/repos/${props.org}/${brokerRepo}/issues`, {
      title,
      body: buildAcceptanceBody({
        team: { team_slug: teamSlug, team_name: teamName, team_action: teamAction },
        claim: claimField,
      }),
    })

    if (!issueRes.ok) {
      const msg = issueRes.data?.message || `HTTP ${issueRes.status}`
      if (issueRes.status === 404) {
        throw new Error(`Broker repository "${brokerRepo}" not found. Ask your lecturer to publish the assignment.`)
      }
      throw new Error(`Failed to submit team registration (${msg}). Ensure the broker repository exists and issues are enabled.`)
    }

    // Which issue the hub will answer on. Without it the announcement below is
    // unreadable and a group student gets nothing an individual student gets.
    acceptanceIssue.value = issueRes.data?.number ?? null

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
  waitedMs.value = 0
  pollStartedAt = Date.now()
  const pattern = props.assignment.repository_name_pattern || `${props.assignment.id}-{team_slug}`
  const expectedName = pattern
    .replace('{team_slug}', teamSlug)
    .replace('{github_login}', props.user.login)

  const tick = async () => {
    pollCount.value++
    waitedMs.value = Date.now() - pollStartedAt
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
    const evidence = invitationEvidence(invites, { org: props.org, repo: expectedName })
    invitationProven.value = evidence.proven
    if (evidence.invitation) {
      const match = evidence.invitation
      pendingInvitation.value = match
      repoUrl.value = match.repository.html_url
      repoFullName.value = match.repository.full_name
      acceptState.value = 'invited'
      return
    }

    // Ask the hub, which is the only party that can answer: the call above is
    // expected to come back empty even when an invitation is waiting. Not from
    // tick one - the marker cannot exist before the repository does.
    if (pollCount.value >= 2 && announcesInvitation(await readTeamAcceptanceOutcome())) {
      acceptState.value = 'invited'
      return
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

  // Immediately, not at +3s - see AssignmentView.
  tick()
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
  showAlternatives.value = true
  acceptState.value = 'ready'
}

function copyRepoUrl() {
  if (repoUrl.value) {
    copyText(repoUrl.value).then((ok) => {
      if (ok) {
        repoCopied.value = true
        setTimeout(() => { repoCopied.value = false }, 2000)
      } else {
        toast.error('Could not copy repository URL')
      }
    })
  }
}
</script>

<style scoped>
.alt-group-action {
  margin-top: var(--space-sm);
}

.back-to-group {
  margin-bottom: var(--space-sm);
}

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
  background: var(--bg-surface-hover);
  color: var(--text-primary);
}

.tab-pill.active {
  background: var(--bg-surface-hover);
  border-color: var(--border-muted);
  color: var(--accent-blue);
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
  border-color: var(--accent-blue);
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
  border-color: var(--accent-blue);
  color: var(--accent-blue);
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


.alert-warn {
  background: var(--tint-attention-muted);
  border: 1px solid var(--tint-attention-emphasis);
  color: var(--accent-yellow);
  padding: 8px 12px;
  border-radius: 6px;
  font-size: 0.85rem;
}

/* ------------------------------------------------------------------------
   Vocabulary that was carried INLINE.

   Each class below was written in the markup beside a `style="…"` that said
   what it meant, so the class itself was declared nowhere and the look lived on
   the element. Moving the declarations here changes nothing on screen - the
   values are unchanged - but it takes them off the undeclared-class register
   and puts the appearance where DESIGN.md says it belongs.
   ------------------------------------------------------------------------ */

.team-actions {
  margin-top: var(--space-md);
  border-top: 1px solid var(--border-default);
  padding-top: var(--space-sm);
}
</style>
