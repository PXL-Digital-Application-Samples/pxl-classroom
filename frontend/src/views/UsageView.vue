<template>
  <div class="usage-page">
    <header class="dashboard-header">
      <div class="container flex items-center justify-between">
        <div class="logo flex items-center gap-sm">
          <router-link to="/" class="logo-link">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/>
              <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>
            </svg>
          </router-link>
          <h1>Usage — {{ org }}</h1>
        </div>
        <div class="header-right flex items-center gap-md">
          <router-link :to="{ name: 'dashboard', params: { org } }" class="btn">Back to dashboard</router-link>
          <router-link to="/usage" class="btn">All orgs</router-link>
          <UserBadge :user="user" @logout="handleLogout" />
        </div>
      </div>
    </header>

    <main class="container">
      <div v-if="!user" class="center-card fade-in">
        <h2>Sign in</h2>
        <button class="btn btn-primary btn-lg" @click="startLogin" :disabled="authLoading">
          <template v-if="authLoading">
            <div class="spinner" style="width:18px;height:18px;border-width:2px"></div>
            Waiting…
          </template>
          <template v-else>Sign in with GitHub</template>
        </button>
        <div v-if="deviceFlow" class="device-flow-inline">
          <p>Go to <a :href="deviceFlow.verification_uri" target="_blank">{{ deviceFlow.verification_uri }}</a> and enter:</p>
          <code class="device-code-big">{{ deviceFlow.user_code }}</code>
        </div>
      </div>

      <div v-else-if="loading" class="center-card fade-in">
        <div class="spinner-lg spinner"></div>
        <p class="text-secondary">Loading usage report…</p>
      </div>

      <div v-else-if="!report" class="center-card fade-in empty-state">
        <h2>No usage report yet</h2>
        <p class="text-secondary">
          The Weekly Usage Report scans every repo in <code>{{ org }}</code> against your configured thresholds
          (Actions minutes, Codespaces, Packages, etc.) and flags anything over. It runs automatically
          every <strong>Sunday at 22:00 UTC</strong> — but you can also kick off a one-off run right now.
        </p>

        <div v-if="!triggering && !runWatching">
          <button class="btn btn-primary btn-lg btn-with-icon" @click="generateNow">
            <Icon name="zap" :size="16" />
            <span>Generate report now</span>
          </button>
          <p class="text-secondary" style="font-size: 0.85rem; margin-top: var(--space-sm);">
            Triggers <code>weekly-usage-report.yml</code> in the hub. Takes roughly 1–2 minutes.
          </p>
        </div>

        <div v-else-if="triggering" class="inline-spinner">
          <div class="spinner"></div>
          <span>Triggering workflow…</span>
        </div>

        <div v-else class="run-watching">
          <div class="inline-spinner">
            <div class="spinner"></div>
            <span>Workflow started. Watching for the report to land… (checked {{ pollCount }}×)</span>
          </div>
          <p class="text-secondary" style="font-size: 0.85rem;">
            Follow the run in the <a :href="`https://github.com/PXL-Digital-Application-Samples/pxl-classroom/actions/workflows/weekly-usage-report.yml`" target="_blank">Actions tab</a>.
          </p>
        </div>
      </div>

      <div v-else class="fade-in">
        <div class="report-meta">
          <p><strong>Week:</strong> {{ report.week_start }} → {{ report.week_end }}</p>
          <p><strong>Generated:</strong> {{ formatDate(report.generated_at) }}</p>
          <p v-if="report.over_count > 0" class="text-danger">
            <strong>{{ report.over_count }}</strong> repo/SKU pair(s) over threshold.
          </p>
          <p v-else class="text-success">All repos within configured limits.</p>
        </div>

        <input v-model="filter" type="search" placeholder="Filter by repo or SKU…" class="filter-input" />

        <table class="usage-table">
          <thead>
            <tr>
              <th @click="sortBy('repo')"><span class="th-label">Repository<SortIcon :dir="sortDirFor('repo')" /></span></th>
              <th @click="sortBy('sku')"><span class="th-label">SKU<SortIcon :dir="sortDirFor('sku')" /></span></th>
              <th @click="sortBy('used')" class="num"><span class="th-label">Used<SortIcon :dir="sortDirFor('used')" /></span></th>
              <th class="num">Limit</th>
              <th>Unit</th>
              <th>Source</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in filtered" :key="item.repo + item.sku" :class="{ 'over-threshold': item.over }">
              <td><code>{{ item.repo }}</code></td>
              <td>{{ item.sku }}</td>
              <td class="num"><strong v-if="item.over">{{ item.used }}</strong><span v-else>{{ item.used }}</span></td>
              <td class="num">{{ item.limit ?? '—' }}</td>
              <td>{{ item.unit }}</td>
              <td><span class="badge">{{ item.limit_source }}</span></td>
            </tr>
          </tbody>
        </table>
      </div>
    </main>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch, h } from 'vue'
