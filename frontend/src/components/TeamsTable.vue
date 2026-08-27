<template>
  <div class="teams-table-component">
    <!-- Filter bar & Toolbar -->
    <div class="table-toolbar flex justify-between items-center gap-md flex-wrap">
      <div class="flex items-center gap-md flex-wrap">
        <div class="search-input-wrapper">
          <Icon name="search" :size="16" class="search-icon" />
          <input
            v-model="searchQuery"
            type="text"
            placeholder="Filter teams or members…"
            class="form-control table-search"
            aria-label="Filter teams or members"
          />
        </div>

        <!-- Quick Filter Status Chips for Teams -->
        <div class="tab-pill-selector team-quick-filters" role="tablist" aria-label="Team Status Quick Filters">
          <button
            type="button"
            class="tab-pill"
            :class="{ active: teamStatusFilter === '' }"
            @click="teamStatusFilter = ''"
          >
            All ({{ teams.length }})
          </button>
          <button
            type="button"
            class="tab-pill"
            :class="{ active: teamStatusFilter === 'on-time' }"
            @click="teamStatusFilter = 'on-time'"
          >
            On-time ({{ onTimeTeamsCount }})
          </button>
          <button
            type="button"
            class="tab-pill"
            :class="{ active: teamStatusFilter === 'late' }"
            @click="teamStatusFilter = 'late'"
          >
            Late ({{ lateTeamsCount }})
          </button>
          <button
            type="button"
            class="tab-pill"
            :class="{ active: teamStatusFilter === 'under-capacity' }"
            @click="teamStatusFilter = 'under-capacity'"
          >
            Under-capacity ({{ underCapacityCount }})
          </button>
        </div>
      </div>

      <div class="toolbar-actions flex items-center gap-sm">
        <button class="btn btn-sm btn-secondary btn-with-icon" @click="showSeedModal = true" title="Carry an existing grouping into this assignment">
          <Icon name="users" :size="14" />
          <span>Seed teams</span>
        </button>
        <button class="btn btn-sm btn-secondary btn-with-icon" @click="openCreateTeamModal">
          <Icon name="plus" :size="14" />
          <span>Create Team</span>
        </button>

        <button
          v-if="removableSeededTeams.length"
          class="btn btn-sm btn-danger-outline btn-with-icon"
          type="button"
          :disabled="saving"
          @click="removeSeededTeams"
          title="Delete the carried-over teams nobody has accepted into yet"
        >
          <Icon name="x-circle" :size="14" />
          <span>Undo seed ({{ removableSeededTeams.length }})</span>
        </button>

        <div class="toolbar-stats text-secondary text-sm">
          <span>Showing <strong>{{ filteredTeams.length }}</strong> of <strong>{{ teams.length }}</strong> team(s)</span>
        </div>
      </div>
    </div>

    <!-- Provenance: one line for the whole table, not a badge on every row -->
    <p v-if="seededSummary" class="seeded-note">
      <Icon name="users" :size="13" />
      <span>{{ seededSummary }}</span>
    </p>
    <p v-if="unassignedStudents.length" class="seeded-note">
      <Icon name="alert-circle" :size="13" />
      <span>
        {{ unassignedStudents.length }} student{{ unassignedStudents.length === 1 ? '' : 's' }} on the
        roster {{ unassignedStudents.length === 1 ? 'has' : 'have' }} no team:
        {{ unassignedPreview }}
      </span>
    </p>
    <p v-if="assignment?.state === 'draft' && teams.length" class="seeded-note">
      <Icon name="eye-off" :size="13" />
      <span>Draft — students cannot see these teams until the assignment is published.</span>
    </p>

    <!-- Empty state -->
    <div v-if="filteredTeams.length === 0" class="empty-state card text-center py-xl">
      <Icon name="users" :size="40" class="status-icon" />
      <template v-if="teams.length === 0">
        <p class="text-secondary">
          No teams yet. Students form their own when they accept — or start from the groups they
          already worked in.
        </p>
        <div class="flex gap-sm justify-center" style="margin-top: 8px;">
          <button class="btn btn-secondary btn-sm" @click="showSeedModal = true">
            Seed teams from a previous assignment
          </button>
          <button class="btn btn-secondary btn-sm" @click="openCreateTeamModal">
            Create a team
          </button>
        </div>
      </template>
      <template v-else>
        <p class="text-secondary">No teams match your search filter.</p>
        <button class="btn btn-secondary btn-sm" style="margin-top: 8px;" @click="openCreateTeamModal">
          Create a new team
        </button>
      </template>
    </div>

    <!-- Teams Table -->
    <div v-else class="table-responsive">
      <table class="data-table">
        <thead>
          <tr>
            <th>Team</th>
            <th>Members</th>
            <th>Capacity</th>
            <th>Repository</th>
            <th>Commits</th>
            <th>Status</th>
            <th v-if="ciStatusColumn">CI Status</th>
            <th v-if="autogradeEnabled">Score</th>
            <th>Preserved</th>
            <th class="col-actions"><span class="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="team in filteredTeams" :key="team.team_slug">
            <!-- Team column -->
            <td>
              <div class="team-cell">
                <strong class="team-title">{{ team.team_name }}</strong>
                <code class="team-slug">{{ team.team_slug }}</code>
              </div>
            </td>

            <!-- Members column -->
            <td>
              <div class="members-cell">
                <div v-if="team.members && team.members.length" class="member-pills">
                  <span
                    v-for="m in team.members"
                    :key="m"
                    class="member-pill"
                    :class="{ 'member-pending': isPending(m) }"
                    :title="memberTitle(m)"
                  >
                    @{{ m }}
                  </span>
                </div>
                <span v-else class="text-muted text-xs">No members (vacant)</span>
                <span v-if="pendingCount(team)" class="status-indicator member-pending-note">
                  <span class="status-dot dot-warning"></span>
                  <span>{{ pendingCount(team) }} not accepted yet</span>
                </span>
              </div>
            </td>

            <!-- Capacity column -->
            <td>
              <span class="status-indicator">
                <span class="status-dot" :class="team.under_capacity ? 'dot-warning' : ((team.members?.length || 0) >= maxTeamSize ? 'dot-neutral' : 'dot-success')"></span>
                <span class="mono text-xs">{{ team.members ? team.members.length : 0 }}/{{ maxTeamSize }}<template v-if="team.under_capacity"> (low)</template></span>
              </span>
            </td>

            <!-- Repository column -->
            <td>
              <a
                v-if="team.repo_url"
                :href="team.repo_url"
                target="_blank"
                rel="noopener"
                class="repo-link mono"
              >
                {{ team.repo_name ? team.repo_name.split('/').pop() : team.team_slug }}
              </a>
              <span v-else class="text-muted text-xs">-</span>
            </td>

            <!-- Commits column -->
            <td>
              <span v-if="team.commit_count != null" class="mono text-xs">
                {{ team.commit_count }}
              </span>
              <span v-else class="text-muted text-xs">-</span>
            </td>

            <!-- Submission Status column -->
            <td>
              <span class="status-indicator">
                <span class="status-dot" :class="team.submission_status === 'on-time' ? 'dot-success' : (team.submission_status === 'late' ? 'dot-warning' : 'dot-neutral')"></span>
                <span class="text-sm">{{ team.submission_status || 'unknown' }}</span>
              </span>
            </td>

            <!-- CI Status column (Autograding) -->
            <td v-if="ciStatusColumn">
              <button
                v-if="team.ci_status"
                type="button"
                :class="['badge', team.ci_status === 'success' ? 'badge-success' : team.ci_status === 'failure' ? 'badge-error' : 'badge-warning']"
                @click="openTeamAutogradeModal(team)"
                title="Click to view team test breakdown"
                style="cursor: pointer; border: none;"
              >
                {{ team.ci_status }}
              </button>
              <span v-else class="text-muted text-xs">-</span>
            </td>

            <!-- Score column (Autograding) -->
            <td v-if="autogradeEnabled">
              <button
                v-if="team.earned_points != null"
                type="button"
                class="badge"
                :class="team.earned_points >= team.total_points && team.total_points > 0 ? 'badge-success' : (team.earned_points > 0 ? 'badge-warning' : 'badge-error')"
                @click="openTeamAutogradeModal(team)"
                title="Click to view the score and open the CI run"
                style="cursor: pointer; border: none; font-size: 0.75rem;"
              >
                {{ team.earned_points }}/{{ team.total_points }} pts
              </button>
              <span v-else class="text-muted text-xs">-</span>
            </td>

            <!-- Preserved column -->
            <td>
              <a
                v-if="team.preservation_status === 'preserved' && teamArchiveUrl(team)"
                :href="teamArchiveUrl(team)"
                target="_blank"
                rel="noopener"
                class="badge badge-success archive-link"
                title="View preserved code in archive repository"
                style="display: inline-flex; align-items: center; text-decoration: none;"
              >
                Preserved
              </a>
              <span v-else-if="team.lock_down_at" class="badge badge-neutral" title="Locked down">
                Locked
              </span>
              <span v-else class="text-muted text-xs">-</span>
            </td>

            <!-- Actions column -->
            <td class="col-actions">
              <div class="flex gap-xs justify-end items-center">
                <button
                  class="btn btn-sm btn-secondary"
                  type="button"
                  @click="openManageTeamModal(team)"
                  title="Manage team members"
                >
                  Manage
                </button>
                <button
                  v-if="!team.members || team.members.length === 0"
                  class="btn btn-sm btn-danger"
                  type="button"
                  @click="deleteVacantTeam(team)"
                  title="Delete vacant team"
                >
                  Delete
                </button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Modal: Create Team -->
    <div v-if="showCreateModal" class="modal-overlay" @click.self="showCreateModal = false">
      <div class="modal card">
        <header class="modal-head flex justify-between items-center">
          <h3>Create Team - {{ assignment.id }}</h3>
          <button class="modal-close" type="button" @click="showCreateModal = false" aria-label="Close">×</button>
        </header>
        <form @submit.prevent="submitCreateTeam" class="modal-body flex flex-col gap-md">
          <div class="form-group">
            <label>Team Name <span class="req">*</span></label>
            <input
              v-model="newTeamForm.name"
              type="text"
              class="form-control"
              placeholder="e.g. Team Phoenix"
              required
            />
            <span class="form-hint text-xs text-muted">
              Team slug: <code>{{ computedNewSlug || 'team-slug' }}</code>
            </span>
          </div>

          <div class="form-group">
            <label>Assign Students (Optional)</label>
            <div class="unassigned-students-list">
              <label
                v-for="s in unassignedStudents"
                :key="s.github_login"
                class="student-check-item flex items-center gap-xs text-sm"
              >
                <input
                  type="checkbox"
                  :value="s.github_login"
                  v-model="newTeamForm.members"
                  :disabled="newTeamForm.members.length >= maxTeamSize && !newTeamForm.members.includes(s.github_login)"
                />
                <span>@{{ s.github_login }} ({{ s.full_name || s.student_number }})</span>
              </label>
              <div v-if="unassignedStudents.length === 0" class="text-muted text-xs">
                No unassigned students available in roster.
              </div>
            </div>
            <span class="form-hint text-xs text-secondary">
              Selected {{ newTeamForm.members.length }}/{{ maxTeamSize }} members
            </span>
          </div>

          <footer class="modal-foot flex justify-end gap-sm">
            <button class="btn btn-secondary" type="button" @click="showCreateModal = false">Cancel</button>
            <button class="btn btn-primary" type="submit" :disabled="!computedNewSlug || saving">
              {{ saving ? 'Creating…' : 'Create Team' }}
            </button>
          </footer>
        </form>
      </div>
    </div>

    <!-- Modal: Manage Team -->
    <div v-if="managingTeam" class="modal-overlay" @click.self="managingTeam = null">
      <div class="modal card">
        <header class="modal-head flex justify-between items-center">
          <h3>Manage: {{ managingTeam.team_name }} (<code>{{ managingTeam.team_slug }}</code>)</h3>
          <button class="modal-close" type="button" @click="managingTeam = null" aria-label="Close">×</button>
        </header>
        <div class="modal-body flex flex-col gap-md">
          <!-- Current Members list -->
          <div class="current-members-section">
            <label class="section-label">Current Members ({{ manageMembers.length }}/{{ maxTeamSize }})</label>
            <div v-if="manageMembers.length" class="members-manage-list">
              <div v-for="m in manageMembers" :key="m" class="member-manage-row flex justify-between items-center">
                <div class="flex items-center gap-xs">
                  <span class="mono font-semibold" style="color: var(--text-primary);">@{{ m }}</span>
                  <span v-if="resolveMemberDisplayName(m)" class="text-secondary text-xs">({{ resolveMemberDisplayName(m) }})</span>
                </div>
                <div class="flex gap-xs">
                  <button class="btn btn-xs btn-danger" type="button" @click="removeMemberFromTeam(m)">
                    Remove
                  </button>
                </div>
              </div>
            </div>
            <div v-else class="text-muted text-xs">
              No active members in this team.
            </div>
          </div>

          <!-- Add Member section -->
          <div v-if="manageMembers.length < maxTeamSize" class="add-member-section">
            <label class="section-label">Add Member</label>
            <div class="flex gap-sm">
              <select v-model="selectedStudentToAdd" class="form-control">
                <option value="">Select unassigned student…</option>
                <option v-for="s in unassignedStudents" :key="s.github_login" :value="s.github_login">
                  @{{ s.github_login }} ({{ s.full_name || s.student_number }})
                </option>
              </select>
              <button
                class="btn btn-sm btn-secondary"
                type="button"
                :disabled="!selectedStudentToAdd"
                @click="addMemberToTeam(selectedStudentToAdd)"
              >
                Add
              </button>
            </div>
          </div>

          <footer class="modal-foot flex justify-between items-center gap-sm">
            <button
              v-if="manageMembers.length === 0"
              class="btn btn-danger btn-sm"
              type="button"
              :disabled="saving"
              @click="deleteVacantTeam(managingTeam)"
            >
              Delete Vacant Team
            </button>
            <div class="flex gap-sm" style="margin-left: auto;">
              <button class="btn btn-secondary" type="button" @click="managingTeam = null">Close</button>
              <button class="btn btn-primary" type="button" :disabled="saving" @click="saveTeamMembers">
                {{ saving ? 'Saving…' : 'Save Changes' }}
              </button>
            </div>
          </footer>
        </div>
      </div>
    </div>

    <!-- Modal: Seed teams from an existing grouping -->
    <SeedTeamsModal
      v-if="showSeedModal"
      :org="org"
      :assignment="assignment"
      :assignments="assignments"
      @close="showSeedModal = false"
      @seeded="emit('refresh')"
    />

    <!-- Modal: Team Autograding Test Breakdown -->
    <div v-if="activeTeamAutograde" class="modal-overlay" @click.self="closeTeamAutogradeModal">
      <div class="modal card autograde-modal" role="dialog" aria-modal="true" :aria-label="`Autograding Results for ${activeTeamAutograde.team_name}`" style="max-width: 650px;">
        <header class="modal-head flex justify-between items-center">
          <div class="flex items-center gap-sm">
            <Icon name="check-circle" :size="20" :class="activeTeamAutograde.ci_status === 'success' ? 'text-success' : 'text-danger'" />
            <h3 style="margin: 0;">
              Team Autograding: <strong>{{ activeTeamAutograde.team_name }}</strong> (<code>{{ activeTeamAutograde.team_slug }}</code>)
            </h3>
          </div>
          <button class="modal-close" type="button" @click="closeTeamAutogradeModal" aria-label="Close">×</button>
        </header>

        <div class="modal-body flex flex-col gap-md" style="padding: var(--space-md);">
          <!-- Summary Banner -->
          <div class="score-banner flex justify-between items-center p-md" :class="activeTeamAutograde.ci_status === 'success' ? 'banner-success' : 'banner-warning'" style="border-radius: var(--radius-sm, 6px); border: 1px solid var(--border-default); padding: 12px 16px;">
            <div>
              <div class="text-xs text-secondary uppercase font-semibold">Team Score</div>
              <div class="text-xl font-bold" style="font-size: 1.4rem;">
                <!-- No invented denominator: `points_possible` is not a schema
                     field, so the 100 was a number nobody set. -->
                {{ activeTeamAutograde.earned_points != null ? `${activeTeamAutograde.earned_points} / ${activeTeamAutograde.total_points} pts` : (activeTeamAutograde.ci_status || 'No score read yet') }}
              </div>
            </div>
            <div>
              <span :class="['badge', activeTeamAutograde.ci_status === 'success' ? 'badge-success' : activeTeamAutograde.ci_status === 'failure' ? 'badge-error' : 'badge-warning']" style="font-size: 0.85rem; padding: 4px 10px;">
                {{ activeTeamAutograde.ci_status || 'completed' }}
              </span>
            </div>
          </div>

          <!-- Team Test Breakdown List -->
          <div v-if="activeTeamAutograde.tests && activeTeamAutograde.tests.length" class="tests-breakdown-list flex flex-col gap-sm">
            <h4 style="margin: 0 0 4px 0;">Test Suites</h4>
            <div v-for="t in activeTeamAutograde.tests" :key="t.id" class="test-item-card p-sm" style="border: 1px solid var(--border-default); border-radius: var(--radius-sm, 6px); padding: 10px; background: var(--bg-surface);">
              <div class="flex justify-between items-center">
                <div class="flex items-center gap-xs">
                  <span :class="['badge', t.passed ? 'badge-success' : 'badge-error']" style="font-size: 0.7rem; padding: 2px 6px;">
                    {{ t.passed ? 'PASSED' : 'FAILED' }}
                  </span>
                  <strong>{{ t.name || t.id }}</strong>
                </div>
                <span class="mono font-semibold text-sm">{{ t.earned != null ? t.earned : (t.passed ? t.points : 0) }}/{{ t.points }} pts</span>
              </div>
              <div v-if="t.stdout || t.stderr" class="test-logs mt-xs" style="margin-top: 6px;">
                <pre class="mono text-xs p-xs" style="background: var(--bg-canvas); border-radius: 4px; max-height: 120px; overflow-y: auto; white-space: pre-wrap; margin: 0; padding: 8px;">{{ t.stderr || t.stdout }}</pre>
              </div>
            </div>
          </div>
          <!-- Check-run annotations carry the grand total only; the per-check
               breakdown exists in the run and nowhere else. -->
          <div v-else class="text-secondary text-sm">
            <p style="margin: 0;">
              The per-check breakdown is in the grading run itself.
              <a v-if="activeTeamAutograde.ci_run_url" :href="activeTeamAutograde.ci_run_url" target="_blank" rel="noopener" class="btn-link">
                Open the run →
              </a>
              <a v-else-if="activeTeamAutograde.repo_url" :href="`${activeTeamAutograde.repo_url}/actions`" target="_blank" rel="noopener" class="btn-link">
                Open GitHub Actions →
              </a>
            </p>
          </div>
        </div>

        <footer class="modal-foot flex justify-end gap-sm" style="padding: var(--space-sm) var(--space-md); border-top: 1px solid var(--border-default);">
          <button class="btn btn-secondary" type="button" @click="closeTeamAutogradeModal">Close</button>
        </footer>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import Icon from './Icon.vue'
