<template>
  <div class="detail-page">
    <header class="detail-header">
      <div class="container flex items-center justify-between">
        <div class="breadcrumb flex items-center gap-md">
          <router-link :to="{ name: 'dashboard', params: { org } }" class="back-link">
            <Icon name="arrow-left" :size="14" />
            <span>Dashboard</span>
          </router-link>
          <span class="separator">/</span>
          <router-link :to="{ name: 'dashboard', params: { org } }" class="org-name">{{ org }}</router-link>
          <span class="separator">/</span>
          <h1 :title="assignmentId">{{ assignmentId }}</h1>
        </div>
        <UserBadge :user="user" @logout="handleLogout" />
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
          <code>daily-activity.yml</code> run in the hub; the first one lands the night after publishing.
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
        <!-- Summary cards -->
        <div class="summary-row">
          <div class="summary-card card deadline-card">
            <span class="summary-value deadline-value" :class="{ 'stat-red': deadlinePassed }">
              {{ deadlineRelative || '-' }}
            </span>
            <span class="summary-label">Deadline{{ deadlineAbs ? ` · ${deadlineAbs}` : '' }}</span>
          </div>
          <div class="summary-card card">
            <span class="summary-value">{{ report.students.length }}</span>
            <span class="summary-label">Students</span>
          </div>
          <div class="summary-card card">
            <span class="summary-value stat-green">{{ onTimeCount }}</span>
            <span class="summary-label">On-time</span>
          </div>
          <div class="summary-card card">
            <span class="summary-value stat-yellow">{{ lateCount }}</span>
            <span class="summary-label">Late</span>
          </div>
          <div class="summary-card card">
            <span class="summary-value stat-red">{{ noSubCount }}</span>
            <span class="summary-label">No submission</span>
          </div>
        </div>

        <!-- Actions bar -->
        <div class="actions-bar flex items-center justify-between">
          <div class="flex items-center gap-md">
            <input
              v-model="search"
              type="search"
              placeholder="Search by login or repo…"
              class="search-input"
              aria-label="Search students"
            />
            <select v-model="statusFilter" aria-label="Filter by status">
              <option value="">All statuses</option>
              <option value="on-time">On-time</option>
              <option value="late">Late</option>
              <option value="no-submission">No submission</option>
              <option value="unknown">Unknown</option>
            </select>
          </div>
          <div class="flex gap-sm items-center">
            <button class="btn btn-primary btn-with-icon" @click="refreshLiveStatus" :disabled="refreshingLive">
              <span v-if="refreshingLive">Fetching ({{ refreshedStudentsCount }}/{{ totalStudentsToRefresh }})</span>
              <template v-else>
                <Icon name="refresh-cw" :size="14" />
                <span>Live Status</span>
              </template>
            </button>
            <button class="btn btn-with-icon" @click="exportCSV">
              <Icon name="download" :size="14" />
              <span>Export CSV</span>
            </button>
            <button class="btn btn-with-icon" @click="downloadManifest" :title="preservedCount ? `${preservedCount} preserved submission(s)` : 'No preserved submissions in the report'">
              <Icon name="download" :size="14" />
              <span>Download manifest</span>
            </button>
            <button class="btn btn-with-icon" @click="copyDownloadCmd">
              <Icon name="copy" :size="14" />
              <span>Copy CLI command</span>
            </button>
            <button class="btn btn-with-icon" @click="copyAcceptLink">
              <Icon name="copy" :size="14" />
              <span>Copy accept link</span>
            </button>
          </div>
        </div>

        <!-- Student table (desktop) -->
        <div class="table-wrapper desktop-only">
          <table>
            <thead>
              <tr>
                <th @click="sortBy('github_login')" @keydown.enter="sortBy('github_login')" @keydown.space.prevent="sortBy('github_login')" tabindex="0" class="sortable" :aria-sort="ariaSort('github_login')">
                  <span class="th-label">Login<SortIcon :dir="sortDir('github_login')" /></span>
                </th>
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
                <th @click="sortBy('tagged_submission_observed_at')" @keydown.enter="sortBy('tagged_submission_observed_at')" @keydown.space.prevent="sortBy('tagged_submission_observed_at')" tabindex="0" class="sortable" :aria-sort="ariaSort('tagged_submission_observed_at')">
                  <span class="th-label">Submit tag<SortIcon :dir="sortDir('tagged_submission_observed_at')" /></span>
                </th>
                <th @click="sortBy('commit_count')" @keydown.enter="sortBy('commit_count')" @keydown.space.prevent="sortBy('commit_count')" tabindex="0" class="sortable num" :aria-sort="ariaSort('commit_count')">
                  <span class="th-label">Commits<SortIcon :dir="sortDir('commit_count')" /></span>
                </th>
                <th v-if="isGitHubActionsAutograde" class="col-ci">CI Status</th>
                <th v-if="feedbackPrEnabled" class="col-feedback-pr">Feedback PR</th>
                <th class="col-warnings">Warnings</th>
                <th class="col-actions"><span class="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="s in filteredStudents" :key="s.github_login">
                <td>
                  <a :href="`https://github.com/${s.github_login}`" target="_blank">{{ s.github_login }}</a>
                </td>
                <td>
                  <span :class="['badge', acceptBadge(s.acceptance_state)]">{{ s.acceptance_state }}</span>
                </td>
                <td>
                  <span :class="['badge', statusBadge(s.submission_status)]">{{ s.submission_status }}</span>
                  <div v-if="extensionFor(s.github_login)" class="ext-note" :title="`Extension granted. Reason: ${extensionFor(s.github_login).reason}`">
                    ext → {{ fmt(extensionFor(s.github_login).value) }}
                  </div>
                </td>
                <td class="col-repo">
                  <a v-if="s.repo_url" :href="s.repo_url" target="_blank" class="mono repo-link">{{ shortRepo(s.repo_name) }}</a>
                  <span v-else class="text-muted">-</span>
                </td>
                <td class="col-last-commit">
                  <template v-if="s.repo_url && latestSha(s)">
                    <div v-if="s.latest_observed_at" class="commit-time-top" :title="fmt(s.latest_observed_at)">
                      {{ formatRelative(s.latest_observed_at, assignment?.timezone) }}
                    </div>
                    <a :href="`${s.repo_url}/commit/${latestSha(s)}`" target="_blank" class="mono sha">
                      {{ latestSha(s).slice(0, 7) }}
                    </a>
                  </template>
                  <span v-else-if="s.repo_url" class="text-muted">no commits</span>
                  <span v-else class="text-muted">-</span>
                </td>
                <td class="col-submit-tag">
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
                      {{ formatRelative(s.tagged_submission_observed_at, assignment?.timezone) }}
                    </div>
                  </template>
                  <span v-else class="text-muted untagged" title="No submit/ tag found">-</span>
                </td>
                <td class="num">
                  <span v-if="s.commit_count != null">{{ s.commit_count.toLocaleString() }}</span>
                  <span v-else class="text-muted">-</span>
                </td>
                <td v-if="isGitHubActionsAutograde" class="col-ci">
                  <span v-if="s.ci_status" :class="['badge', s.ci_status === 'success' ? 'badge-success' : s.ci_status === 'failure' ? 'badge-error' : 'badge-warning']">
                    {{ s.ci_status }}
                  </span>
                  <span v-else class="text-muted">-</span>
                </td>
                <td v-if="feedbackPrEnabled" class="col-feedback-pr">
                  <template v-if="s.feedback_pr_number">
                    <a :href="s.feedback_pr_url" target="_blank" class="mono">#{{ s.feedback_pr_number }}</a>
                  </template>
                  <span v-else class="text-muted" title="Run `pxl-classroom feedback open` once the student has pushed commits.">- pending</span>
                </td>
                <td class="col-warnings">
                  <div v-if="s.warnings?.length" class="flex gap-sm flex-wrap">
                    <span v-for="w in s.warnings" :key="w" class="badge badge-warning text-xs">{{ w }}</span>
                  </div>
                  <span v-else class="text-muted">-</span>
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
            <header class="student-card-head">
              <a :href="`https://github.com/${s.github_login}`" target="_blank" class="student-card-login">{{ s.github_login }}</a>
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
            <!-- Touch devices can't reach title tooltips — repeat the detail as text. -->
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
                <span v-if="s.latest_observed_at" :title="fmt(s.latest_observed_at)">{{ formatRelative(s.latest_observed_at, assignment?.timezone) }}</span>
                <a :href="`${s.repo_url}/commit/${latestSha(s)}`" target="_blank" class="mono sha text-muted">· {{ latestSha(s).slice(0, 7) }}</a>
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
              <span v-for="w in s.warnings" :key="w" class="badge badge-warning text-xs">{{ w }}</span>
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
              Sync reads each student's CI conclusion at the preserved SHA — it is a
              <strong>pass/fail signal</strong>, not per-test grading.
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
                  <th v-if="summaryIsCiBased">CI result</th>
                  <template v-else>
                    <th class="num">Earned</th>
                    <th class="num">Total</th>
                  </template>
                  <th>Last graded</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in autogradeSummary.students" :key="row.login">
                  <td><a :href="`https://github.com/${row.login}`" target="_blank">{{ row.login }}</a></td>
                  <td v-if="summaryIsCiBased">
                    <span :class="['badge', row.earned_points >= row.total_points && row.total_points > 0 ? 'badge-success' : 'badge-error']">
                      {{ row.earned_points >= row.total_points && row.total_points > 0 ? 'passed' : 'failed' }}
                    </span>
                  </td>
                  <template v-else>
                    <td class="num">{{ row.earned_points }}</td>
                    <td class="num">{{ row.total_points }}</td>
                  </template>
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

