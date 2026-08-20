<template>
  <div class="teams-table-component">
    <!-- Filter bar & Toolbar -->
    <div class="table-toolbar flex justify-between items-center gap-md">
      <div class="search-input-wrapper">
        <Icon name="search" :size="16" class="search-icon" />
        <input
          v-model="searchQuery"
          type="text"
          placeholder="Filter teams or members…"
          class="form-control table-search"
        />
      </div>

      <div class="toolbar-actions flex items-center gap-sm">
        <button class="btn btn-sm btn-primary btn-with-icon" @click="openCreateTeamModal">
          <Icon name="plus" :size="14" />
          <span>Create Team</span>
        </button>

        <div class="toolbar-stats text-secondary text-sm">
          <span>Showing <strong>{{ filteredTeams.length }}</strong> of <strong>{{ teams.length }}</strong> team(s)</span>
          <span v-if="underCapacityCount > 0" class="badge badge-warning" style="margin-left: 8px;">
            {{ underCapacityCount }} under-capacity
          </span>
        </div>
      </div>
    </div>

    <!-- Empty state -->
    <div v-if="filteredTeams.length === 0" class="empty-state card text-center py-xl">
      <Icon name="users" :size="40" class="status-icon" />
      <p class="text-secondary">No teams match your search filter.</p>
      <button class="btn btn-secondary btn-sm" style="margin-top: 8px;" @click="openCreateTeamModal">
        Create a new team
      </button>
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
            <th v-if="isGitHubActionsAutograde">CI Status</th>
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
                    :title="resolveMemberTooltip(m)"
                  >
                    @{{ m }}
                  </span>
                </div>
                <span v-else class="text-muted text-xs">No members (vacant)</span>
              </div>
            </td>

            <!-- Capacity column -->
            <td>
              <span
                :class="[
                  'badge',
                  team.under_capacity
                    ? 'badge-warning'
                    : team.members.length >= (assignment?.group_config?.max_team_size || 3)
                    ? 'badge-neutral'
                    : 'badge-success'
                ]"
                style="font-size: 0.75rem;"
              >
                {{ team.members ? team.members.length : 0 }}/{{ assignment?.group_config?.max_team_size || 3 }}
                <template v-if="team.under_capacity"> (low)</template>
              </span>
            </td>

            <!-- Repository column -->
            <td>
              <a
                v-if="team.repo_url"
                :href="team.repo_url"
                target="_blank"
                rel="noopener"
                class="repo-link"
              >
                {{ team.repo_name ? team.repo_name.split('/').pop() : team.team_slug }}
              </a>
              <span v-else class="text-muted text-xs">Not created</span>
            </td>

            <!-- Commits column -->
            <td>
              <span v-if="team.commit_count != null" class="commit-count-badge">
                {{ team.commit_count }} commit{{ team.commit_count === 1 ? '' : 's' }}
              </span>
              <span v-else class="text-muted text-xs">-</span>
            </td>

            <!-- Submission Status column -->
            <td>
              <span :class="['badge', statusBadgeClass(team.submission_status)]">
                {{ team.submission_status || 'unknown' }}
              </span>
            </td>

            <!-- CI Status column (Autograding) -->
            <td v-if="isGitHubActionsAutograde">
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
                v-if="team.earned_points != null || team.score"
                type="button"
                class="badge"
                :class="(team.earned_points != null ? team.earned_points >= (team.total_points || 30) : !String(team.score).includes('0/')) ? 'badge-success' : 'badge-warning'"
                @click="openTeamAutogradeModal(team)"
                title="Click to view team test breakdown"
                style="cursor: pointer; border: none; font-size: 0.75rem;"
              >
                {{ team.score || `${team.earned_points}/${team.total_points || 30} pts` }}
              </button>
              <span v-else class="text-muted text-xs">-</span>
            </td>

            <!-- Preserved column -->
            <td>
              <a
                v-if="team.preservation_status === 'preserved'"
                :href="`https://github.com/${org}/pxl-classroom-archive/tree/${encodeURIComponent(`preserved/${assignment.id}/${team.team_slug}`)}`"
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
              <button
                class="btn btn-sm btn-secondary"
                type="button"
                @click="openManageTeamModal(team)"
                title="Manage team members"
              >
                Manage
              </button>
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
          <button class="modal-close" @click="showCreateModal = false">×</button>
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
          <button class="modal-close" @click="managingTeam = null">×</button>
        </header>
        <div class="modal-body flex flex-col gap-md">
          <!-- Current Members list -->
          <div class="current-members-section">
            <label class="section-label">Current Members ({{ manageMembers.length }}/{{ maxTeamSize }})</label>
            <div v-if="manageMembers.length" class="members-manage-list">
              <div v-for="m in manageMembers" :key="m" class="member-manage-row flex justify-between items-center">
                <span>@{{ m }} <small class="text-muted">{{ resolveMemberTooltip(m) }}</small></span>
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
                class="btn btn-sm btn-primary"
                type="button"
                :disabled="!selectedStudentToAdd"
                @click="addMemberToTeam(selectedStudentToAdd)"
              >
                Add
              </button>
            </div>
          </div>

          <footer class="modal-foot flex justify-end gap-sm">
            <button class="btn btn-secondary" type="button" @click="managingTeam = null">Close</button>
            <button class="btn btn-success" type="button" :disabled="saving" @click="saveTeamMembers">
              {{ saving ? 'Saving…' : 'Save Changes' }}
            </button>
          </footer>
        </div>
      </div>
    </div>

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
          <div class="score-banner flex justify-between items-center p-md" :class="activeTeamAutograde.ci_status === 'success' ? 'banner-success' : 'banner-warning'" style="border-radius: var(--radius-sm, 6px); border: 1px solid var(--border-color, #30363d); padding: 12px 16px;">
            <div>
              <div class="text-xs text-secondary uppercase font-semibold">Team Score</div>
              <div class="text-xl font-bold" style="font-size: 1.4rem;">
                {{ activeTeamAutograde.earned_points != null ? `${activeTeamAutograde.earned_points} / ${activeTeamAutograde.total_points || assignment?.autograde?.points_possible || 100} pts` : (activeTeamAutograde.score || activeTeamAutograde.ci_status || 'Graded') }}
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
            <div v-for="t in activeTeamAutograde.tests" :key="t.id" class="test-item-card p-sm" style="border: 1px solid var(--border-color, #30363d); border-radius: var(--radius-sm, 6px); padding: 10px; background: var(--bg-surface, #161b22);">
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
                <pre class="mono text-xs p-xs" style="background: var(--bg-canvas, #0d1117); border-radius: 4px; max-height: 120px; overflow-y: auto; white-space: pre-wrap; margin: 0; padding: 8px;">{{ t.stderr || t.stdout }}</pre>
              </div>
            </div>
          </div>
          <div v-else class="text-secondary text-sm">
            <p v-if="activeTeamAutograde.repo_url" style="margin: 0;">
              View full test runs and workflow logs on GitHub Actions:
              <a :href="`${activeTeamAutograde.repo_url}/actions`" target="_blank" rel="noopener" class="link-btn" style="text-decoration: underline;">
                Open Team GitHub Actions logs →
              </a>
            </p>
          </div>
        </div>

        <footer class="modal-foot flex justify-end gap-sm" style="padding: var(--space-sm) var(--space-md); border-top: 1px solid var(--border-color, #30363d);">
          <button class="btn btn-secondary" type="button" @click="closeTeamAutogradeModal">Close</button>
        </footer>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import Icon from './Icon.vue'
