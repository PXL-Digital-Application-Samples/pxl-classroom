<template>
  <div class="detail-page">
    <header class="detail-header">
      <div class="container flex items-center justify-between">
        <div class="flex items-center gap-md">
          <router-link :to="{ name: 'dashboard', params: { org } }" class="back-link">← Dashboard</router-link>
          <span class="separator">/</span>
          <router-link :to="{ name: 'dashboard', params: { org } }" class="org-name">{{ org }}</router-link>
          <span class="separator">/</span>
          <h1>{{ assignmentId }}</h1>
        </div>
        <UserBadge :user="user" @logout="handleLogout" />
      </div>
    </header>

    <main class="container">
      <!-- Loading -->
      <div v-if="loading" class="center-card fade-in">
        <div class="spinner-lg spinner"></div>
        <p class="text-secondary">Loading report…</p>
      </div>

      <!-- No report -->
      <div v-else-if="!report" class="center-card fade-in">
        <h2>No report found</h2>
        <p class="text-secondary">Run the "Export report" workflow in the control repo to generate a report for this assignment.</p>
      </div>

      <!-- Report loaded -->
      <div v-else class="report-content fade-in">
        <!-- Summary cards -->
        <div class="summary-row">
          <div class="summary-card card deadline-card">
            <span class="summary-value deadline-value" :class="{ 'stat-red': deadlinePassed }">
              {{ deadlineRelative || '—' }}
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
            <button class="btn btn-primary" @click="refreshLiveStatus" :disabled="refreshingLive">
              <span v-if="refreshingLive">Fetching ({{ refreshedStudentsCount }}/{{ totalStudentsToRefresh }})</span>
              <template v-else>
                <span aria-hidden="true">↻</span><span>Live Status</span>
              </template>
            </button>
            <button class="btn" @click="exportCSV">
              <span aria-hidden="true">⬇</span><span>Export CSV</span>
            </button>
            <button class="btn" @click="copyAcceptLink">
              <span aria-hidden="true">⧉</span><span>Copy accept link</span>
            </button>
          </div>
        </div>

        <!-- Student table (desktop) -->
        <div class="table-wrapper desktop-only">
          <table>
            <thead>
              <tr>
                <th @click="sortBy('github_login')" class="sortable">
                  Login {{ sortIcon('github_login') }}
                </th>
                <th @click="sortBy('acceptance_state')" class="sortable">
                  Acceptance {{ sortIcon('acceptance_state') }}
                </th>
                <th @click="sortBy('submission_status')" class="sortable">
                  Status {{ sortIcon('submission_status') }}
                </th>
                <th>Repo</th>
                <th @click="sortBy('latest_observed_at')" class="sortable">
                  Last commit {{ sortIcon('latest_observed_at') }}
                </th>
                <th @click="sortBy('commit_count')" class="sortable num">
                  Commits {{ sortIcon('commit_count') }}
                </th>
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
                </td>
                <td class="col-repo">
                  <a v-if="s.repo_url" :href="s.repo_url" target="_blank" class="mono repo-link">{{ shortRepo(s.repo_name) }}</a>
                  <span v-else class="text-muted">—</span>
                </td>
                <td class="col-last-commit">
                  <template v-if="s.repo_url && latestSha(s)">
                    <div v-if="s.latest_observed_at" class="commit-time-top" :title="formatDate(s.latest_observed_at)">
                      {{ formatRelative(s.latest_observed_at) }}
                    </div>
                    <a :href="`${s.repo_url}/commit/${latestSha(s)}`" target="_blank" class="mono sha">
                      {{ latestSha(s).slice(0, 7) }}
                    </a>
                  </template>
                  <span v-else-if="s.repo_url" class="text-muted">no commits</span>
                  <span v-else class="text-muted">—</span>
                </td>
                <td class="num">
                  <span v-if="s.commit_count != null">{{ s.commit_count.toLocaleString() }}</span>
                  <span v-else class="text-muted">—</span>
                </td>
                <td class="col-warnings">
                  <div v-if="s.warnings?.length" class="flex gap-sm flex-wrap">
                    <span v-for="w in s.warnings" :key="w" class="badge badge-warning text-xs">{{ w }}</span>
                  </div>
                  <span v-else class="text-muted">—</span>
                </td>
                <td class="col-actions">
                  <button class="row-action" type="button" @click="openActions(s)" :aria-label="`Actions for ${s.github_login}`">⋯</button>
                </td>
              </tr>
              <tr v-if="report.students.length > 0 && filteredStudents.length === 0">
                <td colspan="8" class="empty-row">
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
              <button class="row-action" type="button" @click="openActions(s)" :aria-label="`Actions for ${s.github_login}`">⋯</button>
            </header>
            <div class="student-card-badges">
              <span :class="['badge', acceptBadge(s.acceptance_state)]">{{ s.acceptance_state }}</span>
              <span :class="['badge', statusBadge(s.submission_status)]">{{ s.submission_status }}</span>
              <span v-if="s.lock_down_at" class="badge badge-info">locked</span>
            </div>
            <div v-if="s.repo_url" class="student-card-repo">
              <a :href="s.repo_url" target="_blank" class="mono">{{ shortRepo(s.repo_name) }}</a>
              <div v-if="latestSha(s)" class="commit-row">
                Last commit
                <span v-if="s.latest_observed_at" :title="formatDate(s.latest_observed_at)">{{ formatRelative(s.latest_observed_at) }}</span>
                <a :href="`${s.repo_url}/commit/${latestSha(s)}`" target="_blank" class="mono sha text-muted">· {{ latestSha(s).slice(0, 7) }}</a>
                <span v-if="s.commit_count != null" class="text-muted">· {{ s.commit_count.toLocaleString() }} commits</span>
              </div>
            </div>
            <div v-if="s.warnings?.length" class="student-card-warnings">
              <span v-for="w in s.warnings" :key="w" class="badge badge-warning text-xs">{{ w }}</span>
            </div>
          </article>
        </div>

        <p class="table-footer text-muted">
          {{ filteredStudents.length }} of {{ report.students.length }} students shown ·
          Generated {{ formatDate(report.generated_at) }}<span v-if="liveRefreshedAt"> · Live-refreshed {{ formatDate(liveRefreshedAt) }}</span><span v-if="rateLimit.remaining != null" :title="`Your GitHub REST quota — resets hourly`"> · API quota {{ rateLimit.remaining.toLocaleString() }} / {{ rateLimit.limit.toLocaleString() }}</span>.
        </p>
      </div>

      <!-- Per-row action modal -->
      <div v-if="actionStudent" class="modal-overlay" @click.self="closeActions">
        <div class="modal" role="dialog" aria-modal="true" :aria-label="`Actions for ${actionStudent.github_login}`">
          <header class="modal-head">
            <h3>Actions — <code>{{ actionStudent.github_login }}</code></h3>
            <button class="modal-close" type="button" @click="closeActions" :disabled="actionExtending || actionRetrying" aria-label="Close">×</button>
          </header>

          <section class="modal-section">
            <h4>Grant deadline extension</h4>
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
import { ref, computed, onMounted } from 'vue'
import UserBadge from '../components/UserBadge.vue'
import { config } from '../lib/config.js'
import { getToken, getUser, clearAuth } from '../lib/auth.js'
import { getRepoContent, ghApi, commitFile, triggerWorkflow, explainDispatchFailure, totalFromLinkHeader } from '../lib/api.js'
import { validateAgainst } from '../lib/validate.js'
import { formatDate } from '../lib/format.js'
import { toast } from '../lib/toast.js'
import { buildDashboardEntry } from '../../../lib/dashboard-aggregate.mjs'
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
const search = ref('')
const statusFilter = ref('')
const sortKey = ref('github_login')
const sortAsc = ref(true)

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

