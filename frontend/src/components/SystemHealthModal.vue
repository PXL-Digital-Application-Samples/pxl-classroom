<template>
  <div v-if="isOpen" class="modal-overlay" @click.self="$emit('close')">
    <div class="modal-card diagnostic-modal">
      <!-- HEADER -->
      <div class="modal-head">
        <div class="head-title">
          <Icon name="activity" :size="18" class="text-blue" />
          <h3 v-if="assignmentId">System Diagnostic &amp; Auto-Fix: <code>{{ assignmentId }}</code></h3>
          <h3 v-else>Organization Health &amp; Infrastructure: <code>{{ org }}</code></h3>
        </div>
        <div class="head-actions">
          <button class="btn btn-sm btn-with-icon" type="button" @click="run" :disabled="running">
            <Icon name="refresh-cw" :size="12" :class="{ 'spin-animation': running }" />
            <span>{{ running ? 'Diagnosing…' : 'Re-run Tests' }}</span>
          </button>
          <button class="modal-close" type="button" @click="$emit('close')" aria-label="Close modal">✕</button>
        </div>
      </div>

      <!-- BODY -->
      <div class="modal-body">
        <!-- OVERALL STATUS BANNER -->
        <div v-if="report" class="diag-banner" :class="`banner-${report.overall}`">
          <Icon :name="severityIcon(report.overall)" :size="20" />
          <div class="banner-text">
            <h4>{{ overallTitle(report.overall) }}</h4>
            <p>{{ overallSummary(report.overall) }}</p>
          </div>
        </div>

        <div v-if="running && !report" class="loading-state">
          <div class="spinner"></div>
          <p>Running ordered diagnostic tests against organization, templates, and broker infrastructure…</p>
        </div>

        <!-- ACCORDION TIERS -->
        <div v-else-if="report" class="tiers-list">
          <div v-for="tier in report.tiers" :key="tier.id" class="tier-card" :class="`tier-${tier.severity}`">
            <div class="tier-header" @click="toggleTier(tier.id)">
              <Icon :name="severityIcon(tier.severity)" :size="16" class="tier-glyph" />
              <div class="tier-title-group">
                <span class="tier-title">{{ tier.label }}</span>
                <span v-if="tier.subtitle" class="tier-subtitle">{{ tier.subtitle }}</span>
              </div>
              <span class="status-indicator">
                <span class="status-dot" :class="tier.severity === 'ok' ? 'dot-success' : (tier.severity === 'warn' ? 'dot-warning' : 'dot-danger')"></span>
                <span class="text-xs font-semibold">{{ tier.severity === 'ok' ? 'Healthy' : (tier.severity === 'warn' ? 'Warning' : 'Action Required') }}</span>
              </span>
              <Icon :name="expandedTiers[tier.id] ? 'chevron-up' : 'chevron-down'" :size="14" class="tier-toggle" />
            </div>

            <div v-if="expandedTiers[tier.id]" class="tier-checks">
              <div v-for="c in tier.checks" :key="c.id" class="check-item" :class="`check-${c.severity}`">
                <div class="check-row">
                  <Icon :name="severityIcon(c.severity)" :size="14" class="check-glyph" />
                  <div class="check-content">
                    <div class="check-header-row">
                      <strong class="check-label">{{ c.label }}</strong>
                      <span v-if="c.severity !== 'ok'" class="status-indicator">
                        <span class="status-dot" :class="c.severity === 'warn' ? 'dot-warning' : 'dot-danger'"></span>
                        <span class="text-xs font-medium" :class="c.severity === 'warn' ? 'text-warning' : 'text-danger'">{{ c.severity === 'warn' ? 'Warning' : 'Error' }}</span>
                      </span>
                    </div>
                    <p class="check-msg">{{ c.message }}</p>
                  </div>
                </div>

                <!-- 1-CLICK FIX ACTION -->
                <div v-if="c.fixAction && c.severity !== 'ok'" class="fix-action-box">
                  <div class="fix-info">
                    <Icon name="zap" :size="14" class="text-yellow" />
                    <span>Suggested Fix:</span>
                  </div>
                  <button
                    class="btn btn-sm btn-primary btn-with-icon"
                    type="button"
                    @click="executeFix(c)"
                    :disabled="fixingId === c.id"
                  >
                    <Icon name="refresh-cw" :size="12" :class="{ 'spin-animation': fixingId === c.id }" />
                    <span>{{ fixingId === c.id ? 'Applying repair…' : c.fixAction.label }}</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- FOOTER -->
      <div class="modal-foot">
        <span class="text-muted" style="font-size: 0.8rem;">
          Diagnostics run in strict dependency order (Auth → Org → Control Repo → Templates → Brokers → Pages).
        </span>
        <button class="btn" type="button" @click="$emit('close')">Close</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, watch, onMounted } from 'vue'
