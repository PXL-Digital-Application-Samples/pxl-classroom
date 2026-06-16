<template>
  <div class="usage-overview-page">
    <header class="dashboard-header">
      <div class="container flex items-center justify-between">
        <div class="logo flex items-center gap-sm">
          <router-link to="/" class="logo-link">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
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
        <div v-if="deviceFlow" class="device-flow-inline">
          <p>Go to <a :href="deviceFlow.verification_uri" target="_blank">{{ deviceFlow.verification_uri }}</a> and enter:</p>
          <code class="device-code-big">{{ deviceFlow.user_code }}</code>
        </div>
      </div>

      <div v-else-if="loading" class="center-card fade-in">
        <div class="spinner-lg spinner"></div>
        <p class="text-secondary">Loading usage across {{ orgsTotal }} orgs…</p>
      </div>

      <div v-else-if="rows.length === 0" class="center-card fade-in">
        <h2>No usage reports found</h2>
        <p class="text-secondary">No weekly usage reports available across any of the orgs where the App is installed. The report runs every Sunday at 22:00 UTC.</p>
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
              <th @click="sortBy('org')">Org ↕</th>
              <th @click="sortBy('repo')">Repository ↕</th>
              <th @click="sortBy('sku')">SKU ↕</th>
              <th @click="sortBy('used')" class="num">Used ↕</th>
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
import { ref, computed, onMounted } from 'vue'
import UserBadge from '../components/UserBadge.vue'
import { isAuthenticated, getUser, getToken, clearAuth, startDeviceFlow, pollDeviceFlow } from '../lib/auth.js'
import { getRepoContent, getInstallations } from '../lib/api.js'
import { config } from '../lib/config.js'

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
let pollAbort = null

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
    for (const org of orgs) {
      try {
        const content = await getRepoContent(token, org, config.controlRepo, 'reports/usage-latest.json')
        if (content) {
          const report = JSON.parse(content)
          for (const item of report.items) rows.value.push({ org, ...item })
        }
      } catch { /* org may not have control repo */ }
      orgsLoaded.value++
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

function handleLogout() {
  clearAuth()
  user.value = null
  rows.value = []
}

onMounted(async () => {
  if (isAuthenticated()) {
    user.value = getUser()
    await loadAll()
  }
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
.usage-table .num { text-align: right; font-variant-numeric: tabular-nums; }
.usage-table tr.over-threshold { background: rgba(248, 81, 73, 0.1); }
.usage-table tr.over-threshold td { color: var(--accent-red); }
.badge { font-size: 0.75rem; padding: 2px 8px; background: var(--bg-secondary); border-radius: 4px; }
.text-danger { color: var(--accent-red); }
.text-success { color: var(--accent-green); }
.device-code-big { font-size: 1.5rem; letter-spacing: 0.2em; display: block; padding: var(--space-md); background: var(--bg-secondary); border-radius: 8px; margin: var(--space-md) 0; }
</style>
