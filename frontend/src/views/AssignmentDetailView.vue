<template>
  <div class="detail-page">
    <header class="detail-header">
      <div class="container flex items-center justify-between">
        <div class="breadcrumb flex items-center gap-md">
          <router-link :to="{ name: 'dashboard', params: { org } }" class="back-link">
            <Icon name="arrow-left" :size="14" />
            <span>Dashboard</span>
          </router-link>
          <h1 :title="assignmentId">{{ assignmentId }}</h1>
          <span v-if="assignment" :class="['badge', assignment.state === 'published' ? 'badge-success' : (assignment.state === 'closed' ? 'badge-warning' : 'badge-neutral')]">
            {{ assignment.state === 'published' ? 'Accepting' : (assignment.state === 'closed' ? 'Acceptance Closed' : assignment.state) }}
          </span>
        </div>
        <div class="header-right flex items-center gap-md">
          <router-link
            :to="{ name: 'admin', params: { org }, query: { edit: assignmentId } }"
            class="btn btn-amber btn-with-icon"
            title="Open and edit this assignment in the Admin Panel"
          >
            <Icon name="edit-3" :size="14" />
            <span>Admin</span>
          </router-link>
          <UserBadge :user="user" @logout="handleLogout" />
        </div>
      </div>
    </header>

    <main class="container">
      <!-- Not authenticated - never show data-shaped empty states signed out -->
      <div v-if="!user" class="center-card fade-in">
        <h2>Sign in to view this assignment</h2>
        <p class="text-secondary">
          Sign in with a GitHub account that owns <strong>{{ org }}</strong> to load the
          report for <code>{{ assignmentId }}</code>. Sessions last 8 hours. If you were
          signed in earlier, it has expired.
        </p>
        <p v-if="authError" class="auth-error" role="alert">{{ authError }}. Try signing in again.</p>
        <button class="btn btn-primary btn-lg" @click="startLogin" :disabled="authLoading">
          <template v-if="authLoading">
            <div class="spinner" style="width:18px;height:18px;border-width:2px"></div>
            Waiting…
          </template>
          <template v-else>Sign in with GitHub</template>
        </button>
        <DeviceFlowCard v-if="deviceFlow" :flow="deviceFlow" @cancel="cancelLogin" />
      </div>

      <!-- Loading -->
      <div v-else-if="loading" class="center-card fade-in">
        <div class="spinner-lg spinner"></div>
        <p class="text-secondary">Loading report…</p>
      </div>

      <!-- Load Error -->
      <div v-else-if="loadError" class="center-card fade-in">
        <h2 class="text-danger">Failed to load report</h2>
        <p class="text-secondary">{{ loadError }}</p>
        <button class="btn btn-primary" type="button" @click="loadAll">Retry</button>
      </div>

      <!-- No report -->
      <div v-else-if="!report" class="center-card fade-in">
        <h2>No report yet</h2>
        <p class="text-secondary">
          Reports for <code>{{ assignmentId }}</code> are written to the control repo by the nightly
          <code>daily-activity.yml</code> run in the hub or automatically after student acceptances.
          You can also force an interim report to generate immediately using the button below.
        </p>
        <div v-if="dailyWatch === ''">
          <button class="btn btn-primary btn-with-icon" @click="runDailyActivity" :disabled="dailyTriggering">
            <Icon name="zap" :size="14" />
            <span>{{ dailyTriggering ? 'Triggering…' : 'Run daily activity now' }}</span>
          </button>
          <p class="text-muted" style="font-size: 0.85rem; margin-top: var(--space-sm);">
            Dispatches <code>daily-activity.yml</code> in the hub for {{ org }}. Takes a couple of minutes.
          </p>
        </div>
        <div v-else-if="dailyWatch === 'watching'" class="daily-watch">
          <div class="spinner" style="width:18px;height:18px;border-width:2px"></div>
          <span class="text-secondary">Workflow started. Watching for the report to land… (checked {{ dailyPollCount }}×)</span>
        </div>
        <p v-else-if="dailyWatch === 'timeout'" class="text-warning">
          No report after 5 minutes. Check the
          <a :href="`https://github.com/${config.hubOwner}/${config.hubRepo}/actions/workflows/daily-activity.yml`" target="_blank" rel="noopener">workflow run</a> for failures.
        </p>
      </div>

      <!-- Report loaded -->
      <div v-else class="report-content fade-in">
        <!-- Post-Deadline Preservation Summary Banner -->
        <div v-if="deadlinePassed && report" class="card preservation-banner">
          <div class="preservation-banner-header">
            <div class="preservation-banner-title-group">
              <span class="preservation-banner-title">Preservation &amp; Lockdown Status</span>
              <span :class="['badge', allPreserved ? 'badge-success' : preservedCount > 0 ? 'badge-warning' : 'badge-neutral']">
                {{ allPreserved ? 'All Preserved' : preservedCount > 0 ? `${preservedCount}/${eligiblePreservationCount} Preserved` : 'Preservation Pending' }}
              </span>
            </div>
            <div class="preservation-banner-meta text-secondary text-sm">
              <span v-if="preservationLockdownTime">
                Lockdown: {{ fmt(preservationLockdownTime) }}
                <span v-if="preservationUncertaintySeconds != null" :title="`Delay between deadline and lockdown execution`">
                  (delay: {{ preservationUncertaintySeconds }}s)
                </span>
              </span>
              <span v-else>
                Deadline passed: {{ deadlineAbs }}
              </span>
            </div>
          </div>

          <div class="preservation-banner-body">
            <p class="text-sm text-secondary" style="margin: 0;">
              Submission commit snapshots are preserved in the private organization archive repository.
            </p>
            <div class="preservation-banner-actions">
              <a
                :href="`https://github.com/${props.org}/pxl-classroom-archive`"
                target="_blank"
                rel="noopener"
                class="btn btn-sm btn-secondary btn-with-icon"
              >
                <Icon name="external-link" :size="13" />
                <span>Archive Repo</span>
              </a>
              <button
                class="btn btn-sm btn-danger btn-with-icon"
                type="button"
                @click="showFreezeConfirmModal = true"
                :disabled="freezingNow"
                title="Immediately lock down student repositories and snapshot commits into the archive"
              >
                <Icon name="lock" :size="13" />
                <span>{{ freezingNow ? 'Freezing…' : 'Freeze & Preserve Now' }}</span>
              </button>
              <button
                v-if="unpreservedCount > 0"
                class="btn btn-sm btn-primary btn-with-icon"
                type="button"
                @click="retryPreservation"
                :disabled="retryingPreservation"
              >
                <Icon name="refresh-cw" :size="13" />
                <span>{{ retryingPreservation ? 'Retrying…' : `Retry Preservation (${unpreservedCount})` }}</span>
              </button>
              <button
                class="btn btn-sm btn-secondary btn-with-icon"
                type="button"
                @click="handleDownloadManifest"
                :disabled="preservedCount === 0"
              >
                <Icon name="tag" :size="13" />
                <span>Download Manifest</span>
              </button>
              <button
                class="btn btn-sm btn-secondary btn-with-icon"
                type="button"
                @click="handleCopyDownloadCmd"
              >
                <Icon name="copy" :size="13" />
                <span>Copy CLI Download</span>
              </button>
            </div>
          </div>
        </div>

        <!-- Summary cards -->
        <div class="summary-row">
          <div class="summary-card card deadline-card">
            <span class="summary-value deadline-value" :class="{ 'stat-red': deadlinePassed }">
              {{ deadlineRelative || '-' }}
            </span>
            <span class="summary-label">Deadline{{ deadlineAbs ? ` · ${deadlineAbs}` : '' }}</span>
          </div>
          <div class="summary-card card" style="cursor: pointer;" @click="statusFilter = ''" title="Show all students">
            <span class="summary-value">{{ report.students.length }}</span>
            <span class="summary-label">Students</span>
          </div>
          <div class="summary-card card" style="cursor: pointer;" @click="statusFilter = 'on-time'" title="Filter on-time submissions">
            <span class="summary-value stat-green">{{ onTimeCount }}</span>
            <span class="summary-label">On-time</span>
          </div>
          <div class="summary-card card" style="cursor: pointer;" @click="statusFilter = 'late'" title="Filter late submissions">
            <span class="summary-value stat-yellow">{{ lateCount }}</span>
            <span class="summary-label">Late</span>
          </div>
          <div class="summary-card card" style="cursor: pointer;" @click="statusFilter = 'no-submission'" title="Filter unstarted / no submissions">
            <span class="summary-value stat-red">{{ noSubCount }}</span>
            <span class="summary-label">No submission</span>
          </div>
        </div>

        <!-- Actions bar -->
        <div class="actions-bar flex items-center justify-between flex-wrap gap-sm">
          <div class="flex items-center gap-md flex-wrap">
            <input
              v-model="search"
              type="search"
              placeholder="Search by login, email or repo…"
              class="search-input"
              aria-label="Search students"
            />
            <!-- Quick Filter Status Chips -->
            <div class="tab-pill-selector quick-filter-pills" role="tablist" aria-label="Status Quick Filters">
              <button
                type="button"
                class="tab-pill"
                :class="{ active: statusFilter === '' }"
                @click="statusFilter = ''"
              >
                All ({{ report.students.length }})
              </button>
              <button
                type="button"
                class="tab-pill"
                :class="{ active: statusFilter === 'on-time' }"
                @click="statusFilter = 'on-time'"
              >
                On-time ({{ onTimeCount }})
              </button>
              <button
                type="button"
                class="tab-pill"
                :class="{ active: statusFilter === 'late' }"
                @click="statusFilter = 'late'"
              >
                Late ({{ lateCount }})
              </button>
              <button
                type="button"
                class="tab-pill"
                :class="{ active: statusFilter === 'no-submission' }"
                @click="statusFilter = 'no-submission'"
              >
                No sub ({{ noSubCount }})
              </button>
              <button
                v-if="deadlinePassed && preservedCount > 0"
                type="button"
                class="tab-pill"
                :class="{ active: statusFilter === 'preserved' }"
                @click="statusFilter = 'preserved'"
              >
                Preserved ({{ preservedCount }})
              </button>
            </div>
          </div>
          <div class="flex gap-sm items-center">
            <button class="btn btn-primary btn-with-icon" @click="refreshLiveStatus" :disabled="refreshingLive">
              <span v-if="refreshingLive">Fetching ({{ refreshedStudentsCount }}/{{ totalStudentsToRefresh }})</span>
              <template v-else>
                <Icon name="refresh-cw" :size="14" />
                <span>Refresh</span>
              </template>
            </button>
            <!-- Consolidated Export & CLI Menu -->
            <div class="dropdown-container" ref="exportDropdownRef">
              <button
                class="btn btn-with-icon"
                type="button"
                @click.stop="toggleExportDropdown"
                :aria-expanded="exportDropdownOpen"
                aria-haspopup="true"
                title="Export data and CLI commands"
              >
                <Icon name="download" :size="14" />
                <span>Export</span>
                <Icon :name="exportDropdownOpen ? 'chevron-up' : 'chevron-down'" :size="12" />
              </button>

              <div v-if="exportDropdownOpen" class="export-dropdown-menu fade-in" role="menu">
                <button class="export-dropdown-item" type="button" role="menuitem" @click="handleExportCSV">
                  <Icon name="download" :size="14" class="dropdown-icon" />
                  <div class="dropdown-item-text">
                    <span class="dropdown-item-title">Export CSV</span>
                    <span class="dropdown-item-sub">Spreadsheet with student submissions &amp; links</span>
                  </div>
                </button>

                <button
                  class="export-dropdown-item"
                  type="button"
                  role="menuitem"
                  @click="handleDownloadManifest"
                  :disabled="preservedCount === 0"
                  :class="{ 'disabled-item': preservedCount === 0 }"
                >
                  <Icon name="tag" :size="14" class="dropdown-icon" />
                  <div class="dropdown-item-text">
                    <span class="dropdown-item-title">
                      Download Manifest
                      <span v-if="preservedCount > 0" class="badge-count">({{ preservedCount }})</span>
                    </span>
                    <span class="dropdown-item-sub">
                      {{ preservedCount > 0 ? 'JSON index of frozen archive SHAs' : 'Available after deadline lockdown' }}
                    </span>
                  </div>
                </button>

                <div class="dropdown-divider"></div>

                <button class="export-dropdown-item" type="button" role="menuitem" @click="handleCopyDownloadCmd">
                  <Icon name="copy" :size="14" class="dropdown-icon" />
                  <div class="dropdown-item-text">
                    <span class="dropdown-item-title">Copy CLI Download</span>
                    <span class="dropdown-item-sub">Command to bulk-clone preserved repos</span>
                  </div>
                </button>

                <button class="export-dropdown-item" type="button" role="menuitem" @click="handleCopyGradeCmd">
                  <Icon name="copy" :size="14" class="dropdown-icon" />
                  <div class="dropdown-item-text">
                    <span class="dropdown-item-title">Copy CLI Grade</span>
                    <span class="dropdown-item-sub">Command to run automated grading runner</span>
                  </div>
                </button>
              </div>
            </div>
            <button
              v-if="feedbackPrEnabled"
              class="btn btn-secondary btn-with-icon"
              type="button"
              @click="openFeedbackPrs"
              :disabled="openingFeedbackPrs"
              title="Open Feedback Pull Requests on student repositories with commits"
            >
              <Icon name="message-square" :size="14" />
              <span>{{ openingFeedbackPrs ? 'Opening PRs…' : 'Open Feedback PRs' }}</span>
            </button>
            <button
              v-if="assignment && assignment.template"
              class="btn btn-secondary btn-with-icon"
              type="button"
              @click="showStarterSyncModal = true"
              title="Sync updated starter code or tests from template repository"
            >
              <Icon name="git-pull-request" :size="14" />
              <span>Sync Starter Code</span>
            </button>
            <button
              v-if="assignment && (assignment.state === 'published' || assignment.state === 'closed')"
              :class="['btn', 'btn-with-icon', assignment.state === 'published' ? 'btn-danger' : 'btn-success']"
              type="button"
              @click="toggleAcceptanceState"
              :disabled="togglingState"
              :title="assignment.state === 'published' ? 'Close acceptance to stop new students from registering' : 'Open acceptance to allow students to register'"
            >
              <Icon :name="assignment.state === 'published' ? 'lock' : 'unlock'" :size="14" />
              <span>{{ togglingState ? 'Updating…' : (assignment.state === 'published' ? 'Close acceptance' : 'Open acceptance') }}</span>
            </button>
            <button class="btn btn-success btn-with-icon" @click="copyAcceptLink">
              <Icon name="copy" :size="14" />
              <span>Copy invitation link</span>
            </button>
          </div>
        </div>

        <!-- Segmented Tab for Group Assignments -->
        <div v-if="isGroupAssignment" class="tab-pill-selector" style="margin-bottom: var(--space-md);">
          <button
            type="button"
            class="tab-pill"
            :class="{ active: viewTab === 'teams' }"
            @click="viewTab = 'teams'"
          >
            Teams View ({{ report.teams ? report.teams.length : 0 }})
          </button>
          <button
            type="button"
            class="tab-pill"
            :class="{ active: viewTab === 'students' }"
            @click="viewTab = 'students'"
          >
            Students View ({{ report.students.length }})
          </button>
        </div>

        <!-- Group Assignment: Teams Table View -->
        <TeamsTable
          v-if="isGroupAssignment && viewTab === 'teams'"
          :teams="report.teams || []"
          :assignment="assignment"
          :org="org"
          :roster="roster"
          @refresh="loadData"
        />

        <!-- Student table (desktop) -->
        <div v-else class="table-wrapper desktop-only">
          <table>
            <thead>
              <tr>
                <th @click="sortBy('github_login')" @keydown.enter="sortBy('github_login')" @keydown.space.prevent="sortBy('github_login')" tabindex="0" class="sortable" :aria-sort="ariaSort('github_login')">
                  <span class="th-label">Login<SortIcon :dir="sortDir('github_login')" /></span>
                </th>
                <th v-if="isGroupAssignment">Team</th>
                <th @click="sortBy('acceptance_state')" @keydown.enter="sortBy('acceptance_state')" @keydown.space.prevent="sortBy('acceptance_state')" tabindex="0" class="sortable" :aria-sort="ariaSort('acceptance_state')">
                  <span class="th-label">Acceptance<SortIcon :dir="sortDir('acceptance_state')" /></span>
                </th>
                <th @click="sortBy('submission_status')" @keydown.enter="sortBy('submission_status')" @keydown.space.prevent="sortBy('submission_status')" tabindex="0" class="sortable" :aria-sort="ariaSort('submission_status')">
                  <span class="th-label">Status<SortIcon :dir="sortDir('submission_status')" /></span>
                </th>
                <th>Repo</th>
                <th @click="sortBy('latest_observed_at')" @keydown.enter="sortBy('latest_observed_at')" @keydown.space.prevent="sortBy('latest_observed_at')" tabindex="0" class="sortable" :aria-sort="ariaSort('latest_observed_at')">
                  <span class="th-label">Last commit<SortIcon :dir="sortDir('latest_observed_at')" /></span>
                </th>
                <th @click="sortBy('commit_count')" @keydown.enter="sortBy('commit_count')" @keydown.space.prevent="sortBy('commit_count')" tabindex="0" class="sortable num" :aria-sort="ariaSort('commit_count')">
                  <span class="th-label">Commits<SortIcon :dir="sortDir('commit_count')" /></span>
                </th>
                <th v-if="isGitHubActionsAutograde" class="col-ci">CI Status</th>
                <th v-if="autogradeEnabled" class="col-score">Score</th>
                <th v-if="feedbackPrEnabled" class="col-feedback-pr">Feedback PR</th>
                <th v-if="hasWarnings" class="col-warnings">Warnings</th>
                <th v-if="hasSubmitTags" @click="sortBy('tagged_submission_observed_at')" @keydown.enter="sortBy('tagged_submission_observed_at')" @keydown.space.prevent="sortBy('tagged_submission_observed_at')" tabindex="0" class="sortable" :aria-sort="ariaSort('tagged_submission_observed_at')">
                  <span class="th-label">Submit tag<SortIcon :dir="sortDir('tagged_submission_observed_at')" /></span>
                </th>
                <th class="col-actions"><span class="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="s in filteredStudents" :key="s.github_login">
                <td>
                  <a :href="`https://github.com/${s.github_login}`" target="_blank" :title="studentTooltip(s)">{{ s.github_login }}</a>
                </td>
                <td v-if="isGroupAssignment">
                  <span v-if="s.team_name || s.team_slug" class="badge badge-neutral" style="font-size: 0.75rem;">
                    {{ s.team_name || s.team_slug }}
                  </span>
                  <span v-else class="text-muted text-xs">-</span>
                </td>
                <td>
                  <span :class="['badge', acceptBadge(s.acceptance_state)]">{{ s.acceptance_state }}</span>
                </td>
                <td>
                  <span :class="['badge', statusBadge(s.submission_status)]">{{ s.submission_status }}</span>
                  <div v-if="extensionFor(s.github_login)" class="ext-note" :title="`Extension granted. Reason: ${extensionFor(s.github_login).reason}`">
                    ext -> {{ fmt(extensionFor(s.github_login).value) }}
                  </div>
                  <div v-if="s.preservation_status === 'preserved' && s.preserved_sha" class="archive-link-wrap" style="margin-top: 3px;">
                    <a
                      :href="`https://github.com/${props.org}/pxl-classroom-archive/tree/${encodeURIComponent(`preserved/${props.assignmentId}/${s.github_login}`)}`"
                      target="_blank"
                      rel="noopener"
                      class="mono text-xs"
                      :title="`Preserved in archive repository at SHA ${s.preserved_sha}`"
                      style="display: inline-flex; align-items: center; gap: 3px; color: var(--text-secondary, #8b949e); text-decoration: underline;"
                    >
                      <Icon name="archive" :size="11" />
                      <span>archive ({{ s.preserved_sha.slice(0, 7) }})</span>
                    </a>
                  </div>
                </td>
                <td class="col-repo">
                  <a v-if="s.repo_url" :href="s.repo_url" target="_blank" class="mono repo-link">{{ shortRepo(s.repo_name) }}</a>
                  <span v-else class="text-muted">-</span>
                </td>
                <td class="col-last-commit">
                  <template v-if="s.repo_url && latestSha(s)">
                    <div v-if="commitTime(s)" class="commit-time-top" :title="fmt(commitTime(s))">
                      {{ formatRelative(commitTime(s)) }}
                    </div>
                    <a :href="`${s.repo_url}/commit/${latestSha(s)}`" target="_blank" class="mono sha" :title="commitMsg(s) || null">
                      {{ latestSha(s).slice(0, 7) }}
                    </a>
                  </template>
                  <span v-else-if="s.repo_url" class="text-muted">no commits</span>
                  <span v-else class="text-muted">-</span>
                </td>
                <td class="num">
                  <span v-if="s.commit_count != null">{{ s.commit_count.toLocaleString() }}</span>
                  <span v-else class="text-muted">-</span>
                </td>
                <td v-if="isGitHubActionsAutograde" class="col-ci">
                  <button
                    v-if="s.ci_status"
                    type="button"
                    :class="['badge badge-clickable', s.ci_status === 'success' ? 'badge-success' : s.ci_status === 'failure' ? 'badge-error' : 'badge-warning']"
                    @click="openAutogradeModal(s)"
                    title="Click to view autograding details"
                    style="cursor: pointer; border: none;"
                  >
                    {{ s.ci_status }}
                  </button>
                  <span v-else class="text-muted">-</span>
                </td>
                <td v-if="autogradeEnabled" class="col-score">
                  <button
                    v-if="s.earned_points != null"
                    type="button"
                    class="badge"
                    :class="s.earned_points >= (s.total_points || 30) ? 'badge-success' : 'badge-warning'"
                    @click="openAutogradeModal(s)"
                    title="Click to view autograding test breakdown"
                    style="cursor: pointer; border: none; font-size: 0.75rem;"
                  >
                    {{ s.earned_points }}/{{ s.total_points || assignment?.autograde?.points_possible || 30 }} pts
                  </button>
                  <span v-else class="text-muted text-xs">-</span>
                </td>
                <td v-if="feedbackPrEnabled" class="col-feedback-pr">
                  <template v-if="s.feedback_pr_number">
                    <a :href="s.feedback_pr_url" target="_blank" class="mono">#{{ s.feedback_pr_number }}</a>
                  </template>
                  <span v-else class="text-muted" title="Run `pxl-classroom feedback open` once the student has pushed commits.">- pending</span>
                </td>
                <td v-if="hasWarnings" class="col-warnings">
                  <div v-if="s.warnings?.length" class="flex gap-sm flex-wrap">
                    <span v-for="w in s.warnings" :key="w" class="badge badge-warning text-xs" :title="getWarningDesc(w)">
                      {{ getWarningLabel(w) }}
                    </span>
                  </div>
                  <span v-else class="text-muted">-</span>
                </td>
                <td v-if="hasSubmitTags" class="col-submit-tag">
                  <template v-if="s.tagged_submission_tag">
                    <span class="tag-row">
                      <Icon name="tag" :size="13" class="tag-icon" />
                      <a v-if="s.repo_url && s.tagged_submission_sha"
                         :href="`${s.repo_url}/tree/${encodeURIComponent(s.tagged_submission_tag)}`"
                         target="_blank"
                         class="mono tag-link"
                         :title="`Tag observed ${fmt(s.tagged_submission_observed_at)} · declared ${fmt(s.tagged_submission_declared_at)}`">
                        {{ shortTag(s.tagged_submission_tag) }}
                      </a>
                      <span v-else class="mono tag-link" :title="fmt(s.tagged_submission_observed_at)">
                        {{ shortTag(s.tagged_submission_tag) }}
                      </span>
                    </span>
                    <div class="tag-time text-muted" :title="fmt(s.tagged_submission_observed_at)">
                      {{ formatRelative(s.tagged_submission_observed_at) }}
                    </div>
                  </template>
                  <span v-else class="text-muted untagged" title="No submit/ tag found">-</span>
                </td>
                <td class="col-actions">
                  <button class="row-action" type="button" @click="openActions(s)" :aria-label="`Actions for ${s.github_login}`">
                    <Icon name="more-horizontal" :size="18" />
                  </button>
                </td>
              </tr>
              <tr v-if="report.students.length > 0 && filteredStudents.length === 0">
                <td :colspan="tableColumnCount" class="empty-row">
                  No students match the current filters.
                  <button class="link-btn" type="button" @click="clearFilters">Clear filters</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- Student cards (mobile) -->
        <div class="card-list mobile-only">
          <div v-if="report.students.length > 0 && filteredStudents.length === 0" class="empty-row">
            No students match the current filters.
            <button class="link-btn" type="button" @click="clearFilters">Clear filters</button>
          </div>
          <article v-for="s in filteredStudents" :key="s.github_login" class="student-card">
            <header class="student-card-head" style="display: flex; align-items: center; justify-content: space-between;">
              <a :href="`https://github.com/${s.github_login}`" target="_blank" class="student-card-login" :title="studentTooltip(s)">{{ s.github_login }}</a>
              <button class="row-action" type="button" @click="openActions(s)" :aria-label="`Actions for ${s.github_login}`">
                <Icon name="more-horizontal" :size="18" />
              </button>
            </header>
            <div class="student-card-badges">
              <span :class="['badge', acceptBadge(s.acceptance_state)]">{{ s.acceptance_state }}</span>
              <span :class="['badge', statusBadge(s.submission_status)]">{{ s.submission_status }}</span>
              <span v-if="s.lock_down_at" class="badge badge-info">locked</span>
              <span v-if="s.tagged_submission_tag" class="badge badge-info badge-with-icon" :title="`Tagged ${fmt(s.tagged_submission_observed_at)}`">
                <Icon name="tag" :size="11" />
                tagged
              </span>
              <span v-if="extensionFor(s.github_login)" class="badge badge-info" :title="`Extended to ${fmt(extensionFor(s.github_login).value)} (${extensionFor(s.github_login).reason})`">
                extended
              </span>
            </div>
            <!-- Touch devices can't reach title tooltips - repeat the detail as text. -->
            <div v-if="s.tagged_submission_tag" class="student-card-detail text-muted">
              Tag observed {{ fmt(s.tagged_submission_observed_at) }}
            </div>
            <div v-if="extensionFor(s.github_login)" class="student-card-detail text-muted">
              Extended to {{ fmt(extensionFor(s.github_login).value) }} ({{ extensionFor(s.github_login).reason }})
            </div>
            <div v-if="s.repo_url" class="student-card-repo">
              <a :href="s.repo_url" target="_blank" class="mono">{{ shortRepo(s.repo_name) }}</a>
              <div v-if="latestSha(s)" class="commit-row">
                Last commit
                <span v-if="commitTime(s)" :title="fmt(commitTime(s))">{{ formatRelative(commitTime(s)) }}</span>
                <a :href="`${s.repo_url}/commit/${latestSha(s)}`" target="_blank" class="mono sha text-muted" :title="commitMsg(s) || null">· {{ latestSha(s).slice(0, 7) }}</a>
                <span v-if="s.commit_count != null" class="text-muted">· {{ s.commit_count.toLocaleString() }} commits</span>
              </div>
              <div v-if="isGitHubActionsAutograde" class="commit-row" style="margin-top: var(--space-xs, 4px); align-items: center;">
                <span>CI Status:</span>
                <span v-if="s.ci_status" :class="['badge', s.ci_status === 'success' ? 'badge-success' : s.ci_status === 'failure' ? 'badge-error' : 'badge-warning']" style="font-size: 0.7rem; padding: 1px 6px;">
                  {{ s.ci_status }}
                </span>
                <span v-else class="text-muted">-</span>
              </div>
              <div v-if="feedbackPrEnabled" class="commit-row" style="margin-top: var(--space-xs, 4px);">
                <span>Feedback PR:</span>
                <template v-if="s.feedback_pr_number">
                  <a :href="s.feedback_pr_url" target="_blank" class="mono">#{{ s.feedback_pr_number }}</a>
                </template>
                <span v-else class="text-muted">- pending</span>
              </div>
            </div>
            <div v-if="s.warnings?.length" class="student-card-warnings">
              <span v-for="w in s.warnings" :key="w" class="badge badge-warning text-xs" :title="getWarningDesc(w)">
                {{ getWarningLabel(w) }}
              </span>
            </div>
          </article>
        </div>

        <p class="table-footer text-muted">
          {{ filteredStudents.length }} of {{ report.students.length }} students shown ·
          Generated {{ fmt(report.generated_at) }}<span v-if="liveRefreshedAt"> · Live-refreshed {{ fmt(liveRefreshedAt) }}</span><span v-if="rateLimit.remaining != null" :title="`Your GitHub REST quota (resets hourly)`"> · API quota {{ rateLimit.remaining.toLocaleString() }} / {{ rateLimit.limit.toLocaleString() }}</span>.
        </p>

        <!-- Autograde results (read-only) -->
        <section v-if="autogradeEnabled" class="autograde-section">
          <header class="autograde-head">
            <h3>Autograder</h3>
            <span class="text-muted text-xs">
              {{ autogradeSummary
                ? `Last run ${fmt(autogradeSummary.generated_at)} by @${autogradeSummary.graded_by} via ${autogradeSummary.runner}`
                : 'No results yet. Execution stays off-platform.' }}
            </span>
          </header>
          <div class="autograde-banner">
            Configured tests: <strong>{{ assignment?.autograde?.tests?.length || 0 }}</strong>.
            Total points: <strong>{{ autogradeTotalPoints }}</strong>.
            <template v-if="isGitHubActionsAutograde">
              Sync reads CI check-run summaries and point scores directly from GitHub Actions.
            </template>
            <button v-if="!isGitHubActionsAutograde" class="link-btn" type="button" @click="copyGradeCmd">Copy <code>pxl-classroom grade …</code></button>
            <button v-else class="btn btn-primary" type="button" @click="syncGradesFromGitHub" :disabled="syncingGrades">
              {{ syncingGrades ? `Syncing (${syncedGradesCount}/${totalGradesToSync})` : 'Sync CI results from GitHub' }}
            </button>
          </div>
          <div v-if="autogradeSummary && autogradeSummary.students?.length" class="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>Login</th>
                  <th class="num">Earned</th>
                  <th class="num">Total</th>
                  <th v-if="summaryIsCiBased">CI status</th>
                  <th>Last graded</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in autogradeSummary.students" :key="row.login">
                  <td><a :href="`https://github.com/${row.login}`" target="_blank">{{ row.login }}</a></td>
                  <td class="num">{{ row.earned_points }}</td>
                  <td class="num">{{ row.total_points }}</td>
                  <td v-if="summaryIsCiBased">
                    <span :class="['badge', row.earned_points >= row.total_points && row.total_points > 0 ? 'badge-success' : (row.earned_points > 0 ? 'badge-warning' : 'badge-error')]">
                      {{ row.earned_points >= row.total_points && row.total_points > 0 ? 'passed' : (row.earned_points > 0 ? 'partial' : 'failed') }}
                    </span>
                  </td>
                  <td>{{ fmt(row.graded_at) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div v-if="autogradeSummary?.failed?.length" class="autograde-failed">
            <strong>{{ autogradeSummary.failed.length }} grading failure(s):</strong>
            <ul>
              <li v-for="f in autogradeSummary.failed" :key="f.login"><code>{{ f.login }}</code>: {{ f.reason }}</li>
            </ul>
          </div>
        </section>
      </div>

      <!-- Per-row action modal -->
      <div v-if="actionStudent" class="modal-overlay" @click.self="closeActions">
        <div class="modal" ref="modalEl" role="dialog" aria-modal="true" :aria-label="`Actions for ${actionStudent.github_login}`" @keydown="trapTab">
          <header class="modal-head">
            <h3>Actions: <code>{{ actionStudent.github_login }}</code></h3>
            <button class="modal-close" type="button" @click="closeActions" :disabled="actionExtending || actionRetrying" aria-label="Close">×</button>
          </header>

          <section class="modal-section">
            <h4>Grant deadline extension</h4>
            <p v-if="extensionFor(actionStudent.github_login)" class="text-secondary">
              Currently extended to <strong>{{ fmt(extensionFor(actionStudent.github_login).value) }}</strong>
              ("{{ extensionFor(actionStudent.github_login).reason }}"). Granting again adds a new extension to their override history.
            </p>
            <div class="field">
              <label>New deadline (just for this student)</label>
              <input type="datetime-local" v-model="actionExt.deadline_local" />
            </div>
            <div class="field">
              <label>Reason (recorded in the override)</label>
              <textarea v-model="actionExt.reason" rows="2" placeholder="Medical certificate / approved by program coordinator / etc."></textarea>
            </div>
            <button class="btn btn-primary" type="button" @click="grantExtensionFor(actionStudent)" :disabled="actionExtending || !actionExt.deadline_local || !actionExt.reason.trim()">
              {{ actionExtending ? 'Granting…' : 'Grant extension' }}
            </button>
          </section>

          <section class="modal-section">
            <h4>Retry acceptance</h4>
            <p class="text-secondary">Wipes the half-done state and re-runs the full pipeline. Use when a student's acceptance got stuck (e.g. rate-limit during a burst).</p>
            <button class="btn" type="button" @click="retryAcceptanceFor(actionStudent)" :disabled="actionRetrying">
              {{ actionRetrying ? 'Triggering…' : 'Retry acceptance' }}
            </button>
          </section>

          <section v-if="actionStudent.preservation_status === 'preserved' && actionStudent.preserved_sha" class="modal-section">
            <h4>Preserved Submission Archive</h4>
            <p class="text-secondary">
              Preserved commit SHA: <code class="mono">{{ actionStudent.preserved_sha }}</code>
            </p>
            <a
              :href="`https://github.com/${props.org}/pxl-classroom-archive/tree/${encodeURIComponent(`preserved/${props.assignmentId}/${actionStudent.github_login}`)}`"
              target="_blank"
              rel="noopener"
              class="btn btn-secondary btn-with-icon"
              style="display: inline-flex; align-items: center; gap: 6px; text-decoration: none;"
            >
              <Icon name="external-link" :size="14" />
              <span>View Preserved Code in Archive</span>
            </a>
          </section>
        </div>
      </div>

      <!-- Feedback PRs Confirmation Modal -->
      <div v-if="showFeedbackPrModal" class="modal-overlay" @click.self="showFeedbackPrModal = false">
        <div class="modal feedback-pr-modal" role="dialog" aria-modal="true" aria-label="Open Feedback Pull Requests">
          <header class="modal-head">
            <h3>Open Feedback Pull Requests</h3>
            <button class="modal-close" type="button" @click="showFeedbackPrModal = false" :disabled="openingFeedbackPrs" aria-label="Close">×</button>
          </header>

          <section class="modal-section">
            <p>
              This creates a dedicated <strong>Draft Pull Request</strong> (comparing <code>main</code> against the frozen <code>{{ assignment?.feedback_pr_baseline_branch || 'pxl-baseline' }}</code> branch) in student repositories that have pushed commits.
            </p>

            <div class="safety-box">
              <h4 class="safety-box-title">Student Code Safety & Scope</h4>
              <ul class="safety-list">
                <li><strong>No student code is altered or merged:</strong> The student's <code>main</code> branch, files, and git commit history remain completely untouched.</li>
                <li><strong>Safe Draft mode:</strong> The pull request is opened in Draft status for inline review comments and annotations only.</li>
                <li><strong>Continuous tracking:</strong> As students make and push further commits to <code>main</code>, the pull request automatically updates to include their new work.</li>
                <li><strong>Control repository records:</strong> PR numbers and links are saved to your control repository (<code>pxl-classroom-control/repositories/</code>), not written to student repos.</li>
              </ul>
            </div>

            <div class="cohort-summary-grid">
              <div class="cohort-summary-item">
                <span class="cohort-summary-val">{{ feedbackPrEligibleCount }}</span>
                <span class="cohort-summary-lbl">Eligible (commits pushed)</span>
              </div>
              <div class="cohort-summary-item">
                <span class="cohort-summary-val">{{ feedbackPrAlreadyOpenedCount }}</span>
                <span class="cohort-summary-lbl">Already opened</span>
              </div>
              <div class="cohort-summary-item">
                <span class="cohort-summary-val">{{ feedbackPrSkippedNoCommitsCount }}</span>
                <span class="cohort-summary-lbl">Skipped (0 commits yet)</span>
              </div>
            </div>

            <div v-if="feedbackPrEligibleCount === 0" class="empty-eligible-notice">
              All student repositories with pushed commits already have Feedback PRs opened, or no students have pushed code yet.
            </div>
          </section>

          <footer class="modal-actions">
            <button class="btn" type="button" @click="showFeedbackPrModal = false" :disabled="openingFeedbackPrs">
              Cancel
            </button>
            <button
              class="btn btn-primary"
              type="button"
              @click="executeOpenFeedbackPrs"
              :disabled="openingFeedbackPrs || feedbackPrEligibleCount === 0"
            >
              {{ openingFeedbackPrs ? 'Opening Pull Requests…' : `Open Feedback PRs on ${feedbackPrEligibleCount} Repo(s)` }}
            </button>
          </footer>
        </div>
      </div>

      <!-- Modal: Autograding Test Breakdown & Failure Logs -->
      <div v-if="showAutogradeModal && activeAutogradeItem" class="modal-overlay" @click.self="closeAutogradeModal">
        <div class="modal card autograde-modal" role="dialog" aria-modal="true" :aria-label="`Autograding Results for ${activeAutogradeItem.github_login || activeAutogradeItem.team_slug}`" style="max-width: 650px;">
          <header class="modal-head flex justify-between items-center">
            <div class="flex items-center gap-sm">
              <Icon name="check-circle" :size="20" :class="activeAutogradeItem.ci_status === 'success' ? 'text-success' : 'text-danger'" />
              <h3 style="margin: 0;">
                Autograding: <code>{{ activeAutogradeItem.github_login || activeAutogradeItem.team_slug }}</code>
              </h3>
            </div>
            <button class="modal-close" type="button" @click="closeAutogradeModal" aria-label="Close">×</button>
          </header>

          <div class="modal-body flex flex-col gap-md" style="padding: var(--space-md);">
            <!-- Summary Banner -->
            <div class="score-banner flex justify-between items-center p-md" :class="activeAutogradeItem.ci_status === 'success' ? 'banner-success' : 'banner-warning'" style="border-radius: var(--radius-sm, 6px); border: 1px solid var(--border-color, #30363d); padding: 12px 16px;">
              <div>
                <div class="text-xs text-secondary uppercase font-semibold">Total Score</div>
                <div class="text-xl font-bold" style="font-size: 1.4rem;">
                  {{ activeAutogradeItem.earned_points != null ? `${activeAutogradeItem.earned_points} / ${activeAutogradeItem.total_points || assignment?.autograde?.points_possible || 100} pts` : (activeAutogradeItem.score || activeAutogradeItem.ci_status || 'Graded') }}
                </div>
              </div>
              <div>
                <span :class="['badge', activeAutogradeItem.ci_status === 'success' ? 'badge-success' : activeAutogradeItem.ci_status === 'failure' ? 'badge-error' : 'badge-warning']" style="font-size: 0.85rem; padding: 4px 10px;">
                  {{ activeAutogradeItem.ci_status || 'completed' }}
                </span>
              </div>
            </div>

            <!-- Test Breakdown List -->
            <div v-if="activeAutogradeItem.tests && activeAutogradeItem.tests.length" class="tests-breakdown-list flex flex-col gap-sm">
              <h4 style="margin: 0 0 4px 0;">Test Suites</h4>
              <div v-for="t in activeAutogradeItem.tests" :key="t.id" class="test-item-card p-sm" style="border: 1px solid var(--border-color, #30363d); border-radius: var(--radius-sm, 6px); padding: 10px; background: var(--bg-surface, #161b22);">
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
              <p v-if="activeAutogradeItem.repo_url" style="margin: 0;">
                View full workflow logs on GitHub Actions:
                <a :href="`${activeAutogradeItem.repo_url}/actions`" target="_blank" rel="noopener" class="link-btn" style="text-decoration: underline;">
                  Open GitHub Actions logs →
                </a>
              </p>
            </div>
          </div>

          <footer class="modal-foot flex justify-end gap-sm" style="padding: var(--space-sm) var(--space-md); border-top: 1px solid var(--border-color, #30363d);">
            <button class="btn btn-secondary" type="button" @click="closeAutogradeModal">Close</button>
          </footer>
        </div>
      </div>

      <!-- Starter Code Sync Modal -->
      <StarterSyncModal
        v-if="showStarterSyncModal && assignment"
        :assignment="assignment"
        :org="org"
        :students="report?.students || []"
        @close="showStarterSyncModal = false"
        @synced="loadData"
      />

      <!-- Modal: Freeze & Preserve Consequences Confirmation -->
      <div v-if="showFreezeConfirmModal" class="modal-overlay" @click.self="showFreezeConfirmModal = false">
        <div class="modal card modal-consequences" role="dialog" aria-modal="true" aria-label="Confirm Immediate Freeze and Lockdown" style="max-width: 560px;">
          <header class="modal-head flex justify-between items-center" style="border-bottom: 1px solid var(--border-color, #30363d); padding: 14px 18px;">
            <div class="flex items-center gap-xs">
              <Icon name="alert-triangle" :size="18" class="stat-yellow" />
              <h3 style="margin: 0; font-size: 1.05rem;">Confirm Immediate Freeze &amp; Lockdown</h3>
            </div>
            <button class="modal-close" type="button" @click="showFreezeConfirmModal = false" aria-label="Close">×</button>
          </header>
          <div class="modal-body flex flex-col gap-md" style="padding: 16px 18px;">
            <div class="card" style="background: rgba(210, 153, 34, 0.1); border: 1px solid rgba(210, 153, 34, 0.3); padding: 12px; border-radius: 6px;">
              <p class="text-sm font-semibold" style="margin-bottom: 4px; color: var(--accent-yellow, #d29922);">
                ⚠️ Immediate Submissions Lockdown
              </p>
              <p class="text-xs text-secondary" style="margin: 0;">
                You are initiating an administrative freeze for assignment <strong>{{ assignment?.id }}</strong> across all {{ eligiblePreservationCount }} student repositories.
              </p>
            </div>

            <div class="consequences-list flex flex-col gap-sm text-sm">
              <div class="consequence-item flex gap-sm items-start">
                <Icon name="lock" :size="16" class="stat-red" style="margin-top: 2px; flex-shrink: 0;" />
                <div>
                  <strong>Demotes Student Permissions to Read-Only:</strong>
                  <p class="text-xs text-secondary" style="margin: 2px 0 0 0;">
                    All students and team members will be demoted from Admin/Write to Read (<code>pull</code>). They will not be able to push new commits.
                  </p>
                </div>
              </div>

              <div class="consequence-item flex gap-sm items-start">
                <Icon name="archive" :size="16" class="stat-green" style="margin-top: 2px; flex-shrink: 0;" />
                <div>
                  <strong>Snapshots Immutable Archive Commits:</strong>
                  <p class="text-xs text-secondary" style="margin: 2px 0 0 0;">
                    The current <code>HEAD</code> commit of each student repository is cloned and committed into the private organization archive (<code>pxl-classroom-archive</code>) as the authoritative grading snapshot.
                  </p>
                </div>
              </div>

              <div class="consequence-item flex gap-sm items-start">
                <Icon name="clock" :size="16" class="stat-blue" style="margin-top: 2px; flex-shrink: 0;" />
                <div>
                  <strong>Locks Deadline Classification:</strong>
                  <p class="text-xs text-secondary" style="margin: 2px 0 0 0;">
                    The lockdown timestamp is recorded. Any future commits pushed after this moment will require an explicit lecturer deadline extension to count toward grading.
                  </p>
                </div>
              </div>
            </div>

            <footer class="modal-foot flex justify-end gap-sm" style="padding-top: 14px; border-top: 1px solid var(--border-color, #30363d); margin-top: 6px;">
              <button class="btn btn-secondary" type="button" @click="showFreezeConfirmModal = false">
                Cancel
              </button>
              <button
                class="btn btn-danger btn-with-icon"
                type="button"
                :disabled="freezingNow"
                @click="executeFreezeNow"
              >
                <Icon name="lock" :size="14" />
                <span>{{ freezingNow ? 'Executing Lockdown…' : 'Confirm Freeze &amp; Lockdown' }}</span>
              </button>
            </footer>
          </div>
        </div>
      </div>
    </main>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue'
import { h } from 'vue'
import UserBadge from '../components/UserBadge.vue'
import Icon from '../components/Icon.vue'
import TeamsTable from '../components/TeamsTable.vue'
import StarterSyncModal from '../components/StarterSyncModal.vue'

// Tiny render helper - keeps the table markup readable. `dir` is "asc" |
// "desc" | null; null renders nothing so non-active columns stay quiet.
const SortIcon = (props) => props.dir
  ? h(Icon, { name: props.dir === 'asc' ? 'arrow-up' : 'arrow-down', size: 11, class: 'sort-glyph' })
  : null
SortIcon.props = ['dir']
import { config } from '../lib/config.js'
import { getToken, getUser, clearAuth, isAuthenticated, startDeviceFlow, pollDeviceFlow } from '../lib/auth.js'
import { getRepoContent, listRepoDir, ghApi, commitFile, triggerWorkflow, explainDispatchFailure, totalFromLinkHeader, getRepo, getWorkflowRuns } from '../lib/api.js'
import { validateAgainst } from '../lib/validate.js'
import { formatDate } from '../lib/format.js'
import { toast } from '../lib/toast.js'
import { buildDashboardEntry } from '../../../lib/dashboard-aggregate.mjs'
import DeviceFlowCard from '../components/DeviceFlowCard.vue'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

const REFRESH_CONCURRENCY = 6

const props = defineProps({
  org: { type: String, required: true },
  assignmentId: { type: String, required: true },
})

const user = ref(getUser())
const loading = ref(true)
const report = ref(null)
const assignment = ref(null)
const loadError = ref(null)
const togglingState = ref(false)
const viewTab = ref('teams')

const isGroupAssignment = computed(() =>
  assignment.value?.assignment_type === 'group' || (report.value?.teams && report.value.teams.length > 0)
)

async function toggleAcceptanceState() {
  const token = getToken()
  if (!token || !assignment.value) return
  const currentState = assignment.value.state || 'published'
  const nextState = currentState === 'published' ? 'closed' : 'published'

  const confirmMsg = nextState === 'closed'
    ? `Close acceptance for "${props.assignmentId}"? Students can no longer accept new repositories (existing accepted repositories are unaffected).`
    : `Open acceptance for "${props.assignmentId}"? Students with the link can now accept and get their repositories.`

  if (!window.confirm(confirmMsg)) return

  togglingState.value = true
  try {
    const path = `assignments/${props.assignmentId}.yml`
    const updatedDoc = { ...assignment.value, state: nextState }
    const yamlStr = stringifyYaml(updatedDoc)
    const res = await commitFile(token, props.org, config.controlRepo, path, yamlStr, `Set ${props.assignmentId} state to ${nextState}`)
    if (res.ok) {
      assignment.value.state = nextState
      toast.success(`Acceptance is now ${nextState === 'published' ? 'OPEN' : 'CLOSED'}`)
    } else {
      toast.error(`Failed to change state: ${res.data?.message || 'unknown error'}`)
    }
  } catch (e) {
    toast.error(`Failed to update state: ${e.message}`)
  } finally {
    togglingState.value = false
  }
}

// All dates in this view render in the assignment's display timezone
// (assignment.timezone, set in the Admin Panel), falling back to the
// configured default inside formatDate.
const fmt = (iso) => formatDate(iso, assignment.value?.timezone)
const search = ref('')
const statusFilter = ref('')
const sortKey = ref('github_login')
const sortAsc = ref(true)

const autogradeSummary = ref(null)
const refreshingLive = ref(false)
const totalStudentsToRefresh = ref(0)
const refreshedStudentsCount = ref(0)
const liveRefreshedAt = ref(null)
const rateLimit = ref({ remaining: null, limit: null })

// Per-row action modal (Grant extension / Retry acceptance)
const actionStudent = ref(null)
const actionExt = ref({ deadline_local: '', reason: '' })
const actionExtending = ref(false)
const actionRetrying = ref(false)
const modalEl = ref(null)
let modalReturnFocus = null

// "Run daily activity now" - dispatch + watch for the first report to land.
const dailyTriggering = ref(false)
const dailyWatch = ref('') // '' | 'watching' | 'timeout'
const dailyPollCount = ref(0)
let dailyPollTimer = null

async function runDailyActivity() {
  const token = getToken()
  if (!token) return
  dailyTriggering.value = true
  try {
    const res = await triggerWorkflow(token, config.hubOwner, config.hubRepo, 'daily-activity.yml', { org: props.org })
    if (res.ok || res.status === 204) {
      toast.success('Daily activity triggered. Watching for the report…')
      startDailyWatch()
    } else {
      toast.error(explainDispatchFailure(res, 'Trigger failed'))
    }
  } finally {
    dailyTriggering.value = false
  }
}

function startDailyWatch() {
  stopDailyWatch()
  dailyWatch.value = 'watching'
  dailyPollCount.value = 0
  const tick = async () => {
    dailyPollCount.value++
    const token = getToken()
    if (token) {
      const content = await getRepoContent(token, props.org, config.controlRepo, `reports/${props.assignmentId}.json`)
      if (content) {
        try {
          report.value = JSON.parse(content)
          if (report.value.live_refreshed_at) liveRefreshedAt.value = report.value.live_refreshed_at
          dailyWatch.value = ''
          toast.success('Report ready.')
          return
        } catch { /* half-written file - keep polling */ }
      }
    }
    if (dailyPollCount.value >= 30) { // 30 × 10s = 5 minutes
      dailyWatch.value = 'timeout'
      return
    }
    dailyPollTimer = setTimeout(tick, 10000)
  }
  dailyPollTimer = setTimeout(tick, 10000)
}

function stopDailyWatch() {
  if (dailyPollTimer) {
    clearTimeout(dailyPollTimer)
    dailyPollTimer = null
  }
}

const onTimeCount = computed(() => report.value?.students.filter((s) => s.submission_status === 'on-time').length || 0)
const lateCount = computed(() => report.value?.students.filter((s) => s.submission_status === 'late').length || 0)
const noSubCount = computed(() => report.value?.students.filter((s) => s.submission_status === 'no-submission').length || 0)
const feedbackPrEnabled = computed(() => assignment.value?.feedback_pr === true)
const autogradeEnabled = computed(() => assignment.value?.autograde?.enabled === true)
const isGitHubActionsAutograde = computed(() => autogradeEnabled.value && assignment.value?.autograde?.execution_environment === 'github_actions')
const preservedCount = computed(() => (report.value?.students || []).filter((s) => s.preservation_status === 'preserved' && s.preserved_sha).length)
const eligiblePreservationCount = computed(() =>
  (report.value?.students || []).filter((s) => s.repo_name && s.acceptance_state === 'accepted').length
)
const unpreservedCount = computed(() =>
  (report.value?.students || []).filter(
    (s) => s.repo_name && s.acceptance_state === 'accepted' && !(s.preservation_status === 'preserved' && s.preserved_sha)
  ).length
)
const allPreserved = computed(() =>
  eligiblePreservationCount.value > 0 && preservedCount.value >= eligiblePreservationCount.value
)
const preservationLockdownTime = computed(() => {
  const s = (report.value?.students || []).find((s) => s.lock_down_at)
  return s?.lock_down_at || report.value?.lockdown_at || null
})
const preservationUncertaintySeconds = computed(() => {
  const s = (report.value?.students || []).find((s) => s.uncertainty_interval_seconds != null)
  return s?.uncertainty_interval_seconds ?? report.value?.uncertainty_seconds ?? null
})

const showStarterSyncModal = ref(false)
const openingFeedbackPrs = ref(false)
const retryingPreservation = ref(false)
const showFreezeConfirmModal = ref(false)
const freezingNow = ref(false)

async function executeFreezeNow() {
  const token = getToken()
  if (!token) return
  freezingNow.value = true
  try {
    const res = await triggerWorkflow(token, config.hubOwner, config.hubRepo, 'daily-activity.yml', 'main', {
      'collection-type': 'deadline',
      'assignment-id': props.assignmentId,
    })
    if (res.ok) {
      toast.success('Lockdown and preservation workflow triggered successfully.')
      showFreezeConfirmModal.value = false
    } else {
      toast.error(`Failed to trigger lockdown: ${res.error || 'Unknown error'}`)
    }
  } catch (err) {
    toast.error(`Failed to execute lockdown: ${err.message}`)
  } finally {
    freezingNow.value = false
  }
}

const activeAutogradeItem = ref(null)
const showAutogradeModal = ref(false)

function openAutogradeModal(item) {
  activeAutogradeItem.value = item
  showAutogradeModal.value = true
}

function closeAutogradeModal() {
  activeAutogradeItem.value = null
  showAutogradeModal.value = false
}

async function retryPreservation() {
  const token = getToken()
  if (!token) return
  retryingPreservation.value = true
  try {
    const res = await triggerWorkflow(token, config.hubOwner, config.hubRepo, 'daily-activity.yml', 'main', {})
    if (res.ok) {
      toast.success('Preservation workflow dispatched.')
    } else {
      toast.error(`Failed to trigger preservation: ${res.error || 'Unknown error'}`)
    }
  } catch (err) {
    toast.error(`Failed to retry preservation: ${err.message}`)
  } finally {
    retryingPreservation.value = false
  }
}

const showFeedbackPrModal = ref(false)
const feedbackPrCandidates = computed(() =>
  (report.value?.students || []).filter(
    (s) => s.repo_name && (s.commit_count > 0 || s.latest_observed_sha) && !s.feedback_pr_number
  )
)
const feedbackPrEligibleCount = computed(() => feedbackPrCandidates.value.length)
const feedbackPrAlreadyOpenedCount = computed(() =>
  (report.value?.students || []).filter((s) => s.feedback_pr_number).length
)
const feedbackPrSkippedNoCommitsCount = computed(() =>
  (report.value?.students || []).filter(
    (s) => s.repo_name && !s.feedback_pr_number && !(s.commit_count > 0 || s.latest_observed_sha)
  ).length
)

function openFeedbackPrs() {
  showFeedbackPrModal.value = true
}

async function executeOpenFeedbackPrs() {
  const token = getToken()
  if (!token || !report.value) return

  const targets = feedbackPrCandidates.value
  if (targets.length === 0) {
    toast.info('No eligible student repositories to open Feedback PRs for.')
    return
  }

  openingFeedbackPrs.value = true
  const baseline = assignment.value?.feedback_pr_baseline_branch || 'pxl-baseline'
  const title = `${assignment.value?.title || props.assignmentId} - Feedback`
  const body = 'PXL Classroom feedback thread for inline reviews.'

  let opened = 0
  let failed = 0

  for (const s of targets) {
    const repoName = s.repo_name?.split('/')[1] || s.repo_name
    try {
      const prRes = await ghApi(token, 'POST', `/repos/${props.org}/${repoName}/pulls`, {
        title,
        body,
        head: 'main',
        base: baseline,
        draft: true,
      })

      if (prRes.ok && prRes.data) {
        opened++
        s.feedback_pr_number = prRes.data.number
        s.feedback_pr_url = prRes.data.html_url

        try {
          const recPath = `repositories/${props.assignmentId}/${s.github_login}.json`
          const existingContent = await getRepoContent(token, props.org, config.controlRepo, recPath)
          if (existingContent) {
            const recDoc = JSON.parse(existingContent)
            recDoc.feedback_pr_number = prRes.data.number
            recDoc.feedback_pr_url = prRes.data.html_url
            await commitFile(
              token,
              props.org,
              config.controlRepo,
              recPath,
              JSON.stringify(recDoc, null, 2) + '\n',
              `Record feedback PR #${prRes.data.number} for ${s.github_login}`
            )
          }
        } catch (commitErr) {
          console.warn(`Failed to commit repo record for ${s.github_login}:`, commitErr)
        }
      } else {
        failed++
      }
    } catch {
      failed++
    }
  }

  openingFeedbackPrs.value = false
  showFeedbackPrModal.value = false
  if (opened > 0) {
    toast.success(`Successfully opened ${opened} feedback PR(s).`)
  }
  if (failed > 0) {
    toast.warning(`${failed} PR creation(s) skipped or failed.`)
  }
}

const autogradeTotalPoints = computed(() => (assignment.value?.autograde?.tests || []).reduce((sum, t) => sum + (t.points || 0), 0))
const syncingGrades = ref(false)
const syncedGradesCount = ref(0)
const totalGradesToSync = ref(0)

// CI-derived summaries carry a single pass/fail conclusion, not per-test
// points - display them as such instead of implying granular grading.
const summaryIsCiBased = computed(() => autogradeSummary.value?.runner === 'github_actions')

// login -> override doc from overrides/<assignment>/<login>.json, so granted
// extensions are visible (and inspectable before granting again).
const overridesByLogin = ref(new Map())
const rosterByLogin = ref(new Map())
const userProfilesByLogin = ref(new Map())
const profileCache = new Map()

async function fetchUserProfile(token, login) {
  if (!login) return null
  const key = login.toLowerCase()
  if (profileCache.has(key)) return profileCache.get(key)
  try {
    const res = await ghApi(token, 'GET', `/users/${login}`)
    if (res.ok && res.data) {
      profileCache.set(key, res.data)
      return res.data
    }
  } catch {
    // ignore
  }
  return null
}

function isBot(str) {
  if (!str) return false
  const s = str.toLowerCase()
  return s.includes('[bot]') || s.includes('provisioner') || s === 'github' || s === 'web-flow'
}

function studentTooltip(s) {
  const roster = rosterByLogin.value.get(s.github_login?.toLowerCase())
  const profile = userProfilesByLogin.value.get(s.github_login?.toLowerCase())

  // Real email from roster, commit, or GitHub public profile
  const rawEmail = s.email || roster?.email || s.author_email || profile?.email
  const realEmail = rawEmail && !rawEmail.includes('noreply.github.com') ? rawEmail : null

  // Name from roster, GitHub public profile, or non-bot Git commit author
  let fullName = s.full_name || roster?.full_name || profile?.name
  if (!fullName && s.author_name && !isBot(s.author_name)) {
    fullName = s.author_name
  }
  if (fullName && fullName.toLowerCase() === s.github_login.toLowerCase()) {
    fullName = null
  }

  const studentNr = s.student_number || roster?.student_number
  const classGroup = s.class_group || roster?.class_group

  const meta = []
  if (classGroup) meta.push(classGroup)
  if (studentNr) meta.push(`s${String(studentNr).replace(/^s/i, '')}`)
  if (profile?.company && !meta.includes(profile.company)) meta.push(profile.company)
  const metaStr = meta.length > 0 ? ` (${meta.join(' · ')})` : ''

  if (realEmail) {
    return fullName ? `${realEmail} - ${fullName}${metaStr}` : `${realEmail}${metaStr}`
  }
  if (fullName) {
    return `${fullName}${metaStr}`
  }
  return null
}

// Base columns: login, acceptance, status, repo, last commit,
// commits, actions - plus the four conditional columns (CI, Feedback PR, Warnings, Submit tag).
const hasWarnings = computed(() =>
  (report.value?.students || []).some(s => s.warnings && s.warnings.length > 0))

const hasSubmitTags = computed(() =>
  (report.value?.students || []).some(s => !!s.tagged_submission_tag))

const tableColumnCount = computed(() =>
  7 +
  (isGitHubActionsAutograde.value ? 1 : 0) +
  (feedbackPrEnabled.value ? 1 : 0) +
  (hasWarnings.value ? 1 : 0) +
  (hasSubmitTags.value ? 1 : 0))

function extensionFor(login) {
  const doc = overridesByLogin.value.get(login)
  const ext = (doc?.overrides || []).filter((o) => o.type === 'deadline_extension').pop()
  return ext || null
}

const WARNING_MAP = {
  'missing-repo-id': {
    label: 'missing repo ID',
    desc: 'The repository record is missing a GitHub repository ID. Run Setup Org or reconcile registry.'
  },
  'accepted-not-provisioned': {
    label: 'accepted not provisioned',
    desc: 'The student accepted the assignment, but no repository has been provisioned yet. Try triggering a retry acceptance.'
  },
  'late-activity-detected': {
    label: 'late activity',
    desc: 'Commits were detected after the student\'s effective deadline.'
  },
  'deadline-gap': {
    label: 'deadline gap',
    desc: 'There is a large uncertainty interval between the student\'s last on-time push and the deadline.'
  }
}

function getWarningLabel(w) {
  return WARNING_MAP[w]?.label || w
}

function getWarningDesc(w) {
  return WARNING_MAP[w]?.desc || ''
}

// Deadline source of truth: the current assignment YAML (so a Live Status
// refresh after a deadline change reclassifies correctly), with the report's
// per-student effective_deadline_at as a fallback.
const currentDeadline = computed(() => {
  return assignment.value?.deadline_at || report.value?.students?.[0]?.effective_deadline_at || null
})
const deadlinePassed = computed(() => {
  if (!currentDeadline.value) return false
  return new Date(currentDeadline.value).getTime() < Date.now()
})
const deadlineRelative = computed(() => currentDeadline.value ? formatRelative(currentDeadline.value) : '')
const deadlineAbs = computed(() => {
  return currentDeadline.value ? fmt(currentDeadline.value) : ''
})

const filteredStudents = computed(() => {
  let list = report.value?.students || []
  if (search.value) {
    const q = search.value.toLowerCase().trim()
    list = list.filter((s) => {
      const roster = rosterByLogin.value.get(s.github_login?.toLowerCase())
      const profile = userProfilesByLogin.value.get(s.github_login?.toLowerCase())
      const fullName = (s.name || s.full_name || roster?.name || roster?.full_name || profile?.name || (!isBot(s.author_name) ? s.author_name : '') || '').toLowerCase()
      const email = (s.email || roster?.email || s.author_email || profile?.email || '').toLowerCase()
      const studentNr = (s.student_number || roster?.student_number || '').toLowerCase()
      const classGroup = (s.class_group || roster?.class_group || '').toLowerCase()
      const company = (profile?.company || '').toLowerCase()
      return s.github_login.toLowerCase().includes(q) ||
             (s.repo_name && s.repo_name.toLowerCase().includes(q)) ||
             fullName.includes(q) ||
             email.includes(q) ||
             studentNr.includes(q) ||
             classGroup.includes(q) ||
             company.includes(q)
    })
  }
  if (statusFilter.value) {
    if (statusFilter.value === 'preserved') {
      list = list.filter((s) => s.preservation_status === 'preserved' && s.preserved_sha)
    } else {
      list = list.filter((s) => s.submission_status === statusFilter.value)
    }
  }
  list = [...list].sort((a, b) => {
    let av = a[sortKey.value]
    let bv = b[sortKey.value]
    if (sortKey.value === 'latest_observed_at') {
      av = a.commit_date || a.latest_commit_date || a.latest_observed_at
      bv = b.commit_date || b.latest_commit_date || b.latest_observed_at
    }
    // Nulls last regardless of direction
    if (av == null && bv == null) return 0
    if (av == null) return 1
    if (bv == null) return -1
    const cmp = typeof av === 'number' && typeof bv === 'number'
      ? av - bv
      : String(av).localeCompare(String(bv))
    return sortAsc.value ? cmp : -cmp
  })
  return list
})

// Export Dropdown Menu State
const exportDropdownOpen = ref(false)
const exportDropdownRef = ref(null)

function toggleExportDropdown() {
  exportDropdownOpen.value = !exportDropdownOpen.value
}

function handleExportCSV() {
  exportDropdownOpen.value = false
  exportCSV()
}

function handleDownloadManifest() {
  exportDropdownOpen.value = false
  downloadManifest()
}

function handleCopyDownloadCmd() {
  exportDropdownOpen.value = false
  copyDownloadCmd()
}

function handleCopyGradeCmd() {
  exportDropdownOpen.value = false
  copyGradeCmd()
}

function onDocumentClick(e) {
  if (exportDropdownRef.value && !exportDropdownRef.value.contains(e.target)) {
    exportDropdownOpen.value = false
  }
}

function onKeydown(e) {
  if (e.key === 'Escape') {
    if (exportDropdownOpen.value) exportDropdownOpen.value = false
    if (actionStudent.value) closeActions()
    if (showBreakdown.value) showBreakdown.value = false
  }
}

onMounted(async () => {
  window.addEventListener('keydown', onKeydown)
  document.addEventListener('click', onDocumentClick)
  if (!isAuthenticated()) { loading.value = false; return }
  user.value = getUser()
  await loadAll()
})

// Device-flow sign-in for deep links opened without a session. Failures
// render inside the auth card (authError), never a misleading empty state.
const authLoading = ref(false)
const authError = ref(null)
const deviceFlow = ref(null)
let pollAbort = null

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
    loading.value = true
    await loadAll()
  } catch (e) {
    if (e.message !== 'Cancelled') authError.value = e.message
    deviceFlow.value = null
  }
  authLoading.value = false
}

