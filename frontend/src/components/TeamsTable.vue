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
            On time ({{ onTimeTeamsCount }})
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
        <HelpButton topic="group-assignments" label="teams" />
        <button class="btn btn-sm btn-secondary btn-with-icon" @click="showSeedModal = true" title="Carry an existing grouping into this assignment">
          <Icon name="users" :size="14" />
          <span>Copy teams</span>
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
          <span>Undo copy ({{ removableSeededTeams.length }})</span>
        </button>

        <div class="toolbar-stats text-secondary text-sm">
          <span>Showing <strong>{{ filteredTeams.length }}</strong> of <strong>{{ teams.length }}</strong> team(s)</span>
        </div>
      </div>
    </div>

    <!-- Whether students see a rename, from the page they are served (review
         2026-10-14, PG12): read when the teams load and on Check again. -->
    <p v-if="namesLine" class="seeded-note" data-note="renamed-served" :data-state="namesServed.state">
      <Icon :name="namesServed.state === 'current' ? 'check' : 'alert-circle'" :size="13" />
      <span>
        {{ namesLine }}
        <button type="button" class="btn-link" :disabled="checkingNames" @click="checkRenamedNames">
          {{ checkingNames ? 'Checking…' : 'Check again' }}
        </button>
        <template v-if="namesServed.state === 'stale' && !namesAsked">
          ·
          <button type="button" class="btn-link" :disabled="checkingNames" @click="rebuildForNames">{{ rebuildingNames ? 'Updating…' : 'Update the student pages' }}</button>
        </template>
      </span>
    </p>
    <!-- Provenance: one line for the whole table, not a badge on every row -->
    <p v-if="seededSummary" class="seeded-note">
      <Icon name="users" :size="13" />
      <span>{{ seededSummary }}</span>
    </p>
    <p v-if="unassignedStudents.length" class="seeded-note">
      <Icon name="alert-circle" :size="13" />
      <span>
        {{ unassignedStudents.length }} student{{ unassignedStudents.length === 1 ? '' : 's' }} of this
        assignment {{ unassignedStudents.length === 1 ? 'has' : 'have' }} no team:
        {{ unassignedPreview }}
      </span>
    </p>
    <!-- Students the roster admits who have no GitHub username yet. A team
         stores usernames, so they cannot be placed; they are named here and in
         the pickers rather than left out, and the one thing that fixes it is
         offered beside the sentence (BETA-UX.md, decided 2026-10-04). -->
    <p v-if="waitingStudents.length" class="seeded-note" data-note="waiting">
      <Icon name="mail" :size="13" />
      <span>
        {{ waitingStudents.length }} student{{ waitingStudents.length === 1 ? '' : 's' }}
        can't be placed yet: no GitHub username.
        <template v-if="confirmLink">
          Send them the confirm-email link; they appear here once they confirm.
        </template>
        <template v-else>
          Their confirm-email link exists once the assignment is published.
        </template>
      </span>
      <button v-if="confirmLink" type="button" class="btn-link" @click="copyConfirmLink">
        {{ confirmCopied ? 'Copied' : 'Copy confirm-email link' }}
      </button>
    </p>
    <p v-if="assignment?.state === 'draft' && teams.length" class="seeded-note">
      <Icon name="eye-off" :size="13" />
      <span>Draft: students cannot see these teams until the assignment is published.</span>
    </p>

    <!-- Empty state -->
    <div v-if="filteredTeams.length === 0" class="empty-state card text-center py-xl">
      <Icon name="users" :size="40" class="status-icon" />
      <template v-if="teams.length === 0">
        <p class="text-secondary">
          No teams yet. Copy the teams of an earlier assignment, so students keep the group they
          already worked in, or let students form their own when they accept.
        </p>
        <div class="flex gap-sm justify-center" style="margin-top: 8px;">
          <button class="btn btn-secondary btn-sm" @click="showSeedModal = true">
            Copy the teams of an earlier assignment
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
          <!-- The Progress table's columns and cells where they are the same
               thing (asked 2026-10-20): every column sorts, the repository is
               an icon, Last commit is there, and preservation is the archive
               link under the status rather than a column of its own. -->
          <tr>
            <SortableTh :sort="teamSort" col="team">Team</SortableTh>
            <SortableTh :sort="teamSort" col="members">Members</SortableTh>
            <SortableTh :sort="teamSort" col="capacity">Capacity</SortableTh>
            <SortableTh :sort="teamSort" col="repo">Repo</SortableTh>
            <SortableTh :sort="teamSort" col="last_commit">Last commit</SortableTh>
            <SortableTh :sort="teamSort" col="commit_count" class="num" title="Commits"><span aria-hidden="true">#</span><span class="sr-only">Commits</span></SortableTh>
            <SortableTh :sort="teamSort" col="submission_status">Status</SortableTh>
            <SortableTh v-if="autogradeEnabled" :sort="teamSort" col="score">Score</SortableTh>
            <th class="col-actions"><span class="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="team in sortedTeams" :key="team.team_slug">
            <!-- Team column -->
            <td>
              <div class="team-cell">
                <strong class="team-title">{{ team.team_name }}</strong>
                <code class="team-slug">{{ team.team_slug }}</code>
                <span v-if="teamNeedsJoinCode(assignment.group_config, team)" class="team-code text-xs">
                  Join code <code data-join-code>{{ formatJoinCode(team.join_code) || 'unreadable' }}</code>
                </span>
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
                    {{ memberLabel(m) }}
                  </span>
                </div>
                <span v-else class="text-muted text-xs">No members (vacant)</span>
                <span v-if="pendingCount(team)" class="status-indicator member-pending-note">
                  <span class="status-dot dot-warning"></span>
                  <span>{{ pendingCount(team) }} not accepted yet</span>
                </span>
              </div>
            </td>

            <!-- Capacity column. Amber below the minimum size ("needs a look"),
                 green otherwise (DESIGN.md §4: "the state you wanted"). A full
                 team was grey, which §4 keeps for "not started, unknown" -
                 and that it is full is what "3/3" already says. -->
            <td>
              <span class="status-indicator">
                <span class="status-dot" :class="team.under_capacity ? 'dot-warning' : 'dot-success'"></span>
                <span class="mono text-xs">{{ team.members ? team.members.length : 0 }}/{{ maxTeamSize }}<template v-if="team.under_capacity"> (low)</template></span>
              </span>
            </td>

            <td class="col-repo">
              <RepoIconLink :url="team.repo_url" :name="team.repo_name || team.team_slug" />
            </td>

            <td class="col-last-commit">
              <LastCommitCell :row="teamCommitRow(team, students)" :timezone="assignment?.timezone || null" />
            </td>

            <td class="num">
              <span v-if="team.commit_count != null">{{ team.commit_count.toLocaleString() }}</span>
              <span v-else class="text-muted">-</span>
            </td>

            <!-- Submission Status column, and under it where the team's work
                 was preserved, as on the Progress table. -->
            <td>
              <span class="status-indicator">
                <span class="status-dot" :class="team.submission_status === 'on-time' ? 'dot-success' : (team.submission_status === 'late' ? 'dot-warning' : 'dot-neutral')"></span>
                <span class="text-sm">{{ submissionLabel(team.submission_status || 'unknown') }}</span>
              </span>
              <ArchiveLink
                v-if="team.preservation_status === 'preserved'"
                :url="teamArchiveUrl(team)"
                :sha="team.preserved_sha"
              />
            </td>

            <!-- No CI status column: the run's status is on the Grading tab,
                 and the score below opens the team's results. -->
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

            <!-- Actions column. One button: an empty team is deleted from
                 Manage, where its emptiness is on screen. A solid red Delete on
                 every empty row was a destructive action as a bare button,
                 which DESIGN.md §1.2 keeps out of tables. -->
            <td class="col-actions">
              <button
                class="btn btn-sm btn-secondary"
                type="button"
                @click="openManageTeamModal(team)"
              >
                Manage
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Modal: Create Team -->
    <div v-if="showCreateModal" class="modal-overlay" @click.self="showCreateModal = false" @keydown.esc="showCreateModal = false">
      <div class="modal card" role="dialog" aria-modal="true" aria-labelledby="create-team-title">
        <header class="modal-head flex justify-between items-center">
          <h3 id="create-team-title">Create a team in {{ assignmentTitle }}</h3>
          <button class="modal-close" type="button" @click="showCreateModal = false" aria-label="Close">×</button>
        </header>
        <form @submit.prevent="submitCreateTeam" class="modal-form">
          <div class="modal-body flex flex-col gap-md">
            <div class="form-group">
              <label for="create-team-name">Team Name <span class="req">*</span></label>
              <input
                id="create-team-name"
                ref="createNameEl"
                v-model="newTeamForm.name"
                type="text"
                class="form-control"
                placeholder="e.g. Team Phoenix"
                required
              />
              <span class="form-hint text-xs text-muted">
                Team slug: <code>{{ computedNewSlug || 'team-slug' }}</code>
              </span>
              <span v-if="newSlugProblem" class="field-error-msg" role="alert" data-new-slug-problem>{{ newSlugProblem }}</span>
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
                <label
                  v-for="s in waitingStudents"
                  :key="waitingKey(s)"
                  class="student-check-item student-waiting flex items-center gap-xs text-sm"
                >
                  <input type="checkbox" disabled />
                  <span>{{ waitingName(s) }} <span class="text-xs">no GitHub username yet</span></span>
                </label>
                <div v-if="unassignedStudents.length === 0 && waitingStudents.length === 0" class="text-muted text-xs">
                  Every student of this assignment is already in a team.
                </div>
              </div>
              <span class="form-hint text-xs text-secondary">
                Selected {{ newTeamForm.members.length }}/{{ maxTeamSize }} members
              </span>
            </div>
          </div>

          <footer class="modal-foot flex justify-end gap-sm">
            <button class="btn btn-secondary" type="button" @click="showCreateModal = false">Cancel</button>
            <button class="btn btn-primary" type="submit" :disabled="!computedNewSlug || !!newSlugProblem || saving">
              {{ saving ? 'Creating…' : 'Create Team' }}
            </button>
          </footer>
        </form>
      </div>
    </div>

    <!-- Modal: Manage Team -->
    <div v-if="managingTeam" class="modal-overlay" @click.self="managingTeam = null" @keydown.esc="managingTeam = null">
      <div ref="manageDialogEl" class="modal card" role="dialog" aria-modal="true" aria-labelledby="manage-team-title" tabindex="-1">
        <header class="modal-head flex justify-between items-center">
          <h3 id="manage-team-title">Manage {{ managingTeam.team_name }}</h3>
          <button class="modal-close" type="button" @click="managingTeam = null" aria-label="Close">×</button>
        </header>
        <div class="modal-body flex flex-col gap-md">
          <!-- RENAME, while nobody in the team has accepted (asked 2026-10-12):
               until then nothing hangs on the name, and the repository the
               team will get is named after it. After that it says why not. -->
          <div class="team-rename" data-team-rename>
            <template v-if="renaming">
              <label class="section-label" for="team-rename-input">New name</label>
              <div class="flex gap-xs items-center">
                <input
                  id="team-rename-input"
                  ref="renameInput"
                  v-model="renameName"
                  type="text"
                  maxlength="100"
                  class="team-rename-input"
                  :disabled="saving"
                  @keydown.enter.prevent="saveRename"
                  @keydown.esc.stop.prevent="cancelRename"
                />
                <button class="btn btn-secondary btn-sm" type="button" :disabled="saving || !renameName.trim()" @click="saveRename">{{ saving ? 'Renaming…' : 'Rename' }}</button>
                <button class="btn-link" type="button" :disabled="saving" @click="cancelRename">Cancel</button>
              </div>
              <small class="text-muted">
                Its repository will be called <code>{{ renameRepoPreview }}</code> when the first member accepts.
              </small>
              <div v-if="renameError" class="field-error-msg" role="alert">{{ renameError }}</div>
            </template>
            <small v-else-if="renameBlocked" class="text-muted">Cannot be renamed: {{ renameBlocked }}.</small>
            <small v-else-if="memberEditsPending" class="text-muted">Save or undo the member changes first, then rename.</small>
            <button v-else ref="renameButton" class="btn-link" type="button" @click="startRename">Rename team</button>
          </div>

          <!-- Current Members list -->
          <div class="current-members-section">
            <label class="section-label">Current Members ({{ manageMembers.length }}/{{ maxTeamSize }})</label>
            <div v-if="manageMembers.length" class="members-manage-list">
              <div v-for="m in manageMembers" :key="m" class="member-manage-row flex justify-between items-center gap-sm">
                <!-- Who, then where they stand: the same rule as the table's
                     dimmed pills, said in words, because this is where a
                     lecturer decides whether moving them costs anything. -->
                <div class="member-manage-who">
                  <div class="flex items-center gap-xs flex-wrap">
                    <span class="member-login font-semibold" :class="{ mono: !memberEmail(m) }" :title="resolveMemberTooltip(m)">{{ memberLabel(m) }}</span>
                    <span v-if="resolveMemberDisplayName(m)" class="text-secondary text-xs">({{ resolveMemberDisplayName(m) }})</span>
                  </div>
                  <span v-if="memberStatusFor(m)" class="status-indicator text-xs" data-member-status>
                    <span class="status-dot" :class="`dot-${memberStatusFor(m).tone}`"></span>
                    <span>{{ memberStatusFor(m).text }}</span>
                  </span>
                </div>
                <div class="flex gap-xs items-center">
                  <!-- One gesture, both manifests. Removing here and adding in
                       the other team's modal is two commits with a window in
                       between where the student is in no team at all. -->
                  <select
                    v-if="moveTargets.length"
                    class="form-control move-select"
                    :disabled="saving"
                    :aria-label="`Move @${m} to another team`"
                    @change="moveMemberTo(m, $event.target.value); $event.target.value = ''"
                  >
                    <option value="">Move to…</option>
                    <option v-for="t in moveTargets" :key="t.team_slug" :value="t.team_slug">
                      {{ t.team_name }} ({{ (t.members || []).length }}/{{ maxTeamSize }})
                    </option>
                  </select>
                  <!-- Plain, not red: it takes them off the list below and
                       nothing happens until Save. -->
                  <button class="btn btn-xs btn-secondary" type="button" @click="removeMemberFromTeam(m)">
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
                <option v-for="s in waitingStudents" :key="waitingKey(s)" disabled>
                  {{ waitingName(s) }} - no GitHub username yet
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
        </div>

        <footer class="modal-foot flex justify-between items-center gap-sm">
          <!-- Only an empty team can be deleted, and only from here, where its
               emptiness is on screen. A subtle outline, confirmed in a dialog
               (DESIGN.md §1.2). Judged on the STORED members, not the list
               being edited: emptying the list and deleting before Save would
               delete a team whose file still names students. -->
          <button
            v-if="!(managingTeam.members || []).length && manageMembers.length === 0"
            class="btn btn-danger-outline btn-sm"
            type="button"
            :disabled="saving"
            @click="deleteVacantTeam(managingTeam)"
          >
            Delete team
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

    <!-- Modal: Copy teams from an existing grouping -->
    <SeedTeamsModal
      v-if="showSeedModal"
      :org="org"
      :assignment="assignment"
      :assignments="assignments"
      @close="showSeedModal = false"
      @seeded="emit('refresh')"
    />

    <!-- Team autograding results. Same component AssignmentDetailView uses:
         this markup was duplicated there, byte-for-byte apart from the item
         name and comments each copy had reworded on its own. -->
    <AutogradeResultsModal
      v-if="activeTeamAutograde"
      :item="activeTeamAutograde"
      :subject-label="activeTeamAutograde.team_name"
      score-label="Team Score"
      @close="closeTeamAutogradeModal"
    >
      <template #title>
        Team Autograding: <strong>{{ activeTeamAutograde.team_name }}</strong> (<code>{{ activeTeamAutograde.team_slug }}</code>)
      </template>
    </AutogradeResultsModal>
  </div>
