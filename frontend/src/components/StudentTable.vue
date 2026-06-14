<template>
  <div class="student-table-wrapper">
    <!-- Toolbar -->
    <div class="table-toolbar">
      <div class="search-box">
        <svg class="search-icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
          <path fill="currentColor" d="M10.68 11.74a6 6 0 0 1-7.92-8.98 6 6 0 0 1 8.98 7.92l3.81 3.81a.75.75 0 0 1-1.06 1.06l-3.81-3.81ZM6 10.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9Z" />
        </svg>
        <input
          v-model="searchQuery"
          type="search"
          placeholder="Filter by login, status, warnings…"
          class="search-input"
          aria-label="Filter students"
        />
      </div>

      <div class="toolbar-actions">
        <span class="result-count">{{ filteredStudents.length }} student{{ filteredStudents.length !== 1 ? 's' : '' }}</span>
        <button class="btn-export" @click="exportCsv" title="Download CSV report">
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path fill="currentColor" d="M2.75 14A1.75 1.75 0 0 1 1 12.25v-2.5a.75.75 0 0 1 1.5 0v2.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25v-2.5a.75.75 0 0 1 1.5 0v2.5A1.75 1.75 0 0 1 13.25 14ZM7.25 1.75a.75.75 0 0 1 1.5 0v7.94l2.72-2.72a.75.75 0 1 1 1.06 1.06l-4 4a.75.75 0 0 1-1.06 0l-4-4a.75.75 0 0 1 1.06-1.06l2.72 2.72V1.75Z" />
          </svg>
          Export CSV
        </button>
      </div>
    </div>

    <!-- Table -->
    <div class="table-scroll">
      <table class="student-table" role="grid">
        <thead>
          <tr>
            <th
              v-for="col in columns"
              :key="col.key"
              :class="['sortable', { sorted: sortKey === col.key }]"
              @click="toggleSort(col.key)"
              @keydown.enter="toggleSort(col.key)"
              tabindex="0"
              role="columnheader"
              :aria-sort="sortKey === col.key ? (sortAsc ? 'ascending' : 'descending') : 'none'"
            >
              <span class="th-label">{{ col.label }}</span>
              <span class="sort-indicator" v-if="sortKey === col.key">
                {{ sortAsc ? '↑' : '↓' }}
              </span>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-if="sortedStudents.length === 0">
            <td :colspan="columns.length" class="empty-row">
              {{ searchQuery ? 'No students match your filter.' : 'No student data available.' }}
            </td>
          </tr>
          <tr v-for="(student, idx) in sortedStudents" :key="student.login || idx">
            <!-- GitHub Login -->
            <td>
              <a
                :href="`https://github.com/${student.login}`"
                target="_blank"
                rel="noopener noreferrer"
                class="login-link"
              >
                {{ student.login }}
              </a>
            </td>

            <!-- Acceptance -->
            <td>
              <span :class="['badge', acceptanceBadgeClass(student.acceptance)]">
                {{ student.acceptance || '—' }}
              </span>
            </td>

            <!-- Submission Status -->
            <td>
              <span :class="['badge', statusBadgeClass(student.submission_status)]">
                {{ statusLabel(student.submission_status) }}
              </span>
            </td>

            <!-- Repo -->
            <td>
              <a
                v-if="student.repo"
                :href="repoUrl(student)"
                target="_blank"
                rel="noopener noreferrer"
                class="repo-link"
              >
                {{ student.repo }}
              </a>
              <span v-else class="text-muted">—</span>
            </td>

            <!-- Last On-Time SHA -->
            <td>
              <a
                v-if="student.last_on_time_sha"
                :href="commitUrl(student, student.last_on_time_sha)"
                target="_blank"
                rel="noopener noreferrer"
                class="sha-link"
              >
                {{ shortSha(student.last_on_time_sha) }}
              </a>
              <span v-else class="text-muted">—</span>
            </td>

            <!-- Latest SHA -->
            <td>
              <a
                v-if="student.latest_sha"
                :href="commitUrl(student, student.latest_sha)"
                target="_blank"
                rel="noopener noreferrer"
                class="sha-link"
              >
                {{ shortSha(student.latest_sha) }}
              </a>
              <span v-else class="text-muted">—</span>
            </td>

            <!-- Lock-down -->
            <td>
              <span :class="['badge', student.locked ? 'badge-blue' : 'badge-muted']">
                {{ student.locked ? 'Locked' : '—' }}
              </span>
            </td>

            <!-- Preservation -->
            <td>
              <span :class="['badge', student.preserved ? 'badge-blue' : 'badge-muted']">
                {{ student.preserved ? 'Preserved' : '—' }}
              </span>
            </td>

            <!-- Warnings -->
            <td>
              <span v-if="student.warnings && student.warnings.length" class="warnings-text">
                {{ Array.isArray(student.warnings) ? student.warnings.join('; ') : student.warnings }}
              </span>
              <span v-else class="text-muted">—</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { getToken } from '../lib/auth.js'
import { getRepoContent } from '../lib/api.js'
import { config } from '../lib/config.js'

