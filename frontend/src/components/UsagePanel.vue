<template>
  <section class="usage-panel card fade-in" :class="{ 'is-collapsed': !isExpanded }">
    <!-- Header Bar (Clickable Accordion Toggle) -->
    <header
      class="usage-toggle-head flex items-center justify-between"
      @click="toggleExpanded"
      role="button"
      :aria-expanded="isExpanded"
      tabindex="0"
      @keydown.enter.space.prevent="toggleExpanded"
      title="Click to toggle Resource Usage &amp; Limits details"
    >
      <div class="flex items-center gap-sm flex-wrap">
        <Icon name="activity" :size="16" class="text-accent flex-shrink-0" />
        <h3 class="usage-title">Resource Usage &amp; Limits: <code>{{ org }}</code></h3>

        <!-- Summary Chips (Visible in Header) -->
        <div class="usage-summary-chips flex items-center gap-xs">
          <span class="summary-chip" title="Actions Linux compute minutes used in past 7 days">
            <Icon name="clock" :size="11" class="chip-icon text-muted" />
            <strong>{{ orgTotals.actionsMinutes }}</strong> min
          </span>
          <span class="summary-chip" title="Storage and artifacts used">
            <Icon name="database" :size="11" class="chip-icon text-muted" />
            <strong>{{ orgTotals.storageGbHours }}</strong> GB-hrs
          </span>
          <span class="summary-chip" title="Organization GitHub API rate limit headroom" v-if="rateLimit">
            <Icon name="zap" :size="11" class="chip-icon text-muted" />
            API: <strong>{{ rateLimit.remaining.toLocaleString() }}</strong> / {{ rateLimit.limit.toLocaleString() }}
          </span>
          <span v-if="report && report.over_count > 0" class="status-indicator">
            <span class="status-dot dot-warning"></span>
            <span class="text-xs text-warning">{{ report.over_count }} over</span>
          </span>
          <span v-else-if="report" class="status-indicator">
            <span class="status-dot dot-success"></span>
            <span class="text-xs text-success">Limits OK</span>
          </span>
        </div>
      </div>

      <div class="flex items-center gap-sm flex-shrink-0">
        <!-- The panel is the glance; /dashboard/:org/usage is the detail, and
             it had exactly one inbound link - from a view that itself had none
             (ARCHITECTURE §10.5). `@click.stop` because this header IS the accordion
             toggle: without it, following the link also collapses the panel
             behind it. -->
        <router-link
          :to="{ name: 'usage-org', params: { org } }"
          class="btn-link usage-full-report"
          @click.stop
        >Full report</router-link>
        <span class="toggle-indicator text-xs text-muted">
          {{ isExpanded ? 'Hide details' : 'Show details' }}
        </span>
        <Icon :name="isExpanded ? 'chevron-up' : 'chevron-down'" :size="14" class="text-muted" />
      </div>
    </header>

    <!-- Collapsible Body Content -->
    <div v-if="isExpanded" class="usage-body fade-in">
      <div class="usage-sub-row flex items-center justify-between flex-wrap gap-sm">
        <p class="text-muted usage-sub">
          7-day early-warning audit against course resource thresholds (GitHub monthly quotas reset on the 1st of each month).
        </p>
        <div class="flex items-center gap-sm">
          <button
            v-if="!runWatching"
            class="btn btn-sm btn-with-icon"
            type="button"
            @click.stop="generateNow"
            :disabled="triggering"
            title="Trigger an on-demand usage scan on GitHub Actions"
          >
            <Icon name="refresh-cw" :size="12" :class="{ 'spin-anim': triggering }" />
            <span>{{ triggering ? 'Scanning…' : (report ? 'Regenerate now' : 'Run audit now') }}</span>
          </button>
          <div v-else class="inline-spinner text-xs text-secondary">
            <div class="spinner" style="width: 12px; height: 12px; border-width: 2px;"></div>
            <span>Auditing…</span>
          </div>
        </div>
      </div>

      <!-- Org-Wide Summary KPI Cards -->
      <div class="kpi-grid">
        <div class="kpi-card">
          <span class="kpi-label">Actions Minutes (Linux)</span>
          <div class="kpi-val-row">
            <span class="kpi-val">{{ orgTotals.actionsMinutes }}</span>
            <span class="kpi-unit">min used</span>
          </div>
          <span class="kpi-sub text-muted">Weekly limit: 800 min/repo</span>
        </div>

        <div class="kpi-card">
          <span class="kpi-label">Storage &amp; Artifacts</span>
          <div class="kpi-val-row">
            <span class="kpi-val">{{ orgTotals.storageGbHours }}</span>
            <span class="kpi-unit">GB-hrs</span>
          </div>
          <span class="kpi-sub text-muted">Weekly limit: 5 GB-hrs/repo</span>
        </div>

        <div class="kpi-card">
          <span class="kpi-label">Organization API Quota</span>
          <div class="kpi-val-row" v-if="rateLimit">
            <span :class="['kpi-val', rateLimit.remaining < 500 ? 'text-danger' : '']">
              {{ rateLimit.remaining.toLocaleString() }}
            </span>
            <span class="kpi-unit">/ {{ rateLimit.limit.toLocaleString() }} avail</span>
          </div>
          <div class="kpi-val-row" v-else>
            <span class="kpi-val text-muted">-</span>
            <span class="kpi-unit">/ 5,000 avail</span>
          </div>
          <span class="kpi-sub text-muted">{{ formatRateReset(rateLimit?.reset) }}</span>
        </div>

        <div class="kpi-card">
          <span class="kpi-label">Organization Status</span>
          <div class="kpi-val-row">
            <span v-if="report && report.over_count > 0" class="status-pill status-pill-warn">
              ⚠ {{ report.over_count }} repo(s) over
            </span>
            <span v-else-if="report" class="status-pill status-pill-ok">
              ✓ All {{ org }} within limits
            </span>
            <span v-else class="status-pill" style="background: var(--bg-tertiary); color: var(--text-secondary);">
              Audit Pending
            </span>
          </div>
          <span class="kpi-sub text-muted" v-if="report">Period: {{ report.week_start }} → {{ report.week_end }}</span>
          <span class="kpi-sub text-muted" v-else>Weekly audit runs Sundays 22:00 UTC</span>
        </div>
      </div>

      <!-- Loading -->
      <div v-if="loading" class="usage-loading flex items-center gap-sm text-secondary">
        <div class="spinner" style="width: 14px; height: 14px; border-width: 2px;"></div>
        <span class="text-sm">Loading usage data for {{ org }}…</span>
      </div>

      <!-- Error State -->
      <div v-else-if="loadError" class="usage-error flex items-center justify-between" role="alert">
        <span class="text-sm">Failed to load usage report: {{ loadError }}</span>
        <button class="btn btn-sm" type="button" @click="loadReport">Retry</button>
      </div>

      <!-- Empty State / No Report Generated Yet -->
      <div v-else-if="!report" class="usage-empty text-sm">
        <p class="text-secondary" style="margin-bottom: var(--space-xs);">
          No weekly breakdown report found for <code>{{ org }}</code> yet. The audit runs automatically every <strong>Sunday at 22:00 UTC</strong>, or you can run one now.
        </p>
        <button
          v-if="!runWatching"
          class="btn btn-primary btn-sm btn-with-icon"
          type="button"
          @click="generateNow"
          :disabled="triggering"
        >
          <Icon name="zap" :size="12" />
          <span>{{ triggering ? 'Starting audit…' : 'Generate usage report now' }}</span>
        </button>
      </div>

      <!-- Loaded Report Content -->
      <div v-else class="usage-content">
        <!-- Filter / Search toolbar -->
        <div class="usage-toolbar flex items-center justify-between">
          <div class="text-xs text-muted">
            Showing <strong>{{ filtered.length }}</strong> of {{ (report.items || []).length }} resource line item(s)
          </div>
          <input
            v-model="filter"
            type="search"
            placeholder="Filter repositories or resources…"
            class="filter-search-input"
            aria-label="Filter usage items"
          />
        </div>

        <!-- Compact Table -->
        <div class="table-wrapper">
          <table class="usage-table">
            <thead>
              <tr>
                <th @click="sortBy('repo')" tabindex="0" :aria-sort="ariaSortFor('repo')">
                  <span class="th-label">Repository<SortIcon :dir="sortDirFor('repo')" /></span>
                </th>
                <th @click="sortBy('sku')" tabindex="0" :aria-sort="ariaSortFor('sku')">
                  <span class="th-label">Resource Type<SortIcon :dir="sortDirFor('sku')" /></span>
                </th>
                <th @click="sortBy('used')" tabindex="0" :aria-sort="ariaSortFor('used')" class="num">
                  <span class="th-label">Used (7 Days)<SortIcon :dir="sortDirFor('used')" /></span>
                </th>
                <th class="num">Weekly Limit</th>
                <th>Unit</th>
                <th>Threshold Level</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="filtered.length === 0">
                <td colspan="6" class="text-center text-muted" style="padding: var(--space-md);">
                  No matching usage records found.
                </td>
              </tr>
              <tr v-for="item in filtered" :key="item.repo + item.sku" :class="{ 'over-threshold': item.over }">
                <td>
                  <span v-if="item.repo === '<org-level>'" class="text-muted">&lt;org-level&gt;</span>
                  <code v-else>{{ item.repo }}</code>
                </td>
                <td>{{ formatSku(item.sku) }}</td>
                <td class="num">
                  <strong v-if="item.over" class="text-danger">{{ item.used }}</strong>
                  <span v-else>{{ item.used }}</span>
                </td>
                <td class="num">{{ item.limit ?? '-' }}</td>
                <td>{{ item.unit }}</td>
                <td><span class="badge source-badge">{{ formatSource(item.limit_source) }}</span></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch, h } from 'vue'