import SeedTeamsModal from './SeedTeamsModal.vue'
import { getToken } from '../lib/auth.js'
import { commitFile, commitFiles, deleteFile, getRepoContent, addCollaborator, removeCollaborator, triggerWorkflow, explainDispatchFailure } from '../lib/api.js'
import { validateAgainst } from '../lib/validate.js'
import { config } from '../lib/config.js'
import { maxTeamSize as teamMaxSize } from '../../../lib/group-config.mjs'
import { toast } from '../lib/toast.js'
import { planUnseed } from '../../../lib/seed-teams.mjs'
import { archiveBranchUrl } from '../lib/archive-repo.js'

const props = defineProps({
  teams: { type: Array, required: true },
  assignment: { type: Object, required: true },
  org: { type: String, required: true },
  roster: { type: Array, default: () => [] },
  // Report students - used to tell a seeded member apart from one who has
  // actually accepted. Seeding grants nothing; only acceptance provisions.
  students: { type: Array, default: () => [] },
  // Other assignments in the org, offered as seeding sources.
  assignments: { type: Array, default: () => [] },
})

const emit = defineEmits(['refresh'])

// Archives are per assignment (`pxl-classroom-archive-<id>`), and which one a
// preserved team is in is read off the report row, never derived - a cohort
// preserved before that change is in the org's old shared archive and must keep
// resolving there. lib/archive-repo.mjs is the only place either rule lives.
function teamArchiveUrl(team) {
  return archiveBranchUrl({
    org: props.org,
    assignmentId: props.assignment?.id,
    teamSlug: team?.team_slug,
    recorded: team?.archive_repo,
    recordedRef: team?.archive_ref,
  })
}