</template>

<script setup>
import { ref, computed, nextTick, onMounted, onBeforeUnmount, watch } from 'vue'
import Icon from './Icon.vue'
import HelpButton from './HelpButton.vue'
import { membersWithRecords, planTeamRename, renameBlocker, renameRefusalAt, teamSlug } from '../../../lib/team-rename.mjs'
import { teamNameProblem } from '../../../lib/public-text.mjs'
import { changedSinceRead, contentsAt as contentsAtCommit, unseedRefusalAt } from '../../../lib/team-write-guard.mjs'
import { decodeBase64 as decodeBase64Text } from '../../../lib/grade-dispatch.mjs'
import AutogradeResultsModal from './AutogradeResultsModal.vue'
import SortableTh from './SortableTh.vue'
import RepoIconLink from './RepoIconLink.vue'
import LastCommitCell from './LastCommitCell.vue'
import ArchiveLink from './ArchiveLink.vue'
import { useTableSort } from '../composables/useTableSort.js'
import { sortRows, timeValue } from '../lib/table-sort.js'
import { commitTime, teamCommitRow } from '../lib/last-commit.js'
import { askConfirm } from '../lib/confirm.js'
import { teamPath, teamsDir, repositoryPath, acceptancePath, repositoriesDir, acceptancesDir, lockdownRecordPath, overridesDir, unlockedDir } from '../../../lib/control-layout.mjs'
import { grantableAfterLock } from '../../../lib/permission-change.mjs'
import { deadlineVariableValue, writeDeadlineVariable } from '../../../lib/deadline-variable.mjs'
import { sameLogin } from '../../../lib/github-login.mjs'
import { repositoryNameFor } from '../../../lib/repo-name.mjs'
import { formatJoinCode, teamNeedsJoinCode } from '../../../lib/team-join-code.mjs'
import { planMemberRecordChanges, teamRepository } from '../../../lib/team-member-records.mjs'
import SeedTeamsModal from './SeedTeamsModal.vue'
import { getToken } from '../lib/auth.js'
import { submissionLabel } from '../lib/status-labels.js'
import {
  commitFile,
  commitFiles,
  deleteFile,
  getRepoContent,
  ghApi,
  listRepoDir,
  addCollaborator,
  removeCollaborator,
  githubAccountExists,
  listClaims,
} from '../lib/api.js'
import { indexClaims, bindingForEntry } from '../lib/claim-bindings.js'
import { confirmationUrl, linkSecretFrom, inviteTeamsUrl } from '../lib/invite.js'
import { renamedTeamsServed, renamedTeamsLine } from '../lib/team-names-served.js'
import { copyText } from '../lib/clipboard.js'
import {
  moveConfirmation,
  deleteConfirmation,
  memberStatus,
  revokeOutcome,
  notAnAccountNote,
  membersEdited,
} from '../lib/team-edit.js'
import { republishStudentPages } from '../lib/student-pages.js'
import { validateAgainst } from '../lib/validate.js'
import { config } from '../lib/config.js'
import { maxTeamSize as teamMaxSize } from '../../../lib/group-config.mjs'
import { toast } from '../lib/toast.js'
import { planUnseed } from '../../../lib/seed-teams.mjs'
import { teamCandidates } from '../../../lib/team-candidates.mjs'
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
// Focus goes into a dialog when it opens, so Escape (on the overlay) reaches
// it, and back to whatever opened it when it closes - from any of the places
// that close it, hence watched rather than set beside each one.
const createNameEl = ref(null)
const manageDialogEl = ref(null)
let dialogOpener = null
function followDialog(open, focusInside) {
  if (open) {
    dialogOpener = document.activeElement
    nextTick(() => focusInside()?.focus())
  } else if (dialogOpener) {
    const back = dialogOpener
    dialogOpener = null
    nextTick(() => { if (back.isConnected) back.focus() })
  }
}
watch(showCreateModal, (open) => followDialog(open, () => createNameEl.value))
watch(() => Boolean(managingTeam.value), (open) => followDialog(open, () => manageDialogEl.value))
const manageMembers = ref([])
const selectedStudentToAdd = ref('')
const saving = ref(false)