import Icon from './Icon.vue'
import { getToken } from '../lib/auth.js'
import {
  createWorkflowRequestId,
  getRepoContent,
  getWorkflowRunByRequestId,
  triggerWorkflow,
  explainDispatchFailure,
  ghApi,
} from '../lib/api.js'
import { config } from '../lib/config.js'
import { toast } from '../lib/toast.js'

const SortIcon = (props) =>
  h(Icon, {
    name: props.dir === 'asc' ? 'arrow-up' : props.dir === 'desc' ? 'arrow-down' : 'chevrons-up-down',
    size: 10,
    class: props.dir ? 'sort-glyph sort-glyph-active' : 'sort-glyph',
  })
SortIcon.props = ['dir']

const props = defineProps({
  org: { type: String, required: true }
})

// Collapsible state (collapsed by default)
const isExpanded = ref(false)

function toggleExpanded() {
  isExpanded.value = !isExpanded.value
}

const loading = ref(false)
const report = ref(null)
const loadError = ref(null)
const filter = ref('')
const sortKey = ref('used')
const sortDir = ref('desc')
const triggering = ref(false)
const runWatching = ref(false)
const pollCount = ref(0)
const rateLimit = ref(null)
let runPollInterval = null
let activeRequestId = null

const orgTotals = computed(() => {
  if (!report.value?.items) return { actionsMinutes: 0, storageGbHours: 0, codespacesHours: 0 }
  let actionsMinutes = 0
  let storageGbHours = 0
  let codespacesHours = 0
  for (const item of report.value.items) {
    const skuLower = (item.sku || '').toLowerCase()
    if (skuLower.includes('actions') && (skuLower.includes('linux') || skuLower.includes('windows') || skuLower.includes('macos') || skuLower.includes('minute'))) {
      actionsMinutes += item.used || 0
    } else if (skuLower.includes('storage')) {
      storageGbHours += item.used || 0
    } else if (skuLower.includes('codespace') && (skuLower.includes('compute') || skuLower.includes('hour'))) {
      codespacesHours += item.used || 0
    }
  }
  return {
    actionsMinutes: Math.round(actionsMinutes * 10) / 10,
    storageGbHours: Math.round(storageGbHours * 10) / 10,
    codespacesHours: Math.round(codespacesHours * 10) / 10,
  }
})

