<template>
  <div class="detail-page">
    <AppHeader :user="user" @logout="handleLogout">
      <template #left>
        <div class="app-header-crumbs flex items-center gap-sm">
          <router-link :to="{ name: 'dashboard', params: { org } }" class="back-link">
            <Icon name="arrow-left" :size="14" />
            <span>Dashboard</span>
          </router-link>
          <span class="app-header-sep">/</span>
          <span class="text-secondary">{{ org }}</span>
          <span class="app-header-sep">/</span>
          <h1 class="app-header-heading" :title="assignmentId">{{ assignmentId }}</h1>
          <span v-if="assignment" class="status-indicator">
            <span class="status-dot" :class="assignment.state === 'published' ? 'dot-success' : (assignment.state === 'closed' ? 'dot-warning' : 'dot-neutral')"></span>
            <span class="text-xs text-secondary">{{ assignment.state === 'published' ? 'Accepting' : (assignment.state === 'closed' ? 'Closed' : assignment.state) }}</span>
          </span>
        </div>
      </template>
      <template #actions>
        <router-link
          :to="{ name: 'admin', params: { org }, query: { edit: assignmentId } }"
          class="btn btn-secondary btn-with-icon btn-sm"
          title="Open and edit this assignment in the Admin Panel"
        >
          <Icon name="edit-3" :size="13" />
          <span>Edit</span>
        </router-link>
      </template>
    </AppHeader>

    <main class="container">
      <!-- Not authenticated - never show data-shaped empty states signed out -->
      <AuthCard v-if="!user" title="Sign in to view this assignment" @authenticated="onAuthenticated">
        Sign in with a GitHub account that owns <strong>{{ org }}</strong> to load the
        report for <code>{{ assignmentId }}</code>. Sessions last 8 hours. If you were
        signed in earlier, it has expired.
      </AuthCard>

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

      <!-- No dedicated "no report" page. It used to replace the WHOLE view -
           header, share block, Teams, Export, Sync, Feedback PRs and Freeze all
           vanished with the table - so the one moment a lecturer most needs the
           invitation link was the one moment the page hid it (ARCHITECTURE §10.1.1).
           An absent report is now an empty one, and only the table swaps. -->

      <!-- Report loaded.
           `v-else-if="report"`, NOT a bare `v-else`. Everything below
           dereferences `report.students` directly, so any path that finishes
           with report still null rendered this block and threw
           `TypeError: can't access property "students"` - a blank page in
           production. There is more than one such path: an expired token
           (isAuthenticated() true, getToken() null) and an unreadable
           assignment YAML both leave it null. Guarding on the thing the block
           actually reads closes the class rather than the instance. -->
      <div v-else-if="report" class="report-content fade-in">
        <!-- Post-Deadline Preservation Summary Banner -->
        <!-- `report.students.length`, not just `report`: an absent report is
             now an empty one, and "Preservation Pending 0/0" for an assignment
             nobody accepted is a status about nothing. -->
        <div v-if="deadlinePassed && report && report.students.length > 0" class="card preservation-banner">
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
              Submission commit snapshots are preserved in a private archive repository for this assignment,
              <code v-if="archiveRepoSlug" class="mono">{{ archiveRepoSlug.split('/')[1] }}</code><span v-else>created on the first preservation</span>.
            </p>
            <div class="preservation-banner-actions">
              <!-- Only once something is actually preserved: before that the
                   archive repository does not exist, and a button to it is the
                   page guessing. The href comes off the report, never from the
                   assignment id - a cohort archived before per-assignment
                   archives is in the org's old shared one. -->
              <a
                v-if="archiveRepoHref"
                :href="archiveRepoHref"
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
                class="btn btn-sm btn-secondary btn-with-icon"
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

        <!-- Capacity Alert & 1-Click Bumper Banner (2.D) -->
        <div v-if="capacityAlert" class="card capacity-banner flex justify-between items-center flex-wrap gap-md" style="margin-bottom: var(--space-md); padding: 12px 16px; border-left: 4px solid var(--accent-yellow); background: var(--tint-attention-subtle);">
          <div class="flex items-center gap-sm">
            <Icon name="alert-circle" :size="20" class="text-warning" />
            <div>
              <div class="font-semibold text-sm">
                Cohort Capacity Alert: <strong>{{ acceptedStudentsCount }} / {{ assignment.max_acceptances }}</strong> acceptances
              </div>
              <div class="text-xs text-secondary">
                {{ acceptedStudentsCount >= assignment.max_acceptances ? 'Registration cap reached. New student acceptances are currently blocked.' : 'Cohort is approaching maximum student capacity.' }}
              </div>
            </div>
          </div>
          <div class="flex items-center gap-xs flex-wrap">
            <span class="text-xs text-secondary font-medium">Quick Bump:</span>
            <button class="btn btn-xs btn-secondary" :disabled="bumpingCapacity" @click="bumpCapacity(10)">+10</button>
            <button class="btn btn-xs btn-secondary" :disabled="bumpingCapacity" @click="bumpCapacity(25)">+25</button>
            <button class="btn btn-xs btn-secondary" :disabled="bumpingCapacity" @click="bumpCapacity(50)">+50</button>
            <!-- Not offered under open enrolment. There the cap is the ONLY
               thing limiting who can claim a repository - nothing gates it -
               so the schema requires it and accept.mjs treats its absence as
               fail:config, which hard-fails every acceptance that follows. A
               one-click button that breaks a live cohort is not a control. -->
          <button
            v-if="!capIsMandatory"
            class="btn btn-xs btn-secondary"
            :disabled="bumpingCapacity"
            @click="bumpCapacity(null)"
          >Remove limit</button>
          <span
            v-else
            class="text-xs text-secondary"
            title="Open enrolment has no roster, so the cap is the only limit on who can accept. Switch the assignment to an enforced roster to remove it."
          >Cap required under open enrolment</span>
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
          <div class="flex gap-xs items-center">
            <!-- Refresh Button (Neutral Secondary) -->
            <button class="btn btn-secondary btn-sm btn-with-icon" @click="refreshLiveStatus" :disabled="refreshingLive" title="Fetch live commit and autograding status">
              <Icon name="refresh-cw" :size="13" :class="{ 'spin-icon': refreshingLive }" />
              <span v-if="refreshingLive">({{ refreshedStudentsCount }}/{{ totalStudentsToRefresh }})</span>
              <span v-else>Refresh</span>
            </button>

            <!-- Export Dropdown Menu -->
            <div class="dropdown-container" ref="exportDropdownRef">
              <button
                class="btn btn-secondary btn-sm btn-with-icon"
                type="button"
                @click.stop="toggleExportDropdown"
                :aria-expanded="exportDropdownOpen"
                aria-haspopup="true"
                title="Export data and CLI commands"
              >
                <Icon name="download" :size="13" />
                <span>Export</span>
                <Icon :name="exportDropdownOpen ? 'chevron-up' : 'chevron-down'" :size="11" />
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

            <!-- More Actions Dropdown Menu (Consolidating secondary/maintenance actions) -->
            <div class="dropdown-container" ref="moreActionsRef">
              <button
                class="btn btn-secondary btn-sm btn-with-icon"
                type="button"
                @click.stop="toggleMoreActions"
                :aria-expanded="moreActionsOpen"
                aria-haspopup="true"
                title="More assignment management actions"
              >
                <Icon name="more-horizontal" :size="14" />
                <span>More</span>
                <Icon :name="moreActionsOpen ? 'chevron-up' : 'chevron-down'" :size="11" />
              </button>

              <div v-if="moreActionsOpen" class="export-dropdown-menu fade-in" role="menu">
                <button
                  v-if="assignment && assignment.template"
                  class="export-dropdown-item"
                  type="button"
                  role="menuitem"
                  @click="handleSyncStarterCode"
                >
                  <Icon name="git-pull-request" :size="14" class="dropdown-icon" />
                  <div class="dropdown-item-text">
                    <span class="dropdown-item-title">Sync Starter Code</span>
                    <span class="dropdown-item-sub">Propagate template updates to students</span>
                  </div>
                </button>

                <!-- The only way in for an assignment whose autograding ships
                     inside the template repository: there is no Autograder
                     section to hold the button until the first read has
                     produced grades. Maintenance actions live here per
                     DESIGN.md §1.2. -->
                <button
                  v-if="ciGradingAvailable"
                  class="export-dropdown-item"
                  type="button"
                  role="menuitem"
                  @click="handleSyncGrades"
                  :disabled="syncingGrades"
                >
                  <Icon name="check-circle" :size="14" class="dropdown-icon" />
                  <div class="dropdown-item-text">
                    <span class="dropdown-item-title">{{ syncingGrades ? `Reading scores (${syncedGradesCount}/${totalGradesToSync})` : 'Read scores from GitHub Actions' }}</span>
                    <span class="dropdown-item-sub">Pull each student's autograding result into the table</span>
                  </div>
                </button>

                <button
                  v-if="feedbackPrEnabled"
                  class="export-dropdown-item"
                  type="button"
                  role="menuitem"
                  @click="handleOpenFeedbackPrs"
                  :disabled="openingFeedbackPrs"
                >
                  <Icon name="message-square" :size="14" class="dropdown-icon" />
                  <div class="dropdown-item-text">
                    <span class="dropdown-item-title">{{ openingFeedbackPrs ? 'Opening PRs…' : 'Open Feedback PRs' }}</span>
                    <span class="dropdown-item-sub">Create review branches on student repos</span>
                  </div>
                </button>

                <button
                  v-if="feedbackPrEnabled"
                  class="export-dropdown-item"
                  type="button"
                  role="menuitem"
                  @click="handleRefreshFeedbackPrs"
                  :disabled="refreshingFeedbackPrs || feedbackPrAlreadyOpenedCount === 0"
                >
                  <Icon name="refresh-cw" :size="14" class="dropdown-icon" :class="{ 'spin-animation': refreshingFeedbackPrs }" />
                  <div class="dropdown-item-text">
                    <span class="dropdown-item-title">{{ refreshingFeedbackPrs ? 'Checking PRs…' : 'Refresh feedback PR status' }}</span>
                    <span class="dropdown-item-sub">
                      {{ feedbackPrAlreadyOpenedCount === 0
                        ? 'No feedback PRs have been opened yet'
                        : `State and review-comment count for ${feedbackPrAlreadyOpenedCount} PR(s)` }}
                    </span>
                  </div>
                </button>

                <button
                  v-if="canPromoteRoster"
                  class="export-dropdown-item"
                  type="button"
                  role="menuitem"
                  @click="handlePromoteRoster"
                >
                  <Icon name="users" :size="14" class="dropdown-icon" />
                  <div class="dropdown-item-text">
                    <span class="dropdown-item-title">Add accepted students to roster</span>
                    <span class="dropdown-item-sub">Reuse this cohort on your next assignment</span>
                  </div>
                </button>

                <div v-if="assignment && (assignment.template || feedbackPrEnabled || canPromoteRoster)" class="dropdown-divider"></div>

                <button
                  v-if="assignment && (assignment.state === 'published' || assignment.state === 'closed')"
                  class="export-dropdown-item"
                  type="button"
                  role="menuitem"
                  @click="handleToggleAcceptanceState"
                  :disabled="togglingState"
                >
                  <Icon :name="assignment.state === 'published' ? 'lock' : 'unlock'" :size="14" class="dropdown-icon" :class="assignment.state === 'published' ? 'text-danger' : 'text-success'" />
                  <div class="dropdown-item-text">
                    <span class="dropdown-item-title" :class="assignment.state === 'published' ? 'text-danger' : 'text-success'">
                      {{ togglingState ? 'Updating…' : (assignment.state === 'published' ? 'Close Acceptance' : 'Re-open Acceptance') }}
                    </span>
                    <span class="dropdown-item-sub">
                      {{ assignment.state === 'published' ? 'Prevent new student registrations' : 'Allow new students to join' }}
                    </span>
                  </div>
                </button>
              </div>
            </div>

          </div>
        </div>

        <!-- Handing the link to students is the thing this page is for before
             anyone has accepted, so it is a block with the student-facing
             status on it, not a lone button (ARCHITECTURE §10.3). -->
        <InvitationShare :org="org" :assignment="shareAssignment" variant="inline" class="detail-share" />

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
          :students="report.students || []"
          @refresh="loadAll"
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
                <th v-if="ciStatusColumn" class="col-ci">CI Status</th>
                <th v-if="hasGrades" class="col-score">Score</th>
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
                  <span v-if="s.team_name || s.team_slug" class="text-sm font-medium">
                    {{ s.team_name || s.team_slug }}
                  </span>
                  <span v-else class="text-muted text-xs">-</span>
                </td>
                <td>
                  <span class="status-indicator">
                    <span class="status-dot" :class="s.acceptance_state === 'accepted' || s.acceptance_state === 'provisioned' ? 'dot-success' : (s.acceptance_state === 'declined' ? 'dot-danger' : 'dot-neutral')"></span>
                    <span class="text-sm">{{ s.acceptance_state || '-' }}</span>
                  </span>
                </td>
                <td>
                  <span class="status-indicator">
                    <span class="status-dot" :class="s.submission_status === 'on-time' ? 'dot-success' : (s.submission_status === 'late' ? 'dot-warning' : (s.submission_status === 'no-submission' ? 'dot-neutral' : 'dot-info'))"></span>
                    <span class="text-sm">{{ s.submission_status }}</span>
                  </span>
                  <div v-if="extensionFor(s.github_login)" class="ext-note" :title="`Extension granted. Reason: ${extensionFor(s.github_login).reason}`">
                    ext -> {{ fmt(extensionFor(s.github_login).value) }}
                  </div>
                  <div v-if="s.preservation_status === 'preserved' && s.preserved_sha && studentArchiveUrl(s)" class="archive-link-wrap">
                    <a
                      :href="studentArchiveUrl(s)"
                      target="_blank"
                      rel="noopener"
                      class="mono text-xs"
                      :title="`Preserved in archive repository at SHA ${s.preserved_sha}`"
                      style="display: inline-flex; align-items: center; gap: 3px; color: var(--text-secondary); text-decoration: underline;"
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
                <td v-if="ciStatusColumn" class="col-ci">
                  <button
                    v-if="s.ci_status"
                    type="button"
                    :class="['badge badge-clickable', s.ci_status === 'success' ? 'badge-success' : s.ci_status === 'failure' ? 'badge-error' : 'badge-warning']"
                    @click="openAutogradeModal(s)"
                    title="Click to view autograding details"
                  >
                    {{ s.ci_status }}
                  </button>
                  <span v-else class="text-muted">-</span>
                </td>
                <td v-if="hasGrades" class="col-score">
                  <button
                    v-if="s.earned_points != null"
                    type="button"
                    class="badge badge-clickable"
                    :class="s.earned_points >= s.total_points && s.total_points > 0 ? 'badge-success' : (s.earned_points > 0 ? 'badge-warning' : 'badge-error')"
                    @click="openAutogradeModal(s)"
                    title="Click to view the score and open the CI run"
                    style="font-size: 0.75rem;"
                  >
                    {{ s.earned_points }}/{{ s.total_points }} pts
                  </button>
                  <span v-else class="text-muted text-xs">-</span>
                </td>
                <td v-if="feedbackPrEnabled" class="col-feedback-pr">
                  <template v-if="s.feedback_pr_number">
                    <a :href="s.feedback_pr_url" target="_blank" class="mono">#{{ s.feedback_pr_number }}</a>
                    <!-- What `pxl-classroom feedback list` answers and the
                         panel could not: is it still open, and has anyone
                         left review comments on it (ARCHITECTURE §10.5 / UX20).
                         Absent until refreshed - it is a live read, not a
                         field on the report. -->
                    <span v-if="s.feedback_pr_state" class="fb-pr-meta">
                      <span class="status-indicator">
                        <span class="status-dot" :class="feedbackPrDot(s)"></span>
                        <span class="status-text">{{ feedbackPrStateLabel(s) }}</span>
                      </span>
                      <span
                        class="fb-pr-comments"
                        :title="`${s.feedback_pr_review_comments} inline review comment(s) on this pull request`"
                      >
                        <Icon name="message-square" :size="11" />
                        {{ s.feedback_pr_review_comments }}
                      </span>
                    </span>
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
                  <button class="btn-link" type="button" @click="clearFilters">Clear filters</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- Nobody has accepted. Only the TABLE says so; the header, the share
             block and the actions bar stay where they were (ARCHITECTURE §10.1.1).
             Not on the Teams tab: TeamsTable has its own empty state, and two
             of them stacked is the noise this is meant to remove. -->
        <div
          v-if="report.students.length === 0 && !(isGroupAssignment && viewTab === 'teams')"
          class="empty-state cohort-empty"
        >
          <h3>No one has accepted yet.</h3>
          <p class="text-secondary">
            Students appear here as they accept. Share the link above, or
            <router-link :to="{ name: 'admin', params: { org }, query: { edit: assignmentId } }" class="btn-link">check the invitation</router-link>
            if you expected someone by now.
          </p>
          <p v-if="dailyWatch === ''" class="text-muted cohort-empty-note">
            Reports refresh automatically after each acceptance and nightly.
            <button class="btn-link" type="button" @click="runDailyActivity" :disabled="dailyTriggering">
              {{ dailyTriggering ? 'Refreshing…' : 'Refresh now' }}
            </button>
          </p>
          <p v-else-if="dailyWatch === 'watching'" class="text-muted cohort-empty-note">
            <span class="spinner-sm"></span>
            Refreshing… (checked {{ dailyPollCount }}×)
          </p>
          <p v-else-if="dailyWatch === 'timeout'" class="text-warning cohort-empty-note">
            Still nothing after 5 minutes. Check the
            <a :href="`https://github.com/${config.hubOwner}/${config.hubRepo}/actions/workflows/daily-activity.yml`" target="_blank" rel="noopener">workflow run</a>
            for failures.
          </p>
        </div>

        <!-- Student cards (mobile) -->
        <div class="card-list mobile-only">
          <div v-if="report.students.length > 0 && filteredStudents.length === 0" class="empty-row">
            No students match the current filters.
            <button class="btn-link" type="button" @click="clearFilters">Clear filters</button>
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
              <div v-if="ciStatusColumn" class="commit-row" style="margin-top: var(--space-xs, 4px); align-items: center;">
                <span>CI Status:</span>
                <span v-if="s.ci_status" :class="['badge', s.ci_status === 'success' ? 'badge-success' : s.ci_status === 'failure' ? 'badge-error' : 'badge-warning']" style="font-size: 0.7rem; padding: 1px 6px;">
                  {{ s.ci_status }}
                </span>
                <span v-else class="text-muted">-</span>
                <span v-if="s.earned_points != null" class="text-muted">· {{ s.earned_points }}/{{ s.total_points }} pts</span>
              </div>
              <div v-if="feedbackPrEnabled" class="commit-row" style="margin-top: var(--space-xs, 4px);">
                <span>Feedback PR:</span>
                <template v-if="s.feedback_pr_number">
                  <a :href="s.feedback_pr_url" target="_blank" class="mono">#{{ s.feedback_pr_number }}</a>
                  <span v-if="s.feedback_pr_state" class="fb-pr-meta">
                    <span class="status-indicator">
                      <span class="status-dot" :class="feedbackPrDot(s)"></span>
                      <span class="status-text">{{ feedbackPrStateLabel(s) }}</span>
                    </span>
                    <span class="fb-pr-comments">
                      <Icon name="message-square" :size="11" />
                      {{ s.feedback_pr_review_comments }}
                    </span>
                  </span>
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
            <template v-if="autogradeDeclared">
              Configured tests: <strong>{{ assignment?.autograde?.tests?.length || 0 }}</strong>.
              Total points: <strong>{{ autogradeTotalPoints }}</strong>.
            </template>
            <template v-else>
              The checks are defined by a workflow inside the template repository, not here.
            </template>
            <template v-if="ciGradingAvailable">
              Reads the score annotation each grading run leaves on the student's commit.
            </template>
            <!-- Secondary, not primary: DESIGN.md §1.2 names Sync among the
                 toolbar actions, and the invitation link is this view's one
                 solid button. -->
            <button v-if="localRunnerDeclared" class="btn-link" type="button" @click="copyGradeCmd">Copy <code>pxl-classroom grade …</code></button>
            <button v-else class="btn btn-secondary btn-sm" type="button" @click="syncGradesFromGitHub" :disabled="syncingGrades">
              {{ syncingGrades ? `Reading (${syncedGradesCount}/${totalGradesToSync})` : 'Read scores from GitHub Actions' }}
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
                    <!-- The run's own conclusion where it was recorded. Deriving
                         "passed / partial / failed" from the score alone reads a
                         cancelled or timed-out run as a legitimate zero. -->
                    <a v-if="row.ci_run_url" :href="row.ci_run_url" target="_blank" rel="noopener"
                       :class="['badge', row.ci_status === 'success' ? 'badge-success' : row.ci_status === 'failure' ? 'badge-error' : 'badge-warning']">
                      {{ row.ci_status || 'completed' }}
                    </a>
                    <span v-else :class="['badge', row.earned_points >= row.total_points && row.total_points > 0 ? 'badge-success' : (row.earned_points > 0 ? 'badge-warning' : 'badge-error')]">
                      {{ row.ci_status || (row.earned_points >= row.total_points && row.total_points > 0 ? 'passed' : (row.earned_points > 0 ? 'partial' : 'failed')) }}
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

      <!-- Nothing loaded, and no error to show for it. Reached when a path
           finishes with `report` still null without recording why - an expired
           token being the one that produced a blank page in production. Says so
           rather than rendering nothing. -->
      <div v-else class="center-card fade-in">
        <h2>Could not load this assignment</h2>
        <p class="text-secondary">
          The report for <code>{{ assignmentId }}</code> in <strong>{{ org }}</strong> could not be
          read. Your session may have expired - sessions last 8 hours.
        </p>
        <button class="btn btn-primary" type="button" @click="loadAll">Retry</button>
      </div>

      <!-- Per-student actions: extension, retry, archive link. Lifted out with
           its own form state and focus trap - the dialog owned all three and
           they were spread across 2,100 lines of this file. -->
      <StudentActionsModal
        v-if="actionStudent"
        :student="actionStudent"
        :extension="extensionFor(actionStudent.github_login)"
        :archive-url="studentArchiveUrl(actionStudent)"
        :extending="actionExtending"
        :retrying="actionRetrying"
        @close="closeActions"
        @grant="grantExtensionFor(actionStudent, $event)"
        @retry="retryAcceptanceFor(actionStudent)"
      />

      <!-- Open a draft Feedback PR per eligible student repository. -->
      <FeedbackPrModal
        v-if="showFeedbackPrModal"
        :assignment="assignment"
        :eligible-count="feedbackPrEligibleCount"
        :already-opened-count="feedbackPrAlreadyOpenedCount"
        :skipped-no-commits-count="feedbackPrSkippedNoCommitsCount"
        :busy="openingFeedbackPrs"
        @close="showFeedbackPrModal = false"
        @confirm="executeOpenFeedbackPrs"
      />

      <!-- Autograding results. One component, shared with TeamsTable: this was
           ~70 lines of markup duplicated there, and the two copies had already
           reworded their own explanatory comments independently. -->
      <AutogradeResultsModal
        v-if="showAutogradeModal && activeAutogradeItem"
        :item="activeAutogradeItem"
        :subject-label="activeAutogradeItem.github_login || activeAutogradeItem.team_slug"
        @close="closeAutogradeModal"
      />

      <!-- Roster promotion: turns this assignment's acceptances into roster
           entries a later assignment can enforce against. -->
      <PromoteRosterModal
        v-if="showPromoteRosterModal && assignment"
        :assignment="assignment"
        :org="org"
        @close="showPromoteRosterModal = false"
      />

      <!-- Starter Code Sync Modal -->
      <StarterSyncModal
        v-if="showStarterSyncModal && assignment"
        :assignment="assignment"
        :org="org"
        :students="report?.students || []"
        @close="showStarterSyncModal = false"
        @synced="loadAll"
      />

      <!-- Freeze and preserve the whole cohort now, and what that costs. -->
      <FreezeConfirmModal
        v-if="showFreezeConfirmModal"
        :assignment="assignment"
        :eligible-count="eligiblePreservationCount"
        :archive-repo-name="plannedArchiveRepoName"
        :busy="freezingNow"
        @close="showFreezeConfirmModal = false"
        @confirm="executeFreezeNow"
      />
    </main>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { h } from 'vue'