const onTimeCount = computed(() => report.value?.students.filter((s) => s.submission_status === 'on-time').length || 0)
const lateCount = computed(() => report.value?.students.filter((s) => s.submission_status === 'late').length || 0)
const noSubCount = computed(() => report.value?.students.filter((s) => s.submission_status === 'no-submission').length || 0)

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
  if (!currentDeadline.value) return ''
  return new Date(currentDeadline.value).toLocaleString('en-GB', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  })
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

onMounted(async () => {
  const token = getToken()
  if (!token) { loading.value = false; return }
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
  } catch (e) {
    console.error('Failed to load report:', e)
  }
  loading.value = false
})

function handleLogout() {
  clearAuth()
  window.location.href = import.meta.env.BASE_URL
}

function sortBy(key) {
  if (sortKey.value === key) sortAsc.value = !sortAsc.value
  else { sortKey.value = key; sortAsc.value = true }
}
function sortIcon(key) {
  if (sortKey.value !== key) return ''
  return sortAsc.value ? '↑' : '↓'
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

function latestSha(s) {
  return s.latest_observed_sha || s.last_on_time_sha || null
}

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
  else if (abs < 30 * day) s = `${Math.round(abs / day)}d`
  else s = new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
  return future ? `in ${s}` : `${s} ago`
}