function formatSku(sku) {
  const map = {
    'Actions Linux': 'Actions (Linux runner)',
    'Actions Windows': 'Actions (Windows runner)',
    'Actions macOS': 'Actions (macOS runner)',
    'Actions storage': 'Workflow Logs & Storage',
    'Packages storage': 'Package Storage',
    'Packages data transfer': 'Package Data Transfer',
    'Git LFS storage': 'Git LFS Storage',
    'Git LFS bandwidth': 'Git LFS Bandwidth',
    'Codespaces compute': 'Codespaces Compute',
    'Codespaces storage': 'Codespaces Disk Storage',
  }
  return map[sku] || sku
}

function formatSource(src) {
  if (src === 'repo') return 'Repo Override'
  if (src === 'org') return 'Org Policy'
  if (src === 'global') return 'Global Default'
  return 'None'
}

function formatRateReset(resetDate) {
  if (!resetDate) return 'Hourly REST quota'
  const diffMs = resetDate.getTime() - Date.now()
  if (diffMs <= 0) return 'Resets momentarily'
  const mins = Math.ceil(diffMs / 60000)
  return `Resets in ~${mins} min`
}

const filtered = computed(() => {
  if (!report.value?.items) return []
  const f = filter.value.toLowerCase().trim()
  let items = report.value.items
  if (f) items = items.filter(i => (i.repo || '').toLowerCase().includes(f) || (i.sku || '').toLowerCase().includes(f))
  return [...items].sort((a, b) => {
    if (a.over !== b.over) return a.over ? -1 : 1
    const av = a[sortKey.value], bv = b[sortKey.value]
    const cmp = typeof av === 'number' ? av - bv : String(av).localeCompare(String(bv))
    return sortDir.value === 'asc' ? cmp : -cmp
  })
})

