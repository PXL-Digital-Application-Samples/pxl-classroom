<!--
  Where a preserved submission is: a small link under the row's status, to the
  branch in the archive repository, with the preserved commit. The Progress
  table's; the Teams table had a whole Preserved column for the same link.
  The caller decides the URL (lib/archive-repo.mjs is the only judge of where a
  preservation is) and whether the row is preserved.
-->
<template>
  <div v-if="url && sha" class="archive-link-wrap">
    <a
      :href="url"
      target="_blank"
      rel="noopener"
      class="archive-link mono text-xs"
      :title="`Preserved in archive repository at SHA ${sha}`"
    >
      <Icon name="archive" :size="11" />
      <span>archive ({{ sha.slice(0, 7) }})</span>
    </a>
  </div>
</template>

<script setup>
import Icon from './Icon.vue'

defineProps({
  url: { type: String, default: null },
  sha: { type: String, default: null },
})
</script>

<style scoped>
.archive-link-wrap { margin-top: 3px; }
.archive-link {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  color: var(--text-secondary);
  text-decoration: underline;
}
</style>
