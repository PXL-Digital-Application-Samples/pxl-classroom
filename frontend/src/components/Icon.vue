<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    :stroke-width="strokeWidth"
    stroke-linecap="round"
    stroke-linejoin="round"
    :aria-hidden="ariaLabel ? null : true"
    :aria-label="ariaLabel || null"
    :role="ariaLabel ? 'img' : null"
    class="icon"
    v-html="paths"
  ></svg>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  name: { type: String, required: true },
  size: { type: [Number, String], default: 16 },
  strokeWidth: { type: [Number, String], default: 2 },
  ariaLabel: { type: String, default: '' },
})

// Lucide-derived 24×24 outline paths. All strokes are currentColor so the
// caller's text color drives the icon — keeps theming trivial.
const ICONS = {
  'alert-triangle':
    '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>' +
    '<line x1="12" y1="9" x2="12" y2="13"/>' +
    '<line x1="12" y1="17" x2="12.01" y2="17"/>',
  clipboard:
    '<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>' +
    '<rect x="8" y="2" width="8" height="4" rx="1" ry="1"/>',
  clock:
    '<circle cx="12" cy="12" r="10"/>' +
    '<polyline points="12 6 12 12 16 14"/>',
  timer:
    '<line x1="10" y1="2" x2="14" y2="2"/>' +
    '<line x1="12" y1="14" x2="15" y2="11"/>' +
    '<circle cx="12" cy="14" r="8"/>',
  'check-circle':
    '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>' +
    '<polyline points="22 4 12 14.01 9 11.01"/>',
  inbox:
    '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/>' +
    '<path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  'x-circle':
    '<circle cx="12" cy="12" r="10"/>' +
    '<line x1="15" y1="9" x2="9" y2="15"/>' +
    '<line x1="9" y1="9" x2="15" y2="15"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  x:
    '<line x1="18" y1="6" x2="6" y2="18"/>' +
    '<line x1="6" y1="6" x2="18" y2="18"/>',
  'refresh-cw':
    '<path d="M21 12a9 9 0 0 1-9 9 9 9 0 0 1-6.36-2.64L3 21"/>' +
    '<path d="M3 12a9 9 0 0 1 9-9 9 9 0 0 1 6.36 2.64L21 3"/>' +
    '<path d="M21 3v6h-6"/>' +
    '<path d="M3 21v-6h6"/>',
  download:
    '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>' +
    '<polyline points="7 10 12 15 17 10"/>' +
    '<line x1="12" y1="15" x2="12" y2="3"/>',
  copy:
    '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>' +
    '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  'more-horizontal':
    '<circle cx="12" cy="12" r="1"/>' +
    '<circle cx="19" cy="12" r="1"/>' +
    '<circle cx="5" cy="12" r="1"/>',
  zap: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
  'arrow-left':
    '<line x1="19" y1="12" x2="5" y2="12"/>' +
    '<polyline points="12 19 5 12 12 5"/>',
  'arrow-up':
    '<line x1="12" y1="19" x2="12" y2="5"/>' +
    '<polyline points="5 12 12 5 19 12"/>',
  'arrow-down':
    '<line x1="12" y1="5" x2="12" y2="19"/>' +
    '<polyline points="19 12 12 19 5 12"/>',
  tag:
    '<path d="M20.59 13.41 13.42 20.58a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/>' +
    '<circle cx="7" cy="7" r="1"/>',
  info:
    '<circle cx="12" cy="12" r="10"/>' +
    '<line x1="12" y1="16" x2="12" y2="12"/>' +
    '<line x1="12" y1="8" x2="12.01" y2="8"/>',
  plus:
    '<line x1="12" y1="5" x2="12" y2="19"/>' +
    '<line x1="5" y1="12" x2="19" y2="12"/>',
  'chevrons-up-down':
    '<polyline points="7 15 12 20 17 15"/>' +
    '<polyline points="7 9 12 4 17 9"/>',
  'arrow-right':
    '<line x1="5" y1="12" x2="19" y2="12"/>' +
    '<polyline points="12 5 19 12 12 19"/>',
}

const paths = computed(() => ICONS[props.name] || '')
</script>

<style scoped>
.icon {
  display: inline-block;
  vertical-align: -0.125em;
  flex-shrink: 0;
}
</style>
