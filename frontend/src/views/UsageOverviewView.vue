<template>
  <div class="usage-overview-page">
    <header class="dashboard-header">
      <div class="container flex items-center justify-between">
        <div class="logo flex items-center gap-sm">
          <router-link to="/" class="logo-link" aria-label="PXL Classroom home">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/>
              <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>
            </svg>
          </router-link>
          <h1>Usage — all organizations</h1>
        </div>
        <div class="header-right flex items-center gap-md">
          <router-link to="/" class="btn">Home</router-link>
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
        <DeviceFlowCard v-if="deviceFlow" :flow="deviceFlow" @cancel="cancelLogin" />
      </div>

      <div v-else-if="loading" class="center-card fade-in">
        <div class="spinner-lg spinner"></div>
        <p class="text-secondary">Loading usage across {{ orgsTotal }} orgs…</p>
      </div>

      <div v-else-if="rows.length === 0" class="center-card fade-in empty-state">
        <h2>No usage reports yet</h2>
        <p class="text-secondary">
          No weekly usage reports landed in any of the <strong>{{ orgsTotal }}</strong> orgs where the App is installed.
          The report scans every repo against your configured thresholds (Actions minutes, Codespaces, Packages, etc.)
          and flags anything over. It runs automatically every <strong>Sunday at 22:00 UTC</strong> —
          but you can kick off a one-off run right now across all participating orgs.
        </p>

        <div v-if="!triggering && !runWatching">
          <button class="btn btn-primary btn-lg btn-with-icon" @click="generateNow">
            <Icon name="zap" :size="16" />
            <span>Generate report for all orgs</span>
          </button>
          <p class="text-secondary" style="font-size: 0.85rem; margin-top: var(--space-sm);">
            Triggers <code>weekly-usage-report.yml</code> in the hub with no org input, fanning out to every participating org. Takes a few minutes.
          </p>
        </div>

        <div v-else-if="triggering" class="inline-spinner">
          <div class="spinner"></div>
          <span>Triggering workflow…</span>
        </div>

        <div v-else class="run-watching">
          <div class="inline-spinner">
            <div class="spinner"></div>
            <span>Workflow started. Watching for reports to land… (checked {{ pollCount }}×)</span>
          </div>
          <p class="text-secondary" style="font-size: 0.85rem;">
            Follow the run in the <a :href="`https://github.com/${config.hubOwner}/${config.hubRepo}/actions/workflows/weekly-usage-report.yml`" target="_blank">Actions tab</a>.
          </p>
        </div>
      </div>

      <div v-else class="fade-in">
        <div class="report-meta">
          <p><strong>Orgs scanned:</strong> {{ orgsLoaded }} / {{ orgsTotal }}</p>
          <p v-if="overCount > 0" class="text-danger"><strong>{{ overCount }}</strong> repo/SKU pair(s) over threshold across all orgs.</p>
          <p v-else class="text-success">All scanned orgs within configured limits.</p>
        </div>

        <div class="filter-row">
          <input v-model="filter" type="search" placeholder="Filter by org, repo, or SKU…" class="filter-input" />
          <label><input type="checkbox" v-model="overOnly" /> Show only over-threshold</label>
        </div>

        <table class="usage-table">
          <thead>
            <tr>
              <th @click="sortBy('org')"><span class="th-label">Org<SortIcon :dir="sortDirFor('org')" /></span></th>
              <th @click="sortBy('repo')"><span class="th-label">Repository<SortIcon :dir="sortDirFor('repo')" /></span></th>
              <th @click="sortBy('sku')"><span class="th-label">SKU<SortIcon :dir="sortDirFor('sku')" /></span></th>
              <th @click="sortBy('used')" class="num"><span class="th-label">Used<SortIcon :dir="sortDirFor('used')" /></span></th>
              <th class="num">Limit</th>
              <th>Unit</th>
              <th>Source</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in filtered" :key="item.org + item.repo + item.sku" :class="{ 'over-threshold': item.over }">
              <td><router-link :to="{ name: 'usage-org', params: { org: item.org } }">{{ item.org }}</router-link></td>
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
import { ref, computed, onMounted, onBeforeUnmount, h } from 'vue'
import UserBadge from '../components/UserBadge.vue'
import Icon from '../components/Icon.vue'
import DeviceFlowCard from '../components/DeviceFlowCard.vue'