import AppHeader from '../components/AppHeader.vue'
import AuthCard from '../components/AuthCard.vue'
import Icon from '../components/Icon.vue'
import InvitationShare from '../components/InvitationShare.vue'
import TeamsTable from '../components/TeamsTable.vue'
import StarterSyncModal from '../components/StarterSyncModal.vue'
import PromoteRosterModal from '../components/PromoteRosterModal.vue'
import AutogradeResultsModal from '../components/AutogradeResultsModal.vue'
import StudentActionsModal from '../components/StudentActionsModal.vue'
import FeedbackPrModal from '../components/FeedbackPrModal.vue'
import FreezeConfirmModal from '../components/FreezeConfirmModal.vue'

// Tiny render helper - keeps the table markup readable. `dir` is "asc" |
// "desc" | null; null renders nothing so non-active columns stay quiet.
const SortIcon = (props) => props.dir
  ? h(Icon, { name: props.dir === 'asc' ? 'arrow-up' : 'arrow-down', size: 11, class: 'sort-glyph' })
  : null
SortIcon.props = ['dir']
import { config } from '../lib/config.js'
import { getToken, getUser, clearAuth, isAuthenticated } from '../lib/auth.js'
import { getRepo, getRepoContent, listRepoDir, ghApi, commitFile, commitFiles, triggerWorkflow, explainDispatchFailure, totalFromLinkHeader, getWorkflowRuns } from '../lib/api.js'
import { isAlreadyExists, feedbackPrTitle, feedbackPrBody } from '../lib/feedback-pr.js'
import { validateAgainst } from '../lib/validate.js'
import { parseCheckRunScore, pickAutogradeCheckRun, fetchCheckRunAnnotations } from '../lib/check-run-score.js'
import { formatDate } from '../lib/format.js'
import { toast } from '../lib/toast.js'
import { extensionFrom } from '../lib/deadline.js'
import { requiresAcceptanceCap } from '../../../lib/roster-mode.mjs'
import { archiveBranchName, archiveBranchUrl, archiveRepoName, archiveRepoUrl, reportArchiveRepo } from '../lib/archive-repo.js'
import { buildDashboardEntry } from '../../../lib/dashboard-aggregate.mjs'
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