const searchQuery = ref('')
const teamStatusFilter = ref('')
const showSeedModal = ref(false)
const showCreateModal = ref(false)
const managingTeam = ref(null)
const manageMembers = ref([])
const selectedStudentToAdd = ref('')
const saving = ref(false)

const newTeamForm = ref({
  name: '',
  members: [],
})

const maxTeamSize = computed(() => teamMaxSize(props.assignment?.group_config))

// Same rule as AssignmentDetailView: the Score column keys on grades EXISTING,
// not on the assignment declaring autograding here. Grades produced by a
// workflow that shipped inside the template repository are still grades, and a
// column that can only ever be blank is C4.
const hasGrades = computed(() => (props.teams || []).some((t) => t.earned_points != null))
const autogradeEnabled = computed(() => hasGrades.value)

// Whether the assignment declares Actions-run autograding here - which is what
// makes `refreshLiveStatus` fill ci_status, independently of any score. So the
// CI column has two ways to be populated and the Score column has one.
const isGitHubActionsAutograde = computed(
  () => props.assignment?.autograde?.enabled === true &&
        props.assignment?.autograde?.execution_environment === 'github_actions'
)
const ciStatusColumn = computed(() => hasGrades.value || isGitHubActionsAutograde.value)

const activeTeamAutograde = ref(null)

