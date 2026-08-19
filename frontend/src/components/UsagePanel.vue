<template>
  <section class="usage-panel card fade-in">
    <div class="usage-head flex items-center justify-between">
      <div>
        <div class="flex items-center gap-sm">
          <Icon name="activity" :size="18" class="text-accent" />
          <h2 class="usage-title">Resource Usage &amp; Limits</h2>
        </div>
        <p class="text-muted usage-sub">Weekly audit of Actions minutes, Codespaces, and storage against configured limits.</p>
      </div>
      <div class="flex items-center gap-sm">
        <button
          v-if="report && !runWatching"
          class="btn btn-with-icon"
          type="button"
          @click="generateNow"
          :disabled="triggering"
          title="Trigger a new audit scan on GitHub Actions"
        >
          <Icon name="refresh-cw" :size="14" :class="{ 'spin-anim': triggering }" />
          <span>{{ triggering ? 'Triggering…' : 'Regenerate now' }}</span>
        </button>
        <div v-else-if="runWatching" class="inline-spinner text-sm text-secondary">
          <div class="spinner" style="width: 14px; height: 14px; border-width: 2px;"></div>
          <span>Generating report… ({{ pollCount }}×)</span>
        </div>
      </div>
    </div>

    <!-- Loading -->
    <div v-if="loading" class="usage-loading flex items-center gap-sm text-secondary">
      <div class="spinner" style="width: 16px; height: 16px; border-width: 2px;"></div>
      <span>Loading usage data…</span>
    </div>

    <!-- Error State -->
    <div v-else-if="loadError" class="usage-error flex items-center justify-between" role="alert">
      <span>Failed to load usage report: {{ loadError }}</span>
      <button class="btn btn-sm" type="button" @click="loadReport">Retry</button>
    </div>

    <!-- Empty State / No Report Generated Yet -->
    <div v-else-if="!report" class="usage-empty">
      <p class="text-secondary">
        No usage report found for <code>{{ org }}</code> yet. The usage scan runs automatically every <strong>Sunday at 22:00 UTC</strong>, or you can generate one right now.
      </p>
      <button
        v-if="!runWatching"
        class="btn btn-primary btn-with-icon"
        type="button"
        @click="generateNow"
        :disabled="triggering"
        style="margin-top: var(--space-sm);"
      >
        <Icon name="zap" :size="14" />
        <span>{{ triggering ? 'Starting workflow…' : 'Generate usage report now' }}</span>
      </button>
      <div v-else class="inline-spinner" style="margin-top: var(--space-sm);">
        <div class="spinner" style="width: 14px; height: 14px; border-width: 2px;"></div>
        <span>Workflow started. Waiting for the report to land… ({{ pollCount }}×)</span>
      </div>
    </div>

    <!-- Loaded Report Content -->
    <div v-else class="usage-content">
      <div class="usage-summary-bar flex items-center justify-between">
        <div class="flex items-center gap-md flex-wrap">
          <div class="usage-meta-item">
            <span class="meta-label">Period:</span>
            <span class="meta-value">{{ report.week_start }} → {{ report.week_end }}</span>
          </div>
          <div class="usage-meta-item">
            <span class="meta-label">Audited:</span>
            <span class="meta-value" :title="formatDate(report.generated_at)">{{ formatDate(report.generated_at) }}</span>
          </div>
          <div class="usage-meta-item">
            <span
              v-if="report.over_count > 0"
              class="badge badge-warning"
              style="color: var(--accent-red); border-color: rgba(248, 81, 73, 0.4); background: rgba(248, 81, 73, 0.1);"
            >
              ⚠ {{ report.over_count }} repo/SKU pair(s) over threshold
            </span>
            <span v-else class="badge badge-success">
              ✓ All repos within configured limits
            </span>
          </div>
        </div>
        <input
          v-model="filter"
          type="search"
          placeholder="Filter by repository or SKU…"
          class="filter-search-input"
          aria-label="Filter usage items"
        />
      </div>

      <div class="table-wrapper">
        <table class="usage-table">
          <thead>
            <tr>
              <th @click="sortBy('repo')" @keydown.enter="sortBy('repo')" @keydown.space.prevent="sortBy('repo')" tabindex="0" :aria-sort="ariaSortFor('repo')">
                <span class="th-label">Repository<SortIcon :dir="sortDirFor('repo')" /></span>
              </th>
              <th @click="sortBy('sku')" @keydown.enter="sortBy('sku')" @keydown.space.prevent="sortBy('sku')" tabindex="0" :aria-sort="ariaSortFor('sku')">
                <span class="th-label">SKU<SortIcon :dir="sortDirFor('sku')" /></span>
              </th>
              <th @click="sortBy('used')" @keydown.enter="sortBy('used')" @keydown.space.prevent="sortBy('used')" tabindex="0" :aria-sort="ariaSortFor('used')" class="num">
                <span class="th-label">Used<SortIcon :dir="sortDirFor('used')" /></span>
              </th>
              <th class="num">Limit</th>
              <th>Unit</th>
              <th>Threshold Source</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="filtered.length === 0">
              <td colspan="6" class="text-center text-muted" style="padding: var(--space-lg);">
                No matching usage entries found.
              </td>
            </tr>
            <tr v-for="item in filtered" :key="item.repo + item.sku" :class="{ 'over-threshold': item.over }">
              <td><code>{{ item.repo }}</code></td>
              <td>{{ item.sku }}</td>
              <td class="num">
                <strong v-if="item.over" class="text-danger">{{ item.used }}</strong>
                <span v-else>{{ item.used }}</span>
              </td>
              <td class="num">{{ item.limit ?? '-' }}</td>
              <td>{{ item.unit }}</td>
              <td><span class="badge source-badge">{{ item.limit_source }}</span></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </section>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch, h } from 'vue'
