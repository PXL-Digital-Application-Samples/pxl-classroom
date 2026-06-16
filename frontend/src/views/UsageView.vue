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

      <div v-else-if="!report" class="center-card fade-in">
        <h2>No usage report available</h2>
        <p class="text-secondary">No weekly usage report has been generated for {{ org }} yet. The report runs every Sunday at 22:00 UTC.</p>
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
              <th @click="sortBy('repo')">Repository ↕</th>
              <th @click="sortBy('sku')">SKU ↕</th>
              <th @click="sortBy('used')" class="num">Used ↕</th>
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
import { ref, computed, onMounted, watch } from 'vue'
import UserBadge from '../components/UserBadge.vue'
import { isAuthenticated, getUser, getToken, clearAuth, startDeviceFlow, pollDeviceFlow } from '../lib/auth.js'
import { getRepoContent } from '../lib/api.js'
import { config } from '../lib/config.js'
import { formatDate } from '../lib/format.js'

const props = defineProps({ org: String })

const user = ref(getUser())
const authLoading = ref(false)
const deviceFlow = ref(null)
const loading = ref(false)
const report = ref(null)
const filter = ref('')
const sortKey = ref('used')
const sortDir = ref('desc')
let pollAbort = null

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
}

onMounted(async () => {
  if (isAuthenticated()) {
    user.value = getUser()
    await loadReport()
  }
})

watch(() => props.org, async () => {
  if (isAuthenticated()) await loadReport()
})
</script>

<style scoped>
.report-meta { padding: var(--space-md); background: var(--bg-secondary); border-radius: 8px; margin-bottom: var(--space-md); border: 1px solid var(--border-default); }
.report-meta p { margin: 0.25rem 0; }
.filter-input { display: block; width: 100%; max-width: 400px; margin-bottom: var(--space-md); padding: var(--space-sm); }
.usage-table { width: 100%; border-collapse: collapse; }
.usage-table th, .usage-table td { padding: var(--space-sm); text-align: left; border-bottom: 1px solid var(--border-default); }
.usage-table th { cursor: pointer; user-select: none; background: var(--bg-secondary); }
.usage-table .num { text-align: right; font-variant-numeric: tabular-nums; }
.usage-table tr.over-threshold { background: rgba(248, 81, 73, 0.1); }
.usage-table tr.over-threshold td { color: var(--accent-red); }
.badge { font-size: 0.75rem; padding: 2px 8px; background: var(--bg-secondary); border-radius: 4px; }
.text-danger { color: var(--accent-red); }
.text-success { color: var(--accent-green); }
.device-code-big { font-size: 1.5rem; letter-spacing: 0.2em; display: block; padding: var(--space-md); background: var(--bg-secondary); border-radius: 8px; margin: var(--space-md) 0; }
</style>