const props = defineProps({
  students: {
    type: Array,
    required: true,
  },
  assignmentId: {
    type: String,
    default: '',
  },
  org: {
    type: String,
    default: '',
  },
})

const searchQuery = ref('')
const sortKey = ref('login')
const sortAsc = ref(true)

const columns = [
  { key: 'login', label: 'GitHub Login' },
  { key: 'acceptance', label: 'Acceptance' },
  { key: 'submission_status', label: 'Status' },
  { key: 'repo', label: 'Repository' },
  { key: 'last_on_time_sha', label: 'On-Time SHA' },
  { key: 'latest_sha', label: 'Latest SHA' },
  { key: 'locked', label: 'Lock-down' },
  { key: 'preserved', label: 'Preservation' },
  { key: 'warnings', label: 'Warnings' },
]

// --- Filtering ---

const filteredStudents = computed(() => {
  const q = searchQuery.value.toLowerCase().trim()
  if (!q) return props.students

  return props.students.filter((s) => {
    const login = (s.login || '').toLowerCase()
    const status = (s.submission_status || '').toLowerCase()
    const warnings = Array.isArray(s.warnings)
      ? s.warnings.join(' ').toLowerCase()
      : (s.warnings || '').toLowerCase()
    const acceptance = (s.acceptance || '').toLowerCase()
    const repo = (s.repo || '').toLowerCase()

    return (
      login.includes(q) ||
      status.includes(q) ||
      warnings.includes(q) ||
      acceptance.includes(q) ||
      repo.includes(q)
    )
  })
})

// --- Sorting ---

function toggleSort(key) {
  if (sortKey.value === key) {
    sortAsc.value = !sortAsc.value
  } else {
    sortKey.value = key
    sortAsc.value = true
  }
}

const sortedStudents = computed(() => {
  const data = [...filteredStudents.value]
  const key = sortKey.value
  const asc = sortAsc.value

  data.sort((a, b) => {
    let va = a[key]
    let vb = b[key]

    // Handle arrays (warnings)
    if (Array.isArray(va)) va = va.join(', ')
    if (Array.isArray(vb)) vb = vb.join(', ')

    // Handle booleans
    if (typeof va === 'boolean') va = va ? 1 : 0
    if (typeof vb === 'boolean') vb = vb ? 1 : 0

    // Null / undefined last
    if (va == null && vb == null) return 0
    if (va == null) return 1
    if (vb == null) return -1

    if (typeof va === 'string') {
      const cmp = va.localeCompare(vb, undefined, { sensitivity: 'base' })
      return asc ? cmp : -cmp
    }

    return asc ? va - vb : vb - va
  })

  return data
})

// --- Badge classes ---

function statusBadgeClass(status) {
  const map = {
    'on-time': 'badge-green',
    'on_time': 'badge-green',
    late: 'badge-yellow',
    'no-submission': 'badge-red',
    'no_submission': 'badge-red',
  }
  return map[status] || 'badge-muted'
}

function statusLabel(status) {
  const map = {
    'on-time': 'On Time',
    'on_time': 'On Time',
    late: 'Late',
    'no-submission': 'No Sub',
    'no_submission': 'No Sub',
  }
  return map[status] || status || 'Unknown'
}

function acceptanceBadgeClass(acceptance) {
  if (!acceptance) return 'badge-muted'
  const a = acceptance.toLowerCase()
  if (a === 'accepted' || a === 'yes') return 'badge-green'
  if (a === 'pending' || a === 'invited') return 'badge-yellow'
  return 'badge-muted'
}

// --- URL helpers ---

function repoUrl(student) {
  const org = props.org || config.defaultOrg
  return `https://github.com/${org}/${student.repo}`
}

function commitUrl(student, sha) {
  const org = props.org || config.defaultOrg
  if (student.repo) {
    return `https://github.com/${org}/${student.repo}/commit/${sha}`
  }
  return '#'
}

function shortSha(sha) {
  return sha ? sha.substring(0, 7) : '—'
}

// --- CSV Export ---