function cancelLogin() {
  if (pollAbort) pollAbort.abort()
  deviceFlow.value = null
  authLoading.value = false
}

async function loadAll() {
  const token = getToken()
  if (!token) { loading.value = false; return }
  loadError.value = null
  try {
    const [reportContent, assignmentContent, rosterContent] = await Promise.all([
      getRepoContent(token, props.org, config.controlRepo, `reports/${props.assignmentId}.json`),
      getRepoContent(token, props.org, config.controlRepo, `assignments/${props.assignmentId}.yml`),
      getRepoContent(token, props.org, config.controlRepo, 'students/roster.yml'),
    ])
    if (reportContent) {
      report.value = JSON.parse(reportContent)
      if (report.value.live_refreshed_at) liveRefreshedAt.value = report.value.live_refreshed_at
    }
    if (assignmentContent) {
      assignment.value = parseYaml(assignmentContent)
    }
    if (rosterContent) {
      try {
        const parsed = parseYaml(rosterContent)
        const list = Array.isArray(parsed?.students) ? parsed.students : (Array.isArray(parsed) ? parsed : [])
        const map = new Map()
        for (const s of list) {
          if (s.github_login) map.set(s.github_login.toLowerCase(), s)
        }
        rosterByLogin.value = map
      } catch (e) {
        console.warn('Failed to parse roster:', e)
      }
    }

    if (report.value && assignment.value?.feedback_pr === true) {
      await mergeRepoRecordsIntoReport(token)
    }
    if (assignment.value?.autograde?.enabled === true) {
      const sum = await getRepoContent(token, props.org, config.controlRepo, `grading/${props.assignmentId}/summary.json`)
      if (sum) {
        try { autogradeSummary.value = JSON.parse(sum) } catch { /* malformed */ }
      }
    }
    await Promise.all([
      loadOverrides(token),
      fetchRateLimit(token),
    ])
  } catch (e) {
    console.error('Failed to load report:', e)
    loadError.value = e.message || String(e)
  }
  loading.value = false
}