import { getToken, startDeviceFlow } from '../lib/auth.js'
import { ghApi, triggerWorkflow } from '../lib/api.js'
import { config } from '../lib/config.js'
import { toast } from '../lib/toast.js'
import { runDiagnostics } from '../../../lib/diagnostics.mjs'
import Icon from './Icon.vue'

const props = defineProps({
  isOpen: { type: Boolean, default: false },
  org: { type: String, required: true },
  assignmentId: { type: String, default: null },
  formDoc: { type: Object, default: null },
})

const emit = defineEmits(['close', 'fixed', 'navigate-tab'])

const running = ref(false)
const report = ref(null)
const fixingId = ref(null)
const expandedTiers = reactive({})

onMounted(() => {
  if (props.isOpen) run()
})

watch(() => props.isOpen, (open) => {
  if (open) run()
})

watch(() => [props.org, props.assignmentId], () => {
  if (props.isOpen) run()
})

async function run() {
  const token = getToken()
  if (!token) return
  running.value = true
  try {
    const request = async (method, path, body = null) => {
      const r = await ghApi(token, method, path, body)
      return { status: r.status, ok: r.ok, data: r.data }
    }

    const fetchPages = async (targetOrg) => {
      const pagesUrl = `${import.meta.env.BASE_URL}data/${targetOrg}/assignments.json?t=${Date.now()}`
      const res = await fetch(pagesUrl, { cache: 'no-store' })
      if (!res.ok) return null
      return await res.json().catch(() => null)
    }

    const res = await runDiagnostics({
      request,
      org: props.org,
      assignmentId: props.assignmentId,
      formDoc: props.formDoc,
      hubOwner: config.hubOwner,
      hubRepo: config.hubRepo,
      fetchPages,
    })

    report.value = res

    // Auto-expand all tiers that have warnings or errors, collapse fully ok tiers
    for (const t of res.tiers) {
      if (expandedTiers[t.id] === undefined) {
        expandedTiers[t.id] = t.severity !== 'ok'
      }
    }
  } catch (e) {
    toast.error(`Diagnostic execution failed: ${e.message}`)
  } finally {
    running.value = false
  }
}

function toggleTier(tierId) {
  expandedTiers[tierId] = !expandedTiers[tierId]
}

