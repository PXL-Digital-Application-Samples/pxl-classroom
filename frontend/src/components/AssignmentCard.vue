<template>
  <article
    class="assignment-card"
    tabindex="0"
    role="button"
    :aria-label="`View details for ${assignment.title}`"
    @click="$emit('click', assignment)"
    @keydown.enter="$emit('click', assignment)"
    @keydown.space.prevent="$emit('click', assignment)"
  >
    <header class="card-header">
      <h3 class="card-title">{{ assignment.title }}</h3>
      <span :class="['state-badge', `state-${assignment.state}`]">
        {{ stateLabel }}
      </span>
    </header>

    <div class="card-meta">
      <div class="meta-item" v-if="assignment.opens_at">
        <span class="meta-label">Opens</span>
        <time :datetime="assignment.opens_at">{{ formatDate(assignment.opens_at) }}</time>
      </div>
      <div class="meta-item" v-if="assignment.deadline_at">
        <span class="meta-label">Deadline</span>
        <time :datetime="assignment.deadline_at">{{ formatDate(assignment.deadline_at) }}</time>
      </div>
    </div>

    <div class="card-stats">
      <div class="stat" v-if="stats.accepted != null">
        <span class="stat-value">{{ stats.accepted }}</span>
        <span class="stat-label">Accepted</span>
      </div>
      <div class="stat" v-if="stats.provisioned != null">
        <span class="stat-value">{{ stats.provisioned }}</span>
        <span class="stat-label">Provisioned</span>
      </div>
      <div class="stat stat-green" v-if="stats.on_time != null">
        <span class="stat-value">{{ stats.on_time }}</span>
        <span class="stat-label">On Time</span>
      </div>
      <div class="stat stat-yellow" v-if="stats.late != null">
        <span class="stat-value">{{ stats.late }}</span>
        <span class="stat-label">Late</span>
      </div>
      <div class="stat stat-red" v-if="stats.no_submission != null">
        <span class="stat-value">{{ stats.no_submission }}</span>
        <span class="stat-label">No Sub</span>
      </div>
      <div class="stat stat-orange" v-if="stats.warnings != null && stats.warnings > 0">
        <span class="stat-value">{{ stats.warnings }}</span>
        <span class="stat-label">Warnings</span>
      </div>
    </div>

    <div class="card-arrow" aria-hidden="true">→</div>
  </article>
</template>

<script setup>
import { computed } from 'vue'
import { config } from '../lib/config.js'

const props = defineProps({
  assignment: {
    type: Object,
    required: true,
  },
})

defineEmits(['click'])

const stateLabel = computed(() => {
  const labels = {
    draft: 'Draft',
    open: 'Open',
    closed: 'Closed',
    active: 'Active',
    archived: 'Archived',
  }
  return labels[props.assignment.state] || props.assignment.state || 'Unknown'
})

const stats = computed(() => {
  const c = props.assignment.counts || props.assignment.stats || {}
  return {
    accepted: c.accepted ?? null,
    provisioned: c.provisioned ?? null,
    on_time: c.on_time ?? c.onTime ?? null,
    late: c.late ?? null,
    no_submission: c.no_submission ?? c.noSubmission ?? null,
    warnings: c.warnings ?? null,
  }
})

function formatDate(iso) {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString('en-GB', {
      timeZone: config.timezone,
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
  } catch {
    return iso
  }
}
</script>

<style scoped>
.assignment-card {
  background: #161b22;
  border: 1px solid #30363d;
  border-radius: 12px;
  padding: 20px 24px;
  cursor: pointer;
  transition: border-color 0.2s, box-shadow 0.2s, transform 0.15s;
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.assignment-card:hover {
  border-color: #58a6ff;
  box-shadow: 0 4px 24px rgba(88, 166, 255, 0.08);
  transform: translateY(-2px);
}

.assignment-card:focus-visible {
  outline: 2px solid #58a6ff;
  outline-offset: 2px;
}

.card-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.card-title {
  font-family: system-ui, -apple-system, sans-serif;
  font-size: 1.05rem;
  font-weight: 600;
  color: #e6edf3;
  margin: 0;
  line-height: 1.4;
}

.state-badge {
  font-size: 0.7rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding: 3px 10px;
  border-radius: 20px;
  white-space: nowrap;
  flex-shrink: 0;
}

.state-draft {
  background: rgba(139, 148, 158, 0.15);
  color: #8b949e;
}
.state-open,
.state-active {
  background: rgba(63, 185, 80, 0.15);
  color: #3fb950;
}
.state-closed,
.state-archived {
  background: rgba(210, 153, 34, 0.15);
  color: #d29922;
}

.card-meta {
  display: flex;
  gap: 20px;
  flex-wrap: wrap;
}

.meta-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.meta-label {
  font-size: 0.68rem;
  color: #8b949e;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  font-weight: 500;
}

.meta-item time {
  font-size: 0.82rem;
  color: #c9d1d9;
  font-family: ui-monospace, Consolas, monospace;
}

.card-stats {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.stat {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 8px 12px;
  border-radius: 8px;
  background: rgba(88, 166, 255, 0.06);
  min-width: 52px;
}

.stat-green {
  background: rgba(63, 185, 80, 0.08);
}
.stat-green .stat-value {
  color: #3fb950;
}

.stat-yellow {
  background: rgba(210, 153, 34, 0.08);
}
.stat-yellow .stat-value {
  color: #d29922;
}

.stat-red {
  background: rgba(248, 81, 73, 0.08);
}
.stat-red .stat-value {
  color: #f85149;
}

.stat-orange {
  background: rgba(210, 153, 34, 0.08);
}
.stat-orange .stat-value {
  color: #d29922;
}

.stat-value {
  font-size: 1.15rem;
  font-weight: 700;
  color: #58a6ff;
  font-family: ui-monospace, Consolas, monospace;
}

.stat-label {
  font-size: 0.62rem;
  color: #8b949e;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin-top: 2px;
}

.card-arrow {
  position: absolute;
  right: 20px;
  top: 50%;
  transform: translateY(-50%);
  font-size: 1.2rem;
  color: #30363d;
  transition: color 0.2s, transform 0.2s;
}

.assignment-card:hover .card-arrow {
  color: #58a6ff;
  transform: translateY(-50%) translateX(3px);
}
</style>