async function fetchRateLimit(token) {
  if (!token) return
  try {
    const rl = await ghApi(token, 'GET', '/rate_limit')
    if (rl.ok && rl.data?.resources?.core) {
      rateLimit.value = {
        remaining: rl.data.resources.core.remaining,
        limit: rl.data.resources.core.limit,
      }
    }
  } catch (e) {
    console.error('Failed to fetch rate limit:', e)
  }
}

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
  document.removeEventListener('click', onDocumentClick)
  stopDailyWatch()
  if (retryPollTimer) {
    clearTimeout(retryPollTimer)
    retryPollTimer = null
  }
})

// Best-effort: surface granted deadline extensions in the table + modal.
async function loadOverrides(token) {
  try {
    const files = await listRepoDir(token, props.org, config.controlRepo, `overrides/${props.assignmentId}`)
    const jsonFiles = (files || []).filter((f) => f.type === 'file' && f.name.endsWith('.json'))
    const map = new Map()
    await Promise.all(jsonFiles.map(async (f) => {
      const text = await getRepoContent(token, props.org, config.controlRepo, f.path)
      if (!text) return
      try {
        const doc = JSON.parse(text)
        if (doc?.github_login) map.set(doc.github_login, doc)
      } catch { /* malformed */ }
    }))
    overridesByLogin.value = map
  } catch (e) {
    console.error('Failed to load overrides:', e)
  }
}