// The assignment YAML plus the live accepted count, which is what makes the
// share block's status line ("cap reached") true rather than a guess. The
// component reads the token from the same YAML if it is not in hand.
const shareAssignment = computed(() => ({
  ...(assignment.value || {}),
  id: props.assignmentId,
  accepted_count: acceptedStudentsCount.value,
}))
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

// Per-row action modal (Grant extension / Retry acceptance).
//
// Which student, and whether either action is in flight. The FORM, the focus
// trap and the element ref went with the dialog into
// components/StudentActionsModal.vue - a form that exists only while a dialog
// is open is the dialog's state, and holding it here meant it outlived every
// close and had to be reset by hand on every open.
const actionStudent = ref(null)
const actionExtending = ref(false)
const actionRetrying = ref(false)

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

// Three separate questions, and conflating them is what hid scores from every
// assignment whose autograding ships INSIDE the template repository - the
// GitHub Classroom shape, where `.github/workflows/classroom.yml` arrives with
// the starter code and the Admin Panel knows nothing about it.
//
//  - autogradeDeclared:  this assignment configures checks HERE, so the
//                        Autograder section has something to describe.
//  - localRunnerDeclared: those checks run on the lecturer's machine via the
//                        CLI, so offering to read GitHub check runs would be
//                        describing behaviour this assignment does not have.
//  - ciGradingAvailable: nothing rules out reading check runs. Requires no
//                        configuration at all: the reporter's annotation
//                        carries `maxPoints`, so even the denominator is known
//                        without anybody declaring it.
const autogradeDeclared = computed(() => assignment.value?.autograde?.enabled === true)
const localRunnerDeclared = computed(
  () => autogradeDeclared.value && assignment.value?.autograde?.execution_environment !== 'github_actions',
)
const ciGradingAvailable = computed(() => !localRunnerDeclared.value)
const isGitHubActionsAutograde = computed(
  () => autogradeDeclared.value && assignment.value?.autograde?.execution_environment === 'github_actions',
)