function openTeamAutogradeModal(team) {
  activeTeamAutograde.value = team
}

function closeTeamAutogradeModal() {
  activeTeamAutograde.value = null
}

const acceptedLogins = computed(() => {
  const set = new Set()
  for (const s of props.students || []) {
    if (!s.github_login) continue
    // A student row exists for anyone on the roster; only an acceptance record
    // (or a provisioned repo) means they actually joined.
    if (s.acceptance_state === 'not-accepted' && !s.repo_url) continue
    set.add(s.github_login.toLowerCase())
  }
  return set
})

function hasAccepted(login) {
  // Acceptance requires a published assignment, so on a draft nobody has -
  // which is what makes every seeded team on a draft safely removable.
  if (props.assignment?.state === 'draft') return false
  // No student data at all (an older report) is not evidence of non-acceptance.
  if (!(props.students || []).length) return true
  return acceptedLogins.value.has(String(login).toLowerCase())
}

// Worth flagging in the table? On a draft the banner already says students
// cannot see these teams, so marking every member "not accepted yet" on top of
// that is noise about a state that is simply not reachable yet.
function isPending(login) {
  if (props.assignment?.state === 'draft') return false
  if (!(props.students || []).length) return false
  return !hasAccepted(login)
}

function memberTitle(login) {
  const base = resolveMemberTooltip(login)
  return isPending(login) ? `${base} - has not accepted yet, so has no repository access` : base
}