function sortBy(key) {
  if (sortKey.value === key) {
    sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc'
  } else {
    sortKey.value = key
    sortDir.value = key === 'used' ? 'desc' : 'asc'
  }
}

function sortDirFor(key) {
  return sortKey.value === key ? sortDir.value : null
}

function ariaSortFor(key) {
  if (sortKey.value !== key) return 'none'
  return sortDir.value === 'asc' ? 'ascending' : 'descending'
}

async function fetchRateLimit() {
  const token = getToken()
  if (!token) return
  try {
    const res = await ghApi(token, 'GET', '/rate_limit')
    if (res.ok && res.data?.resources?.core) {
      const core = res.data.resources.core
      rateLimit.value = {
        remaining: core.remaining,
        limit: core.limit,
        used: core.used || (core.limit - core.remaining),
        reset: core.reset ? new Date(core.reset * 1000) : null,
      }
    }
  } catch (e) {
    console.error('Failed to fetch rate limit:', e)
  }
}

async function loadReport() {
  const token = getToken()
  if (!token || !props.org) return
  loading.value = true
  loadError.value = null
  try {
    await fetchRateLimit()
    const content = await getRepoContent(token, props.org, config.controlRepo, 'reports/usage-latest.json')
    if (content) {
      report.value = JSON.parse(content)
    } else {
      report.value = null
    }
  } catch (e) {
    console.error('Failed to load usage report:', e)
    loadError.value = e.message || String(e)
  } finally {
    loading.value = false
  }
}

async function generateNow() {
  const token = getToken()
  if (!token || !props.org) return
  triggering.value = true
  try {
    const requestId = createWorkflowRequestId('usage')
    const baseline = report.value?.generated_at || null
    const res = await triggerWorkflow(token, config.hubOwner, config.hubRepo, 'weekly-usage-report.yml', {
      org: props.org,
      request_id: requestId,
    })
    if (res.ok || res.status === 204) {
      toast.success('Audit workflow dispatched - waiting for report…')
      runWatching.value = true
      startRunPoll(requestId, baseline)
    } else {
      toast.error(explainDispatchFailure(res, 'Trigger failed'))
    }
  } catch (e) {
    toast.error(`Trigger failed: ${e.message || String(e)}`)
  } finally {
    triggering.value = false
  }
}