async function executeFix(c) {
  const fix = c.fixAction
  if (!fix) return
  fixingId.value = c.id
  const token = getToken()

  try {
    if (fix.type === 'mark_template') {
      const res = await ghApi(token, 'PATCH', `/repos/${fix.owner}/${fix.repo}`, { is_template: true })
      if (res.ok) {
        toast.success(`Marked ${fix.owner}/${fix.repo} as a Template Repository on GitHub!`)
        emit('fixed', { type: fix.type })
        await run()
      } else {
        toast.error(`Failed to mark template: ${res.data?.message || 'unknown error'}`)
      }
    } else if (fix.type === 'make_broker_public') {
      const res = await ghApi(token, 'PATCH', `/repos/${props.org}/${fix.brokerName}`, { private: false })
      if (res.ok) {
        toast.success(`Made ${fix.brokerName} public!`)
        emit('fixed', { type: fix.type })
        await run()
      } else {
        toast.error(`Failed to update broker visibility: ${res.data?.message || 'unknown error'}`)
      }
    } else if (fix.type === 'publish_broker') {
      const res = await triggerWorkflow(token, config.hubOwner, config.hubRepo, 'publish-assignment.yml', {
        org: props.org,
        assignment_id: props.assignmentId,
      })
      if (res.ok || res.status === 204) {
        toast.success('Publish workflow triggered! Setting up broker on GitHub Actions…')
        emit('fixed', { type: fix.type })
        setTimeout(run, 4000)
      } else {
        toast.error(`Publish workflow dispatch failed (HTTP ${res.status}).`)
      }
    } else if (fix.type === 'setup_org') {
      const res = await triggerWorkflow(token, config.hubOwner, config.hubRepo, 'setup-org.yml', {
        org: props.org,
      })
      if (res.ok || res.status === 204) {
        toast.success('Setup Organization workflow triggered! Initializing scaffold…')
        emit('fixed', { type: fix.type })
        setTimeout(run, 5000)
      } else {
        toast.error(`Setup workflow dispatch failed (HTTP ${res.status}).`)
      }
    } else if (fix.type === 'deploy_pages') {
      const res = await triggerWorkflow(token, config.hubOwner, config.hubRepo, 'deploy-frontend.yml', {})
      if (res.ok || res.status === 204) {
        toast.success('Pages deployment triggered!')
        emit('fixed', { type: fix.type })
        setTimeout(run, 5000)
      } else {
        toast.error(`Deploy workflow dispatch failed (HTTP ${res.status}).`)
      }
    } else if (fix.type === 'regen_dashboard') {
      const res = await triggerWorkflow(token, config.hubOwner, config.hubRepo, 'regenerate-dashboard.yml', {
        org: props.org,
      })
      if (res.ok || res.status === 204) {
        toast.success('Dashboard data regeneration triggered!')
        emit('fixed', { type: fix.type })
        setTimeout(run, 4000)
      } else {
        toast.error(`Dashboard workflow dispatch failed (HTTP ${res.status}).`)
      }
    } else if (fix.type === 'navigate_roster') {
      emit('navigate-tab', 'roster')
      emit('close')
    } else if (fix.type === 'login') {
      startDeviceFlow(config.clientId)
      emit('close')
    } else if (fix.type === 'link' && fix.url) {
      window.open(fix.url, '_blank', 'noopener,noreferrer')
    }
  } catch (e) {
    toast.error(`Fix failed: ${e.message}`)
  } finally {
    fixingId.value = null
  }
}

function severityIcon(sev) {
  if (sev === 'ok') return 'check-circle'
  if (sev === 'warn') return 'alert-triangle'
  if (sev === 'fail') return 'x-circle'
  return 'info'
}

function badgeClass(sev) {
  if (sev === 'ok') return 'badge-success'
  if (sev === 'warn') return 'badge-warning'
  if (sev === 'fail') return 'badge-danger'
  return 'badge-neutral'
}

function overallTitle(sev) {
  if (sev === 'ok') return 'All Systems Operational & Verified'
  if (sev === 'warn') return 'Warnings Detected (Non-Blocking)'
  return 'Action Required: Blockers Detected'
}

function overallSummary(sev) {
  if (sev === 'ok') {
    return props.assignmentId
      ? 'All foundational layers, starter templates, broker repositories, and public Pages endpoints are verified and ready for students.'
      : 'Organization installation, App permissions, and control repository scaffold are intact and verified.'
  }
  if (sev === 'warn') return 'Some components have warnings or are currently deploying. Review the items below.'
  return 'One or more essential components are missing or improperly configured. Review the flagged checks and use the suggested 1-click repairs.'
}
</script>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  background: var(--bg-scrim);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  z-index: 1050;
  padding: max(24px, 5vh) var(--space-md);
  overflow-y: auto;
  backdrop-filter: blur(4px);
}
.diagnostic-modal {
  background: var(--bg-secondary);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-lg);
  box-shadow: 0 20px 45px var(--shadow-color-modal), 0 0 0 1px var(--border-subtle);
  width: 100%;
  max-width: 720px;
  max-height: calc(100vh - 10vh);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  margin: 0 auto;
}
.modal-head {
  padding: var(--space-md) var(--space-lg);
  border-bottom: 1px solid var(--border-default);
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: var(--bg-tertiary);
}
.head-title {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
}
.head-title h3 {
  margin: 0;
  font-size: 1rem;
  font-weight: 600;
}
.head-actions {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
}
.modal-close {
  background: none;
  border: none;
  font-size: 1.25rem;
  line-height: 1;
  color: var(--text-muted);
  cursor: pointer;
  padding: 0 4px;
}
.modal-close:hover {
  color: var(--text-primary);
}
.modal-body {
  padding: var(--space-lg);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: var(--space-md);
}
.modal-foot {
  padding: var(--space-md) var(--space-lg);
  border-top: 1px solid var(--border-default);
  background: var(--bg-tertiary);
  display: flex;
  justify-content: space-between;
  align-items: center;
}