function pendingCount(team) {
  return (team.members || []).filter((m) => isPending(m)).length
}

const unassignedPreview = computed(() => {
  const logins = unassignedStudents.value.map((s) => `@${s.github_login}`)
  const shown = logins.slice(0, 8)
  const rest = logins.length - shown.length
  return rest > 0 ? `${shown.join(', ')} and ${rest} more` : shown.join(', ')
})

// A bulk write needs a bulk undo. The rule for what may be removed lives in
// lib/seed-teams.mjs so the CLI cannot drift from it.
const unseedPlan = computed(() =>
  planUnseed({
    teams: props.teams,
    assignmentId: props.assignment?.id,
    acceptedLogins: props.assignment?.state === 'draft' ? [] : [...acceptedLogins.value],
  })
)

const removableSeededTeams = computed(() => unseedPlan.value.removable)
const keptSeededTeams = computed(() => unseedPlan.value.kept)

const seededSummary = computed(() => {
  const seeded = props.teams.filter((t) => t.seeded_from)
  if (seeded.length === 0) return ''
  const titles = [
    ...new Set(
      seeded.map(
        (t) => t.seeded_from.assignment_title || t.seeded_from.assignment_id || 'the roster'
      )
    ),
  ]
  const from = titles.length === 1 ? titles[0] : `${titles.length} sources`
  return `${seeded.length} of ${props.teams.length} team(s) carried over from ${from}. Students confirm the group when they accept.`
})

