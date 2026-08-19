<template>
  <div class="teams-table-component">
    <!-- Filter bar -->
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

      <div class="toolbar-stats text-secondary text-sm">
        <span>Showing <strong>{{ filteredTeams.length }}</strong> of <strong>{{ teams.length }}</strong> team(s)</span>
        <span v-if="underCapacityCount > 0" class="badge badge-warning" style="margin-left: 8px;">
          {{ underCapacityCount }} under-capacity
        </span>
      </div>
    </div>

    <!-- Empty state -->
    <div v-if="filteredTeams.length === 0" class="empty-state card text-center py-xl">
      <Icon name="users" :size="40" class="status-icon" />
      <p class="text-secondary">No teams match your search filter.</p>
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
            <th>Preserved</th>
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
                <span v-else class="text-muted text-xs">No members</span>
              </div>
            </td>

            <!-- Capacity column -->
            <td>
              <span
                :class="[
                  'badge',
                  team.under_capacity
                    ? 'badge-warning'
                    : team.members.length >= (assignment.group_config?.max_team_size || 3)
                    ? 'badge-neutral'
                    : 'badge-success'
                ]"
                style="font-size: 0.75rem;"
              >
                {{ team.members ? team.members.length : 0 }}/{{ assignment.group_config?.max_team_size || 3 }}
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

            <!-- Preserved column -->
            <td>
              <span v-if="team.preservation_status === 'preserved'" class="badge badge-success" title="Preserved in archive">
                Preserved
              </span>
              <span v-else-if="team.lock_down_at" class="badge badge-neutral" title="Locked down">
                Locked
              </span>
              <span v-else class="text-muted text-xs">-</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import Icon from './Icon.vue'

const props = defineProps({
  teams: { type: Array, required: true },
  assignment: { type: Object, required: true },
  org: { type: String, required: true },
  roster: { type: Array, default: () => [] },
})

const searchQuery = ref('')

const underCapacityCount = computed(() =>
  props.teams.filter((t) => t.under_capacity).length
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
</style>