// Walks repositories/<assignment-id>/*.json and stitches feedback_pr_number
// + feedback_pr_url onto each matching report student row. Best-effort: a
// missing record (drift) just leaves the row's PR fields null.
async function mergeRepoRecordsIntoReport(token) {
  try {
    const files = await listRepoDir(token, props.org, config.controlRepo, `repositories/${props.assignmentId}`)
    const jsonFiles = (files || []).filter((f) => f.type === 'file' && f.name.endsWith('.json'))
    const records = await Promise.all(
      jsonFiles.map(async (f) => {
        const text = await getRepoContent(token, props.org, config.controlRepo, f.path)
        if (!text) return null
        try { return JSON.parse(text) } catch { return null }
      }),
    )
    const byLogin = new Map()
    for (const r of records) {
      if (r?.github_login) byLogin.set(r.github_login, r)
    }
    for (const s of report.value.students || []) {
      const r = byLogin.get(s.github_login)
      if (!r) continue
      s.feedback_pr_number = r.feedback_pr_number ?? null
      s.feedback_pr_url = r.feedback_pr_url ?? null
    }
  } catch (e) {
    console.error('Failed to merge repository records:', e)
  }
}

function handleLogout() {
  clearAuth()
  window.location.href = import.meta.env.BASE_URL
}