// Grades on screen, whatever produced them. The Score and CI Status columns
// key on THIS and never on the assignment's configuration: they rendered off
// `autograde.enabled` before, and since nothing ever wrote `earned_points`
// onto a report row, every cell under them was empty for as long as they
// existed. A column that can only ever be blank is C4 - the UI describing
// behaviour the system does not have.
const hasGrades = computed(() => (autogradeSummary.value?.students?.length || 0) > 0)
const autogradeEnabled = computed(() => autogradeDeclared.value || hasGrades.value)

// `refreshLiveStatus` fills ci_status from the check run at each student's
// latest commit without reading any score, so the CI column has a second way
// to be populated and outlives the grades.
const ciStatusColumn = computed(() => hasGrades.value || isGitHubActionsAutograde.value)
const preservedCount = computed(() =>
  (report.value?.students || []).filter((s) => s.preservation_status === 'preserved' || s.preserved_sha).length
)
const eligiblePreservationCount = computed(() =>
  (report.value?.students || []).filter((s) => s.repo_name && s.acceptance_state !== 'rejected' && s.acceptance_state !== 'pending').length
)
const unpreservedCount = computed(() =>
  (report.value?.students || []).filter(
    (s) => s.repo_name && s.acceptance_state !== 'rejected' && s.acceptance_state !== 'pending' && s.preservation_status !== 'preserved' && !s.preserved_sha
  ).length
)
const allPreserved = computed(() =>
  eligiblePreservationCount.value > 0 && preservedCount.value >= eligiblePreservationCount.value
)
// The archive repository this cohort is in, read off the report rather than
// derived from the assignment id: archives are per assignment now, and a cohort
// preserved before that change lives in the org's old shared archive. Null
// until something is actually preserved - at which point no archive repository
// exists yet, and offering a link to one is the page guessing (the same rule
// the provisioning wait screen is held to).
const archiveRepoSlug = computed(() =>
  reportArchiveRepo({ org: props.org, students: report.value?.students })
)
const archiveRepoHref = computed(() =>
  archiveRepoSlug.value ? archiveRepoUrl({ recorded: archiveRepoSlug.value }) : null
)
// What "Freeze & Preserve Now" would create. Derived, not resolved: this one is
// about the archive that does not exist yet, which is the only question
// archiveRepoName may answer.
const plannedArchiveRepoName = computed(() => archiveRepoName(props.assignmentId))
function studentArchiveUrl(s) {
  return archiveBranchUrl({
    org: props.org,
    assignmentId: props.assignmentId,
    login: s?.github_login,
    teamSlug: s?.team_slug,
    recorded: s?.archive_repo,
    recordedRef: s?.archive_ref,
  })
}
const preservationLockdownTime = computed(() => {
  const s = (report.value?.students || []).find((s) => s.lock_down_at)
  return s?.lock_down_at || report.value?.lockdown_at || null
})
// How long after the deadline a student could still push - which is what the
// banner beside it says it is.
//
// It used to read `uncertainty_interval_seconds`, which is the OTHER SIDE of the
// deadline: the gap between the last observation and the deadline, i.e. how
// stale the evidence was going in. With a nightly collect that is routinely
// hours, so the banner reported a large "delay between deadline and lockdown
// execution" on a cohort frozen at the instant by the sentinel - understating
// the system on the one screen a lecturer would cite in a dispute.
//
// `lockdown_delay_seconds` comes from the lockdown record, which is the only
// document that knows when writes actually stopped. The maximum across the
// cohort, not the first non-null: one student demoted late is exactly what this
// number is for.
const preservationUncertaintySeconds = computed(() => {
  const delays = (report.value?.students || [])
    .map((s) => s.lockdown_delay_seconds)
    .filter((d) => typeof d === 'number')
  if (delays.length) return Math.max(...delays)
  // A report generated before this field existed. Null rather than the evidence
  // gap: showing the wrong quantity is what this replaced.
  return null
})

// Capacity Alert & 1-Click Bumper Logic (2.D)
const acceptedStudentsCount = computed(() =>
  (report.value?.students || []).filter((s) => s.repo_name || s.acceptance_state === 'accepted' || s.status !== 'no-submission').length
)

const capacityAlert = computed(() => {
  const cap = assignment.value?.max_acceptances
  if (!cap || cap <= 0) return false
  const count = acceptedStudentsCount.value
  return count >= cap || count / cap >= 0.9
})

// Only `open` requires a cap, and it must have one: nothing else gates who may
// accept there. requiresAcceptanceCap is the single reader for that rule - it
// had existed since roster_mode: claim shipped with no call sites at all, which
// is why the "Remove limit" button could offer to break a live open cohort.
const capIsMandatory = computed(() => requiresAcceptanceCap(assignment.value?.roster_mode))

const bumpingCapacity = ref(false)

async function bumpCapacity(delta) {
  if (!assignment.value) return
  // Belt to the template's braces: removing the cap under open enrolment writes
  // a document the schema rejects and accept.mjs reads as fail:config, so every
  // acceptance after it hard-fails. The button is hidden there; this stops any
  // other path reaching the same write.
  if (delta == null && capIsMandatory.value) {
    toast.error('Open enrolment has no roster, so the cap is the only limit on who can accept - it cannot be removed.')
    return
  }
  bumpingCapacity.value = true
  try {
    const token = getToken()
    const content = await getRepoContent(token, props.org, config.controlRepo, `assignments/${props.assignmentId}.yml`)
    if (!content) throw new Error('Could not load assignment configuration YAML')
    const doc = parseYaml(content)
    let newCap = null
    if (delta == null) {
      delete doc.max_acceptances
    } else {
      const current = doc.max_acceptances || 0
      newCap = current + delta
      doc.max_acceptances = newCap
    }
    const updatedYaml = stringifyYaml(doc)
    const commitMsg = delta == null
      ? `Remove max_acceptances cap for ${props.assignmentId}`
      : `Increase max_acceptances by +${delta} (total: ${newCap}) for ${props.assignmentId}`
    const res = await commitFile(token, props.org, config.controlRepo, `assignments/${props.assignmentId}.yml`, updatedYaml, commitMsg)
    if (res.ok) {
      toast.success(delta == null ? 'Registration cap removed' : `Capacity increased to ${newCap} slots`)
      if (delta == null) {
        delete assignment.value.max_acceptances
      } else {
        assignment.value.max_acceptances = newCap
      }
      await loadAll()
    } else {
      toast.error(`Failed to update capacity: ${res.data?.message || 'unknown error'}`)
    }
  } catch (e) {
    toast.error(`Error updating capacity: ${e.message}`)
  } finally {
    bumpingCapacity.value = false
  }
}

const showStarterSyncModal = ref(false)
const showPromoteRosterModal = ref(false)