const underCapacityCount = computed(() =>
  props.teams.filter((t) => t.under_capacity).length
)

const onTimeTeamsCount = computed(() =>
  props.teams.filter((t) => t.submission_status === 'on-time').length
)

const lateTeamsCount = computed(() =>
  props.teams.filter((t) => t.submission_status === 'late').length
)

const computedNewSlug = computed(() => {
  if (!newTeamForm.value.name) return ''
  return newTeamForm.value.name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
})

const assignedLogins = computed(() => {
  const set = new Set()
  for (const t of props.teams) {
    for (const m of t.members || []) {
      set.add(m.toLowerCase())
    }
  }
  return set
})

const unassignedStudents = computed(() =>
  (props.roster || []).filter(
    (s) => s.github_login && !assignedLogins.value.has(s.github_login.toLowerCase())
  )
)

const filteredTeams = computed(() => {
  let list = props.teams
  const q = searchQuery.value.toLowerCase().trim()
  if (q) {
    list = list.filter(
      (t) =>
        t.team_name?.toLowerCase().includes(q) ||
        t.team_slug?.toLowerCase().includes(q) ||
        (t.members || []).some((m) => m.toLowerCase().includes(q))
    )
  }
  if (teamStatusFilter.value) {
    if (teamStatusFilter.value === 'under-capacity') {
      list = list.filter((t) => t.under_capacity)
    } else {
      list = list.filter((t) => t.submission_status === teamStatusFilter.value)
    }
  }
  return list
})

function resolveMemberTooltip(login) {
  const r = (props.roster || []).find((s) => s.github_login?.toLowerCase() === login.toLowerCase())
  if (r) {
    return `${r.full_name || login} (${r.student_number || r.email || ''})`
  }
  return `@${login}`
}

function resolveMemberDisplayName(login) {
  const r = (props.roster || []).find((s) => s.github_login?.toLowerCase() === login?.toLowerCase())
  if (r && r.full_name && r.full_name.toLowerCase() !== login?.toLowerCase()) {
    return r.student_number ? `${r.full_name} · ${r.student_number}` : r.full_name
  }
  return null
}


function openCreateTeamModal() {
  newTeamForm.value = { name: '', members: [] }
  showCreateModal.value = true
}

function openManageTeamModal(team) {
  managingTeam.value = team
  manageMembers.value = [...(team.members || [])]
  selectedStudentToAdd.value = ''
}

function removeMemberFromTeam(login) {
  manageMembers.value = manageMembers.value.filter((m) => m !== login)
}

function addMemberToTeam(login) {
  if (login && !manageMembers.value.includes(login)) {
    manageMembers.value.push(login)
    selectedStudentToAdd.value = ''
  }
}

// Students never read the control repo - they read the generated public teams
// file. A lecturer edit that skips this is invisible to them until the next
// nightly run, which is exactly how lecturer-created teams used to vanish.
async function republishTeams(token) {
  try {
    // triggerWorkflow resolves with { ok: false } on a 403/404 rather than
    // throwing, so the result has to be inspected: silently swallowing it
    // reports success while students still cannot see the change.
    const res = await triggerWorkflow(
      token,
      config.hubOwner,
      config.hubRepo,
      'regenerate-dashboard.yml',
      { org: props.org }
    )
    if (!res.ok) {
      toast.error(
        explainDispatchFailure(res, 'Saved, but publishing the change to students failed'),
        { link: {
          href: `https://github.com/${config.hubOwner}/${config.hubRepo}/actions/workflows/regenerate-dashboard.yml`,
          text: 'Run it manually',
        } }
      )
      return false
    }
    return true
  } catch (e) {
    toast.error(
      `Saved, but publishing the change to students failed: ${e.message}. Run Regenerate Dashboard from the hub's Actions tab.`
    )
    return false
  }
}