function sortBy(key) {
  if (sortKey.value === key) sortAsc.value = !sortAsc.value
  else { sortKey.value = key; sortAsc.value = true }
}
// Returns 'asc' | 'desc' | null - consumed by the <SortIcon> render helper
// so the active column shows a directional arrow, the rest show nothing.
function sortDir(key) {
  if (sortKey.value !== key) return null
  return sortAsc.value ? 'asc' : 'desc'
}

function ariaSort(key) {
  if (sortKey.value !== key) return 'none'
  return sortAsc.value ? 'ascending' : 'descending'
}

function statusBadge(status) {
  return { 'on-time': 'badge-success', late: 'badge-warning', 'no-submission': 'badge-error', unknown: 'badge-neutral' }[status] || 'badge-neutral'
}
function acceptBadge(state) {
  return { provisioned: 'badge-success', accepted: 'badge-info', failed: 'badge-error', 'not-accepted': 'badge-neutral' }[state] || 'badge-neutral'
}

function shortRepo(name) {
  if (!name) return ''
  return name.includes('/') ? name.split('/')[1] : name
}

// `submit/2026-10-05T20:34:11Z-a1b2c3d` -> `a1b2c3d` (short SHA suffix) so the
// column stays narrow. Full tag name is on hover via title.
function shortTag(tag) {
  if (!tag) return ''
  const dash = tag.lastIndexOf('-')
  return dash >= 0 ? tag.slice(dash + 1) : tag
}

