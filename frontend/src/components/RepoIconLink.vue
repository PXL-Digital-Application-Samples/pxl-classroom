<!--
  A row's repository, as an icon with its name on hover and as its accessible
  name. The Progress table's Repo column (DESIGN.md 7, "A nowrap table pays for
  every column out of one width"): the name is a prefix every row shares plus
  the first column, so spelled out it was the widest column and said nothing.
  The Teams table spelled it out too, until it used this.
-->
<template>
  <a
    v-if="url"
    :href="url"
    target="_blank"
    rel="noopener"
    class="repo-link repo-icon-link"
    :title="shortName"
    :aria-label="`Repository ${shortName}`"
  >
    <Icon name="book" :size="16" />
  </a>
  <span v-else class="text-muted">-</span>
</template>

<script setup>
import { computed } from 'vue'
import Icon from './Icon.vue'

const props = defineProps({
  url: { type: String, default: null },
  /** `owner/name` or a bare name; shown without the owner. */
  name: { type: String, default: null },
})

const shortName = computed(() => {
  const n = props.name || (props.url ? props.url.split('/').pop() : '')
  return n.includes('/') ? n.split('/').pop() : n
})
</script>

<style scoped>
/* The link is an icon, so it gets a box and the row menu's hover: a bare 16px
   glyph is a poor target for the link a table is clicked on most. The negative
   margin keeps the glyph on the heading's left edge and the row at the height
   it had. */
.repo-icon-link {
  justify-content: center;
  width: 28px;
  height: 28px;
  margin: -6px 0 -6px -6px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  vertical-align: middle;
}
.repo-icon-link:hover {
  background: var(--bg-surface-elevated);
  border-color: var(--border-default);
}
</style>