// Tiny render helper — keeps the table markup readable. `dir` is "asc" |
// "desc" | null; null renders nothing so non-active columns stay quiet.
const SortIcon = (props) => props.dir
  ? h(Icon, { name: props.dir === 'asc' ? 'arrow-up' : 'arrow-down', size: 11, class: 'sort-glyph' })
  : null
SortIcon.props = ['dir']
import { config } from '../lib/config.js'
import { getToken, getUser, clearAuth, isAuthenticated, startDeviceFlow, pollDeviceFlow } from '../lib/auth.js'
import { getRepoContent, listRepoDir, ghApi, commitFile, triggerWorkflow, explainDispatchFailure, totalFromLinkHeader, getRepo } from '../lib/api.js'
import { validateAgainst } from '../lib/validate.js'
import { formatDate } from '../lib/format.js'
import { toast } from '../lib/toast.js'
import { buildDashboardEntry } from '../../../lib/dashboard-aggregate.mjs'
import DeviceFlowCard from '../components/DeviceFlowCard.vue'
import { parse as parseYaml } from 'yaml'

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

// "Run daily activity now" — dispatch + watch for the first report to land.
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
        } catch { /* half-written file — keep polling */ }
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
const autogradeTotalPoints = computed(() => (assignment.value?.autograde?.tests || []).reduce((sum, t) => sum + (t.points || 0), 0))
const syncingGrades = ref(false)
const syncedGradesCount = ref(0)
const totalGradesToSync = ref(0)