function latestSha(s) {
  return s.latest_observed_sha || s.last_on_time_sha || null
}

function commitTime(s) {
  return s.commit_date || s.latest_commit_date || s.latest_observed_at || null
}

function commitMsg(s) {
  if (s.commit_message) return s.commit_message
  if (s.latest_commit_message) return s.latest_commit_message
  if (s.commit_count === 1) return 'Initial commit'
  return null
}

// Always a duration, never a date: the result is wrapped in "in …" / "… ago",
// so an absolute date here reads as "in 30 Aug 2026". Every caller already
// shows the exact timestamp alongside (the deadline card's label, or a title
// tooltip), so this only ever needs to answer "how long?".
function formatRelative(iso) {
  if (!iso) return ''
  const diffMs = Date.now() - new Date(iso).getTime()
  if (Number.isNaN(diffMs)) return ''
  const abs = Math.abs(diffMs)
  const future = diffMs < 0
  const min = 60_000, hr = 3_600_000, day = 86_400_000
  let s
  if (abs < hr) s = `${Math.max(1, Math.round(abs / min))}m`
  else if (abs < day) s = `${Math.round(abs / hr)}h`
  else if (abs < 60 * day) s = `${Math.round(abs / day)}d`
  else if (abs < 730 * day) s = `${Math.round(abs / (30 * day))}mo`
  else s = `${Math.round(abs / (365 * day))}y`
  return future ? `in ${s}` : `${s} ago`
}

// Same column set as report.mjs's nightly CSV, but generated from the report
// currently on screen - so an export taken after a Live Status refresh can
// never contradict the table the lecturer just looked at.
const CSV_HEADERS = [
  'github_login', 'student_number', 'full_name', 'class_group',
  'team_slug', 'team_name',
  'acceptance_state', 'submission_status', 'effective_deadline_at',
  'override_applied', 'override_reason', 'repo_name', 'repo_url',
  'last_on_time_sha', 'last_on_time_observed_at', 'first_late_sha',
  'first_late_observed_at', 'latest_observed_sha', 'latest_observed_at',
  'commit_count',
  'ci_status', 'earned_points', 'total_points',
  'feedback_pr_number', 'feedback_pr_url',
  'uncertainty_interval_seconds', 'tagged_submission_tag',
  'tagged_submission_sha', 'tagged_submission_observed_at',
  'tagged_submission_declared_at', 'lock_down_at', 'preservation_status',
  'preserved_sha', 'warnings',
]

function csvCell(v) {
  if (v === null || v === undefined) return ''
  let str = Array.isArray(v) ? v.join('; ') : String(v)
  if (/^[=\+\-@]/.test(str)) {
    str = `'${str}`
  }
  return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str
}