import Icon from './Icon.vue'
import { getToken } from '../lib/auth.js'
import { getRepoContent, triggerWorkflow, explainDispatchFailure } from '../lib/api.js'
import { config } from '../lib/config.js'
import { formatDate } from '../lib/format.js'
import { toast } from '../lib/toast.js'

const SortIcon = (props) =>
  h(Icon, {
    name: props.dir === 'asc' ? 'arrow-up' : props.dir === 'desc' ? 'arrow-down' : 'chevrons-up-down',
    size: 11,
    class: props.dir ? 'sort-glyph sort-glyph-active' : 'sort-glyph',
  })
SortIcon.props = ['dir']

const props = defineProps({
  org: { type: String, required: true }
})

const loading = ref(false)
const report = ref(null)
const loadError = ref(null)
const filter = ref('')
const sortKey = ref('used')
const sortDir = ref('desc')
const triggering = ref(false)
const runWatching = ref(false)
const pollCount = ref(0)
let runPollInterval = null

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

async function loadReport() {
  const token = getToken()
  if (!token || !props.org) return
  loading.value = true
  loadError.value = null
  try {
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
    const res = await triggerWorkflow(token, config.hubOwner, config.hubRepo, 'weekly-usage-report.yml', { org: props.org })
    if (res.ok || res.status === 204) {
      toast.success('Audit workflow dispatched - waiting for report…')
      runWatching.value = true
      startRunPoll()
    } else {
      toast.error(explainDispatchFailure(res, 'Trigger failed'))
    }
  } catch (e) {
    toast.error(`Trigger failed: ${e.message || String(e)}`)
  } finally {
    triggering.value = false
  }
}

function startRunPoll() {
  stopRunPoll()
  pollCount.value = 0
  const baseline = report.value?.generated_at || null
  const maxPolls = 20 // 20 × 15s = 5 minutes
  runPollInterval = setInterval(async () => {
    pollCount.value++
    await loadReport()
    if (report.value && report.value.generated_at !== baseline) {
      toast.success('Usage report updated!')
      runWatching.value = false
      stopRunPoll()
    } else if (pollCount.value >= maxPolls) {
      toast.info('Workflow is still running. Refresh in a minute to see latest report.')
      runWatching.value = false
      stopRunPoll()
    }
  }, 15_000)
}

function stopRunPoll() {
  if (runPollInterval) {
    clearInterval(runPollInterval)
    runPollInterval = null
  }
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
  margin-top: var(--space-2xl);
  border: 1px solid var(--border-default);
  background: var(--bg-surface, #161b22);
  border-radius: var(--radius-lg, 8px);
  padding: var(--space-lg);
}

.usage-head {
  margin-bottom: var(--space-md);
  flex-wrap: wrap;
  gap: var(--space-md);
}

.usage-title {
  margin: 0;
  font-size: 1.15rem;
  font-weight: 600;
  color: var(--text-primary);
}

.usage-sub {
  margin: 2px 0 0;
  font-size: 0.82rem;
}

.usage-loading,
.usage-empty {
  padding: var(--space-lg) 0;
}

.usage-error {
  background: rgba(248, 81, 73, 0.1);
  border: 1px solid var(--accent-red);
  color: var(--accent-red);
  padding: var(--space-sm) var(--space-md);
  border-radius: var(--radius-md);
  font-size: 0.85rem;
  margin: var(--space-sm) 0;
}

.usage-summary-bar {
  padding: var(--space-sm) var(--space-md);
  background: var(--bg-secondary);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  margin-bottom: var(--space-md);
  gap: var(--space-md);
  flex-wrap: wrap;
}

.usage-meta-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 0.82rem;
}

.meta-label {
  color: var(--text-muted);
  font-weight: 500;
}

.meta-value {
  color: var(--text-primary);
  font-weight: 600;
}

.filter-search-input {
  display: inline-block;
  min-width: 240px;
  max-width: 320px;
  padding: 4px 10px;
  font-size: 0.82rem;
  background: var(--bg-primary);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
}

.filter-search-input:focus {
  outline: 2px solid var(--color-accent, #58a6ff);
  border-color: transparent;
}

.table-wrapper {
  overflow-x: auto;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
}

.usage-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.85rem;
}

.usage-table th,
.usage-table td {
  padding: 8px 12px;
  text-align: left;
  border-bottom: 1px solid var(--border-default);
}

.usage-table th {
  background: var(--bg-secondary);
  font-weight: 600;
  cursor: pointer;
  user-select: none;
}

.usage-table th:hover {
  color: var(--accent-blue);
}

.th-label {
  display: inline-flex;
  align-items: center;
  gap: 4px;
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
  background: rgba(248, 81, 73, 0.08);
}

.usage-table tr.over-threshold td {
  color: var(--accent-red);
}

.source-badge {
  font-size: 0.72rem;
  padding: 2px 6px;
  background: var(--bg-tertiary);
  border-radius: 4px;
  color: var(--text-secondary);
}

.text-accent {
  color: var(--accent-blue);
}

.text-danger {
  color: var(--accent-red);
}

.text-center {
  text-align: center;
}

.inline-spinner {
  display: inline-flex;
  align-items: center;
  gap: var(--space-xs);
}

@media (max-width: 640px) {
  .usage-summary-bar {
    flex-direction: column;
    align-items: stretch;
  }
  .filter-search-input {
    width: 100%;
    max-width: 100%;
  }
}
</style>