function startRunPoll(requestId, baseline) {
  stopRunPoll()
  pollCount.value = 0
  activeRequestId = requestId
  const deadline = Date.now() + 4 * 60_000

  const poll = async () => {
    if (activeRequestId !== requestId) return
    pollCount.value++
    const res = await getWorkflowRunByRequestId(
      getToken(),
      config.hubOwner,
      config.hubRepo,
      'weekly-usage-report.yml',
      requestId
    )
    if (!res.ok) {
      toast.error(`Could not watch the audit workflow (HTTP ${res.status}).`)
      runWatching.value = false
      stopRunPoll()
      return
    }

    const run = res.run
    if (run?.status === 'completed') {
      await loadReport()
      runWatching.value = false
      stopRunPoll()
      if (run.conclusion !== 'success') {
        toast.error(`Usage audit ${run.conclusion || 'failed'}.`, {
          link: { href: run.html_url, text: 'Open workflow run' },
        })
      } else if (report.value && report.value.generated_at !== baseline) {
        toast.success('Usage report updated!')
      } else {
        toast.error('Audit completed but produced no new report. Open System Health to diagnose billing access.', {
          link: { href: run.html_url, text: 'Open workflow run' },
        })
      }
      return
    }

    if (Date.now() >= deadline) {
      toast.error('Audit watcher timed out after 4 minutes.', run?.html_url
        ? { link: { href: run.html_url, text: 'Open workflow run' } }
        : undefined)
      runWatching.value = false
      stopRunPoll()
      return
    }
    runPollInterval = setTimeout(poll, 5_000)
  }

  runPollInterval = setTimeout(poll, 1_500)
}

function stopRunPoll() {
  if (runPollInterval) {
    clearTimeout(runPollInterval)
    runPollInterval = null
  }
  activeRequestId = null
}

onMounted(async () => {
  await loadReport()
})

watch(() => props.org, async () => {
  stopRunPoll()
  runWatching.value = false
  report.value = null
  await loadReport()
})

onBeforeUnmount(() => {
  stopRunPoll()
})
</script>

<style scoped>
.usage-panel {
  margin-top: var(--space-xl);
  border: 1px solid var(--border-default);
  background: var(--bg-surface);
  border-radius: var(--radius-md, 6px);
  padding: var(--space-md);
  transition: all 0.2s ease;
}

.usage-panel.is-collapsed {
  padding: 10px 14px;
}

.usage-toggle-head {
  cursor: pointer;
  user-select: none;
  border-radius: var(--radius-sm);
  padding: 2px 4px;
  /* The right cluster is flex-shrink-0 and gained a "Full report" link, which
     pushed the dashboard 10px wider than a 360px phone. Wrapping is the right
     answer rather than shrinking: these are three separate controls, not one
     label to squeeze. */
  flex-wrap: wrap;
  gap: var(--space-xs);
}

.usage-toggle-head:hover .usage-title {
  color: var(--accent-blue);
}

.usage-toggle-head:focus-visible {
  outline: 2px solid var(--accent-blue);
}

.usage-title {
  margin: 0;
  font-size: 0.92rem;
  font-weight: 600;
  color: var(--text-primary);
  display: flex;
  align-items: center;
  gap: 6px;
  transition: color 0.15s ease;
}

.usage-title code {
  font-size: 0.85em;
  background: var(--bg-tertiary);
  padding: 1px 5px;
  border-radius: 4px;
}

.usage-summary-chips {
  margin-left: var(--space-xs);
}

.summary-chip {
  font-size: 0.72rem;
  padding: 2px 7px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-default);
  border-radius: 4px;
  color: var(--text-secondary);
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.summary-chip strong {
  color: var(--text-primary);
}

.chip-icon {
  opacity: 0.75;
}

.toggle-indicator {
  font-size: 0.75rem;
  font-weight: 500;
}

/* Sits inside a role="button" header, so it needs to read as its own control
   rather than as part of the toggle's label. */
