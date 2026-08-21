<template>
  <button
    type="button"
    class="btn btn-ghost btn-icon theme-toggle"
    :title="`Theme: ${current.label}. Click for ${next.label.toLowerCase()}.`"
    :aria-label="`Theme: ${current.label}. Activate for ${next.label.toLowerCase()}.`"
    @click="cycleThemeMode()"
  >
    <Icon :name="current.icon" :size="16" />
    <span class="sr-only">{{ current.label }}</span>
  </button>
</template>
<!-- Sizing comes from the global .btn-icon (DESIGN.md §3.3). -->


<script setup>
import { computed } from 'vue'
import Icon from './Icon.vue'
import { THEME_MODES, cycleThemeMode, themeMode } from '../lib/theme.js'

// Ghost/icon button per DESIGN.md §3 - a utility, never competing with the
// view's single primary CTA.
const MODE_META = {
  dark: { icon: 'moon', label: 'Dark' },
  light: { icon: 'sun', label: 'Light' },
  system: { icon: 'monitor', label: 'System' },
}

const current = computed(() => MODE_META[themeMode.value] ?? MODE_META.dark)

const next = computed(() => {
  const order = THEME_MODES.indexOf(themeMode.value)
  return MODE_META[THEME_MODES[(order + 1) % THEME_MODES.length]] ?? MODE_META.light
})
</script>