function exportCSV() {
  const students = report.value?.students || []
  if (students.length === 0) {
    toast.info('No students in the report to export.')
    return
  }
  const rows = [CSV_HEADERS.join(',')]
  for (const s of students) {
    rows.push(CSV_HEADERS.map((h) => csvCell(s[h])).join(','))
  }
  // UTF-8 BOM so Excel decodes accented names correctly.
  const blob = new Blob(['﻿' + rows.join('\n') + '\n'], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${props.assignmentId}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

function copyAcceptLink() {
  const base = window.location.origin + (import.meta.env.BASE_URL || '/')
  // Route shape is /:org/a/:assignmentId - the org segment is required.
  const link = `${base}${props.org}/a/${props.assignmentId}`
  navigator.clipboard.writeText(link).then(
    () => toast.success(`Invitation link copied: ${link}`),
    () => toast.error('Could not copy link'),
  )
}

// Manifest of preserved submissions - login + archive SHA + clickable
// archive branch URL. Power users do the actual bulk clone via the CLI; the
// browser can't (and the manifest is enough to drive plagiarism tooling).
function downloadManifest() {
  if (!report.value) return
  const eligible = (report.value.students || []).filter(
    (s) => s.preservation_status === 'preserved' && s.preserved_sha,
  )
  if (eligible.length === 0) {
    toast.info('No preserved submissions in the report yet.')
    return
  }
  const rows = eligible.map((s) => ({
    login: s.github_login,
    archive_sha: s.preserved_sha,
    archive_branch: `preserved/${props.assignmentId}/${s.github_login}`,
    archive_branch_url: `https://github.com/${props.org}/pxl-classroom-archive/tree/${encodeURIComponent(`preserved/${props.assignmentId}/${s.github_login}`)}`,
    downloaded_at: null,
  }))
  const manifest = {
    schema_version: 1,
    org: props.org,
    assignment_id: props.assignmentId,
    generated_at: new Date().toISOString(),
    students: rows,
  }
  const blob = new Blob([JSON.stringify(manifest, null, 2) + '\n'], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${props.assignmentId}-manifest.json`
  a.click()
  URL.revokeObjectURL(url)
}

function copyDownloadCmd() {
  const cmd = `pxl-classroom download --org ${props.org} --assignment ${props.assignmentId} --dir ./${props.assignmentId} --concurrency 4`
  navigator.clipboard.writeText(cmd).then(
    () => toast.success('CLI command copied'),
    () => toast.error('Could not copy command'),
  )
}

function copyGradeCmd() {
  const cmd = `pxl-classroom grade --org ${props.org} --assignment ${props.assignmentId} --runner docker --concurrency 2`
  navigator.clipboard.writeText(cmd).then(
    () => toast.success('CLI command copied'),
    () => toast.error('Could not copy command'),
  )
}

function clearFilters() {
  search.value = ''
  statusFilter.value = ''
}

// Returns true when the row was refreshed, false on any API failure - the
// caller counts failures so a partial refresh is never presented (or saved)
// as a complete one.
async function refreshOne(token, s) {
  if (s.lock_down_at) {
    refreshedStudentsCount.value++
    return true
  }
  try {
    const res = await ghApi(token, 'GET', `/repos/${s.repo_name}/commits?per_page=1`)
    if (!res.ok) return false

    s.commit_count = totalFromLinkHeader(res.headers, res.data)

    if (res.ok && res.data && res.data.length > 0) {
      const commit = res.data[0]
      const sha = commit.sha
      const commitDate = commit.commit?.committer?.date || commit.commit?.author?.date || null
      const commitMessage = commit.commit?.message || null

      // Source of truth for the deadline: per-student override (already on
      // the record), else the current assignment YAML's deadline_at. Fixes
      // the case where the report.json was written before the deadline was
      // set, leaving effective_deadline_at null on each student.
      const effectiveSource = s.effective_deadline_at || assignment.value?.deadline_at
      const deadline = effectiveSource ? new Date(effectiveSource) : null
      if (effectiveSource && !s.effective_deadline_at) s.effective_deadline_at = effectiveSource

      s.commit_date = commitDate
      s.latest_commit_date = commitDate
      s.commit_message = commitMessage
      s.latest_commit_message = commitMessage
      s.latest_observed_sha = sha
      s.latest_observed_at = new Date().toISOString()

      const authorName = commit.commit?.author?.name || null
      const authorEmail = commit.commit?.author?.email || null
      if (authorName && authorName !== s.github_login && !isBot(authorName)) {
        s.author_name = authorName
      }
      if (authorEmail && !authorEmail.includes('noreply.github.com')) {
        s.author_email = authorEmail
      }

      const isUnstarted = (s.commit_count != null ? s.commit_count <= 1 : false) && !s.tagged_submission_tag
      if (isUnstarted) {
        s.submission_status = 'no-submission'
      } else if (deadline) {
        if (new Date() <= deadline) {
          s.submission_status = 'on-time'
          s.last_on_time_sha = sha
        } else {
          // Post-deadline commit. Nightly semantics: an on-time submission on
          // record keeps the student on-time - late *activity* is not a late
          // *submission*. Only classify 'late' when nothing on-time exists.
          s.first_late_sha = s.first_late_sha || sha
          if (!s.last_on_time_sha) {
            s.submission_status = 'late'
          }
        }
      } else {
        s.submission_status = 'unknown'
      }

      // Fetch CI status if github actions. s.repo_name is already org/repo.
      if (isGitHubActionsAutograde.value) {
        const checkRes = await ghApi(token, 'GET', `/repos/${s.repo_name}/commits/${sha}/check-runs`)
        if (checkRes.ok && checkRes.data?.check_runs) {
          const run = checkRes.data.check_runs.find(r => r.name.toLowerCase().includes('grade') || r.name.toLowerCase().includes('autograde')) || checkRes.data.check_runs[0]
          if (run) s.ci_status = run.conclusion || run.status
        }
      }
    } else if (res.ok && res.data && res.data.length === 0) {
      s.submission_status = 'no-submission'
    }
    return true
  } catch (e) {
    console.error(`Failed to fetch live status for ${s.repo_name}:`, e)
    return false
  } finally {
    refreshedStudentsCount.value++
  }
}

async function refreshLiveStatus() {
  const token = getToken()
  if (!token || !report.value) return

  // Clone the students array and the student objects themselves.
  const clonedStudents = report.value.students.map(s => ({ ...s }))

  const queue = clonedStudents.filter(s => s.repo_name)
  if (queue.length === 0) {
    toast.info('No provisioned repositories to check.')
    return
  }

  refreshingLive.value = true
  totalStudentsToRefresh.value = queue.length
  refreshedStudentsCount.value = 0

  let cursor = 0
  let failedCount = 0
  const worker = async () => {
    while (cursor < queue.length) {
      const s = queue[cursor++]
      const ok = await refreshOne(token, s)
      if (!ok) failedCount++
    }
  }
  const workers = Array.from({ length: Math.min(REFRESH_CONCURRENCY, queue.length) }, worker)
  await Promise.all(workers)

  // Fetch rate-limit headroom (one extra call, doesn't count against core)
  await fetchRateLimit(token)

  // A partial refresh must never be presented - or persisted - as a complete
  // one. Surface the failure count and leave the control repo untouched.
  if (failedCount > 0) {
    toast.error(
      `Refreshed ${queue.length - failedCount} of ${queue.length} students; ${failedCount} failed` +
      `${rateLimit.value.remaining === 0 ? ' (API rate limit exhausted)' : ''}. Nothing was saved; try again later.`,
    )
    refreshingLive.value = false
    return
  }

  // Success! Swap the refreshed students back in.
  for (const refreshedStudent of queue) {
    const idx = report.value.students.findIndex(s => s.github_login === refreshedStudent.github_login)
    if (idx !== -1) {
      report.value.students[idx] = refreshedStudent
    }
  }

  // Re-aggregate teams if this is a group assignment
  if (report.value.teams && Array.isArray(report.value.teams)) {
    for (const team of report.value.teams) {
      const members = team.members || []
      const memberStudents = report.value.students.filter((s) =>
        members.some((m) => m && s.github_login && m.toLowerCase() === s.github_login.toLowerCase())
      )
      const firstMember = memberStudents[0]
      if (firstMember) {
        team.repo_name = team.repo_name || firstMember.repo_name || null
        team.repo_url = team.repo_url || firstMember.repo_url || null
        team.repo_id = team.repo_id || firstMember.repo_id || null
        team.submission_status = firstMember.submission_status || 'no-submission'
        team.latest_observed_sha = firstMember.latest_observed_sha || null
        team.commit_count = firstMember.commit_count || null
        team.lock_down_at = firstMember.lock_down_at || null
        team.preservation_status = firstMember.preservation_status || null
        team.preserved_sha = firstMember.preserved_sha || null
      }
      if (assignment.value?.group_config?.min_team_size) {
        team.under_capacity = members.length < assignment.value.group_config.min_team_size
      }
    }
  }

  const refreshedAt = new Date().toISOString()
  liveRefreshedAt.value = refreshedAt
  report.value.live_refreshed_at = refreshedAt
  report.value.live_refreshed_by = user.value?.login || null

  // Persist the refreshed report + dashboard aggregate back to the control
  // repo so reloads (and the Dashboard view) see the up-to-date snapshot.
  try {
    const reportPath = `reports/${props.assignmentId}.json`
    const reportBody = JSON.stringify(report.value, null, 2) + '\n'
    const reportRes = await commitFile(token, props.org, config.controlRepo, reportPath, reportBody, `Live refresh: ${props.assignmentId}`)
    if (!reportRes.ok) {
      toast.error(`Refreshed locally but save failed: ${reportRes.data?.message || 'unknown error'}`)
      return
    }
    await syncDashboardAggregate(token)
    toast.success(`Status refreshed for ${totalStudentsToRefresh.value} students (saved).`)
  } catch (e) {
    console.error('Failed to persist report:', e)
    toast.error('Refreshed locally but save failed.')
  } finally {
    refreshingLive.value = false
  }
}

function parseCheckRunScore(run, defaultTotal = 0) {
  const title = run?.output?.title || ''
  const summary = run?.output?.summary || ''
  const text = run?.output?.text || ''
  const fullText = `${title}\n${summary}\n${text}`

  const match = fullText.match(/Points\s*:?\s*([0-9]+(?:\.[0-9]+)?)\s*\/\s*([0-9]+(?:\.[0-9]+)?)/i)
  if (match) {
    const earned = parseFloat(match[1])
    const total = parseFloat(match[2])
    return {
      earned,
      total,
      passed: earned >= total && total > 0,
      matched: true,
      summaryText: summary || text || title,
    }
  }

  const passed = run?.conclusion === 'success'
  return {
    earned: passed ? defaultTotal : 0,
    total: defaultTotal,
    passed,
    matched: false,
    summaryText: summary || text || title,
  }
}

async function syncGradesFromGitHub() {
  const token = getToken()
  if (!token || !report.value || !assignment.value) return
  
  // CI results are read at each student's preserved SHA (if finalized) or latest observed SHA
  const queue = report.value.students.filter(s => s.repo_name && (s.preserved_sha || s.latest_observed_sha || s.last_on_time_sha || s.tagged_submission_sha))
  if (queue.length === 0) {
    toast.info(
      'No student commit observations or preserved submissions found yet. Click Refresh to query student repositories first.',
    )
    return
  }

  totalGradesToSync.value = queue.length
  syncedGradesCount.value = 0
  syncingGrades.value = true
  const summary = { graded: [], failed: [] }

  let apiFailedCount = 0
  let cursor = 0

  const syncWorker = async () => {
    while (cursor < queue.length) {
      const s = queue[cursor++]
      const targetSha = s.preserved_sha || s.latest_observed_sha || s.last_on_time_sha || s.tagged_submission_sha
      try {
        // s.repo_name is already the full org/repo name.
        const checksReq = await ghApi(token, 'GET', `/repos/${s.repo_name}/commits/${targetSha}/check-runs`)
        if (!checksReq.ok) {
          throw new Error(`checks API fetch failed - HTTP ${checksReq.status}`)
        }
        const checkRuns = checksReq.data?.check_runs || []
        const totalFallback = (assignment.value.autograde?.tests || []).reduce((acc, t) => acc + (t.points || 0), 0)
        
        if (checkRuns.length === 0) {
          summary.failed.push({
            login: s.github_login,
            reason: `no CI run at commit ${targetSha.slice(0, 7)}`
          })
          continue
        }

        const run = checkRuns.find(r => /grad|classroom/i.test(r.name)) || checkRuns[0]
        const parsed = parseCheckRunScore(run, totalFallback)
        
        summary.graded.push({
          login: s.github_login,
          earned_points: parsed.earned,
          total_points: parsed.total > 0 ? parsed.total : totalFallback,
          graded_at: new Date().toISOString()
        })
      } catch (err) {
        apiFailedCount++
        console.error(`Sync failed for ${s.github_login}:`, err)
      } finally {
        syncedGradesCount.value++
      }
    }
  }

  try {
    const workers = Array.from({ length: Math.min(6, queue.length) }, syncWorker)
    await Promise.all(workers)

    if (apiFailedCount > 0) {
      toast.error(`CI results sync failed for ${apiFailedCount} student(s) due to API errors. Nothing was saved; try again later.`)
      syncingGrades.value = false
      return
    }

    if (summary.graded.length === 0) {
      toast.error('Sync results would contain zero graded students (all checks missing or failed). Nothing was saved to avoid overwriting pre-existing grades.')
      syncingGrades.value = false
      return
    }
    
    const summaryDoc = {
      schema_version: 1,
      assignment_id: props.assignmentId,
      generated_at: new Date().toISOString(),
      graded_by: user.value?.login,
      runner: "github_actions",
      students: summary.graded,
      failed: summary.failed,
    }
    
    const path = `grading/${props.assignmentId}/summary.json`
    const body = JSON.stringify(summaryDoc, null, 2) + '\n'
    const res = await commitFile(token, props.org, config.controlRepo, path, body, `Sync grades for ${props.assignmentId}`)
    
    if (res.ok) {
      autogradeSummary.value = summaryDoc
      toast.success(`Grades synced successfully (${summary.graded.length} graded)`)
    } else {
      toast.error(`Save failed: ${res.data?.message}`)
    }
  } catch (e) {
    console.error('Failed to sync grades', e)
    toast.error(`Failed to sync grades: ${e.message}`)
  } finally {
    syncingGrades.value = false
  }
}

// Mirror report.mjs's dashboard aggregate, but only for the assignment we
// just refreshed. Skips silently if dashboard.json doesn't exist or doesn't
// already have an entry for this assignment - we don't conjure entries.
async function syncDashboardAggregate(token) {
  try {
    const path = 'reports/dashboard.json'
    const existing = await getRepoContent(token, props.org, config.controlRepo, path)
    if (!existing) return
    const dashboard = JSON.parse(existing)
    if (!dashboard.assignments?.[props.assignmentId]) return

    const existingEntry = dashboard.assignments[props.assignmentId]
    const pseudoAssignment = {
      title: existingEntry.title,
      state: existingEntry.state,
      opens_at: existingEntry.opens_at,
      deadline_at: existingEntry.deadline_at,
      timezone: existingEntry.timezone ?? assignment.value?.timezone,
    }
    dashboard.assignments[props.assignmentId] = buildDashboardEntry(pseudoAssignment, report.value.students || [])
    dashboard.generated_at = new Date().toISOString()

    const body = JSON.stringify(dashboard, null, 2) + '\n'
    const res = await commitFile(token, props.org, config.controlRepo, path, body, `Live refresh dashboard: ${props.assignmentId}`)
    if (!res.ok) {
      console.error('Dashboard sync failed:', res.data?.message)
    }
  } catch (e) {
    console.error('Failed to sync dashboard aggregate:', e)
  }
}

// --- per-row actions ----------------------------------------------------------

function openActions(student) {
  actionStudent.value = student
  const fallbackDeadline = student.effective_deadline_at || ''
  actionExt.value = {
    deadline_local: fallbackDeadline ? toLocalInputValue(new Date(fallbackDeadline)) : '',
    reason: '',
  }
  // Move focus into the dialog; restore it to the trigger on close.
  modalReturnFocus = document.activeElement
  nextTick(() => {
    modalEl.value?.querySelector('input, textarea, select, button:not([disabled])')?.focus()
  })
}

function closeActions() {
  if (actionExtending.value || actionRetrying.value) return
  actionStudent.value = null
  modalReturnFocus?.focus?.()
  modalReturnFocus = null
}

// Keep Tab cycling inside the dialog while it is open.
function trapTab(e) {
  if (e.key !== 'Tab' || !modalEl.value) return
  const focusables = [...modalEl.value.querySelectorAll(
    'input, textarea, select, button:not([disabled]), a[href]',
  )].filter((el) => el.offsetParent !== null)
  if (focusables.length === 0) return
  const first = focusables[0]
  const last = focusables[focusables.length - 1]
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault()
    first.focus()
  }
}

function toLocalInputValue(date) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function localToUtc(localStr) {
  if (!localStr) return ''
  return new Date(localStr).toISOString()
}

async function grantExtensionFor(student) {
  if (!actionExt.value.deadline_local || !actionExt.value.reason.trim()) {
    toast.error('Deadline and reason are required.')
    return
  }
  // An extension must move the deadline forward. Guard against granting a
  // date at-or-before the student's current effective deadline (which would
  // silently shorten their time).
  const currentEffective = extensionFor(student.github_login)?.value
    || student.effective_deadline_at
    || assignment.value?.deadline_at
  if (currentEffective && new Date(localToUtc(actionExt.value.deadline_local)) <= new Date(currentEffective)) {
    toast.error(`New deadline must be after the current effective deadline (${fmt(currentEffective)}).`)
    return
  }
  actionExtending.value = true
  try {
    const token = getToken()
    let overridesList = []
    try {
      const existing = await getRepoContent(token, props.org, config.controlRepo, `overrides/${props.assignmentId}/${student.github_login}.json`)
      if (existing) {
        const doc = JSON.parse(existing)
        overridesList = doc.overrides || []
      }
    } catch { /* ignore and use empty */ }

    const newExtValue = localToUtc(actionExt.value.deadline_local)

    overridesList.push({
      type: 'deadline_extension',
      value: newExtValue,
      reason: actionExt.value.reason.trim(),
      overridden_by: 'admin-panel',
      overridden_at: new Date().toISOString(),
    })

    const overrideDoc = {
      schema_version: 1,
      assignment_id: props.assignmentId,
      github_login: student.github_login,
      overrides: overridesList,
    }
    const { valid, errors } = await validateAgainst('override', overrideDoc)
    if (!valid) {
      toast.error('Override failed validation: ' + errors.map((e) => `${e.instancePath} ${e.message}`).join('; '))
      return
    }
    const path = `overrides/${props.assignmentId}/${student.github_login}.json`
    const res = await commitFile(token, props.org, config.controlRepo, path, JSON.stringify(overrideDoc, null, 2) + '\n', `Grant extension to ${student.github_login} on ${props.assignmentId}`)
    if (res.ok) {
      toast.success(`Extension granted to ${student.github_login} (status updates on the next nightly run or Live Status refresh).`)
      // Reflect immediately in the table + any re-opened modal.
      overridesByLogin.value.set(student.github_login, overrideDoc)
      overridesByLogin.value = new Map(overridesByLogin.value)
      student.effective_deadline_at = newExtValue
      actionStudent.value = null
    } else {
      toast.error(`Extension failed: ${res.data?.message || 'unknown error'}`)
    }
  } finally {
    actionExtending.value = false
  }
}

let retryPollTimer = null

function startRetryWatch(login, repoName, initialRunId) {
  if (retryPollTimer) clearTimeout(retryPollTimer)
  let pollCount = 0
  const workflowUrl = `https://github.com/${config.hubOwner}/${config.hubRepo}/actions/workflows/retry-acceptance.yml`
  const tick = async () => {
    pollCount++
    const token = getToken()
    if (!token) return

    try {
      const res = await getWorkflowRuns(token, config.hubOwner, config.hubRepo, 'retry-acceptance.yml')
      if (res.ok && res.data?.workflow_runs) {
        const latestRun = res.data.workflow_runs[0]
        if (latestRun && latestRun.id !== initialRunId) {
          if (latestRun.status === 'completed') {
            if (latestRun.conclusion === 'success') {
              toast.success(`Retry succeeded: repository is live.`, {
                link: { text: repoName, href: `https://github.com/${props.org}/${repoName}` }
              })
              await loadAll()
              return
            } else {
              toast.error(`Retry workflow failed.`, {
                link: { text: 'Check the workflow run.', href: latestRun.html_url }
              })
              return
            }
          }
        }
      }
    } catch (e) {
      console.error('Error polling retry workflow:', e)
    }

    if (pollCount >= 48) { // 48 * 5s = 4 minutes
      toast.error(`Retry for ${login} timed out.`, {
        link: { text: 'Check the workflow run.', href: workflowUrl }
      })
      return
    }
    retryPollTimer = setTimeout(tick, 5000)
  }
  retryPollTimer = setTimeout(tick, 5000)
}

async function retryAcceptanceFor(student) {
  actionRetrying.value = true
  const login = student.github_login
  try {
    const token = getToken()

    const deadline = assignment.value?.deadline_at ? new Date(assignment.value.deadline_at) : null
    const opensAt = assignment.value?.opens_at ? new Date(assignment.value.opens_at) : null
    const now = new Date()
    const isOutsideWindow = (deadline && now > deadline) || (opensAt && now < opensAt)
    if (isOutsideWindow) {
      if (!window.confirm(`Warning: The assignment window is currently closed (opens: ${opensAt ? opensAt.toLocaleString() : 'N/A'}, deadline: ${deadline ? deadline.toLocaleString() : 'N/A'}). Retrying will bypass these constraints. Proceed?`)) {
        return
      }
    }

    let initialRunId = null
    try {
      const runsRes = await getWorkflowRuns(token, config.hubOwner, config.hubRepo, 'retry-acceptance.yml')
      if (runsRes.ok && runsRes.data?.workflow_runs) {
        initialRunId = runsRes.data.workflow_runs[0]?.id || null
      }
    } catch (e) {
      console.error('Failed to fetch initial workflow run:', e)
    }

    const res = await triggerWorkflow(token, config.hubOwner, config.hubRepo, 'retry-acceptance.yml', {
      org: props.org,
      assignment_id: props.assignmentId,
      github_login: login,
      bypass_window: "true",
    })
    if (res.ok || res.status === 204) {
      const workflowUrl = `https://github.com/${config.hubOwner}/${config.hubRepo}/actions/workflows/retry-acceptance.yml`
      toast.success(`Retry triggered for ${login}. Watching workflow run progress…`, {
        link: { text: 'View workflow run', href: workflowUrl }
      })
      
      const pattern = assignment.value?.repository_name_pattern || `${props.assignmentId}-{github_login}`
      const repoName = pattern.replace('{github_login}', login)
      startRetryWatch(login, repoName, initialRunId)
      
      actionStudent.value = null
    } else {
      toast.error(explainDispatchFailure(res, 'Retry failed'))
    }
  } finally {
    actionRetrying.value = false
  }
}
</script>

<style scoped>
.detail-page { min-height: 100vh; }

.detail-header {
  background: var(--bg-secondary);
  border-bottom: 1px solid var(--border-default);
  padding: var(--space-md) 0;
}
.back-link { font-size: 0.875rem; display: inline-flex; align-items: center; gap: 4px; flex-shrink: 0; }
/* The breadcrumb must shrink inside the header flex row - otherwise a long
   assignment id forces horizontal page scroll on mobile. */
.breadcrumb { min-width: 0; flex: 1; }
.breadcrumb h1 { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.btn-with-icon { display: inline-flex; align-items: center; gap: var(--space-xs); }
.separator { color: var(--text-muted); }
.org-name { color: var(--text-secondary); font-size: 0.875rem; text-decoration: none; }
.org-name:hover { color: var(--accent-blue); text-decoration: underline; }
h1 { font-size: 1.125rem; font-weight: 600; }
.avatar { width: 24px; height: 24px; border-radius: 50%; }

main { padding: var(--space-xl) var(--space-lg); }

.center-card {
  max-width: 480px;
  margin: var(--space-2xl) auto;
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-md);
}

.daily-watch {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  justify-content: center;
}

.auth-error {
  color: var(--accent-red);
  border: 1px solid var(--accent-red);
  border-radius: var(--radius-md);
  padding: var(--space-sm) var(--space-md);
  font-size: 0.9rem;
}

.summary-row {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: var(--space-md);
  margin-bottom: var(--space-lg);
}
.summary-card {
  text-align: center;
  padding: var(--space-md);
}
.summary-value {
  display: block;
  font-size: 2rem;
  font-weight: 700;
}
.deadline-value {
  font-size: 1.4rem;
  line-height: 1.2;
  padding: 6px 0;
}
.summary-label {
  font-size: 0.75rem;
  text-transform: uppercase;
  color: var(--text-muted);
  letter-spacing: 0.03em;
}

.stat-green { color: var(--accent-green); }
.stat-yellow { color: var(--accent-yellow); }
.stat-red { color: var(--accent-red); }

.actions-bar {
  margin-bottom: var(--space-md);
  flex-wrap: wrap;
  gap: var(--space-sm);
}
.search-input { min-width: 240px; }

.table-wrapper {
  overflow-x: auto;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-lg);
}

table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.85rem;
}
th, td {
  padding: var(--space-sm) var(--space-md);
  text-align: left;
  border-bottom: 1px solid var(--border-muted);
  white-space: nowrap;
}
th.col-warnings, td.col-warnings { white-space: normal; min-width: 160px; }
th {
  background: var(--bg-tertiary);
  font-weight: 600;
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-secondary);
}
th.sortable { cursor: pointer; user-select: none; }
th.sortable:hover { color: var(--accent-blue); }
.th-label { display: inline-flex; align-items: center; gap: 4px; }
.sort-glyph { color: var(--accent-blue); }