const SortIcon = (props) => h(Icon, {
  name: props.dir === 'asc' ? 'arrow-up' : props.dir === 'desc' ? 'arrow-down' : 'chevrons-up-down',
  size: 11,
  class: props.dir ? 'sort-glyph sort-glyph-active' : 'sort-glyph',
})
SortIcon.props = ['dir']
import { isAuthenticated, getUser, getToken, clearAuth, startDeviceFlow, pollDeviceFlow } from '../lib/auth.js'
import { getRepoContent, getInstallations, triggerWorkflow, explainDispatchFailure } from '../lib/api.js'
import { config } from '../lib/config.js'
import { toast } from '../lib/toast.js'

const user = ref(getUser())
const authLoading = ref(false)
const deviceFlow = ref(null)
const loading = ref(false)
const rows = ref([])
const filter = ref('')
const overOnly = ref(false)
const sortKey = ref('used')
const sortDir = ref('desc')
const orgsTotal = ref(0)
const orgsLoaded = ref(0)
const triggering = ref(false)
const runWatching = ref(false)
const pollCount = ref(0)
let pollAbort = null
let runPollInterval = null

const overCount = computed(() => rows.value.filter(r => r.over).length)

const filtered = computed(() => {
  const f = filter.value.toLowerCase()
  let items = rows.value
  if (overOnly.value) items = items.filter(r => r.over)
  if (f) items = items.filter(r => r.org.toLowerCase().includes(f) || r.repo.toLowerCase().includes(f) || r.sku.toLowerCase().includes(f))
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

async function loadAll() {
  const token = getToken()
  if (!token) return
  loading.value = true
  rows.value = []
  try {
    const insRes = await getInstallations(token)
    const orgs = (insRes.data?.installations || [])
      .filter(i => i.account?.type === 'Organization')
      .map(i => i.account.login)
    orgsTotal.value = orgs.length
    orgsLoaded.value = 0

    const results = await Promise.all(orgs.map(async (org) => {
      try {
        const content = await getRepoContent(token, org, config.controlRepo, 'reports/usage-latest.json')
        return { org, content, error: null }
      } catch (e) {
        return { org, content: null, error: e }
      } finally {
        orgsLoaded.value++
      }
    }))

    const authErrors = results.filter(r => r.error?.status === 401)
    if (authErrors.length > 0 && authErrors.length === results.length) {
      toast.error('Your session has expired. Sign in again.')
      clearAuth()
      user.value = null
      return
    }

    for (const r of results) {
      if (!r.content) continue
      const report = JSON.parse(r.content)
      for (const item of report.items) rows.value.push({ org: r.org, ...item })
    }
  } finally {
    loading.value = false
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
    await loadAll()
  } catch (e) {
    if (e.message !== 'Cancelled') console.error(e)
    deviceFlow.value = null
  } finally {
    authLoading.value = false
  }
}

function cancelLogin() {
  if (pollAbort) pollAbort.abort()
  deviceFlow.value = null
  authLoading.value = false
}

function handleLogout() {
  clearAuth()
  user.value = null
  rows.value = []
  stopRunPoll()
}

async function generateNow() {
  const token = getToken()
  if (!token) return
  triggering.value = true
  try {
    // No 'org' input → workflow fans out to every participating org
    const res = await triggerWorkflow(token, config.hubOwner, config.hubRepo, 'weekly-usage-report.yml', {})
    if (res.ok || res.status === 204) {
      toast.success('Workflow triggered — watching for reports…')
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
    await loadAll()
    if (rows.value.length > 0) {
      toast.success('Usage reports ready.')
      runWatching.value = false
      stopRunPoll()
    } else if (pollCount.value >= maxPolls) {
      toast.info('Still no reports after 10 minutes. Check the Actions tab for failures.')
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

onMounted(async () => {
  if (isAuthenticated()) {
    user.value = getUser()
    await loadAll()
  }
})

onBeforeUnmount(() => {
  stopRunPoll()
})
</script>

<style scoped>
.report-meta { padding: var(--space-md); background: var(--bg-secondary); border-radius: 8px; margin-bottom: var(--space-md); border: 1px solid var(--border-default); }
.report-meta p { margin: 0.25rem 0; }
.filter-row { display: flex; gap: var(--space-md); align-items: center; margin-bottom: var(--space-md); }
.filter-input { flex: 1; max-width: 400px; padding: var(--space-sm); }
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
.empty-state { gap: var(--space-md); max-width: 600px; }
.empty-state p { line-height: 1.5; }
.empty-state code { background: var(--bg-secondary); padding: 1px 6px; border-radius: 4px; font-size: 0.9em; }
.inline-spinner { display: inline-flex; align-items: center; gap: var(--space-sm); color: var(--text-secondary); }
.inline-spinner .spinner { width: 18px; height: 18px; border-width: 2px; }
.run-watching { display: flex; flex-direction: column; gap: var(--space-sm); align-items: center; }
</style>
