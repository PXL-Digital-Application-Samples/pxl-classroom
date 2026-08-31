<template>
  <button
    type="button"
    class="btn btn-ghost btn-icon theme-toggle"
    :title="`${current.label} theme. Switch to ${next.label.toLowerCase()}.`"
    :aria-label="`${current.label} theme. Activate to switch to ${next.label.toLowerCase()}.`"
    @click="toggleTheme()"
  >
    <Icon :name="current.icon" :size="16" />
    <span class="sr-only">{{ current.label }}</span>
  </button>
</template>
<!-- Sizing comes from the global .btn-icon (DESIGN.md §3). -->

<script setup>
import { computed } from 'vue'
import Icon from './Icon.vue'
import { resolvedTheme, toggleTheme } from '../lib/theme.js'

// Ghost/icon button per DESIGN.md §3 - a utility, never competing with the
// view's single primary CTA.
//
// Keyed off `resolvedTheme` (what is on screen) rather than the stored mode,
// so a first-time visitor still sees a plain dark/light control. 'system' is
// how they arrived, not something they should have to reason about.
const META = {
  dark: { icon: 'moon', label: 'Dark' },
  light: { icon: 'sun', label: 'Light' },
}

const current = computed(() => META[resolvedTheme.value] ?? META.dark)
const next = computed(() => (resolvedTheme.value === 'dark' ? META.light : META.dark))
</script>
