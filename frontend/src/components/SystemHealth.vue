<template>
  <section class="health-panel">
    <header class="health-head">
      <div>
        <h2 class="health-title">System health</h2>
        <p class="text-muted health-sub">Read-only checks against the App install for <code>{{ org }}</code>.</p>
      </div>
      <button class="btn btn-with-icon" type="button" @click="run" :disabled="running">
        <Icon name="refresh-cw" :size="14" />
        <span>{{ running ? 'Running…' : (result ? 'Re-run' : 'Run audit') }}</span>
      </button>
    </header>

    <div v-if="!result && !running" class="health-empty text-muted">
      Click <strong>Run audit</strong> to verify App permissions, the control repo scaffold, and per-assignment lockdown/archive state.
    </div>

    <div v-else-if="running && !result" class="health-empty">
      <div class="spinner" style="width:18px;height:18px;border-width:2px"></div>
      <span class="text-muted">Running checks…</span>
    </div>

    <div v-else-if="result" class="health-body">
      <div class="health-overall" :class="`sev-${result.overall}`">
        <Icon :name="severityIcon(result.overall)" :size="18" class="sev-glyph" />
        <span class="sev-label">{{ overallLabel }}</span>
        <span class="text-muted health-time" :title="formatDate(result.generated_at)">{{ relativeTime(result.generated_at) }}</span>
      </div>

      <ul class="health-checks">
        <li v-for="c in result.checks" :key="c.id" :class="['health-check', `sev-${c.severity}`]">
          <Icon :name="severityIcon(c.severity)" :size="16" class="check-glyph" />
          <div class="check-text">
            <div class="check-label">{{ c.label }}</div>
            <div class="check-message text-muted">{{ c.message }}</div>
          </div>
        </li>
      </ul>

      <details class="health-raw">
        <summary class="text-muted">Raw audit JSON</summary>
        <pre>{{ JSON.stringify(result, null, 2) }}</pre>
      </details>
    </div>
  </section>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import { getToken } from '../lib/auth.js'
import { ghApi } from '../lib/api.js'
import { formatDate } from '../lib/format.js'
import { runAudit } from '../../../lib/audit.mjs'
import Icon from './Icon.vue'

const props = defineProps({
  org: { type: String, required: true },
})

const running = ref(false)
const result = ref(null)
const lastRunAt = ref(0)

// Cache window: 5 minutes per the plan, so re-renders / org-flips don't burn
// API budget. The user can still force a re-run via the button.
const CACHE_MS = 5 * 60 * 1000

watch(() => props.org, () => {
  result.value = null
  lastRunAt.value = 0
}, { immediate: false })

async function run() {
  const token = getToken()
  if (!token) return
  if (running.value) return
  // Refresh button overrides the cache; auto-run only honors it.
  running.value = true
  try {
    const request = async (method, path) => {
      const r = await ghApi(token, method, path)
      return { status: r.status, ok: r.ok, data: r.data }
    }
    result.value = await runAudit({
      request,
      org: props.org,
      hubOwner: 'PXL-Digital-Application-Samples',
      hubRepo: 'pxl-classroom',
    })
    lastRunAt.value = Date.now()
  } catch (e) {
    console.error('Audit failed:', e)
  } finally {
    running.value = false
  }
}

defineExpose({ run })

function severityIcon(sev) {
  return { ok: 'check-circle', info: 'info', warn: 'alert-triangle', fail: 'x-circle' }[sev] || 'info'
}

const overallLabel = computed(() => {
  const sev = result.value?.overall ?? 'ok'
  return { ok: 'Healthy', info: 'Healthy (some checks skipped)', warn: 'Warnings', fail: 'Failures' }[sev] || sev
})

function relativeTime(iso) {
  if (!iso) return ''
  const diffMs = Date.now() - new Date(iso).getTime()
  if (diffMs < 60_000) return 'just now'
  if (diffMs < 3_600_000) return `${Math.round(diffMs / 60_000)}m ago`
  if (diffMs < 86_400_000) return `${Math.round(diffMs / 3_600_000)}h ago`
  return formatDate(iso)
}
</script>

<style scoped>
.health-panel {
  background: var(--bg-secondary);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-lg);
  padding: var(--space-md) var(--space-lg);
  margin-bottom: var(--space-lg);
}
.health-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: var(--space-md);
  margin-bottom: var(--space-md);
}
.health-title {
  margin: 0;
  font-size: 1rem;
  font-weight: 600;
}
.health-sub {
  margin: 2px 0 0;
  font-size: 0.8rem;
}
.health-sub code {
  background: var(--bg-tertiary);
  padding: 1px 4px;
  border-radius: 3px;
}
.health-empty {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  padding: var(--space-md) 0;
  font-size: 0.85rem;
}
.health-overall {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  padding: var(--space-sm) var(--space-md);
  border-radius: var(--radius-md);
  border: 1px solid var(--border-default);
  margin-bottom: var(--space-md);
}
.sev-glyph {
  flex-shrink: 0;
}
.sev-label { font-weight: 600; font-size: 0.9rem; }
.btn-with-icon { display: inline-flex; align-items: center; gap: var(--space-xs); }
.health-time { margin-left: auto; font-size: 0.78rem; }

.sev-ok { color: var(--accent-green); border-color: var(--accent-green); }
.sev-info { color: var(--text-secondary); }
.sev-warn { color: var(--accent-yellow); border-color: var(--accent-yellow); }
.sev-fail { color: var(--accent-red); border-color: var(--accent-red); }

.health-checks {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-xs);
}
.health-check {
  display: flex;
  align-items: flex-start;
  gap: var(--space-sm);
  padding: 6px var(--space-sm);
  border-radius: var(--radius-sm);
  background: var(--bg-tertiary);
}
.check-glyph {
  flex-shrink: 0;
  margin-top: 1px;
}
.check-text { flex: 1; min-width: 0; }
.check-label { font-size: 0.85rem; font-weight: 500; color: var(--text-primary); }
.check-message { font-size: 0.78rem; margin-top: 1px; }

.health-raw {
  margin-top: var(--space-md);
  font-size: 0.78rem;
}
.health-raw summary { cursor: pointer; }
.health-raw pre {
  margin-top: var(--space-sm);
  padding: var(--space-sm);
  background: var(--bg-tertiary);
  border-radius: var(--radius-sm);
  max-height: 320px;
  overflow: auto;
  font-family: var(--font-mono);
  font-size: 0.75rem;
}
.text-muted { color: var(--text-muted); }
</style>