async function removeSeededTeams() {
  const removable = removableSeededTeams.value
  if (removable.length === 0) return

  const kept = keptSeededTeams.value
  const message =
    `Remove ${removable.length} carried-over team(s) from ${props.assignment.id}?\n\n` +
    removable.map((t) => `- ${t.team_name} (${(t.members || []).length} member(s))`).join('\n') +
    (kept.length
      ? `\n\n${kept.length} carried-over team(s) will be kept: a member has already accepted into them.`
      : '') +
    `\n\nThis deletes the team files from the control repository. No student repository is touched.`

  if (!window.confirm(message)) return

  saving.value = true
  try {
    const token = getToken()
    const res = await commitFiles(
      token,
      props.org,
      config.controlRepo,
      unseedPlan.value.changes,
      `Remove ${removable.length} seeded team(s) from ${props.assignment.id}`
    )
    if (!res.ok) {
      toast.error(`Could not remove the teams: ${res.error}`)
      return
    }
    await republishTeams(token)
    toast.success(`Removed ${removable.length} carried-over team(s).`)
    emit('refresh')
  } catch (e) {
    toast.error(`Error removing teams: ${e.message}`)
  } finally {
    saving.value = false
  }
}

async function submitCreateTeam() {
  const slug = computedNewSlug.value
  if (!slug) return
  saving.value = true
  try {
    const token = getToken()
    const teamDoc = {
      schema_version: 1,
      assignment_id: props.assignment.id,
      team_slug: slug,
      team_name: newTeamForm.value.name,
      members: newTeamForm.value.members,
      max_members: maxTeamSize.value,
      created_at: new Date().toISOString(),
      created_by: 'lecturer',
    }

    const { valid, errors } = await validateAgainst('team', teamDoc)
    if (!valid) {
      toast.error(
        `Refusing to write an invalid team manifest: ${errors.map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ')}`
      )
      return
    }

    const path = `teams/${props.assignment.id}/${slug}.json`
    const res = await commitFile(
      token,
      props.org,
      config.controlRepo,
      path,
      JSON.stringify(teamDoc, null, 2) + '\n',
      `Create team ${slug} for ${props.assignment.id}`
    )
    if (res.ok) {
      await republishTeams(token)
      toast.success(`Team "${newTeamForm.value.name}" created successfully.`)
      showCreateModal.value = false
      emit('refresh')
    } else {
      toast.error(`Could not create team: HTTP ${res.status}`)
    }
  } catch (e) {
    toast.error(`Error creating team: ${e.message}`)
  } finally {
    saving.value = false
  }
}

async function saveTeamMembers() {
  if (!managingTeam.value) return
  saving.value = true
  try {
    const token = getToken()
    const slug = managingTeam.value.team_slug
    const oldMembers = managingTeam.value.members || []
    const newMembers = manageMembers.value || []
    const path = `teams/${props.assignment.id}/${slug}.json`

    // READ the manifest we are about to edit, before touching anything.
    //
    // This used to rebuild the whole document from the row on screen, which is
    // the `buildDoc` bug in a new place: `props.teams` is a DISPLAY shape built
    // by mergeTeamManifests, so it carries `submission_status`, `commit_count`,
    // `under_capacity` and `warnings` - none of which team.schema.json allows -
    // and it never carries `repo_id` or `created_by` at all. Saving a member
    // change therefore wrote a manifest that FAILS its own schema (created_by
    // is required) and silently dropped `repo_id` and `seeded_from`. Losing
    // seeded_from is the one a lecturer would feel: planUnseed and the
    // "Undo seed" button both key on it, so editing one member of a seeded team
    // quietly removed it from the bulk undo.
    //
    // Merge, never replace - the same rule promote-roster follows. Reading
    // first also means an unreadable manifest refuses before any collaborator
    // is touched, rather than leaving GitHub and the control repo disagreeing.
    let existing = null
    try {
      const text = await getRepoContent(token, props.org, config.controlRepo, path)
      if (text) existing = JSON.parse(text)
    } catch {
      existing = null
    }
    if (!existing || typeof existing !== 'object') {
      toast.error(`Could not read ${path}. Nothing was changed.`)
      return
    }

    // Only what this modal actually changes. Everything else - created_by,
    // seeded_from, repo_id, and any field a later version adds - rides along
    // untouched.
    const teamDoc = {
      ...existing,
      members: newMembers,
      vacant: newMembers.length === 0,
    }

    // Heal a manifest the old rebuild damaged instead of refusing it. Every
    // team edited before this fix lost its required `created_by`, so validating
    // without repairing would lock a lecturer out of exactly the teams the bug
    // touched. "lecturer" is what the create path already writes, and it is the
    // honest answer: the original value is gone and nothing can recover it.
    if (typeof teamDoc.created_by !== 'string' || !teamDoc.created_by) {
      teamDoc.created_by = 'lecturer'
    }

    // Validate BEFORE any collaborator write, so a manifest we cannot store
    // never leaves GitHub and the control repo disagreeing about membership.
    const { valid, errors } = await validateAgainst('team', teamDoc)
    if (!valid) {
      toast.error(
        `Refusing to write an invalid team manifest: ${errors.map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ')}`
      )
      return
    }

    // Determine added and removed members
    const removed = oldMembers.filter((m) => !newMembers.some((nm) => nm.toLowerCase() === m.toLowerCase()))
    const added = newMembers.filter((m) => !oldMembers.some((om) => om.toLowerCase() === m.toLowerCase()))

    const repoName = managingTeam.value.repo_name ? managingTeam.value.repo_name.split('/').pop() : null

    // Sync live GitHub collaborators if repo exists
    if (token && repoName) {
      for (const m of removed) {
        await removeCollaborator(token, props.org, repoName, m).catch((e) =>
          console.warn(`Failed to remove collaborator ${m}:`, e)
        )
      }
      for (const m of added) {
        await addCollaborator(token, props.org, repoName, m, 'admin').catch((e) =>
          console.warn(`Failed to add collaborator ${m}:`, e)
        )
      }
    }

    const res = await commitFile(
      token,
      props.org,
      config.controlRepo,
      path,
      JSON.stringify(teamDoc, null, 2) + '\n',
      `Update members for team ${slug} (${props.assignment.id})`
    )
    if (res.ok) {
      await republishTeams(token)
      toast.success(`Team "${managingTeam.value.team_name}" updated successfully.`)
      managingTeam.value = null
      emit('refresh')
    } else {
      toast.error(`Could not update team: HTTP ${res.status}`)
    }
  } catch (e) {
    toast.error(`Error saving team: ${e.message}`)
  } finally {
    saving.value = false
  }
}