import UserBadge from '../components/UserBadge.vue'
import Icon from '../components/Icon.vue'

const SortIcon = (props) => h(Icon, {
  name: props.dir === 'asc' ? 'arrow-up' : props.dir === 'desc' ? 'arrow-down' : 'chevrons-up-down',
  size: 11,
  class: props.dir ? 'sort-glyph sort-glyph-active' : 'sort-glyph',
})
SortIcon.props = ['dir']
import { isAuthenticated, getUser, getToken, clearAuth, startDeviceFlow, pollDeviceFlow } from '../lib/auth.js'
import { getRepoContent, triggerWorkflow, explainDispatchFailure } from '../lib/api.js'
import { config } from '../lib/config.js'
import { formatDate } from '../lib/format.js'
import { toast } from '../lib/toast.js'

const props = defineProps({ org: String })

const user = ref(getUser())
const authLoading = ref(false)
const deviceFlow = ref(null)
const loading = ref(false)
const report = ref(null)
const filter = ref('')
const sortKey = ref('used')
const sortDir = ref('desc')
const triggering = ref(false)
const runWatching = ref(false)
const pollCount = ref(0)
let pollAbort = null
let runPollInterval = null

const filtered = computed(() => {
  if (!report.value) return []
  const f = filter.value.toLowerCase()
  let items = report.value.items
  if (f) items = items.filter(i => i.repo.toLowerCase().includes(f) || i.sku.toLowerCase().includes(f))
  return [...items].sort((a, b) => {
    if (a.over !== b.over) return a.over ? -1 : 1
    const av = a[sortKey.value], bv = b[sortKey.value]
    const cmp = typeof av === 'number' ? av - bv : String(av).localeCompare(String(bv))
    return sortDir.value === 'asc' ? cmp : -cmp
  })
})

function sortBy(key) {
  if (sortKey.value === key) sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc'
  else { sortKey.value = key; sortDir.value = key === 'used' ? 'desc' : 'asc' }
}

function sortDirFor(key) {
  return sortKey.value === key ? sortDir.value : null
}

async function loadReport() {
  const token = getToken()
  if (!token || !props.org) return
  loading.value = true
  try {
    const content = await getRepoContent(token, props.org, config.controlRepo, 'reports/usage-latest.json')
    if (content) report.value = JSON.parse(content)
  } catch (e) {
    console.error('Failed to load usage report:', e)
  } finally {
    loading.value = false
  }
}

async function generateNow() {
  const token = getToken()
  if (!token || !props.org) return
  triggering.value = true
  try {
    const res = await triggerWorkflow(token, 'PXL-Digital-Application-Samples', 'pxl-classroom', 'weekly-usage-report.yml', { org: props.org })
    if (res.ok || res.status === 204) {
      toast.success('Workflow triggered — watching for the report…')
      runWatching.value = true
      startRunPoll()
    } else {
      toast.error(explainDispatchFailure(res, 'Trigger failed'))
    }
  } finally {
    triggering.value = false
  }
}