async function exportCSV() {
  const token = getToken()
  if (!token) return
  const csv = await getRepoContent(token, props.org, config.controlRepo, `reports/${props.assignmentId}.csv`)
  if (!csv) {
    toast.error('No CSV found in the control repo for this assignment.')
    return
  }
  const blob = new Blob([csv], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${props.assignmentId}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

function copyAcceptLink() {
  const base = window.location.origin + (import.meta.env.BASE_URL || '/')
  const link = `${base}a/${props.assignmentId}`
  navigator.clipboard.writeText(link).then(
    () => toast.success('Accept link copied'),
    () => toast.error('Could not copy link'),
  )
}

function clearFilters() {
  search.value = ''
  statusFilter.value = ''
}

async function refreshOne(token, s) {
  try {
    const res = await ghApi(token, 'GET', `/repos/${s.repo_name}/commits?per_page=1`)

    if (res.ok) s.commit_count = totalFromLinkHeader(res.headers, res.data)

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
          s.submission_status = 'late'
          s.first_late_sha = sha
        }
      } else {
        s.submission_status = 'unknown'
      }
    } else if (res.ok && res.data && res.data.length === 0) {
      s.submission_status = 'no-submission'
    }
  } catch (e) {
    console.error(`Failed to fetch live status for ${s.repo_name}:`, e)
  }
  refreshedStudentsCount.value++
}

async function refreshLiveStatus() {
  const token = getToken()
  if (!token || !report.value) return

  const queue = report.value.students.filter(s => s.repo_name)
  if (queue.length === 0) {
    toast.info('No provisioned repositories to check.')
    return
  }

  refreshingLive.value = true
  totalStudentsToRefresh.value = queue.length
  refreshedStudentsCount.value = 0

  let cursor = 0
  const worker = async () => {
    while (cursor < queue.length) {
      const s = queue[cursor++]
      await refreshOne(token, s)
    }
  }
  const workers = Array.from({ length: Math.min(REFRESH_CONCURRENCY, queue.length) }, worker)
  await Promise.all(workers)

  const refreshedAt = new Date().toISOString()
  liveRefreshedAt.value = refreshedAt
  report.value.live_refreshed_at = refreshedAt
  report.value.live_refreshed_by = user.value?.login || null

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
}

function closeActions() {
  if (actionExtending.value || actionRetrying.value) return
  actionStudent.value = null
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
  actionExtending.value = true
  try {
    const token = getToken()
    const overrideDoc = {
      schema_version: 1,
      assignment_id: props.assignmentId,
      github_login: student.github_login,
      overrides: [
        {
          type: 'deadline_extension',
          value: localToUtc(actionExt.value.deadline_local),
          reason: actionExt.value.reason.trim(),
          overridden_by: 'admin-panel',
          overridden_at: new Date().toISOString(),
        },
      ],
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
      actionStudent.value = null
    } else {
      toast.error(`Extension failed: ${res.data?.message || 'unknown error'}`)
    }
  } finally {
    actionExtending.value = false
  }
}

async function retryAcceptanceFor(student) {
  actionRetrying.value = true
  try {
    const token = getToken()
    const res = await triggerWorkflow(token, 'PXL-Digital-Application-Samples', 'pxl-classroom', 'retry-acceptance.yml', {
      org: props.org,
      assignment_id: props.assignmentId,
      github_login: student.github_login,
    })
    if (res.ok || res.status === 204) {
      toast.success(`Retry triggered for ${student.github_login}`)
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
.back-link { font-size: 0.875rem; }
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