async function deleteVacantTeam(team) {
  if (!team) return
  if (team.members && team.members.length > 0) {
    toast.error('Cannot delete team with active members. Remove all members first.')
    return
  }
  if (!window.confirm(`Delete vacant team "${team.team_name || team.team_slug}"? This removes teams/${props.assignment.id}/${team.team_slug}.json from the control repo.`)) {
    return
  }
  saving.value = true
  try {
    const token = getToken()
    const path = `teams/${props.assignment.id}/${team.team_slug}.json`
    const res = await deleteFile(
      token,
      props.org,
      config.controlRepo,
      path,
      `Delete vacant team ${team.team_slug} (${props.assignment.id})`
    )
    if (res.ok) {
      await republishTeams(token)
      toast.success(`Team "${team.team_name || team.team_slug}" deleted successfully.`)
      if (managingTeam.value?.team_slug === team.team_slug) {
        managingTeam.value = null
      }
      emit('refresh')
    } else {
      toast.error(`Could not delete team: HTTP ${res.status}`)
    }
  } catch (e) {
    toast.error(`Error deleting team: ${e.message}`)
  } finally {
    saving.value = false
  }
}
</script>

<style scoped>
.teams-table-component {
  display: flex;
  flex-direction: column;
  gap: var(--space-md);
}

.table-toolbar {
  margin-bottom: var(--space-xs);
}

.search-input-wrapper {
  position: relative;
  max-width: 320px;
  width: 100%;
}

.search-icon {
  position: absolute;
  left: 10px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--text-muted);
}

.table-search {
  padding-left: 32px;
  width: 100%;
}

.team-cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.team-title {
  color: var(--text-primary);
  font-size: 0.9rem;
}

.team-slug {
  font-size: 0.75rem;
  color: var(--text-muted);
}

.members-cell {
  max-width: 260px;
}

.member-pills {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}

.member-pill {
  font-size: 0.75rem;
  background: var(--bg-secondary);
  border: 1px solid var(--border-default);
  padding: 1px 6px;
  border-radius: 4px;
  color: var(--text-secondary);
}

/* Seeded but not yet accepted: dimmed rather than badged, because a whole
   cohort of "pending" pills would drown the members column (DESIGN.md §1.3). */
.member-pill.member-pending {
  color: var(--text-muted);
  border-style: dashed;
}

.member-pending-note {
  margin-top: 4px;
  font-size: 0.7rem;
}

.seeded-note {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: 0.8rem;
  color: var(--text-muted);
}

.commit-count-badge {
  font-size: 0.8rem;
  color: var(--text-secondary);
}

.unassigned-students-list {
  max-height: 180px;
  overflow-y: auto;
  border: 1px solid var(--border-default);
  border-radius: 6px;
  padding: 8px;
  background: var(--bg-secondary);
}

.student-check-item {
  padding: 4px;
  cursor: pointer;
}

.current-members-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.section-label {
  font-weight: 600;
  font-size: 0.85rem;
}

.members-manage-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  background: var(--bg-secondary);
  padding: 8px;
  border-radius: 6px;
  border: 1px solid var(--border-default);
}

.member-manage-row {
  padding: 4px;
  border-bottom: 1px solid var(--border-muted);
}

.member-manage-row:last-child {
  border-bottom: none;
}
</style>