// Offered only under `open`, and only once somebody has accepted. Under
// `enforced` every acceptor was already on the roster, so the action would be a
// no-op menu item on every assignment - and DESIGN.md's C4 rule is that the UI
// must not offer behaviour the system does not have here. The one genuine
// `enforced` case (a student removed from the roster after accepting) is rare
// and `pxl-classroom roster promote` still covers it.
const canPromoteRoster = computed(() =>
  assignment.value?.roster_mode === 'open' && acceptedStudentsCount.value > 0
)

function handlePromoteRoster() {
  moreActionsOpen.value = false
  showPromoteRosterModal.value = true
}
const openingFeedbackPrs = ref(false)
const retryingPreservation = ref(false)
const showFreezeConfirmModal = ref(false)
const freezingNow = ref(false)

async function executeFreezeNow() {
  const token = getToken()
  if (!token) return
  freezingNow.value = true
  try {
    const res = await triggerWorkflow(token, config.hubOwner, config.hubRepo, 'daily-activity.yml', {
      org: props.org,
    })
    if (res.ok) {
      toast.success('Lockdown and preservation workflow triggered successfully.')
      showFreezeConfirmModal.value = false
    } else {
      toast.error(explainDispatchFailure(res, 'Failed to trigger lockdown'))
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
    const res = await triggerWorkflow(token, config.hubOwner, config.hubRepo, 'daily-activity.yml', {
      org: props.org,
    })
    if (res.ok) {
      toast.success('Preservation retry workflow triggered successfully.')
    } else {
      toast.error(explainDispatchFailure(res, 'Failed to retry preservation'))
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

// --- feedback PR status -------------------------------------------------------
//
// `pxl-classroom feedback list` answers "which students have a feedback PR,
// is it still open, and has anyone left review comments on it". The SPA showed
// only the number and a link (ARCHITECTURE §10.5 / UX20).
//
// It is a LIVE read, not a field: `open-feedback-prs.mjs` records
// feedback_pr_number and feedback_pr_url and nothing else, and a comment count
// changes every time a lecturer reviews. So it is behind an explicit control
// rather than fetched on render - one request per open PR, which on a
// 200-student cohort is 200 requests nobody asked for.
//
// One request per student, not two: GET /pulls/{n} carries `state`, `draft`
// AND `review_comments`. The CLI pages /pulls/{n}/comments for the count
// because it wants only the count; the totals agree.
const refreshingFeedbackPrs = ref(false)

function feedbackPrStateLabel(s) {
  if (s.feedback_pr_state === 'closed') return s.feedback_pr_merged ? 'Merged' : 'Closed'
  return s.feedback_pr_draft ? 'Draft' : 'Open'
}

function feedbackPrDot(s) {
  if (s.feedback_pr_state === 'closed') return s.feedback_pr_merged ? 'dot-success' : 'dot-danger'
  return s.feedback_pr_draft ? 'dot-neutral' : 'dot-success'
}

async function refreshFeedbackPrStatus() {
  const token = getToken()
  if (!token || !report.value) return
  const queue = (report.value.students || []).filter(
    (s) => Number.isInteger(s.feedback_pr_number) && s.repo_name,
  )
  if (queue.length === 0) {
    toast.error('No feedback PRs have been opened for this assignment yet.')
    return
  }

  refreshingFeedbackPrs.value = true
  let failed = 0
  const results = new Map()
  let cursor = 0
  const worker = async () => {
    while (cursor < queue.length) {
      const s = queue[cursor++]
      const repo = (s.repo_name || '').split('/').pop()
      try {
        const res = await ghApi(token, 'GET', `/repos/${props.org}/${repo}/pulls/${s.feedback_pr_number}`)
        if (!res.ok) {
          // A 404 means the PR is gone, not that the read failed - say so
          // rather than leaving a stale "Open" next to a deleted branch.
          if (res.status === 404) {
            results.set(s.github_login, { state: 'closed', draft: false, merged: false, comments: 0 })
          } else {
            failed++
          }
          continue
        }
        results.set(s.github_login, {
          state: res.data?.state === 'closed' ? 'closed' : 'open',
          draft: res.data?.draft === true,
          merged: Boolean(res.data?.merged_at),
          comments: Number(res.data?.review_comments) || 0,
        })
      } catch {
        failed++
      }
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(6, queue.length) }, worker))

    // Partial results are shown, unlike a Live Status refresh - nothing is
    // committed here, so a half-answer costs nothing and is still an answer.
    // The count of what could not be read is part of it.
    for (const s of report.value.students) {
      const r = results.get(s.github_login)
      if (!r) continue
      s.feedback_pr_state = r.state
      s.feedback_pr_draft = r.draft
      s.feedback_pr_merged = r.merged
      s.feedback_pr_review_comments = r.comments
    }
    const withComments = [...results.values()].filter((r) => r.comments > 0).length
    if (failed > 0) {
      toast.error(`Read ${results.size} of ${queue.length} feedback PRs; ${failed} could not be read.`)
    } else {
      toast.success(`${results.size} feedback PR(s) checked - ${withComments} carry review comments.`)
    }
  } finally {
    refreshingFeedbackPrs.value = false
  }
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
  const title = feedbackPrTitle(assignment.value, props.assignmentId)
  const body = feedbackPrBody(baseline)

  let created = 0
  let adopted = 0
  let failed = 0
  // Collected and committed in ONE commit at the end. This used to write each
  // record with its own commitFile(), which on a 200-student cohort is 200
  // commits against a ~80 writes/min secondary limit - the same arithmetic
  // that made team seeding use gittree.
  const changes = []

  for (const s of targets) {
    const repoName = s.repo_name?.split('/')[1] || s.repo_name
    const record = async (pr) => {
      s.feedback_pr_number = pr.number
      s.feedback_pr_url = pr.html_url
      const recPath = `repositories/${props.assignmentId}/${s.github_login}.json`
      const existingContent = await getRepoContent(token, props.org, config.controlRepo, recPath)
      if (!existingContent) return
      const recDoc = JSON.parse(existingContent)
      recDoc.feedback_pr_number = pr.number
      recDoc.feedback_pr_url = pr.html_url
      changes.push({ path: recPath, content: JSON.stringify(recDoc, null, 2) + '\n' })
    }

    try {
      const prRes = await ghApi(token, 'POST', `/repos/${props.org}/${repoName}/pulls`, {
        title,
        body,
        head: 'main',
        base: baseline,
        draft: true,
      })

      if (prRes.ok && prRes.data) {
        created++
        await record(prRes.data)
      } else if (isAlreadyExists(prRes.status, prRes.data)) {
        // Adopt the pull request that is already open. There was no adopt path
        // here at all: a student whose record had lost its PR number - which is
        // what any interrupted run leaves behind - was counted as a failure on
        // every subsequent run and never recorded, while the CLI adopted them.
        // `state=open`, because a closed PR does not produce this 422.
        const list = await ghApi(
          token, 'GET',
          `/repos/${props.org}/${repoName}/pulls?head=${props.org}:main&base=${baseline}&state=open`,
        )
        const found = list.ok ? list.data?.[0] : null
        if (found) {
          adopted++
          await record(found)
        } else {
          failed++
        }
      } else {
        failed++
      }
    } catch {
      failed++
    }
  }

  // One commit for the whole cohort. A failure here is SURFACED, not logged to
  // a console nobody has open: the pull requests exist on GitHub either way, so
  // silently losing the records leaves the dashboard permanently disagreeing
  // with the repositories.
  let recordsSaved = true
  if (changes.length > 0) {
    const res = await commitFiles(
      token, props.org, config.controlRepo, changes,
      `Record ${changes.length} feedback PR(s) for ${props.assignmentId}`,
    )
    recordsSaved = res.ok
  }

  openingFeedbackPrs.value = false
  showFeedbackPrModal.value = false
  if (created > 0 || adopted > 0) {
    const parts = []
    if (created > 0) parts.push(`${created} opened`)
    if (adopted > 0) parts.push(`${adopted} already open, adopted`)
    toast.success(`Feedback PRs: ${parts.join(', ')}.`)
  }
  if (!recordsSaved) {
    toast.error(
      'The pull requests were opened but could not be saved to the control repository. ' +
      'Run this again - it will adopt them rather than open duplicates.',
    )
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
const roster = computed(() => Array.from(rosterByLogin.value.values()))
const userProfilesByLogin = ref(new Map())


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

// Two optional grading columns, not one. This counted `isGitHubActionsAutograde`
// once and the Score column rendered off a different condition entirely, so the
// empty-state colspan was short by one whenever they disagreed.
const tableColumnCount = computed(() =>
  7 +
  (ciStatusColumn.value ? 1 : 0) +
  (hasGrades.value ? 1 : 0) +
  (feedbackPrEnabled.value ? 1 : 0) +
  (hasWarnings.value ? 1 : 0) +
  (hasSubmitTags.value ? 1 : 0))

// One rule, shared with the backend (lib/effective-deadline.mjs): the last
// grant in the append-only history is the one in force. A local
// `.filter(...).pop()` is how the SPA came to hold three different answers.
function extensionFor(login) {
  const ext = extensionFrom(overridesByLogin.value.get(login))
  return ext ? { value: ext.at.toISOString(), reason: ext.reason } : null
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

// More Actions Dropdown Menu State
const moreActionsOpen = ref(false)
const moreActionsRef = ref(null)

function toggleMoreActions() {
  moreActionsOpen.value = !moreActionsOpen.value
}

function handleSyncStarterCode() {
  moreActionsOpen.value = false
  showStarterSyncModal.value = true
}

function handleSyncGrades() {
  moreActionsOpen.value = false
  syncGradesFromGitHub()
}

function handleOpenFeedbackPrs() {
  moreActionsOpen.value = false
  openFeedbackPrs()
}

function handleRefreshFeedbackPrs() {
  moreActionsOpen.value = false
  refreshFeedbackPrStatus()
}

function handleToggleAcceptanceState() {
  moreActionsOpen.value = false
  toggleAcceptanceState()
}

function onDocumentClick(e) {
  if (exportDropdownRef.value && !exportDropdownRef.value.contains(e.target)) {
    exportDropdownOpen.value = false
  }
  if (moreActionsRef.value && !moreActionsRef.value.contains(e.target)) {
    moreActionsOpen.value = false
  }
}

function onKeydown(e) {
  if (e.key === 'Escape') {
    if (exportDropdownOpen.value) exportDropdownOpen.value = false
    if (moreActionsOpen.value) moreActionsOpen.value = false
    if (actionStudent.value) closeActions()
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

async function onAuthenticated(authedUser) {
  user.value = authedUser
  loading.value = true
  await loadAll()
}


// teams/<id>/<slug>.json is the authoritative membership; reports/<id>.json is a
// snapshot the nightly or a dashboard regeneration writes. Two cases would
// otherwise show an empty Teams tab: a grouping seeded seconds ago (the
// regeneration is still running) and any team on a DRAFT assignment, which
// never gets an interim report at all - so "seed, review, then publish" would
// have had nothing to review.
async function mergeTeamManifests(token) {
  if (assignment.value?.assignment_type !== 'group') return

  let files = []
  try {
    files = await listRepoDir(token, props.org, config.controlRepo, `teams/${props.assignmentId}`)
  } catch (e) {
    if (e.status !== 404) console.warn('Could not list team manifests:', e.message)
    return
  }
  const manifests = files
    .filter((f) => f.type === 'file' && f.name.endsWith('.json'))
    .map((f) => ({ slug: f.name.replace(/\.json$/, ''), path: f.path }))
  if (manifests.length === 0) return

  if (!report.value) return

  const known = new Set((report.value.teams || []).map((t) => String(t.team_slug).toLowerCase()))
  const missing = manifests.filter((m) => !known.has(m.slug.toLowerCase()))
  if (missing.length === 0) return

  const minSize = Number(assignment.value?.group_config?.min_team_size) || 0
  const docs = await Promise.all(
    missing.map(async (m) => {
      try {
        const text = await getRepoContent(token, props.org, config.controlRepo, m.path)
        return text ? JSON.parse(text) : null
      } catch {
        return null
      }
    })
  )

  const extra = docs
    .filter((d) => d && d.team_slug && d.vacant !== true)
    .map((d) => ({
      team_slug: d.team_slug,
      team_name: d.team_name || d.team_slug,
      members: d.members || [],
      repo_name: d.repo_name || null,
      repo_url: d.repo_url || null,
      submission_status: 'no-submission',
      commit_count: null,
      under_capacity: minSize > 0 && (d.members || []).length < minSize,
      ...(d.seeded_from ? { seeded_from: d.seeded_from } : {}),
      warnings: [],
    }))

  if (extra.length) {
    report.value.teams = [...(report.value.teams || []), ...extra].sort((a, b) =>
      String(a.team_slug).localeCompare(String(b.team_slug))
    )
  }
}

// The shape reports/<id>.json has before anything has been generated. Used for
// an assignment nobody has accepted yet, and previously open-coded inside
// mergeTeamManifests for the draft case alone.
function emptyReport() {
  return {
    schema_version: 1,
    assignment_id: props.assignmentId,
    assignment_title: assignment.value?.title || props.assignmentId,
    org: props.org,
    generated_at: null,
    students: [],
    teams: [],
  }
}

async function loadAll() {
  const token = getToken()
  // A session can be half-present: isAuthenticated() reads the stored user, so
  // onMounted sets `user` and renders past the AuthCard, while getToken() has
  // already returned null because the 8-hour token expired. This used to bail
  // silently - loading false, no error, report null - and the template rendered
  // its main block over a null report. Say which it is.
  if (!token) {
    loadError.value = 'Your session has expired. Sign in again to load this assignment.'
    loading.value = false
    return
  }
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

    // The assignment YAML is what everything below reads, and getRepoContent
    // answers null for a 404 rather than throwing - so a missing or unreadable
    // assignment fell through with NO error set. `report` then stayed null (the
    // emptyReport() stand-in below is deliberately gated on knowing the
    // assignment), the main content rendered anyway because it is a bare
    // `v-else` with no report guard, and the template threw on
    // `report.students.length`. That is a blank page and a TypeError, in
    // production, on the page a lecturer opens to watch a cohort.
    //
    // An unreadable assignment is a genuine load failure and belongs in the
    // error branch - which is exactly what the comment below already assumed
    // was happening.
    if (!assignment.value) {
      loadError.value =
        `Could not read assignments/${props.assignmentId}.yml in ` +
        `${props.org}/${config.controlRepo}. It may have been renamed or removed, ` +
        `or this account may not have access to that control repository.`
      return
    }

    // An assignment nobody has accepted yet has no report file, and that is a
    // fact about the cohort, not a failure to load. Standing an empty report in
    // for it keeps ONE render path - the alternative was a second full page
    // that dropped every action along with the table (ARCHITECTURE §10.1.1). Only done
    // once the assignment itself is known, so a genuine read failure still
    // lands in the error branch rather than looking like an empty cohort.
    if (!report.value && assignment.value) {
      report.value = emptyReport()
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

    await mergeTeamManifests(token)

    if (report.value && assignment.value?.feedback_pr === true) {
      await mergeRepoRecordsIntoReport(token)
    }
    // Read unconditionally. Gating this on `autograde.enabled` meant an
    // assignment graded by a workflow that shipped with the template - the
    // GitHub Classroom shape - had its grades on disk and never on screen.
    const sum = await getRepoContent(token, props.org, config.controlRepo, `grading/${props.assignmentId}/summary.json`)
    if (sum) {
      try { autogradeSummary.value = JSON.parse(sum) } catch { /* malformed */ }
    }
    mergeGradesIntoReport()
    await Promise.all([
      loadOverrides(token),
      fetchRateLimit(token),
    ])
  } catch (e) {
    console.error('Failed to load report:', e)
    loadError.value = e.message || String(e)
  } finally {
    // `finally`, not a statement after the try: the early return above (an
    // unreadable assignment) would otherwise skip this and leave the page
    // spinning for ever - trading a crash for a hang.
    loading.value = false
  }
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
  'tagged_submission_declared_at', 'lock_down_at', 'lockdown_delay_seconds',
  'preservation_status',
  'preserved_sha', 'warnings',
]

function csvCell(v) {
  if (v === null || v === undefined) return ''
  let str = Array.isArray(v) ? v.join('; ') : String(v)
  if (/^[=+\-@]/.test(str)) {
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

// Copying the link, and the control-repo read behind it, live in
// InvitationShare.vue. Both used to exist here as well, and the read was
// silently broken for months on one of the two copies - `getRepoContent`
// resolves to decoded FILE TEXT, never a {ok, data} envelope, and the copy that
// checked `.ok` returned null for every assignment ever published. One reader.

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
    archive_branch: archiveBranchName({
      assignmentId: props.assignmentId,
      login: s.github_login,
      teamSlug: s.team_slug,
      recordedRef: s.archive_ref,
    }),
    archive_branch_url: studentArchiveUrl(s),
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
          // Shared picker: this had its own `includes('grade')` variant, which
          // misses the `classroom` naming the other copy matched.
          const run = pickAutogradeCheckRun(checkRes.data.check_runs)
          if (run) {
            s.ci_status = run.conclusion || run.status
            s.ci_run_url = run.html_url || run.details_url || s.ci_run_url || null
          }
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
    // Strip the display-only grade join before storing, and refuse rather than
    // write a report that fails its own schema.
    const storable = reportForStorage(report.value)
    const { valid, errors } = await validateAgainst('report', storable)
    if (!valid) {
      toast.error(
        `Refreshed on screen, but not saved - the report does not match its schema: ${errors
          .slice(0, 3)
          .map((e) => `${e.instancePath || '/'} ${e.message}`)
          .join('; ')}`
      )
      return
    }
    const reportBody = JSON.stringify(storable, null, 2) + '\n'
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

// Join grading/<id>/summary.json onto the rows already on screen, by login.
//
// The grades live in their own document because two surfaces write them (this
// view and `pxl-classroom grade`) and neither owns reports/<id>.json. Joining
// at render time keeps it that way - no second writer, no report schema
// change, and the CSV export picks the columns up for free because it is built
// from what is on screen.
// The fields joined onto report rows for DISPLAY only. They live in
// grading/<id>/summary.json, and report.schema.json's student items are
// `additionalProperties: false` and permit none of them - so a report carrying
// them cannot be stored. Anything added by mergeGradesIntoReport (or set on a
// row during a live refresh, like ci_status) belongs in this list.
const DISPLAY_ONLY_ROW_FIELDS = [
  'earned_points',
  'total_points',
  'ci_status',
  'ci_run_url',
  'graded_at',
]

/**
 * The report as it may be STORED, with the display-only join removed.
 *
 * The live refresh used to commit `report.value` verbatim, which wrote all five
 * grade fields into reports/<id>.json - a document the backend's report.mjs
 * never emits. Two costs, and the second is the one that bites later: the
 * stored report failed its own schema, and `earned_points` became a field that
 * appears in real control repos while nothing in the backend writes it, which
 * is exactly how earned_points, preserved_sha and lockdown_at each became a
 * phantom the fixtures believed in and no backend produced.
 *
 * Also heals a report already polluted by an earlier live refresh, because the
 * same fields are stripped whether this session added them or a previous one
 * did.
 */
function reportForStorage(source) {
  const doc = JSON.parse(JSON.stringify(source))
  for (const row of doc.students || []) {
    for (const f of DISPLAY_ONLY_ROW_FIELDS) delete row[f]
  }
  // Team rows carry the same join (a group's grade is its first member's).
  // report.schema.json is lenient about extra team properties, but storing a
  // derived value beside the ones report.mjs computes invites the same
  // divergence, so it goes too.
  for (const team of doc.teams || []) {
    for (const f of DISPLAY_ONLY_ROW_FIELDS) delete team[f]
  }
  return doc
}

function mergeGradesIntoReport() {
  const rows = report.value?.students
  if (!Array.isArray(rows)) return

  const byLogin = new Map()
  for (const row of autogradeSummary.value?.students || []) {
    if (row?.login) byLogin.set(String(row.login).toLowerCase(), row)
  }

  for (const s of rows) {
    const g = s.github_login ? byLogin.get(String(s.github_login).toLowerCase()) : null
    // Assigned rather than spread over the row: a student who has no grade
    // must not keep a stale one from a previous merge.
    s.earned_points = g?.earned_points ?? null
    s.total_points = g?.total_points ?? null
    s.ci_status = g?.ci_status ?? null
    s.ci_run_url = g?.ci_run_url ?? null
    s.graded_at = g?.graded_at ?? null
  }

  // A group shares one repository, so its grade is its first member's - the
  // same rule mergeTeamManifests already uses for repo_url.
  for (const team of report.value?.teams || []) {
    const first = rows.find((s) => s.team_slug && s.team_slug === team.team_slug && s.earned_points != null)
    team.earned_points = first?.earned_points ?? null
    team.total_points = first?.total_points ?? null
    team.ci_status = first?.ci_status ?? null
    team.ci_run_url = first?.ci_run_url ?? null
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
  // Set when GitHub refuses rather than fails. A missing App permission is not
  // something waiting fixes, and it is the same for every student - so it gets
  // its own sentence instead of being counted as N transient errors.
  let permissionDenied = false
  let cursor = 0

  const syncWorker = async () => {
    while (cursor < queue.length) {
      const s = queue[cursor++]
      const targetSha = s.preserved_sha || s.latest_observed_sha || s.last_on_time_sha || s.tagged_submission_sha
      try {
        // No commit on record is not an API failure. Without this the URL was
        // built with `undefined` in it, GitHub answered 404, and a student who
        // simply has not pushed yet was counted among "API errors".
        if (!targetSha) {
          summary.failed.push({
            login: s.github_login,
            reason: 'no commit on record to read a CI run from',
          })
          continue
        }

        // s.repo_name is already the full org/repo name.
        const checksReq = await ghApi(token, 'GET', `/repos/${s.repo_name}/commits/${targetSha}/check-runs`)
        if (!checksReq.ok) {
          // A 403 here is not transient, and "try again later" is advice that
          // can never come true: both check-run endpoints are gated by the
          // App's Checks permission, and a user-to-server token is capped by
          // what the App declares. Name it, or a lecturer retries for ever.
          if (checksReq.status === 403 || checksReq.status === 401) {
            permissionDenied = true
          }
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

        const run = pickAutogradeCheckRun(checkRuns)

        // No autograding run at this commit is NOT a zero and NOT a pass. The
        // picker used to fall back to the first check run of any kind, so a
        // student who deleted the autograding workflow and added a green one of
        // their own was awarded the full total from `conclusion: success`.
        if (!run) {
          summary.failed.push({
            login: s.github_login,
            reason: `no autograding run at commit ${targetSha.slice(0, 7)} - ${checkRuns.length} other check run(s) were found and none of them grades`,
          })
          continue
        }

        // The score is an ANNOTATION, not an output body: a check run created
        // by GitHub Actions has `output.summary === null` and carries
        // `Points X/Y` plus `{"totalPoints":…,"maxPoints":…}` as notices. This
        // used to parse `output.*` only, never match, and fall through to
        // "green means full marks, anything else means zero" - so a 15/20 was
        // recorded as 0. Skipped when the run declares no annotations, so the
        // ordinary case costs no second request.
        let annotations = []
        let annotationsComplete = true
        if (run?.output?.annotations_count) {
          const res = await fetchCheckRunAnnotations(
            (path) => ghApi(token, 'GET', path),
            { repoFullName: s.repo_name, checkRunId: run.id },
          )
          annotations = res.annotations
          annotationsComplete = res.complete
        }

        const parsed = parseCheckRunScore(run, annotations, totalFallback)

        // An incomplete annotation read that still had to guess from the
        // conclusion is not a grade, it is a failed read. Saying so beats
        // writing a plausible number nobody can tell apart from a real one.
        if (!parsed.matched && !annotationsComplete) {
          summary.failed.push({
            login: s.github_login,
            reason: `could not read the score annotations on the CI run at ${targetSha.slice(0, 7)}`,
          })
          continue
        }

        summary.graded.push({
          login: s.github_login,
          earned_points: parsed.earned,
          total_points: parsed.total > 0 ? parsed.total : totalFallback,
          // Recorded because the student table renders it, and because
          // "0 out of 20" and "the run never finished" are different facts.
          ci_status: run?.conclusion || run?.status || 'completed',
          ci_run_url: run?.html_url || run?.details_url || null,
          score_source: parsed.source,
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

    if (permissionDenied) {
      toast.error(
        'GitHub refused to show CI results: the PXL Classroom App needs the "Checks" permission (read), ' +
          'and an owner of this organization has to approve it under Settings → GitHub Apps → PXL Classroom → Review request. Nothing was saved.',
      )
      syncingGrades.value = false
      return
    }

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
    
    // Validated before it is committed, not after somebody notices. Two
    // surfaces write this file and neither checked it until the schema existed.
    const { valid, errors } = await validateAgainst('grading-summary', summaryDoc)
    if (!valid) {
      console.error('grading summary failed schema', errors)
      toast.error('The grade summary came out malformed and was not saved. Nothing was overwritten.')
      syncingGrades.value = false
      return
    }

    const path = `grading/${props.assignmentId}/summary.json`
    const body = JSON.stringify(summaryDoc, null, 2) + '\n'
    const res = await commitFile(token, props.org, config.controlRepo, path, body, `Sync grades for ${props.assignmentId}`)
    
    if (res.ok) {
      autogradeSummary.value = summaryDoc
      mergeGradesIntoReport()
      const partial = summary.failed.length
        ? ` ${summary.failed.length} could not be read.`
        : ''
      toast.success(`Read ${summary.graded.length} score(s) from GitHub Actions.${partial}`)
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
    // EVERY FIELD buildDashboardEntry READS MUST BE HERE. This object is
    // synthesised, so anything the shared builder learns to read and this does
    // not supply comes out null - and the refresh then quietly blanks it on the
    // entry it was refreshing. max_acceptances was added to the builder so the
    // dashboard's share block could tell "live" from "cap reached", and without
    // this line the very next live refresh would erase it again.
    //
    // The loaded assignment YAML wins over the stored entry: it is
    // authoritative and this view already has it. The entry is the fallback.
    const pseudoAssignment = {
      title: existingEntry.title,
      state: existingEntry.state,
      opens_at: existingEntry.opens_at,
      deadline_at: existingEntry.deadline_at,
      timezone: existingEntry.timezone ?? assignment.value?.timezone,
      max_acceptances: assignment.value?.max_acceptances ?? existingEntry.max_acceptances ?? null,
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

// Opening is now just "which student", because StudentActionsModal owns the
// rest: the form it seeds from `effective_deadline_at`, the focus it takes and
// gives back (composables/useFocusTrap.js), and the Tab cycling. All three used
// to live here, ~1,700 lines from the markup they belong to.
function openActions(student) {
  actionStudent.value = student
}

function closeActions() {
  if (actionExtending.value || actionRetrying.value) return
  actionStudent.value = null
}

function localToUtc(localStr) {
  if (!localStr) return ''
  return new Date(localStr).toISOString()
}

async function grantExtensionFor(student, ext) {
  if (!ext.deadline_local || !ext.reason.trim()) {
    toast.error('Deadline and reason are required.')
    return
  }
  // An extension must move the deadline forward. Guard against granting a
  // date at-or-before the student's current effective deadline (which would
  // silently shorten their time).
  const currentEffective = extensionFor(student.github_login)?.value
    || student.effective_deadline_at
    || assignment.value?.deadline_at
  if (currentEffective && new Date(localToUtc(ext.deadline_local)) <= new Date(currentEffective)) {
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

    const newExtValue = localToUtc(ext.deadline_local)

    overridesList.push({
      type: 'deadline_extension',
      value: newExtValue,
      reason: ext.reason.trim(),
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
              // A GREEN RUN IS NOT A REPOSITORY. accept.mjs exits 0 for every
              // `rejected:*` outcome on purpose - a student who is not on the
              // roster is the system working, and painting the hub red for that
              // teaches people to ignore red. But it means the retry concludes
              // `success` when it REFUSED, and this used to announce "Retry
              // succeeded: repository is live" with a link to a repository that
              // does not exist - to a lecturer whose most likely reason for
              // retrying is a student the roster rejects.
              //
              // So verify the claim being made rather than the run asked to
              // make it, the same way acceptanceCardIsLive fetches the card
              // instead of trusting the assignments index.
              const check = await getRepo(token, props.org, repoName)
              if (check.ok) {
                toast.success(`Retry succeeded: repository is live.`, {
                  link: { text: repoName, href: `https://github.com/${props.org}/${repoName}` }
                })
                await loadAll()
                return
              }
              // The run finished and created nothing, which is what a rejection
              // looks like from here. Do not guess WHICH rejection - the reason
              // is in the run log, and naming the wrong one is worse than
              // naming none.
              toast.error(
                `The retry ran, but ${login} still has no repository - the acceptance was refused.`,
                { link: { text: 'Open the run to see why.', href: latestRun.html_url } }
              )
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

.back-link { font-size: 0.85rem; display: inline-flex; align-items: center; gap: 4px; flex-shrink: 0; color: var(--text-secondary); }
.back-link:hover { color: var(--accent-blue); text-decoration: none; }
.breadcrumb { min-width: 0; flex: 1; }
.breadcrumb h1 { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.assignment-heading { font-size: 0.95rem; font-weight: 600; margin: 0; color: var(--text-primary); }
.btn-with-icon { display: inline-flex; align-items: center; gap: var(--space-xs); }
.separator { color: var(--text-muted); }
.org-name { color: var(--text-secondary); font-size: 0.85rem; text-decoration: none; }
.org-name:hover { color: var(--accent-blue); text-decoration: underline; }
.avatar { width: 24px; height: 24px; border-radius: 50%; }

/* padding-top/bottom, NOT the shorthand - see DashboardView: the shorthand
   out-specifies .container and removes its horizontal padding. */
main { padding-top: var(--space-xl); padding-bottom: var(--space-xl); }


.daily-watch {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  justify-content: center;
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
  transition: border-color var(--transition-fast), background-color var(--transition-fast);
}
.summary-card:hover {
  border-color: var(--border-default);
  background: var(--bg-surface-elevated);
}
.summary-value {
  display: block;
  font-size: 1.75rem;
  font-weight: 700;
  line-height: 1.2;
}
.deadline-value {
  font-size: 1.25rem;
  line-height: 1.2;
  padding: 4px 0;
}
.summary-label {
  font-size: 0.72rem;
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
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-md);
  background: var(--bg-surface);
}

table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.85rem;
}
th {
  background: var(--bg-surface);
  border-bottom: 1px solid var(--border-default);
  color: var(--text-secondary);
  font-weight: 600;
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  padding: 10px 14px;
  text-align: left;
  white-space: nowrap;
}
td {
  padding: 10px 14px;
  text-align: left;
  border-bottom: 1px solid var(--border-muted);
  white-space: nowrap;
}
th.col-warnings, td.col-warnings { white-space: normal; min-width: 160px; }
th.sortable { cursor: pointer; user-select: none; }
th.sortable:hover { color: var(--accent-blue); }
.th-label { display: inline-flex; align-items: center; gap: 4px; }
.sort-glyph { color: var(--accent-blue); }

tr:hover td { background: var(--bg-surface-hover); }
tbody tr:nth-child(even) td { background: var(--table-stripe); }
tbody tr:nth-child(even):hover td { background: var(--bg-surface-hover); }

.empty-row {
  text-align: center;
  padding: var(--space-lg);
  color: var(--text-secondary);
  white-space: normal;
}

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
.fb-pr-meta {
  display: inline-flex;
  align-items: center;
  gap: var(--space-xs);
  margin-left: var(--space-xs);
  white-space: nowrap;
}
.fb-pr-comments {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  font-size: 0.75rem;
  color: var(--text-secondary);
}

.autograde-section {
  margin-top: var(--space-xl);
  padding-top: var(--space-lg);
  border-top: 1px solid var(--border-default);
}
.autograde-head { display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-md); margin-bottom: var(--space-sm); }
.autograde-head h3 { margin: 0; font-size: 1rem; font-weight: 600; }
.text-xs { font-size: 0.75rem; }
.autograde-banner {
  background: var(--tint-accent-subtle);
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
  background: var(--tint-danger-subtle);
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

/* Only the table is empty; the page around it is not. */
.cohort-empty {
  margin-top: var(--space-md);
}
.cohort-empty h3 {
  margin: 0 0 var(--space-xs) 0;
}
.cohort-empty-note {
  font-size: 0.8rem;
  margin-top: var(--space-sm);
}
.detail-share {
  margin-bottom: var(--space-md);
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
  background: var(--bg-scrim);
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

/* Export Dropdown Menu */
.dropdown-container {
  position: relative;
  display: inline-block;
}

.export-dropdown-menu {
  position: absolute;
  top: calc(100% + 4px);
  /* Anchored to the trigger's RIGHT edge, because these triggers live in a
     right-aligned toolbar. With `left: 0` the 270px menu grew towards the
     viewport edge and stayed on screen only because another button happened to
     sit to its right - remove that button and the More menu's own centre fell
     outside the window (tests/e2e/21-org-dropdown.spec.mjs). */
  right: 0;
  z-index: 100;
  min-width: 270px;
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  /* No inline fallback after the comma: --radius-md is defined, and a fallback
     only hides a typo (DESIGN.md §5 rule 2). */
  border-radius: var(--radius-md);
  box-shadow: 0 8px 24px var(--shadow-color-lg);
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
  background: var(--bg-tertiary);
}

.export-dropdown-item.disabled-item,
.export-dropdown-item:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.dropdown-icon {
  margin-top: 2px;
  flex-shrink: 0;
  color: var(--accent-blue);
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
  color: var(--accent-blue);
}

.preservation-banner {
  padding: var(--space-md, 16px);
  background: var(--bg-secondary);
  border: 1px solid var(--border-default);
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












@media (max-width: 768px) {
  .summary-row { grid-template-columns: repeat(2, 1fr); }
  .actions-bar { flex-direction: column; align-items: stretch; }
  /* Stacking the bar is not enough: each row is itself a flex line of buttons
     ("Copy invitation link" alone is ~150px), and without wrapping it pushed
     the page sideways below ~430px. */
  .actions-bar > div { width: 100%; flex-wrap: wrap; }
  .search-input { flex: 1; min-width: 0; }
  .desktop-only { display: none; }
  .mobile-only { display: block; }
  .card-list { display: flex; flex-direction: column; gap: var(--space-sm); }
  .modal { padding: var(--space-md); }
}

/* ------------------------------------------------------------------------
   Vocabulary that was carried INLINE.

   Each class below was written in the markup beside a `style="…"` that said
   what it meant, so the class itself was declared nowhere and the look lived on
   the element. Moving the declarations here changes nothing on screen - the
   values are unchanged - but it takes them off the undeclared-class register
   and puts the appearance where DESIGN.md says it belongs.
   ------------------------------------------------------------------------ */

.archive-link-wrap {
  margin-top: 3px;
}

/* A badge that is a button. Both clickable badges in the student table carried
   `cursor: pointer; border: none;` inline - the same two declarations twice -
   while the class naming the behaviour was declared nowhere. Scoped, so
   `[data-v-*].badge-clickable` (0,2,0) still out-specifies the global `.badge`
   (0,1,0) exactly as the inline style did. */
.badge-clickable {
  cursor: pointer;
  border: none;
}
</style>
