<template>
  <div class="detail-page">
    <header class="detail-header">
      <div class="container flex items-center justify-between">
        <div class="flex items-center gap-md">
          <router-link :to="{ name: 'dashboard' }" class="back-link">← Dashboard</router-link>
          <span class="separator">/</span>
          <span class="org-name">{{ org }}</span>
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
              placeholder="Search by login or status…"
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
          <div class="flex gap-sm">

            <button class="btn" @click="copyAcceptLink">📋 Copy accept link</button>
          </div>
        </div>

        <!-- Student table -->
        <div class="table-wrapper">
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
                <th>On-time SHA</th>
                <th>Latest SHA</th>
                <th>Uncertainty</th>
                <th>Lock-down</th>
                <th>Preserved</th>
                <th>Warnings</th>
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
                <td>
                  <a v-if="s.repo_url" :href="s.repo_url" target="_blank" class="mono">{{ shortRepo(s.repo_name) }}</a>
                  <span v-else class="text-muted">—</span>
                </td>
                <td>
                  <a v-if="s.last_on_time_sha && s.repo_url" :href="`${s.repo_url}/commit/${s.last_on_time_sha}`" target="_blank" class="mono sha">
                    {{ s.last_on_time_sha?.slice(0, 7) }}
                  </a>
                  <span v-else class="text-muted">—</span>
                </td>
                <td>
                  <a v-if="s.latest_observed_sha && s.repo_url" :href="`${s.repo_url}/commit/${s.latest_observed_sha}`" target="_blank" class="mono sha">
                    {{ s.latest_observed_sha?.slice(0, 7) }}
                  </a>
                  <span v-else class="text-muted">—</span>
                </td>
                <td>
                  <span v-if="s.uncertainty_interval_seconds != null" :class="{ 'text-warning': s.uncertainty_interval_seconds > 3600 }">
                    {{ formatDuration(s.uncertainty_interval_seconds) }}
                  </span>
                  <span v-else class="text-muted">—</span>
                </td>
                <td>
                  <span v-if="s.lock_down_at" class="badge badge-info">locked</span>
                  <span v-else class="text-muted">—</span>
                </td>
                <td>
                  <span :class="['badge', preserveBadge(s.preservation_status)]">{{ s.preservation_status || '—' }}</span>
                </td>
                <td>
                  <div v-if="s.warnings?.length" class="flex gap-sm flex-wrap">
                    <span v-for="w in s.warnings" :key="w" class="badge badge-warning text-xs">{{ w }}</span>
                  </div>
                  <span v-else class="text-muted">—</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p class="table-footer text-muted">{{ filteredStudents.length }} of {{ report.students.length }} students shown. Generated {{ formatDate(report.generated_at) }}.</p>
      </div>
    </main>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import UserBadge from '../components/UserBadge.vue'
import { config } from '../lib/config.js'
import { getToken, getUser, isAuthenticated, clearAuth } from '../lib/auth.js'
import { getRepoContent } from '../lib/api.js'
import { formatDate } from '../lib/format.js'

const props = defineProps({
  org: { type: String, required: true },
  assignmentId: { type: String, required: true },
})

const user = ref(getUser())
const loading = ref(true)
const report = ref(null)
const search = ref('')
const statusFilter = ref('')
const sortKey = ref('github_login')
const sortAsc = ref(true)

const onTimeCount = computed(() => report.value?.students.filter((s) => s.submission_status === 'on-time').length || 0)
const lateCount = computed(() => report.value?.students.filter((s) => s.submission_status === 'late').length || 0)
const noSubCount = computed(() => report.value?.students.filter((s) => s.submission_status === 'no-submission').length || 0)

const filteredStudents = computed(() => {
  let list = report.value?.students || []
  if (search.value) {
    const q = search.value.toLowerCase()
    list = list.filter((s) => s.github_login.toLowerCase().includes(q) || s.submission_status.includes(q))
  }
  if (statusFilter.value) {
    list = list.filter((s) => s.submission_status === statusFilter.value)
  }
  list = [...list].sort((a, b) => {
    const av = a[sortKey.value] ?? ''
    const bv = b[sortKey.value] ?? ''
    const cmp = String(av).localeCompare(String(bv))
    return sortAsc.value ? cmp : -cmp
  })
  return list
})

onMounted(async () => {
  const token = getToken()
  if (!token) { loading.value = false; return }
  try {
    const content = await getRepoContent(token, props.org, config.controlRepo, `reports/${props.assignmentId}.json`)
    if (content) report.value = JSON.parse(content)
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
function preserveBadge(status) {
  return { preserved: 'badge-success', failed: 'badge-error', pending: 'badge-warning', 'not-required': 'badge-neutral' }[status] || 'badge-neutral'
}

function shortRepo(name) {
  if (!name) return ''
  return name.includes('/') ? name.split('/')[1] : name
}



function formatDuration(seconds) {
  if (seconds < 60) return `${Math.round(seconds)}s`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`
  return `${(seconds / 3600).toFixed(1)}h`
}

function exportCSV() {
  const token = getToken()
  if (!token) return
  // Fetch CSV from control repo
  getRepoContent(token, props.org, config.controlRepo, `reports/${props.assignmentId}.csv`)
    .then((csv) => {
      if (!csv) return
      const blob = new Blob([csv], { type: 'text/csv' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${props.assignmentId}.csv`
      a.click()
      URL.revokeObjectURL(url)
    })
}

function copyAcceptLink() {
  const base = window.location.origin + (import.meta.env.BASE_URL || '/')
  const link = `${base}a/${props.assignmentId}`
  navigator.clipboard.writeText(link)
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
.org-name { color: var(--text-secondary); font-size: 0.875rem; }
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
  grid-template-columns: repeat(4, 1fr);
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
th {
  background: var(--bg-tertiary);
  font-weight: 600;
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-secondary);
  position: sticky;
  top: 0;
}
th.sortable { cursor: pointer; user-select: none; }
th.sortable:hover { color: var(--accent-blue); }

tr:hover td { background: rgba(88, 166, 255, 0.04); }
tr:nth-child(even) td { background: rgba(255, 255, 255, 0.02); }
tr:nth-child(even):hover td { background: rgba(88, 166, 255, 0.06); }

.sha { font-size: 0.8rem; }
.text-muted { color: var(--text-muted); }
.text-secondary { color: var(--text-secondary); }
.text-warning { color: var(--accent-yellow); }

.table-footer {
  margin-top: var(--space-md);
  font-size: 0.8rem;
}

@media (max-width: 768px) {
  .summary-row { grid-template-columns: repeat(2, 1fr); }
  .actions-bar { flex-direction: column; }
}
</style>