const newTeamForm = ref({
  name: '',
  members: [],
})

const maxTeamSize = computed(() => teamMaxSize(props.assignment?.group_config))
// What a grant from this tab gives, which is what provisioning gives: the
// assignment's setting, absent meaning admin. Both grants here were the literal
// 'admin' whatever the lecturer had chosen.
const studentPermission = computed(() => props.assignment?.student_permission || 'admin')

// Same rule as AssignmentDetailView: the Score column keys on grades EXISTING,
// not on the assignment declaring autograding here. Grades produced by a
// workflow that shipped inside the template repository are still grades, and a
// column that can only ever be blank is C4.
const hasGrades = computed(() => (props.teams || []).some((t) => t.earned_points != null))
const autogradeEnabled = computed(() => hasGrades.value)

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

// WHAT THE REPORT ITSELF SAYS, for Rename (review 2026-10-14, P2-16). With no
// student rows, hasAccepted above answers yes for everyone - the cautious
// answer before a move or a delete - and so refused every rename as "has
// accepted" while nobody had: under open enrolment the report has no rows
// until somebody accepts, which is when a misnamed team is fixed. Rename reads
// the acceptance records again at the click (`membersWithRecords`), and those
// are the evidence; here only a row that says so blocks it.
function reportSaysAccepted(login) {
  if (props.assignment?.state === 'draft') return false
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
  const logins = unassignedStudents.value.map((s) => memberLabel(s.github_login))
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

// Acceptance's own rule for a typed name (lib/team-rename.mjs `teamSlug`).
const computedNewSlug = computed(() => teamSlug(newTeamForm.value.name))

// Why the new team cannot have that slug, from what the page shows: a team
// has it, or had it until a rename - a page loaded before that rename still
// sends it, and acceptance takes it as the renamed team (review 2026-10-14).
const newSlugProblem = computed(() => {
  const slug = computedNewSlug.value
  if (!slug) return ''
  // Published on every student page (lib/public-text.mjs).
  const unpublishable = teamNameProblem(newTeamForm.value.name)
  if (unpublishable) return unpublishable
  const teams = props.teams || []
  if (teams.some((t) => t.team_slug === slug)) return `A team called ${slug} already exists.`
  const was = teams.find((t) => (t.renamed_from || []).includes(slug))
  if (was) return `"${was.team_name || was.team_slug}" was called ${slug} until it was renamed, so the name stays with it.`
  return ''
})

// Who confirmed which address, read only when somebody in this assignment's
// cohort has no GitHub username on the roster: the confirm-email link records
// the username in a claim and leaves the roster row as it was, so without this
// a student who confirmed would still be "no GitHub username yet" here.
// A failed read leaves them waiting, which is where they were.
//
// Read again on every load of the page's data (the roster prop is a new array
// each time), so Refresh is what "they appear here once they confirm" means.
// Read once per visit, it would have promised that and not done it (DESIGN.md
// §1.5).
const claimIndex = ref(null)
let claimsRead = 0
async function loadClaims() {
  if (!(props.roster || []).some((r) => !r?.github_login && r?.email)) return
  const token = getToken()
  if (!token) return
  const mine = ++claimsRead
  try {
    const { records } = await listClaims(token, props.org, config.controlRepo)
    if (mine === claimsRead) claimIndex.value = indexClaims(records)
  } catch {
    // Keep what was known: a failed read is not "nobody confirmed".
  }
}
onMounted(loadClaims)
watch(() => props.roster, loadClaims)

const loginFor = (row) => (claimIndex.value ? bindingForEntry(row, claimIndex.value).login : null)

// THIS ASSIGNMENT'S students, never the whole roster: the roster is the
// organization's, and offering all of it let a lecturer place someone in a team
// who was then refused at acceptance (lib/team-candidates.mjs).
const candidates = computed(() =>
  teamCandidates({
    assignment: props.assignment,
    roster: props.roster,
    accepted: props.students,
    teams: props.teams,
    loginFor,
  })
)
const unassignedStudents = computed(() => candidates.value.unassigned)
const waitingStudents = computed(() => candidates.value.waiting)
const waitingName = (s) => s.full_name || s.email || s.student_number || 'A student'
const waitingKey = (s) => `${s.email || ''}|${s.student_number || ''}|${s.full_name || ''}`

const assignmentTitle = computed(() => props.assignment?.title || props.assignment?.id || 'this assignment')

// The confirm-email link is minted with the invitation, at publish; a draft
// has none. Read from the assignment, never fetched in the click: a copy after
// an `await` is refused by Firefox (CLAUDE.md, the clipboard rule).
const confirmLink = computed(() => {
  if (props.assignment?.state !== 'published') return null
  const secret = linkSecretFrom(props.assignment)
  return secret ? confirmationUrl(props.org, secret) : null
})
const confirmCopied = ref(false)
let confirmCopiedTimer = null
async function copyConfirmLink() {
  if (!confirmLink.value) return
  if (!(await copyText(confirmLink.value))) {
    toast.error('Could not copy the link')
    return
  }
  confirmCopied.value = true
  clearTimeout(confirmCopiedTimer)
  confirmCopiedTimer = setTimeout(() => { confirmCopied.value = false }, 2000)
  toast.success('Confirm-email link copied')
}
onBeforeUnmount(() => clearTimeout(confirmCopiedTimer))

function memberStatusFor(login) {
  return memberStatus({
    draft: props.assignment?.state === 'draft',
    known: (props.students || []).length > 0,
    accepted: hasAccepted(login),
    teamHasRepo: Boolean(teamRepository(managingTeam.value, props.org)),
  })
}

/**
 * Remove one collaborator and say how it ended (lib team-edit.js
 * `revokeOutcome`). GitHub answers a username that is not an account with 403,
 * the same as a missing permission, so a 403 asks GitHub whether the account
 * exists before it is reported as a failure.
 */
async function revokeAccess(token, repo, login) {
  const res = await removeCollaborator(token, props.org, repo, login)
  const exists = res?.status === 403 ? await githubAccountExists(token, login) : null
  return { outcome: revokeOutcome(res, exists), status: res?.status }
}

/** A failed grant, named for what it is when the username is not an account. */
async function grantProblem(token, repo, login, res) {
  const exists = await githubAccountExists(token, login)
  return exists === false
    ? `@${login} is not a GitHub account, so ${repo} could not be shared with them`
    : `could not give @${login} access to ${repo} (HTTP ${res?.status ?? '?'})`
}

const filteredTeams = computed(() => {
  let list = props.teams
  const q = searchQuery.value.toLowerCase().trim()
  if (q) {
    list = list.filter(
      (t) =>
        t.team_name?.toLowerCase().includes(q) ||
        t.team_slug?.toLowerCase().includes(q) ||
        (t.members || []).some((m) => m.toLowerCase().includes(q) || memberEmail(m).toLowerCase().includes(q))
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

// Sorted on any column, as the Progress table is (lib/table-sort.js). Members
// sort on the first one the cell shows, by the name it shows them under;
// Capacity on how many there are.
const teamSort = useTableSort('team')
const TEAM_SORT_VALUES = {
  team: (t) => t.team_name || t.team_slug,
  members: (t) => ((t.members || []).length ? memberLabel(t.members[0]) : null),
  capacity: (t) => (t.members || []).length,
  repo: (t) => (t.repo_name ? t.repo_name.split('/').pop() : null),
  last_commit: (t) => timeValue(commitTime(teamCommitRow(t, props.students))),
  commit_count: (t) => t.commit_count ?? null,
  submission_status: (t) => t.submission_status || null,
  score: (t) => t.earned_points ?? null,
}
const sortedTeams = computed(() => {
  const valueOf = TEAM_SORT_VALUES[teamSort.sortKey.value]
  return valueOf ? sortRows(filteredTeams.value, valueOf, teamSort.sortAsc.value) : filteredTeams.value
})

// The roster row behind each member: by the row's own login, or by the login
// a claim binds to a row that has none - a student placed after confirming
// their address is in a team under a login the roster does not carry.
const rosterByLogin = computed(() => {
  const map = new Map()
  for (const row of props.roster || []) {
    const login = row?.github_login || loginFor(row)
    if (login) map.set(String(login).toLowerCase(), row)
  }
  return map
})
const studentByLogin = computed(
  () => new Map((props.students || []).filter((s) => s?.github_login).map((s) => [s.github_login.toLowerCase(), s])),
)
const rosterRowOf = (login) => rosterByLogin.value.get(String(login || '').toLowerCase()) || null

/**
 * A member is named by their email address where one is known (asked
 * 2026-10-05): the address is how a lecturer knows a student, the GitHub
 * username often is not. The roster's address first; else the one the student
 * confirmed. The username stays in the title, and is the name where there is
 * no address.
 */
function memberEmail(login) {
  const k = String(login || '').toLowerCase()
  return rosterByLogin.value.get(k)?.email || studentByLogin.value.get(k)?.claimed_email || ''
}
function memberLabel(login) {
  return memberEmail(login) || `@${login}`
}

function resolveMemberTooltip(login) {
  const r = rosterRowOf(login)
  return [r?.full_name, r?.student_number, `@${login}`].filter(Boolean).join(' · ')
}

function resolveMemberDisplayName(login) {
  const r = rosterRowOf(login)
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
  renaming.value = false
  renameError.value = ''
}

/**
 * A reader of the control repo AT ONE COMMIT, for a write's precondition
 * (lib/gittree.mjs): the contents API's answer, null for a 404, a throw for
 * anything it could not read - which refuses the write rather than passing it.
 * lib/team-write-guard.mjs `contentsAt`, which the seed dialog and the CLI use.
 */
function contentsAt(request, parentSha) {
  return contentsAtCommit(request, parentSha, props.org, config.controlRepo)
}

// --- Rename (lib/team-rename.mjs decides) ---------------------------------
const renaming = ref(false)
const renameName = ref('')
const renameError = ref('')
const renameInput = ref(null)
const renameButton = ref(null)

/** Why the open team cannot be renamed, from what the page shows; asked again at the click. */
const renameBlocked = computed(() =>
  managingTeam.value ? renameBlocker(managingTeam.value, (m) => reportSaysAccepted(m), memberLabel) : null,
)

// Adds or removes made in Manage and not saved yet. A move and a rename both
// close Manage and write from what is stored, so either would drop them
// unasked (review 2026-10-14): one thing at a time.
const memberEditsPending = computed(() =>
  Boolean(managingTeam.value) && membersEdited(managingTeam.value.members, manageMembers.value))

// The name acceptance will give it (lib/repo-name.mjs); a pattern naming
// `{github_login}` too takes the first member's, not known yet.
const renameRepoPreview = computed(() =>
  repositoryNameFor(props.assignment?.repository_name_pattern, { teamSlug: teamSlug(renameName.value) || '…', login: '…' }),
)

async function startRename() {
  renameName.value = managingTeam.value?.team_name || ''
  renameError.value = ''
  renaming.value = true
  await nextTick()
  renameInput.value?.focus()
  renameInput.value?.select()
}

async function cancelRename() {
  renaming.value = false
  renameError.value = ''
  // The input that had focus is gone; give it back to what opened it.
  await nextTick()
  renameButton.value?.focus()
}

/**
 * One commit: the manifest under its new slug, the old file removed - after
 * reading both at the click, so a student who accepted meanwhile, or an empty
 * team already holding the new name, stops it with nothing written.
 */
async function saveRename() {
  const team = managingTeam.value
  if (!team || saving.value) return
  if (memberEditsPending.value) {
    renameError.value = 'Save or undo the member changes first, then rename. Nothing was changed.'
    return
  }
  renameError.value = ''
  saving.value = true
  try {
    const token = getToken()
    const id = props.assignment.id
    // getRepoContent: null for a file that is not there, a throw for one that
    // could not be read - so an unreadable answer stops the rename (below)
    // rather than reading as "nobody" or "free".
    const read = async (path) => {
      const text = await getRepoContent(token, props.org, config.controlRepo, path)
      return text ? JSON.parse(text) : null
    }
    const storedText = await getRepoContent(token, props.org, config.controlRepo, teamPath(id, team.team_slug))
    const stored = storedText ? JSON.parse(storedText) : null
    if (!stored) {
      renameError.value = 'This team is no longer there. Nothing was changed.'
      return
    }
    // Who accepted since the page loaded: a record is the evidence, matched by
    // login as GitHub spells it (acceptance files a record under that spelling).
    // The same question the commit is asked again below (membersWithRecords).
    const listed = []
    for (const dir of [repositoriesDir(id), acceptancesDir(id)]) {
      try {
        listed.push(...(await listRepoDir(token, props.org, config.controlRepo, dir)))
      } catch (e) {
        if (e?.status !== 404) throw e
      }
    }
    const recorded = membersWithRecords(listed, stored.members || [])
    const others = (props.teams || []).filter((t) => t.team_slug !== team.team_slug)
    const plan = planTeamRename({
      team: stored,
      newName: renameName.value,
      assignmentId: id,
      otherSlugs: others.map((t) => t.team_slug),
      reservedSlugs: others.flatMap((t) => t.renamed_from || []),
      accepted: (m) => reportSaysAccepted(m) || recorded.includes(m),
      label: memberLabel,
    })
    if (!plan.ok) {
      renameError.value = `Not renamed: ${plan.reason}. Nothing was changed.`
      return
    }
    // A team everybody left is not on this page, and its file still holds the name.
    if (plan.slug !== stored.team_slug && (await read(teamPath(id, plan.slug)))) {
      renameError.value = `Not renamed: this assignment already has a team called ${plan.slug}, which may be one everybody left. Nothing was changed.`
      return
    }
    const { valid, errors } = await validateAgainst('team', plan.doc)
    if (!valid) {
      // The validator's own words are for whoever debugs it, not the lecturer
      // (DESIGN.md §1.7). Every refusal a typed name can cause is worded by
      // planTeamRename above, so this one is about the stored file.
      console.error('team rename refused by the schema', errors)
      renameError.value = 'Not renamed: the team\'s stored file would not be valid afterwards. This is not about the name you typed; tell whoever runs PXL Classroom. Nothing was changed.'
      return
    }
    // WHAT IT WAS DECIDED FROM, ASKED AGAIN OF THE COMMIT IT LANDS ON
    // (lib/team-rename.mjs `renameRefusalAt`): a retry re-applies the same files
    // to whatever the branch became.
    const precondition = ({ request, parentSha }) => renameRefusalAt({
      get: contentsAt(request, parentSha),
      decode: decodeBase64Text,
      assignmentId: id,
      storedSlug: stored.team_slug,
      storedText,
      newSlug: plan.slug,
      members: stored.members || [],
    })
    const res = await commitFiles(token, props.org, config.controlRepo, plan.changes, `Rename team ${stored.team_slug} to ${plan.slug} (${id})`, { precondition })
    if (!res.ok) {
      renameError.value = `Could not rename the team: ${res.error || 'the save failed'}. Nothing was changed.`
      // What the page shows may be what stopped it: read it again.
      emit('refresh')
      return
    }
    // The publish says its own failure, with a way to run it by hand.
    if (await republishTeams(token)) toast.success(`Renamed to "${plan.doc.team_name}".`)
    renaming.value = false
    managingTeam.value = null
    emit('refresh')
  } catch (e) {
    renameError.value = `Could not rename the team: ${e.message}`
  } finally {
    saving.value = false
  }
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
function republishTeams(token, failure = 'Saved, but publishing the change to students failed') {
  return republishStudentPages({ token, org: props.org, failure })
}

// Whether students see each renamed team's new name (lib/team-names-served.js).
// Asked of the file the student site serves, never remembered from the rename.
const namesServed = ref({ state: 'none', stale: [] })
const checkingNames = ref(false)
const rebuildingNames = ref(false)
// This page asked for the rebuild and GitHub took it: read the page again every
// NAMES_TICK_MS until it is current, for NAMES_WAIT_MS, then offer Update again.
// The same as a card's "Update the student page now" (useStudentPageStatus.js).
const namesAsked = ref(false)
const NAMES_TICK_MS = 20_000
const NAMES_WAIT_MS = 10 * 60_000
let namesAskedAt = 0
let namesTimer = null
const namesLine = computed(() => renamedTeamsLine(namesServed.value, { asked: namesAsked.value }))
let namesRun = 0
async function checkRenamedNames() {
  const mine = ++namesRun
  clearTimeout(namesTimer)
  const secret = linkSecretFrom(props.assignment)
  if (!secret || !(props.teams || []).some((t) => Array.isArray(t?.renamed_from) && t.renamed_from.length)) {
    namesServed.value = { state: 'none', stale: [] }
    namesAsked.value = false
    // An earlier read this one superseded returns without clearing it.
    checkingNames.value = false
    return
  }
  checkingNames.value = true
  let served
  try {
    const res = await fetch(`${await inviteTeamsUrl(props.org, secret)}?t=${Date.now()}`, { cache: 'no-store' })
    if (res.status === 404) served = { status: 'missing' }
    else if (!res.ok) served = { status: 'unreadable' }
    else {
      const data = await res.json().catch(() => null)
      served = Array.isArray(data?.teams) ? { status: 'ok', teams: data.teams } : { status: 'unreadable' }
    }
  } catch {
    served = { status: 'unreadable' }
  }
  if (mine !== namesRun) return
  namesServed.value = renamedTeamsServed(props.teams, served)
  checkingNames.value = false
  if (namesServed.value.state === 'stale' && namesAsked.value && Date.now() - namesAskedAt < NAMES_WAIT_MS) {
    namesTimer = setTimeout(checkRenamedNames, NAMES_TICK_MS)
  } else {
    namesAsked.value = false
  }
}
async function rebuildForNames() {
  // Said at the press (DESIGN.md §1.5): "Updating…", with Check again held,
  // until the rebuild is asked for and the page read again.
  rebuildingNames.value = true
  checkingNames.value = true
  try {
    // Nothing was saved by this press, so its failure says only what failed.
    if (await republishTeams(getToken(), 'Starting the student page update failed')) {
      namesAsked.value = true
      namesAskedAt = Date.now()
    }
    await checkRenamedNames()
  } finally {
    rebuildingNames.value = false
  }
}
watch(() => props.teams, checkRenamedNames, { immediate: true })
onBeforeUnmount(() => clearTimeout(namesTimer))

async function removeSeededTeams() {
  const removable = removableSeededTeams.value
  if (removable.length === 0) return

  const kept = keptSeededTeams.value
  const n = removable.length
  const yes = await askConfirm({
    title: `Remove ${n} copied team${n === 1 ? '' : 's'} from ${assignmentTitle.value}?`,
    confirmLabel: `Remove ${n} team${n === 1 ? '' : 's'}`,
    destructive: true,
    paragraphs: [],
    list: removable.map((t) => {
      const m = (t.members || []).length
      return `${t.team_name} (${m} member${m === 1 ? '' : 's'})`
    }),
    after: [
      ...(kept.length
        ? [`${kept.length} copied team${kept.length === 1 ? ' is' : 's are'} kept: a member has already accepted into ${kept.length === 1 ? 'it' : 'them'}.`]
        : []),
      'No student repository is touched.',
    ],
  })
  if (!yes) return

  saving.value = true
  try {
    const token = getToken()
    const res = await commitFiles(
      token,
      props.org,
      config.controlRepo,
      unseedPlan.value.changes,
      `Remove ${removable.length} seeded team(s) from ${props.assignment.id}`,
      // Decided from what the page loaded: asked again of the commit it lands
      // on, or a member who accepted since loses the team their acceptance names.
      {
        precondition: ({ request, parentSha }) => unseedRefusalAt({
          get: contentsAt(request, parentSha), decode: decodeBase64Text, assignmentId: props.assignment.id, teams: removable,
        }),
      },
    )
    if (!res.ok) {
      toast.error(`Could not remove the teams: ${res.error}. Nothing was removed.`)
      emit('refresh')
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
  if (!slug || newSlugProblem.value) return
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

    // ASKED AGAIN AT THE CLICK (review 2026-10-14, P2-18): the page's teams
    // are as old as the page. A name another tab renamed away since is still
    // that team's, and a file made at this name since is not overwritten -
    // written as new (`expectedSha: null`), so GitHub refuses it if it exists.
    const id = props.assignment.id
    let files = []
    try {
      files = (await listRepoDir(token, props.org, config.controlRepo, teamsDir(id))).filter((f) => f.name.endsWith('.json'))
    } catch (e) {
      if (e?.status !== 404) throw e
    }
    for (const f of files) {
      const text = await getRepoContent(token, props.org, config.controlRepo, f.path)
      const doc = text ? JSON.parse(text) : null
      if (doc?.team_slug !== slug && (doc?.renamed_from || []).includes(slug)) {
        toast.error(`"${doc.team_name || doc.team_slug}" was called ${slug} until it was renamed, so the name stays with it. Nothing was created.`)
        emit('refresh')
        return
      }
    }
    const path = teamPath(id, slug)
    const res = await commitFile(
      token,
      props.org,
      config.controlRepo,
      path,
      JSON.stringify(teamDoc, null, 2) + '\n',
      `Create team ${slug} for ${id}`,
      { expectedSha: null },
    )
    if (res.ok) {
      await republishTeams(token)
      toast.success(`Team "${newTeamForm.value.name}" created successfully.`)
      showCreateModal.value = false
      emit('refresh')
    } else if (res.conflict) {
      toast.error(`A team called ${slug} was made meanwhile. Nothing was created; the teams are read again.`)
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

/** Teams a member of the open team could be moved into, excluding full ones. */
const moveTargets = computed(() => {
  const current = managingTeam.value?.team_slug
  return (props.teams || [])
    .filter((t) => t.team_slug !== current && (t.members || []).length < maxTeamSize.value)
    .sort((a, b) => String(a.team_name || a.team_slug).localeCompare(String(b.team_name || b.team_slug)))
})

/**
 * Move one student from the open team into another, in a single commit.
 *
 * TEAMS-PLAN promised a lecturer "Move Student" action and it was never built;
 * the two-step alternative (remove here, add there) is two commits with a
 * window in between where the student belongs to no team at all - and if the
 * second fails, they are simply lost from the cohort's grouping.
 *
 * Both manifests are MERGED onto what is stored rather than rebuilt from the
 * rows on screen: `props.teams` is the display shape mergeTeamManifests
 * assembles and carries neither `created_by` nor `repo_id` nor `seeded_from`.
 */
/**
 * The permission a move or an add may grant on `repoName` NOW (review
 * 2026-10-16, R7-5): the assignment's, unless the deadline's lock made the
 * repository read-only and nobody reopened it - then read, as the lock left
 * the team. It granted the assignment's permission, so admin on a frozen team
 * repository, able to switch its ruleset off: an unlock around Reopen with no
 * record. One rule with provisioning (lib/permission-change.mjs
 * `grantableAfterLock`), read the way provisioning reads it: an unreadable
 * lock record is held, an unreadable reopen record is a reopen.
 */
async function grantablePermission(token, repoName) {
  const id = props.assignment.id
  const full = `${props.org}/${repoName}`
  let lockRecord = null
  // Unread is held, the safe answer - and said as unread, never as "the
  // deadline's lock left it", which blamed a lock that may not exist (R7-44).
  let unread = false
  try {
    const text = await getRepoContent(token, props.org, config.controlRepo, lockdownRecordPath(id))
    lockRecord = text ? JSON.parse(text) : null
  } catch {
    lockRecord = { results: [{ repo_name: full, lock_method: 'demotion' }] }
    unread = true
  }
  const reopenRecords = []
  if (lockRecord) {
    let files = []
    try {
      files = await listRepoDir(token, props.org, config.controlRepo, unlockedDir(id))
    } catch (e) {
      if (e?.status !== 404) reopenRecords.push({ repo_name: full })
    }
    for (const f of files.filter((x) => x.type === 'file' && x.name.endsWith('.json'))) {
      try {
        const text = await getRepoContent(token, props.org, config.controlRepo, f.path)
        reopenRecords.push(text ? JSON.parse(text) : { repo_name: full })
      } catch {
        reopenRecords.push({ repo_name: full })
      }
    }
  }
  return { ...grantableAfterLock({ permission: studentPermission.value, repoName: full, lockRecord, reopenRecords }), unread }
}

/** Why someone just added has read access only, in the lecturer's words. */
function heldNoteFor(repoName, grant, who = 'those added') {
  return grant.unread
    ? `Whether the deadline's lock holds ${repoName} could not be read, so ${who} have read access for now; add them again once it can be read.`
    : `The deadline's lock left ${repoName} read-only, so ${who} have read access; Reopen gives them more.`
}

/**
 * Write a team repository's deadline variable from the members it has now
 * (review 2026-10-16, R7-14): a team carries its most generous member's
 * extension, so moving or adding someone with one changes what both teams'
 * pages and workflows should show - and nothing rewrote it, so each page went
 * on showing the deadline of the team as it was. One rule with provisioning
 * (lib/deadline-variable.mjs `deadlineVariableValue`). The extensions are read
 * first; one that cannot be read sends nothing, because "none" would delete a
 * real one (R6-10).
 *
 * @returns {Promise<string|null>} null when written, otherwise why not
 */
async function rewriteTeamDeadline(token, repoName, members) {
  if (!repoName) return null
  const overrides = []
  try {
    let files = []
    try {
      files = await listRepoDir(token, props.org, config.controlRepo, overridesDir(props.assignment.id))
    } catch (e) {
      if (e?.status !== 404) throw e
    }
    for (const f of files.filter((x) => x.type === 'file' && members.some((m) => sameLogin(m, x.name.slice(0, -'.json'.length))))) {
      const text = await getRepoContent(token, props.org, config.controlRepo, f.path)
      if (text) overrides.push(JSON.parse(text))
    }
  } catch (e) {
    return `its deadline was not sent: the extensions could not be read (${e.message})`
  }
  const value = members.length ? deadlineVariableValue(props.assignment, members[0], { overrides, team: { members } }) : null
  const res = await writeDeadlineVariable((method, path, body) => ghApi(token, method, path, body), {
    repoFullName: `${props.org}/${repoName}`, value,
  })
  return res.ok ? null : `its deadline was not sent: GitHub refused it (HTTP ${res.status})`
}

async function moveMemberTo(login, targetSlug) {
  if (!managingTeam.value || !targetSlug) return
  const sourceSlug = managingTeam.value.team_slug
  if (targetSlug === sourceSlug) return

  const target = (props.teams || []).find((t) => t.team_slug === targetSlug)
  if (!target) return

  // A move closes Manage, and adds or removes made in it and not saved yet
  // went with it, unasked. One thing at a time, as with a state change.
  if (memberEditsPending.value) {
    toast.error('Save or undo the changes to this team first, then move.')
    return
  }

  // Written from the case in hand (lib team-edit.js): whether they accepted,
  // and whether each team has a repository. One sentence for every case said
  // "granted access to the Bravo repository" over a team that had none.
  const yes = await askConfirm(moveConfirmation({
    login,
    from: managingTeam.value,
    to: target,
    org: props.org,
    accepted: hasAccepted(login),
    draft: props.assignment?.state === 'draft',
  }))
  if (!yes || !managingTeam.value) return

  saving.value = true
  try {
    const token = getToken()
    // lib/control-layout.mjs, never spelled here. These two were spelled by
    // hand and the guard never saw them: it pairs backticks across the whole
    // file, and a comment's inline code had shifted the pairing.
    const sourcePath = teamPath(props.assignment.id, sourceSlug)
    const targetPath = teamPath(props.assignment.id, targetSlug)

    // Read BOTH before touching anything: a move that can only half-apply is
    // worse than one that does not start.
    const [sourceRead, targetRead] = await Promise.all([
      readTeamManifest(token, sourcePath),
      readTeamManifest(token, targetPath),
    ])
    if (!sourceRead || !targetRead) {
      toast.error(`Could not read both team manifests. Nothing was changed.`)
      return
    }
    const sourceDoc = sourceRead.doc
    const targetDoc = targetRead.doc

    const lower = (s) => String(s).toLowerCase()
    if ((targetDoc.members || []).some((m) => lower(m) === lower(login))) {
      toast.error(`@${login} is already in "${target.team_name}".`)
      return
    }
    if ((targetDoc.members || []).length >= maxTeamSize.value) {
      toast.error(`"${target.team_name}" is already at capacity (${maxTeamSize.value}).`)
      return
    }

    const nextSource = {
      ...sourceDoc,
      members: (sourceDoc.members || []).filter((m) => lower(m) !== lower(login)),
    }
    nextSource.vacant = nextSource.members.length === 0
    const nextTarget = {
      ...targetDoc,
      members: [...(targetDoc.members || []), login],
      vacant: false,
    }
    // Heal a manifest an older rebuild damaged, exactly as saveTeamMembers does.
    for (const doc of [nextSource, nextTarget]) {
      if (typeof doc.created_by !== 'string' || !doc.created_by) doc.created_by = 'lecturer'
    }

    for (const [doc, name] of [[nextSource, sourceSlug], [nextTarget, targetSlug]]) {
      const { valid, errors } = await validateAgainst('team', doc)
      if (!valid) {
        toast.error(
          `Refusing to write an invalid manifest for "${name}": ` +
          errors.map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ')
        )
        return
      }
    }

    // Their repository and acceptance records move with them. Without this the
    // collector read the old team's repository for them and lockdown demoted
    // them there (re-inviting them) while leaving admin on the new one.
    let recordChanges
    try {
      recordChanges = await memberRecordChanges(token, login, nextTarget)
    } catch (e) {
      toast.error(`Could not read @${login}'s records (${e.message}). Nothing was changed.`)
      return
    }

    // ONE commit for all of it. Two commits can half-apply; this cannot.
    const res = await commitFiles(
      token,
      props.org,
      config.controlRepo,
      [
        { path: sourcePath, content: JSON.stringify(nextSource, null, 2) + '\n' },
        { path: targetPath, content: JSON.stringify(nextTarget, null, 2) + '\n' },
        ...recordChanges,
      ],
      `Move ${login} from ${sourceSlug} to ${targetSlug} (${props.assignment.id})`,
      // Both files as read, or nothing: a join or a switch landing in between
      // would otherwise be written over (lib/team-write-guard.mjs).
      {
        precondition: async ({ request, parentSha }) => (await changedSinceRead({
          get: contentsAt(request, parentSha), decode: decodeBase64Text,
          files: [{ path: sourcePath, text: sourceRead.text }, { path: targetPath, text: targetRead.text }],
        })) ? 'one of the two teams was changed while you moved them (a student may have joined or left); open it again' : null,
      },
    )
    if (!res.ok) {
      toast.error(`Could not move @${login}: ${res.error || 'commit failed'}. Nothing was changed.`)
      emit('refresh')
      return
    }

    // Collaborators AFTER the commit. The control repo is the source of truth -
    // if the sync fails, the manifests are still right and a retry fixes access;
    // the other order would leave GitHub correct and the manifests stale, which
    // is what the nightly and every report then read.
    const repoOf = (t) => (t?.repo_name ? String(t.repo_name).split('/').pop() : null)
    const sourceRepo = repoOf(managingTeam.value)
    const targetRepo = repoOf(target)
    // The reporting below was already right; the DETECTION could not fire.
    // These call `ghApi`, which resolves `{ ok: false, status }` on an HTTP
    // failure instead of throwing, so `.catch()` never ran, `problems` was
    // always empty, and this always took the success branch. A student moved
    // between teams could silently keep access to the old team's repository and
    // have none on the new one, while the lecturer read "@login moved to X".
    const problems = []
    const notAccounts = []
    const heldNotes = []
    if (sourceRepo) {
      // 404 means they were not a collaborator there, and a 403 on a username
      // that is not an account means there was never any access: both are the
      // end state we wanted (revokeAccess).
      const { outcome, status } = await revokeAccess(token, sourceRepo, login)
      if (outcome === 'not-an-account') notAccounts.push(login)
      else if (outcome === 'failed') problems.push(`revoke on ${sourceRepo} (HTTP ${status ?? '?'})`)
    }
    if (targetRepo) {
      if (notAccounts.length) {
        // Already known; inviting a username that is no account only fails.
        problems.push(`@${login} is not a GitHub account, so ${targetRepo} could not be shared with them`)
      } else {
        // What the lock left, not the assignment's permission (R7-5).
        const grant = await grantablePermission(token, targetRepo)
        const res = await addCollaborator(token, props.org, targetRepo, login, grant.permission)
        if (!res?.ok) problems.push(await grantProblem(token, targetRepo, login, res))
        else if (grant.held) heldNotes.push(grant.unread
          ? `@${login} has read access to ${targetRepo} for now: whether the deadline's lock holds it could not be read`
          : `@${login} has read access to ${targetRepo}, as the deadline's lock left it; Reopen gives them more`)
      }
    }
    // Both teams' deadlines, from their members after the move (R7-14).
    for (const [repo, members] of [[sourceRepo, nextSource.members], [targetRepo, nextTarget.members]]) {
      const why = await rewriteTeamDeadline(token, repo, members)
      if (why) problems.push(`${repo}: ${why}`)
    }

    await republishTeams(token)
    if (problems.length) {
      toast.error(
        `@${login} was moved to "${target.team_name}", but repository access needs attention: ` +
        problems.join('; ')
      )
    } else {
      const note = [notAnAccountNote(notAccounts), ...heldNotes.map((n) => `${n}.`)].filter(Boolean).join(' ')
      toast.success(`@${login} moved to "${target.team_name}".${note ? ` ${note}` : ''}`)
    }
    managingTeam.value = null
    emit('refresh')
  } catch (e) {
    toast.error(`Error moving @${login}: ${e.message}`)
  } finally {
    saving.value = false
  }
}

/**
 * The repository and acceptance records a membership change must rewrite, so
 * the collector, lockdown and acceptance read what the manifests say
 * (lib/team-member-records.mjs). Validated here, before anything is written.
 *
 * THROWS when a record cannot be read. Absent (404) is an answer; a failed read
 * is not, and guessing either way leaves a stale record for lockdown to act on
 * or deletes a real one. The caller has touched nothing yet, so a throw means
 * nothing changed.
 */
async function memberRecordChanges(token, login, toTeam) {
  const read = async (path) => {
    const text = await getRepoContent(token, props.org, config.controlRepo, path)
    return text ? JSON.parse(text) : null
  }
  // UNDER THE SPELLING THE RECORDS ARE FILED AT. A team file can carry the
  // roster's spelling (`ella-dev`) while acceptance filed the student's records
  // under GitHub's (`Ella-Dev.json`), and paths are case-sensitive: the read
  // 404'd as "no record", and the save wrote a second record beside the real
  // one - which still named the old team, so lockdown re-invited her there.
  const filed = await recordSpelling(token, login)
  const [repoRecord, acceptance] = await Promise.all([
    read(repositoryPath(props.assignment.id, filed)),
    read(acceptancePath(props.assignment.id, filed)),
  ])
  const changes = planMemberRecordChanges({
    assignmentId: props.assignment.id,
    org: props.org,
    login: filed,
    toTeam,
    repoRecord,
    acceptance,
    studentPermission: studentPermission.value,
  })
  for (const c of changes) {
    if (c.content === null) continue
    const schema = c.path.startsWith('repositories/') ? 'repository-record' : 'acceptance'
    const { valid, errors } = await validateAgainst(schema, JSON.parse(c.content))
    if (!valid) {
      throw new Error(
        `refusing to write an invalid ${c.path}: ` +
        errors.map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ')
      )
    }
  }
  return changes
}

/**
 * The spelling this student's records are filed under for this assignment,
 * matched lowercased (lib/github-login.mjs); the login as given when none is.
 * THROWS on a listing that fails for any reason but absence, like the reads it
 * serves: a guess here writes the second record this exists to prevent.
 */
async function recordSpelling(token, login) {
  for (const dir of [repositoriesDir(props.assignment.id), acceptancesDir(props.assignment.id)]) {
    let files = []
    try {
      files = await listRepoDir(token, props.org, config.controlRepo, dir)
    } catch (e) {
      if (e?.status !== 404) throw e
    }
    const hit = files.find((f) => f.type === 'file' && f.name.endsWith('.json') && sameLogin(f.name.slice(0, -'.json'.length), login))
    if (hit) return hit.name.slice(0, -'.json'.length)
  }
  return login
}

/** The stored manifest at `path`, or null when it cannot be read or parsed. */
/** A team manifest and the exact text it was read as (for the write's precondition), or null. */
async function readTeamManifest(token, path) {
  try {
    const text = await getRepoContent(token, props.org, config.controlRepo, path)
    if (!text) return null
    const doc = JSON.parse(text)
    return doc && typeof doc === 'object' ? { doc, text } : null
  } catch {
    return null
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
    const path = teamPath(props.assignment.id, slug)

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
    // "Undo copy" button both key on it, so editing one member of a seeded team
    // quietly removed it from the bulk undo.
    //
    // Merge, never replace - the same rule promote-roster follows. Reading
    // first also means an unreadable manifest refuses before any collaborator
    // is touched, rather than leaving GitHub and the control repo disagreeing.
    let existing = null
    let existingText = null
    try {
      existingText = await getRepoContent(token, props.org, config.controlRepo, path)
      if (existingText) existing = JSON.parse(existingText)
    } catch {
      existing = null
    }
    if (!existing || typeof existing !== 'object') {
      toast.error(`Could not read ${path}. Nothing was changed.`)
      return
    }

    // What this dialog changed: who was taken off and who was put on, against
    // the list it OPENED with.
    const removed = oldMembers.filter((m) => !newMembers.some((nm) => sameLogin(nm, m)))
    const added = newMembers.filter((m) => !oldMembers.some((om) => sameLogin(om, m)))

    // ...applied to the list as STORED NOW. Writing the list on screen dropped
    // anyone who accepted into this team while the dialog was open - out of
    // the team file, while their access and records stayed. And the cap is
    // asked of that list, not of the one the dialog counted.
    const stored = Array.isArray(existing.members) ? existing.members.map(String) : []
    const members = [
      ...stored.filter((m) => !removed.some((r) => sameLogin(r, m))),
      ...added.filter((a) => !stored.some((s) => sameLogin(s, a))),
    ]
    if (added.length && members.length > maxTeamSize.value) {
      toast.error(
        `"${managingTeam.value.team_name || slug}" would have ${members.length} members, over its ${maxTeamSize.value}: ` +
        'someone joined while this was open. Nothing was changed.',
      )
      return
    }

    // Only what this modal actually changes. Everything else - created_by,
    // seeded_from, repo_id, and any field a later version adds - rides along
    // untouched.
    const teamDoc = {
      ...existing,
      members,
      vacant: members.length === 0,
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

    // Records for everyone whose membership changed, planned BEFORE any
    // collaborator is touched: an unreadable record refuses the whole save.
    // An added student gets a repository record naming this team's repository,
    // so lockdown demotes them and the collector reads it; a removed one loses
    // theirs, so the deadline does not re-invite them to it.
    const recordChanges = []
    try {
      for (const m of added) recordChanges.push(...(await memberRecordChanges(token, m, teamDoc)))
      for (const m of removed) recordChanges.push(...(await memberRecordChanges(token, m, null)))
    } catch (e) {
      toast.error(`Could not read a member's records (${e.message}). Nothing was changed.`)
      return
    }

    // The repository as STORED too, like the members: one created since the
    // dialog opened is the one a removed student must lose access to, and the
    // one an added student must be invited to.
    const repoName = String(existing.repo_name || managingTeam.value.repo_name || '').split('/').pop() || null

    // Sync live GitHub collaborators if the repo exists.
    //
    // THE RESULT IS CHECKED, and `.catch()` was never checking it. These call
    // `ghApi`, which RESOLVES `{ ok: false, status }` on an HTTP failure rather
    // than throwing - so the old `.catch((e) => console.warn(...))` could not
    // fire for a 403 or a 404, and the returned value was discarded. A student
    // whose access could not be granted was still written into the manifest and
    // the lecturer was told "Team updated successfully"; a student who could not
    // be REMOVED silently kept admin on a repository they are no longer part of,
    // which on an exam is the sharper half.
    const accessFailures = []
    const notAccounts = []
    let heldNote = ''
    if (token && repoName) {
      for (const m of removed) {
        // 204 is the success shape; 404 means they were not a collaborator, and
        // a 403 on a username that is not an account means there never was
        // access - both are the end state we wanted (revokeAccess).
        const { outcome, status } = await revokeAccess(token, repoName, m)
        if (outcome === 'not-an-account') notAccounts.push(m)
        else if (outcome === 'failed') accessFailures.push(`could not remove @${m} (HTTP ${status ?? '?'})`)
      }
      // What the lock left, not the assignment's permission (R7-5); asked
      // once for this repository.
      const grant = added.length ? await grantablePermission(token, repoName) : null
      for (const m of added) {
        const res = await addCollaborator(token, props.org, repoName, m, grant.permission)
        // 201 is "invitation created", 204 is "already a collaborator".
        if (!res?.ok) accessFailures.push(await grantProblem(token, repoName, m, res))
      }
      if (grant?.held) heldNote = heldNoteFor(repoName, grant)
    }

    const res = await commitFiles(
      token,
      props.org,
      config.controlRepo,
      [{ path, content: JSON.stringify(teamDoc, null, 2) + '\n' }, ...recordChanges],
      `Update members for team ${slug} (${props.assignment.id})`,
      // Merged onto the file as read; a join or a switch landing since is
      // merged again by saving again, never written over (lib/team-write-guard.mjs).
      {
        precondition: async ({ request, parentSha }) => (await changedSinceRead({
          get: contentsAt(request, parentSha), decode: decodeBase64Text, files: [{ path, text: existingText }],
        })) ? 'the team was changed while you saved it (a student may have joined or left)' : null,
      },
    )
    if (res.ok) {
      // The team's deadline, from its members as saved (R7-14).
      if (token && repoName && (added.length || removed.length)) {
        const why = await rewriteTeamDeadline(token, repoName, teamDoc.members || [])
        if (why) accessFailures.push(`${repoName}: ${why}`)
      }
      await republishTeams(token)
      // The membership is recorded either way - the manifest is the source of
      // truth and a later reconcile can repair access - but "updated
      // successfully" over a student who cannot reach the repository is the
      // lecturer finding out from the student instead.
      const note = [notAnAccountNote(notAccounts), heldNote].filter(Boolean).join(' ')
      if (accessFailures.length) {
        toast.error(
          `Team "${managingTeam.value.team_name}" was saved, but repository access did not all change: ` +
            `${accessFailures.join('; ')}. Fix the access on GitHub, or re-open this dialog and save again.` +
            (note ? ` ${note}` : ''),
        )
      } else {
        toast.success(`Team "${managingTeam.value.team_name}" updated successfully.${note ? ` ${note}` : ''}`)
      }
      managingTeam.value = null
      emit('refresh')
    } else {
      // `res.error`, never `HTTP ${res.status}`: a commit that ran out of
      // retries has no status, and this printed "HTTP 0" to a lecturer who had
      // saved while their previous save's dashboard update was still writing.
      // Access is synced BEFORE this commit, so say so when it changed:
      // saving again is what records it.
      const accessChanged = Boolean(token && repoName && (added.length || removed.length))
      toast.error(
        `Could not save the team: ${res.error}.` +
          (accessChanged ? ' Repository access was already changed on GitHub; save again to record it.' : ''),
      )
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
  if (!(await askConfirm(deleteConfirmation(team)))) return
  saving.value = true
  try {
    const token = getToken()
    const path = teamPath(props.assignment.id, team.team_slug)
    // VACANT AT THE CLICK, not when the page loaded. A student who joined in
    // between lost their team file and kept their repository, and the next
    // teammate was refused over grp-<slug>: a team assignment refuses an
    // existing repository. Judged on the version the delete names.
    const res = await deleteFile(
      token,
      props.org,
      config.controlRepo,
      path,
      `Delete vacant team ${team.team_slug} (${props.assignment.id})`,
      {
        refuse: (text) => {
          let doc = null
          try { doc = JSON.parse(text) } catch { doc = null }
          if (!doc || typeof doc !== 'object') return 'its file could not be read'
          if (Array.isArray(doc.members) && doc.members.length) return `it has ${doc.members.length === 1 ? 'a member' : `${doc.members.length} members`} now`
          // A repository the page did not show: somebody's run created one.
          if (doc.repo_name && !team.repo_name) return 'it has a repository now'
          return null
        },
      },
    )
    if (res.refused) {
      toast.error(`"${team.team_name || team.team_slug}" was not deleted: ${res.refused}. Someone may have joined since this page loaded.`)
      emit('refresh')
      return
    }
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

.team-code {
  color: var(--text-secondary);
}

.members-cell {
  max-width: 260px;
}

.member-pills {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}

/* An address is longer than a username: one too long for the cell ends in
   "…", and the whole of it, with the username, is in the title. */
.member-pill {
  font-size: 0.75rem;
  background: var(--bg-secondary);
  border: 1px solid var(--border-default);
  padding: 1px 6px;
  border-radius: 4px;
  color: var(--text-secondary);
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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

/* No height of its own: the dialog's body scrolls (style.css, `.modal`).
   A recessed well, not an outlined box: the dialog is the box and its
   checkboxes are controls, and a border here made the third (DESIGN.md §1.1).
   `--bg-inset` because it differs from the dialog in both themes;
   `--bg-secondary` is the dialog's own white. */
.unassigned-students-list {
  border-radius: var(--radius-sm);
  padding: 8px;
  background: var(--bg-inset);
}

.student-check-item {
  padding: 4px;
  cursor: pointer;
}

/* On the list, greyed: a student this assignment admits who cannot be placed
   until they have a GitHub username (the note above the table says how). */
.student-check-item.student-waiting {
  color: var(--text-muted);
  cursor: default;
}

.member-manage-who {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

/* A username is one word: wrapped at its hyphen it reads as two people. */
.member-login {
  color: var(--text-primary);
  white-space: nowrap;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
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

/* Rename sits under the dialog's title: a link, then a box in its place. */
.team-rename {
  display: flex;
  flex-direction: column;
  gap: var(--space-xs);
  align-items: flex-start;
}
.team-rename-input {
  min-width: 0;
  width: 22rem;
  max-width: 100%;
}

/* A well, for the same reason as the list above: a row here holds a select and
   a button, and an outline around them inside the dialog's was three boxes. */
.members-manage-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  background: var(--bg-inset);
  padding: 8px;
  border-radius: var(--radius-sm);
}

.member-manage-row {
  padding: 4px;
  border-bottom: 1px solid var(--border-muted);
}

.member-manage-row:last-child {
  border-bottom: none;
}

/* Sized to sit beside the xs buttons in the member row rather than dominate
   it: moving is a rarer action than removing, and the row is a list first. */
.move-select {
  width: auto;
  min-width: 8.5rem;
  max-width: 14rem;
  padding: 2px 6px;
  /* Matches .text-xs in style.css. There is no font-size token to reference,
     and DESIGN.md §5 forbids a var() fallback, which would pin one theme. */
  font-size: 0.74rem;
  height: auto;
}
</style>
