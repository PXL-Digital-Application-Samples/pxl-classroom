<template>
  <div class="home-page">
    <div class="hero">
      <div class="hero-glow"></div>
      <div class="container">
        <svg class="hero-icon" width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/>
          <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>
        </svg>
        <h1>PXL Classroom</h1>
        <p class="subtitle">GitHub-native assignment distribution for PXL</p>

        <div class="actions">
          <router-link to="/dashboard" class="btn btn-primary btn-lg">
            Open Dashboard
          </router-link>
        </div>

        <p class="hint">
          Students: open the assignment link shared by your lecturer.
        </p>
      </div>
    </div>

    <div class="container" style="padding-bottom: var(--space-2xl)">
      <h2 style="text-align: center; margin-bottom: var(--space-xl)">Open Assignments</h2>
      <div v-if="loading" class="center-card">
        <div class="spinner"></div>
      </div>
      <div v-else-if="loadError" class="center-card text-secondary">
        Couldn't load the assignment list — check your connection and refresh.
      </div>
      <div v-else-if="!indexData || indexData.orgs.length === 0" class="center-card text-secondary">
        No open assignments right now.
      </div>
      <div v-else class="org-list">
        <div v-for="org in indexData.orgs" :key="org.login" class="org-section">
          <h3>{{ org.login }}</h3>
          <div v-if="org.assignments && org.assignments.length > 0" class="assignment-grid">
            <router-link
              v-for="a in org.assignments"
              :key="a.id"
              :to="{ name: 'assignment', params: { org: org.login, assignmentId: a.id } }"
              class="assignment-card card"
            >
              <h4>{{ a.title || a.id }}</h4>
              <p class="deadline-text" v-if="a.deadline_at">Deadline: {{ formatDate(a.deadline_at, a.timezone) }}</p>
            </router-link>
          </div>
          <div v-else class="text-secondary" style="margin-bottom: var(--space-md)">
            No published assignments.
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { config } from '../lib/config.js'
import { formatDate } from '../lib/format.js'

const indexData = ref(null)
const loading = ref(true)
const loadError = ref(false)

onMounted(async () => {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}data/index.json`)
    if (res.ok) {
      const data = await res.json()
      // For each org, fetch its assignments.json to get the list of open assignments
      for (const org of data.orgs) {
        const orgRes = await fetch(`${import.meta.env.BASE_URL}data/${org.login}/assignments.json`)
        if (orgRes.ok) {
          const orgData = await orgRes.json()
          org.assignments = Object.entries(orgData.assignments || {})
            .map(([id, a]) => ({ id, ...a }))
            .filter(a => a.state === 'published')
        } else {
          org.assignments = []
        }
      }
      // Filter out orgs with no assignments
      data.orgs = data.orgs.filter(o => o.assignments.length > 0)
      indexData.value = data
    }
  } catch (e) {
    console.error("Failed to load public index", e)
    loadError.value = true
  }
  loading.value = false
})


</script>

<style scoped>
.home-page {
  min-height: 100vh;
}

.hero {
  text-align: center;
  padding: var(--space-2xl);
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 50vh;
  /* Clip the 400px decorative glow — it otherwise causes horizontal
     scrolling on narrow viewports. */
  overflow: hidden;
}

.hero-glow {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 400px;
  height: 400px;
  background: radial-gradient(circle, rgba(88, 166, 255, 0.08) 0%, transparent 70%);
  pointer-events: none;
}

.hero-icon {
  color: var(--accent-blue);
  margin-bottom: var(--space-lg);
  filter: drop-shadow(0 0 20px rgba(88, 166, 255, 0.3));
}

h1 {
  font-size: 3rem;
  font-weight: 700;
  letter-spacing: -0.02em;
  margin-bottom: var(--space-sm);
  background: linear-gradient(135deg, var(--text-primary) 0%, var(--accent-blue) 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

.subtitle {
  color: var(--text-secondary);
  font-size: 1.125rem;
  margin-bottom: var(--space-xl);
}

.actions {
  margin-bottom: var(--space-xl);
}

.hint {
  color: var(--text-muted);
  font-size: 0.875rem;
}

.center-card {
  text-align: center;
  margin: var(--space-xl) auto;
  display: flex;
  justify-content: center;
  padding: var(--space-lg);
}

.org-section {
  margin-bottom: var(--space-2xl);
}

.org-section h3 {
  font-size: 1.5rem;
  font-weight: 600;
  margin-bottom: var(--space-md);
  border-bottom: 1px solid var(--border-default);
  padding-bottom: var(--space-xs);
  color: var(--text-primary);
}

.assignment-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: var(--space-md);
}

.assignment-card {
  display: block;
  text-decoration: none;
  color: inherit;
  transition: all var(--transition-normal);
}

.assignment-card:hover {
  border-color: var(--accent-blue);
  box-shadow: var(--shadow-glow);
  transform: translateY(-2px);
}

.assignment-card h4 {
  font-size: 1.1rem;
  font-weight: 600;
  margin-bottom: var(--space-xs);
  color: var(--accent-blue);
}

.deadline-text {
  font-size: 0.85rem;
  color: var(--text-secondary);
}
</style>