.usage-full-report {
  font-size: 0.75rem;
  white-space: nowrap;
}

.usage-body {
  margin-top: var(--space-sm);
  padding-top: var(--space-sm);
  border-top: 1px solid var(--border-default);
}

.usage-sub-row {
  margin-bottom: var(--space-sm);
}

.usage-sub {
  margin: 0;
  font-size: 0.78rem;
  line-height: 1.3;
}

.usage-loading,
.usage-empty {
  padding: var(--space-md) 0;
}

.usage-error {
  background: var(--tint-danger-subtle);
  border: 1px solid var(--accent-red);
  color: var(--accent-red);
  padding: var(--space-xs) var(--space-sm);
  border-radius: var(--radius-sm);
  margin: var(--space-xs) 0;
}

/* KPI Summary Cards */
.kpi-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: var(--space-sm);
  margin-bottom: var(--space-sm);
}

.kpi-card {
  background: var(--bg-surface-hover);
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-sm);
  padding: 8px 12px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.kpi-label {
  font-size: 0.72rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-muted);
}

.kpi-val-row {
  display: flex;
  align-items: baseline;
  gap: 6px;
}

.kpi-val {
  font-size: 1.25rem;
  font-weight: 700;
  color: var(--text-primary);
  font-variant-numeric: tabular-nums;
}

.kpi-unit {
  font-size: 0.78rem;
  color: var(--text-secondary);
}

.kpi-sub {
  font-size: 0.72rem;
  margin-top: 1px;
}

.status-pill {
  font-size: 0.78rem;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
}

.status-pill-ok {
  background: var(--tint-success-muted);
  color: var(--accent-green);
  border: 1px solid var(--tint-success-emphasis);
}

.status-pill-warn {
  background: var(--tint-danger-muted);
  color: var(--accent-red);
  border: 1px solid var(--tint-danger-emphasis);
}

/* Toolbar */
.usage-toolbar {
  margin-bottom: var(--space-xs);
  gap: var(--space-sm);
  flex-wrap: wrap;
}

.filter-search-input {
  display: inline-block;
  min-width: 220px;
  max-width: 300px;
  padding: 3px 8px;
  font-size: 0.78rem;
  background: var(--bg-primary);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
}

.filter-search-input:focus {
  outline: 2px solid var(--accent-blue);
  border-color: transparent;
}

/* Compact Table */
.table-wrapper {
  overflow-x: auto;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  max-height: 380px;
}

.usage-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.8rem;
}

.usage-table th,
.usage-table td {
  padding: 6px 10px;
  text-align: left;
  border-bottom: 1px solid var(--border-default);
}

.usage-table th {
  background: var(--bg-secondary);
  font-weight: 600;
  font-size: 0.75rem;
  cursor: pointer;
  user-select: none;
  position: sticky;
  top: 0;
  z-index: 1;
}

.usage-table th:hover {
  color: var(--accent-blue);
}

.th-label {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}

.sort-glyph {
  color: var(--text-muted);
}

.sort-glyph-active {
  color: var(--accent-blue);
}

.usage-table .num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.usage-table tr.over-threshold {
  background: var(--tint-danger-subtle);
}

.usage-table tr.over-threshold td {
  color: var(--accent-red);
}

.source-badge {
  font-size: 0.7rem;
  padding: 1px 5px;
  background: var(--bg-tertiary);
  border-radius: 3px;
  color: var(--text-secondary);
}

.text-accent {
  color: var(--accent-blue);
}

.text-danger {
  color: var(--accent-red);
}


.inline-spinner {
  display: inline-flex;
  align-items: center;
  gap: var(--space-xs);
}

@media (max-width: 768px) {
  .usage-summary-chips {
    width: 100%;
    margin-left: 0;
    margin-top: var(--space-xs);
  }
}

@media (max-width: 640px) {
  .usage-toolbar {
    flex-direction: column;
    align-items: stretch;
  }
  .filter-search-input {
    width: 100%;
    max-width: 100%;
  }
}
</style>