// CI-derived summaries carry a single pass/fail conclusion, not per-test
// points — display them as such instead of implying granular grading.
const summaryIsCiBased = computed(() => autogradeSummary.value?.runner === 'github_actions')

// login → override doc from overrides/<assignment>/<login>.json, so granted
// extensions are visible (and inspectable before granting again).
const overridesByLogin = ref(new Map())

// Base columns: login, acceptance, status, repo, last commit, submit tag,
// commits, warnings, actions — plus the two conditional columns.
const tableColumnCount = computed(() =>
  9 + (isGitHubActionsAutograde.value ? 1 : 0) + (feedbackPrEnabled.value ? 1 : 0))

function extensionFor(login) {
  const doc = overridesByLogin.value.get(login)
  const ext = (doc?.overrides || []).filter((o) => o.type === 'deadline_extension').pop()
  return ext || null
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
const deadlineRelative = computed(() => currentDeadline.value ? formatRelative(currentDeadline.value, assignment.value?.timezone) : '')
const deadlineAbs = computed(() => {
  return currentDeadline.value ? fmt(currentDeadline.value) : ''
})

const filteredStudents = computed(() => {
  let list = report.value?.students || []
  if (search.value) {
    const q = search.value.toLowerCase()
    list = list.filter((s) => s.github_login.toLowerCase().includes(q) || (s.repo_name && s.repo_name.toLowerCase().includes(q)))
  }
  if (statusFilter.value) {
    list = list.filter((s) => s.submission_status === statusFilter.value)
  }
  list = [...list].sort((a, b) => {
    const av = a[sortKey.value]
    const bv = b[sortKey.value]
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

function onKeydown(e) {
  if (e.key === 'Escape' && actionStudent.value) closeActions()
}

onMounted(async () => {
  window.addEventListener('keydown', onKeydown)
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
    const [reportContent, assignmentContent] = await Promise.all([
      getRepoContent(token, props.org, config.controlRepo, `reports/${props.assignmentId}.json`),
      getRepoContent(token, props.org, config.controlRepo, `assignments/${props.assignmentId}.yml`),
    ])
    if (reportContent) {
      report.value = JSON.parse(reportContent)
      if (report.value.live_refreshed_at) liveRefreshedAt.value = report.value.live_refreshed_at
    }
    if (assignmentContent) {
      assignment.value = parseYaml(assignmentContent)
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
    await loadOverrides(token)
  } catch (e) {
    console.error('Failed to load report:', e)
    loadError.value = e.message || String(e)
  }
  loading.value = false
}

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
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
// Returns 'asc' | 'desc' | null — consumed by the <SortIcon> render helper
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

// `submit/2026-10-05T20:34:11Z-a1b2c3d` → `a1b2c3d` (short SHA suffix) so the
// column stays narrow. Full tag name is on hover via title.
function shortTag(tag) {
  if (!tag) return ''
  const dash = tag.lastIndexOf('-')
  return dash >= 0 ? tag.slice(dash + 1) : tag
}

function latestSha(s) {
  return s.latest_observed_sha || s.last_on_time_sha || null
}

function formatRelative(iso, timezone = null) {
  if (!iso) return ''
  const diffMs = Date.now() - new Date(iso).getTime()
  if (Number.isNaN(diffMs)) return ''
  const abs = Math.abs(diffMs)
  const future = diffMs < 0
  const min = 60_000, hr = 3_600_000, day = 86_400_000
  let s
  if (abs < hr) s = `${Math.max(1, Math.round(abs / min))}m`
  else if (abs < day) s = `${Math.round(abs / hr)}h`
  else if (abs < 30 * day) s = `${Math.round(abs / day)}d`
  else {
    try {
      s = new Date(iso).toLocaleDateString('en-GB', {
        timeZone: timezone || assignment.value?.timezone || 'Europe/Brussels',
        day: 'numeric', month: 'short', year: 'numeric'
      })
    } catch {
      s = new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
    }
  }
  return future ? `in ${s}` : `${s} ago`
}

// Same column set as report.mjs's nightly CSV, but generated from the report
// currently on screen — so an export taken after a Live Status refresh can
// never contradict the table the lecturer just looked at.
const CSV_HEADERS = [
  'github_login', 'student_number', 'full_name', 'class_group',
  'acceptance_state', 'submission_status', 'effective_deadline_at',
  'override_applied', 'override_reason', 'repo_name', 'repo_url',
  'last_on_time_sha', 'last_on_time_observed_at', 'first_late_sha',
  'first_late_observed_at', 'latest_observed_sha', 'latest_observed_at',
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
  // Route shape is /:org/a/:assignmentId — the org segment is required.
  const link = `${base}${props.org}/a/${props.assignmentId}`
  navigator.clipboard.writeText(link).then(
    () => toast.success(`Accept link copied: ${link}`),
    () => toast.error('Could not copy link'),
  )
}

// Manifest of preserved submissions — login + archive SHA + clickable
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

// Returns true when the row was refreshed, false on any API failure — the
// caller counts failures so a partial refresh is never presented (or saved)
// as a complete one.
async function refreshOne(token, s) {
  try {
    const res = await ghApi(token, 'GET', `/repos/${s.repo_name}/commits?per_page=1`)
    if (!res.ok) return false

    s.commit_count = totalFromLinkHeader(res.headers, res.data)

    if (res.ok && res.data && res.data.length > 0) {
      const commit = res.data[0]
      const sha = commit.sha
      const commitDateStr = commit.commit.committer.date
      const commitDate = new Date(commitDateStr)

      // Source of truth for the deadline: per-student override (already on
      // the record), else the current assignment YAML's deadline_at. Fixes
      // the case where the report.json was written before the deadline was
      // set, leaving effective_deadline_at null on each student.
      const effectiveSource = s.effective_deadline_at || assignment.value?.deadline_at
      const deadline = effectiveSource ? new Date(effectiveSource) : null
      if (effectiveSource && !s.effective_deadline_at) s.effective_deadline_at = effectiveSource

      s.latest_observed_sha = sha
      s.latest_observed_at = commitDateStr

      if (deadline) {
        if (commitDate <= deadline) {
          s.submission_status = 'on-time'
          s.last_on_time_sha = sha
        } else {
          // Post-deadline commit. Nightly semantics: an on-time submission on
          // record keeps the student on-time — late *activity* is not a late
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

  // A partial refresh must never be presented — or persisted — as a complete
  // one. Surface the failure count and leave the control repo untouched.
  if (failedCount > 0) {
    toast.error(
      `Refreshed ${queue.length - failedCount} of ${queue.length} students; ${failedCount} failed` +
      `${rateLimit.value.remaining === 0 ? ' (API rate limit exhausted)' : ''}. Nothing was saved; try again later.`,
    )
    refreshingLive.value = false
    return
  }

  // Success! Swap the cloned students back in.
  report.value.students = clonedStudents

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
    toast.success(`Live status updated for ${totalStudentsToRefresh.value} students (saved).`)
  } catch (e) {
    console.error('Failed to persist report:', e)
    toast.error('Refreshed locally but save failed.')
  } finally {
    refreshingLive.value = false
  }
}

async function syncGradesFromGitHub() {
  const token = getToken()
  if (!token || !report.value || !assignment.value) return
  
  // CI results are read at each student's *preserved* SHA, which only exists
  // after the deadline-night finalize. Never commit an empty summary (it
  // would overwrite a previous one) — explain the precondition instead.
  const queue = report.value.students.filter(s => s.repo_name && s.preserved_sha)
  if (queue.length === 0) {
    toast.info(
      'CI results sync against preserved submissions, which are created by the deadline finalize. ' +
      'No students are preserved yet. Nothing was synced.',
    )
    return
  }

  totalGradesToSync.value = queue.length
  syncedGradesCount.value = 0
  syncingGrades.value = true
  const summary = { graded: [], failed: [] }

  let apiFailedCount = 0

  try {
    for (const s of queue) {
      try {
        // s.repo_name is already the full org/repo name.
        const checksReq = await ghApi(token, 'GET', `/repos/${s.repo_name}/commits/${s.preserved_sha}/check-runs`);
        if (!checksReq.ok) {
          throw new Error(`checks API fetch failed — HTTP ${checksReq.status}`)
        }
        const checkRuns = checksReq.data?.check_runs || [];
        const total = (assignment.value.autograde?.tests || []).reduce((acc, t) => acc + (t.points || 0), 0);
        let earned = 0;
        let passed = false;
        
        if (checkRuns.length === 0) {
          summary.failed.push({
            login: s.github_login,
            reason: "no CI run at preserved SHA"
          });
          continue;
        }

        const run = checkRuns.find(r => r.name.toLowerCase().includes("grade") || r.name.toLowerCase().includes("autograde")) || checkRuns[0];
        if (run && run.conclusion === "success") {
          earned = total;
          passed = true;
        }
        
        summary.graded.push({
          login: s.github_login,
          earned_points: earned,
          total_points: total,
          graded_at: new Date().toISOString()
        })
      } catch (err) {
        apiFailedCount++
        console.error(`Sync failed for ${s.github_login}:`, err)
      } finally {
        syncedGradesCount.value++
      }
    }

    if (apiFailedCount > 0) {
      toast.error(`CI results sync failed for ${apiFailedCount} student(s) due to API errors. Nothing was saved; try again later.`)
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
    toast.error('Failed to sync grades')
  } finally {
    syncingGrades.value = false
  }
}

// Mirror report.mjs's dashboard aggregate, but only for the assignment we
// just refreshed. Skips silently if dashboard.json doesn't exist or doesn't
// already have an entry for this assignment — we don't conjure entries.
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
      toast.success(`Extension granted to ${student.github_login}`)
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

function startRetryWatch(login, repoName) {
  if (retryPollTimer) clearTimeout(retryPollTimer)
  let pollCount = 0
  const workflowUrl = `https://github.com/${config.hubOwner}/${config.hubRepo}/actions/workflows/retry-acceptance.yml`
  const tick = async () => {
    pollCount++
    const token = getToken()
    if (token) {
      const res = await getRepo(token, props.org, repoName)
      if (res.ok) {
        toast.success(`Retry succeeded: repository is live.`, {
          link: { text: repoName, href: `https://github.com/${props.org}/${repoName}` }
        })
        await loadAll()
        return
      }
    }
    if (pollCount >= 24) { // 24 * 5s = 2 mins
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
    const res = await triggerWorkflow(token, config.hubOwner, config.hubRepo, 'retry-acceptance.yml', {
      org: props.org,
      assignment_id: props.assignmentId,
      github_login: login,
    })
    if (res.ok || res.status === 204) {
      const workflowUrl = `https://github.com/${config.hubOwner}/${config.hubRepo}/actions/workflows/retry-acceptance.yml`
      toast.success(`Retry triggered for ${login}. Watching for repository to appear…`, {
        link: { text: 'View workflow run', href: workflowUrl }
      })
      
      const pattern = assignment.value?.repository_name_pattern || `${props.assignmentId}-{github_login}`
      const repoName = pattern.replace('{github_login}', login)
      startRetryWatch(login, repoName)
      
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
/* The breadcrumb must shrink inside the header flex row — otherwise a long
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
.modal-section .field textarea { resize: vertical; min-height: 56px; font-family: var(--font-sans); }
.modal-section p { margin: 0 0 var(--space-sm); font-size: 0.85rem; }

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