/* BANNER */
.diag-banner {
  padding: var(--space-md);
  border-radius: 8px;
  display: flex;
  gap: var(--space-md);
  align-items: flex-start;
}
.banner-ok {
  background: var(--tint-success-subtle);
  border: 1px solid var(--tint-success-emphasis);
  color: var(--accent-green);
}
.banner-warn {
  background: var(--tint-attention-subtle);
  border: 1px solid var(--tint-attention-emphasis);
  color: var(--accent-yellow);
}
.banner-fail {
  background: var(--tint-danger-subtle);
  border: 1px solid var(--tint-danger-emphasis);
  color: var(--accent-red);
}
.banner-text h4 {
  margin: 0 0 2px 0;
  font-size: 0.95rem;
  font-weight: 600;
}
.banner-text p {
  margin: 0;
  font-size: 0.85rem;
  color: var(--text-secondary);
  line-height: 1.35;
}

/* TIERS */
.tiers-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
}
.tier-card {
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-sm);
  background: var(--bg-surface-elevated);
  overflow: hidden;
}
.tier-header {
  padding: var(--space-sm) var(--space-md);
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  cursor: pointer;
  user-select: none;
  background: var(--bg-surface-hover);
  transition: background var(--transition-fast);
}
.tier-header:hover {
  background: var(--bg-surface-hover);
}
.tier-glyph {
  flex-shrink: 0;
}
.tier-ok .tier-glyph { color: var(--accent-green); }
.tier-title-group {
  display: flex;
  flex-direction: column;
  flex: 1;
  gap: 2px;
}
.tier-title {
  font-size: 0.88rem;
  font-weight: 600;
}
.tier-subtitle {
  font-size: 0.76rem;
  color: var(--text-secondary);
  font-weight: normal;
}
.tier-toggle {
  color: var(--text-muted);
}
.tier-checks {
  padding: var(--space-sm) var(--space-md);
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
  border-top: 1px solid var(--border-subtle);
}
.check-item {
  padding: var(--space-xs) 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.check-item:not(:last-child) {
  border-bottom: 1px solid var(--border-subtle);
  padding-bottom: var(--space-sm);
}
.check-row {
  display: flex;
  gap: var(--space-sm);
  align-items: flex-start;
}
.check-glyph {
  margin-top: 2px;
  flex-shrink: 0;
}
.check-ok .check-glyph { color: var(--accent-green); }
.check-warn .check-glyph { color: var(--accent-yellow); }
.check-fail .check-glyph { color: var(--accent-red); }
.check-info .check-glyph { color: var(--accent-blue); }

.check-content {
  flex: 1;
}
.check-header-row {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
}
.check-label {
  font-size: 0.85rem;
  color: var(--text-primary);
}
.check-status-tag {
  font-size: 0.7rem;
  padding: 1px 6px;
  border-radius: 4px;
  text-transform: uppercase;
  font-weight: 600;
}
.tag-warn { background: var(--tint-attention-muted); color: var(--accent-yellow); }
.tag-fail { background: var(--tint-danger-muted); color: var(--accent-red); }

.check-msg {
  margin: 2px 0 0 0;
  font-size: 0.8rem;
  color: var(--text-secondary);
  line-height: 1.35;
}

/* FIX ACTION BOX */
.fix-action-box {
  margin-top: 4px;
  margin-left: 22px;
  padding: var(--space-xs) var(--space-sm);
  background: var(--bg-tertiary);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-sm);
  flex-wrap: wrap;
}
.fix-info {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.8rem;
  color: var(--text-secondary);
  font-weight: 500;
}
.text-yellow { color: var(--accent-yellow); }
.text-blue { color: var(--accent-blue); }
.loading-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-md);
  padding: var(--space-2xl);
  text-align: center;
  color: var(--text-secondary);
}
</style>