function startRunPoll() {
  stopRunPoll()
  pollCount.value = 0
  const maxPolls = 20 // 20 × 30s = 10 minutes
  runPollInterval = setInterval(async () => {
    pollCount.value++
    await loadReport()
    if (report.value) {
      toast.success('Usage report ready.')
      runWatching.value = false
      stopRunPoll()
    } else if (pollCount.value >= maxPolls) {
      toast.info('Still no report after 10 minutes. Check the Actions tab for failures.')
      runWatching.value = false
      stopRunPoll()
    }
  }, 30_000)
}

function stopRunPoll() {
  if (runPollInterval) {
    clearInterval(runPollInterval)
    runPollInterval = null
  }
}

async function startLogin() {
  if (!config.clientId) return
  authLoading.value = true
  try {
    const flow = await startDeviceFlow(config.clientId)
    deviceFlow.value = flow
    pollAbort = new AbortController()
    const result = await pollDeviceFlow(config.clientId, flow.device_code, flow.interval, pollAbort.signal)
    user.value = result.user
    deviceFlow.value = null
    await loadReport()
  } catch (e) {
    if (e.message !== 'Cancelled') console.error(e)
    deviceFlow.value = null
  } finally {
    authLoading.value = false
  }
}

function handleLogout() {
  clearAuth()
  user.value = null
  report.value = null
  stopRunPoll()
}

onMounted(async () => {
  if (isAuthenticated()) {
    user.value = getUser()
    await loadReport()
  }
})

watch(() => props.org, async () => {
  stopRunPoll()
  runWatching.value = false
  if (isAuthenticated()) await loadReport()
})

onBeforeUnmount(() => {
  stopRunPoll()
})
</script>

<style scoped>
.report-meta { padding: var(--space-md); background: var(--bg-secondary); border-radius: 8px; margin-bottom: var(--space-md); border: 1px solid var(--border-default); }
.report-meta p { margin: 0.25rem 0; }
.filter-input { display: block; width: 100%; max-width: 400px; margin-bottom: var(--space-md); padding: var(--space-sm); }
.usage-table { width: 100%; border-collapse: collapse; }
.usage-table th, .usage-table td { padding: var(--space-sm); text-align: left; border-bottom: 1px solid var(--border-default); }
.usage-table th { cursor: pointer; user-select: none; background: var(--bg-secondary); }
.th-label { display: inline-flex; align-items: center; gap: 4px; }
.sort-glyph { color: var(--text-muted); }
.sort-glyph-active { color: var(--accent-blue); }
.btn-with-icon { display: inline-flex; align-items: center; gap: var(--space-xs); }
.usage-table .num { text-align: right; font-variant-numeric: tabular-nums; }
.usage-table tr.over-threshold { background: rgba(248, 81, 73, 0.1); }
.usage-table tr.over-threshold td { color: var(--accent-red); }
.badge { font-size: 0.75rem; padding: 2px 8px; background: var(--bg-secondary); border-radius: 4px; }
.text-danger { color: var(--accent-red); }
.text-success { color: var(--accent-green); }
.device-code-big { font-size: 1.5rem; letter-spacing: 0.2em; display: block; padding: var(--space-md); background: var(--bg-secondary); border-radius: 8px; margin: var(--space-md) 0; }
.empty-state { gap: var(--space-md); max-width: 560px; }
.empty-state p { line-height: 1.5; }
.empty-state code { background: var(--bg-secondary); padding: 1px 6px; border-radius: 4px; font-size: 0.9em; }
.inline-spinner { display: inline-flex; align-items: center; gap: var(--space-sm); color: var(--text-secondary); }
.inline-spinner .spinner { width: 18px; height: 18px; border-width: 2px; }
.run-watching { display: flex; flex-direction: column; gap: var(--space-sm); align-items: center; }
</style>