async function exportCsv() {
  const token = getToken()
  const org = props.org || config.defaultOrg
  const repo = config.controlRepo

  if (token && props.assignmentId) {
    // Try downloading the pre-built CSV from the control repo
    const csv = await getRepoContent(token, org, repo, `reports/${props.assignmentId}.csv`)
    if (csv) {
      downloadBlob(csv, `${props.assignmentId}.csv`, 'text/csv')
      return
    }
  }

  // Fallback: generate CSV from current table data
  const header = columns.map((c) => c.label).join(',')
  const rows = sortedStudents.value.map((s) => {
    return columns
      .map((c) => {
        let val = s[c.key]
        if (Array.isArray(val)) val = val.join('; ')
        if (val == null) val = ''
        // Escape CSV
        val = String(val).replace(/"/g, '""')
        return `"${val}"`
      })
      .join(',')
  })

  const csvContent = [header, ...rows].join('\n')
  downloadBlob(csvContent, `${props.assignmentId || 'students'}.csv`, 'text/csv')
}

function downloadBlob(content, filename, type) {
  const blob = new Blob([content], { type })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
</script>

<style scoped>
.student-table-wrapper {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* --- Toolbar --- */

.table-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}

.search-box {
  display: flex;
  align-items: center;
  background: #0d1117;
  border: 1px solid #30363d;
  border-radius: 8px;
  padding: 0 12px;
  flex: 1;
  max-width: 420px;
  transition: border-color 0.2s;
}

.search-box:focus-within {
  border-color: #58a6ff;
}

.search-icon {
  color: #8b949e;
  flex-shrink: 0;
}

.search-input {
  background: none;
  border: none;
  color: #e6edf3;
  font-size: 0.85rem;
  padding: 10px 8px;
  width: 100%;
  outline: none;
  font-family: system-ui, -apple-system, sans-serif;
}

.search-input::placeholder {
  color: #484f58;
}

.toolbar-actions {
  display: flex;
  align-items: center;
  gap: 16px;
}

.result-count {
  font-size: 0.78rem;
  color: #8b949e;
  white-space: nowrap;
}

.btn-export {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  background: rgba(88, 166, 255, 0.1);
  border: 1px solid #30363d;
  border-radius: 8px;
  color: #58a6ff;
  font-size: 0.8rem;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.2s, border-color 0.2s;
  font-family: system-ui, -apple-system, sans-serif;
}

.btn-export:hover {
  background: rgba(88, 166, 255, 0.18);
  border-color: #58a6ff;
}

.btn-export:focus-visible {
  outline: 2px solid #58a6ff;
  outline-offset: 2px;
}

/* --- Table --- */

.table-scroll {
  overflow-x: auto;
  border-radius: 10px;
  border: 1px solid #30363d;
}

.student-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.82rem;
  min-width: 900px;
}

.student-table thead {
  background: #161b22;
  position: sticky;
  top: 0;
  z-index: 1;
}

.student-table th {
  padding: 12px 14px;
  text-align: left;
  color: #8b949e;
  font-weight: 600;
  font-size: 0.72rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  border-bottom: 1px solid #30363d;
  white-space: nowrap;
  user-select: none;
}

.student-table th.sortable {
  cursor: pointer;
  transition: color 0.15s;
}

.student-table th.sortable:hover,
.student-table th.sorted {
  color: #e6edf3;
}

.student-table th:focus-visible {
  outline: 2px solid #58a6ff;
  outline-offset: -2px;
}

.th-label {
  margin-right: 4px;
}

.sort-indicator {
  font-size: 0.7rem;
  color: #58a6ff;
}

.student-table td {
  padding: 10px 14px;
  border-bottom: 1px solid #21262d;
  color: #c9d1d9;
  vertical-align: middle;
}

.student-table tbody tr:nth-child(even) {
  background: rgba(22, 27, 34, 0.5);
}

.student-table tbody tr:hover {
  background: rgba(88, 166, 255, 0.04);
}

.empty-row {
  text-align: center;
  padding: 32px 14px !important;
  color: #8b949e;
  font-style: italic;
}

/* --- Links --- */

.login-link {
  color: #58a6ff;
  text-decoration: none;
  font-weight: 500;
}

.login-link:hover {
  text-decoration: underline;
}

.repo-link {
  color: #c9d1d9;
  text-decoration: none;
  font-family: ui-monospace, Consolas, monospace;
  font-size: 0.78rem;
}

.repo-link:hover {
  color: #58a6ff;
  text-decoration: underline;
}

.sha-link {
  color: #8b949e;
  text-decoration: none;
  font-family: ui-monospace, Consolas, monospace;
  font-size: 0.78rem;
  background: rgba(110, 118, 129, 0.1);
  padding: 2px 6px;
  border-radius: 4px;
}

.sha-link:hover {
  color: #58a6ff;
  background: rgba(88, 166, 255, 0.1);
}

/* --- Badges --- */

.badge {
  display: inline-block;
  font-size: 0.7rem;
  font-weight: 600;
  padding: 3px 10px;
  border-radius: 20px;
  white-space: nowrap;
  text-transform: capitalize;
}

.badge-green {
  background: rgba(63, 185, 80, 0.15);
  color: #3fb950;
}

.badge-yellow {
  background: rgba(210, 153, 34, 0.15);
  color: #d29922;
}

.badge-red {
  background: rgba(248, 81, 73, 0.15);
  color: #f85149;
}

.badge-blue {
  background: rgba(88, 166, 255, 0.15);
  color: #58a6ff;
}

.badge-muted {
  background: rgba(139, 148, 158, 0.1);
  color: #8b949e;
}

.text-muted {
  color: #484f58;
}

.warnings-text {
  color: #d29922;
  font-size: 0.78rem;
}

/* --- Responsive --- */

@media (max-width: 768px) {
  .table-toolbar {
    flex-direction: column;
    align-items: stretch;
  }

  .search-box {
    max-width: none;
  }

  .toolbar-actions {
    justify-content: space-between;
  }
}
</style>