import { getToken } from '../lib/auth.js'
import { commitFile } from '../lib/api.js'
import { config } from '../lib/config.js'
import { toast } from '../lib/toast.js'

const props = defineProps({
  teams: { type: Array, required: true },
  assignment: { type: Object, required: true },
  org: { type: String, required: true },
  roster: { type: Array, default: () => [] },
})

const emit = defineEmits(['refresh'])

const searchQuery = ref('')
const showCreateModal = ref(false)
const managingTeam = ref(null)
const manageMembers = ref([])
const selectedStudentToAdd = ref('')
const saving = ref(false)

const newTeamForm = ref({
  name: '',
  members: [],
})

const maxTeamSize = computed(() => props.assignment?.group_config?.max_team_size || 3)

const autogradeEnabled = computed(() => props.assignment?.autograde?.enabled === true)

const isGitHubActionsAutograde = computed(
  () => autogradeEnabled.value && props.assignment?.autograde?.execution_environment === 'github_actions'
)

const activeTeamAutograde = ref(null)

function openTeamAutogradeModal(team) {
  activeTeamAutograde.value = team
}

function closeTeamAutogradeModal() {
  activeTeamAutograde.value = null
}

const underCapacityCount = computed(() =>
  props.teams.filter((t) => t.under_capacity).length
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
  const q = searchQuery.value.toLowerCase().trim()
  if (!q) return props.teams
  return props.teams.filter(
    (t) =>
      t.team_name?.toLowerCase().includes(q) ||
      t.team_slug?.toLowerCase().includes(q) ||
      (t.members || []).some((m) => m.toLowerCase().includes(q))
  )
})

function resolveMemberTooltip(login) {
  const r = (props.roster || []).find((s) => s.github_login?.toLowerCase() === login.toLowerCase())
  if (r) {
    return `${r.full_name || login} (${r.student_number || r.email || ''})`
  }
  return `@${login}`
}

function statusBadgeClass(status) {
  switch (status) {
    case 'on-time':
      return 'badge-success'
    case 'late':
      return 'badge-warning'
    case 'no-submission':
      return 'badge-neutral'
    default:
      return 'badge-neutral'
  }
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
    const teamDoc = {
      schema_version: 1,
      assignment_id: props.assignment.id,
      team_slug: slug,
      team_name: managingTeam.value.team_name,
      members: manageMembers.value,
      max_members: maxTeamSize.value,
      created_at: managingTeam.value.created_at || new Date().toISOString(),
      vacant: manageMembers.value.length === 0,
      repo_name: managingTeam.value.repo_name,
      repo_id: managingTeam.value.repo_id,
      repo_url: managingTeam.value.repo_url,
    }

    const path = `teams/${props.assignment.id}/${slug}.json`
    const res = await commitFile(
      token,
      props.org,
      config.controlRepo,
      path,
      JSON.stringify(teamDoc, null, 2) + '\n',
      `Update members for team ${slug} (${props.assignment.id})`
    )
    if (res.ok) {
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
