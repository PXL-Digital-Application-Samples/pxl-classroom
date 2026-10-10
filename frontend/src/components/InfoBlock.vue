<template>
  <!-- A FACT BESIDE THE BUTTON THAT CHANGES IT, never a button itself (asked
       2026-10-08): when the data on this tab was read, and how, sits left of
       Refresh / Read all scores again, so whether to press it is decided
       there. It was a footer at the bottom of the table, which a lecturer went
       looking for every time. Two lines - what, then when - in the summary
       cards' quiet type, divided from the buttons rather than boxed like one. -->
  <div class="info-block" :title="title || null" data-info-block>
    <Icon :name="icon" :size="14" class="info-block-icon" aria-hidden="true" />
    <div class="info-block-text">
      <span class="info-block-label">{{ label }}</span>
      <span v-if="at" class="info-block-value">
        <time :datetime="at" class="mono">{{ absolute }}</time><span class="info-block-ago"> · {{ ago }}</span>
      </span>
      <span v-else-if="value" class="info-block-value">{{ value }}</span>
    </div>
  </div>
</template>

<script setup>
// One fact, read at a glance: a label and either a time (absolute, and how
// long ago - kept current while the page is open) or a value.
import { computed, onMounted, onUnmounted, ref } from 'vue'
import Icon from './Icon.vue'
import { formatDate, formatRelative } from '../lib/format.js'

const props = defineProps({
  /** What this is: "Commits read by the nightly check". */
  label: { type: String, required: true },
  /** An ISO time, shown as a date and as how long ago. */
  at: { type: String, default: null },
  /** Shown instead of a time. */
  value: { type: String, default: '' },
  /** The timezone the page shows dates in. */
  timezone: { type: String, default: null },
  /** What hovering adds - only something the two lines do not say already;
   *  empty gives no tooltip at all. */
  title: { type: String, default: '' },
  icon: { type: String, default: 'clock' },
})

// "2h ago" goes stale while the page stays open; a minute is the finest step
// formatRelative shows.
const now = ref(Date.now())
let timer = null
onMounted(() => { timer = setInterval(() => { now.value = Date.now() }, 60_000) })
onUnmounted(() => { if (timer) clearInterval(timer) })

const absolute = computed(() => formatDate(props.at, props.timezone))
const ago = computed(() => {
  void now.value
  return formatRelative(props.at)
})
</script>

<style scoped>
.info-block {
  display: inline-flex;
  align-items: center;
  gap: var(--space-xs);
  padding: 0 var(--space-sm);
  border-left: 1px solid var(--border-muted);
  min-width: 0;
}

/* Hover adds something only where there is more to say (asked 2026-10-08);
   the pointer says which blocks those are. */
.info-block[title] {
  cursor: help;
}

.info-block-icon {
  color: var(--text-muted);
  flex-shrink: 0;
}

.info-block-text {
  display: flex;
  flex-direction: column;
  line-height: 1.25;
  min-width: 0;
}

/* The summary cards' label type, without their capitals: a label here is a
   phrase ("Commits read by the nightly check"), not a single word. */
.info-block-label {
  font-size: 0.72rem;
  color: var(--text-muted);
  white-space: nowrap;
}

.info-block-value {
  font-size: 0.8rem;
  color: var(--text-primary);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.info-block-ago {
  color: var(--text-secondary);
}
</style>