tr:hover td { background: rgba(88, 166, 255, 0.04); }
tbody tr:nth-child(even) td { background: rgba(255, 255, 255, 0.02); }
tbody tr:nth-child(even):hover td { background: rgba(88, 166, 255, 0.06); }

.empty-row {
  text-align: center;
  padding: var(--space-lg);
  color: var(--text-secondary);
  white-space: normal;
}
.link-btn {
  background: none;
  border: none;
  color: var(--accent-blue);
  cursor: pointer;
  padding: 0;
  margin-left: var(--space-sm);
  font: inherit;
}
.link-btn:hover { text-decoration: underline; }

.sha { font-size: 0.8rem; }
.text-muted { color: var(--text-muted); }
.text-secondary { color: var(--text-secondary); }
.text-warning { color: var(--accent-yellow); }

.col-repo .repo-link { display: inline-block; }
.col-last-commit { white-space: nowrap; }
.col-last-commit .sha { display: inline-block; }
.col-submit-tag { white-space: nowrap; min-width: 150px; }
.col-submit-tag .tag-row { display: inline-flex; align-items: center; gap: 4px; }
.col-submit-tag .tag-icon { color: var(--accent-green); flex-shrink: 0; }
.col-submit-tag .tag-link { font-size: 0.8rem; }
.col-submit-tag .tag-time { font-size: 0.75rem; margin-top: 2px; }
.col-submit-tag .untagged { font-size: 0.85rem; }
.col-feedback-pr { font-size: 0.85rem; }

.autograde-section {
  margin-top: var(--space-xl);
  padding-top: var(--space-lg);
  border-top: 1px solid var(--border-default);
}
.autograde-head { display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-md); margin-bottom: var(--space-sm); }
.autograde-head h3 { margin: 0; font-size: 1rem; font-weight: 600; }
.text-xs { font-size: 0.75rem; }
.autograde-banner {
  background: rgba(88,166,255,0.08);
  border-left: 3px solid var(--accent-blue);
  padding: var(--space-sm) var(--space-md);
  border-radius: 4px;
  font-size: 0.85rem;
  margin-bottom: var(--space-md);
}
.autograde-banner code { font-size: 0.85rem; }
.autograde-failed {
  margin-top: var(--space-md);
  padding: var(--space-sm) var(--space-md);
  background: rgba(248,81,73,0.08);
  border-left: 3px solid var(--accent-red);
  border-radius: 4px;
  font-size: 0.85rem;
}
.autograde-failed ul { margin: var(--space-xs) 0 0 var(--space-md); padding: 0; }
.badge-with-icon { display: inline-flex; align-items: center; gap: 4px; }
.commit-time-top {
  font-size: 0.85rem;
  color: var(--text-primary);
  margin-bottom: 2px;
}
th.num, td.num { text-align: right; font-variant-numeric: tabular-nums; }
.commit-row {
  display: flex;
  gap: var(--space-sm);
  margin-top: 2px;
  font-size: 0.78rem;
  color: var(--text-muted);
}
.col-actions { width: 1%; text-align: right; }
.row-action {
  background: none;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 1.1rem;
  padding: 2px 8px;
  line-height: 1;
}
.row-action:hover {
  background: var(--bg-tertiary);
  border-color: var(--border-default);
  color: var(--text-primary);
}

.table-footer {
  margin-top: var(--space-md);
  font-size: 0.8rem;
}

.ext-note {
  font-size: 0.72rem;
  color: var(--accent-blue);
  margin-top: 2px;
  white-space: nowrap;
}

/* Mobile card list (hidden by default; shown under breakpoint) */
.mobile-only { display: none; }
.student-card {
  background: var(--bg-secondary);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  padding: var(--space-md);
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
}
.student-card-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--space-sm);
}
.student-card-login { font-weight: 600; }
.student-card-badges { display: flex; flex-wrap: wrap; gap: var(--space-xs); }
.student-card-detail { font-size: 0.8rem; }
.student-card-repo { font-size: 0.85rem; }
.student-card-warnings { display: flex; flex-wrap: wrap; gap: var(--space-xs); }

/* Modal */
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: var(--space-xl) var(--space-md);
  z-index: 100;
  overflow-y: auto;
}
.modal {
  background: var(--bg-secondary);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  width: 100%;
  max-width: 520px;
  padding: var(--space-lg);
  display: flex;
  flex-direction: column;
  gap: var(--space-md);
}
.modal-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--space-sm);
}
.modal-head h3 { margin: 0; font-size: 1.05rem; font-weight: 600; }
.modal-head code { background: var(--bg-tertiary); padding: 2px 6px; border-radius: 4px; }
.modal-close {
  background: none;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 1.5rem;
  line-height: 1;
  padding: 0 var(--space-xs);
}
.modal-close:hover { color: var(--text-primary); }
.modal-section {
  padding: var(--space-md);
  background: var(--bg-tertiary);
  border-radius: var(--radius-md);
}
.modal-section h4 { margin: 0 0 var(--space-sm); font-size: 0.9rem; font-weight: 600; }
.modal-section .field { display: flex; flex-direction: column; gap: 4px; margin-bottom: var(--space-sm); }
.modal-section .field label { font-size: 0.85rem; color: var(--text-secondary); }
.modal-section .field input,
.modal-section .field textarea {
  width: 100%;
  padding: 8px 10px;
  background: var(--bg-primary);
  border: 1px solid var(--border-default);
  border-radius: 4px;
  color: var(--text-primary);
  font-family: inherit;
  font-size: 0.9rem;
}
.modal-section p { margin: 0 0 var(--space-sm); font-size: 0.85rem; }

/* Export Dropdown Menu */
.dropdown-container {
  position: relative;
  display: inline-block;
}

.export-dropdown-menu {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  z-index: 100;
  min-width: 270px;
  background: var(--bg-surface, #161b22);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md, 6px);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  padding: 4px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.export-dropdown-item {
  width: 100%;
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 8px 10px;
  background: none;
  border: none;
  border-radius: var(--radius-sm, 4px);
  color: var(--text-primary);
  text-align: left;
  cursor: pointer;
  font-family: inherit;
  transition: background-color 0.15s ease;
}

.export-dropdown-item:hover:not(:disabled) {
  background: var(--bg-tertiary, #21262d);
}

.export-dropdown-item.disabled-item,
.export-dropdown-item:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.dropdown-icon {
  margin-top: 2px;
  flex-shrink: 0;
  color: var(--color-accent, #58a6ff);
}

.dropdown-item-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.dropdown-item-title {
  font-size: 0.84rem;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 6px;
}

.dropdown-item-sub {
  font-size: 0.72rem;
  color: var(--text-secondary);
  line-height: 1.25;
}

.dropdown-divider {
  height: 1px;
  background: var(--border-default);
  margin: 4px 0;
}

.badge-count {
  font-size: 0.7rem;
  font-weight: 600;
  padding: 0 5px;
  background: var(--bg-tertiary);
  border-radius: 999px;
  color: var(--color-accent, #58a6ff);
}

.preservation-banner {
  padding: var(--space-md, 16px);
  background: var(--bg-secondary, #161b22);
  border: 1px solid var(--border-default, #30363d);
  border-radius: var(--radius-md, 6px);
  margin-bottom: var(--space-md, 16px);
}

.preservation-banner-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: var(--space-xs, 6px);
}

.preservation-banner-title-group {
  display: flex;
  align-items: center;
  gap: var(--space-sm, 8px);
}

.preservation-banner-title {
  font-weight: 600;
  font-size: 0.95rem;
}

.preservation-banner-body {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--space-md, 16px);
  flex-wrap: wrap;
}

.preservation-banner-actions {
  display: flex;
  gap: var(--space-xs, 6px);
  align-items: center;
  flex-wrap: wrap;
}

.feedback-pr-modal {
  max-width: 580px;
}

.safety-box {
  background: var(--bg-tertiary, #21262d);
  border: 1px solid var(--border-default, #30363d);
  border-radius: var(--radius-sm, 4px);
  padding: var(--space-sm, 12px) var(--space-md, 16px);
  margin: var(--space-md, 16px) 0;
}

.safety-box-title {
  font-size: 0.88rem;
  font-weight: 600;
  margin: 0 0 var(--space-xs, 6px) 0;
  color: var(--text-primary, #c9d1d9);
}

.safety-list {
  margin: 0;
  padding-left: var(--space-md, 18px);
  font-size: 0.84rem;
  line-height: 1.5;
  color: var(--text-secondary, #8b949e);
}

.safety-list li + li {
  margin-top: 4px;
}

.cohort-summary-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: var(--space-sm, 8px);
  margin: var(--space-md, 16px) 0;
}

.cohort-summary-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: var(--space-sm, 8px);
  background: var(--bg-secondary, #161b22);
  border: 1px solid var(--border-default, #30363d);
  border-radius: var(--radius-sm, 4px);
}

.cohort-summary-val {
  font-size: 1.25rem;
  font-weight: 700;
  color: var(--text-primary, #c9d1d9);
}

.cohort-summary-lbl {
  font-size: 0.72rem;
  color: var(--text-secondary, #8b949e);
  margin-top: 2px;
}

.empty-eligible-notice {
  padding: var(--space-sm, 8px) var(--space-md, 12px);
  background: var(--bg-secondary, #161b22);
  border: 1px dashed var(--border-default, #30363d);
  border-radius: var(--radius-sm, 4px);
  font-size: 0.84rem;
  color: var(--text-secondary, #8b949e);
  text-align: center;
  margin-top: var(--space-sm, 8px);
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-sm, 8px);
  padding: var(--space-md, 16px);
  border-top: 1px solid var(--border-default, #30363d);
  background: var(--bg-secondary, #161b22);
}

@media (max-width: 768px) {
  .summary-row { grid-template-columns: repeat(2, 1fr); }
  .actions-bar { flex-direction: column; align-items: stretch; }
  .actions-bar > div { width: 100%; }
  .search-input { flex: 1; min-width: 0; }
  .desktop-only { display: none; }
  .mobile-only { display: block; }
  .card-list { display: flex; flex-direction: column; gap: var(--space-sm); }
  .modal { padding: var(--space-md); }
}
</style>
