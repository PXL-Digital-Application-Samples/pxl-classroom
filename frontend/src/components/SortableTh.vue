<!--
  A column heading that sorts its table: click, Enter or Space, an `aria-sort`
  for a screen reader and the arrow for everyone else.

  Every sortable table in the app wrote this as one `<th>` with five attributes
  repeated per column, twenty-odd times across three files. `sort` is the
  table's `useTableSort()`; `col` is the key this column sorts on. A `class`,
  `title` or `v-if` given here lands on the `<th>`, as it did before.
-->
<template>
  <th
    class="sortable"
    tabindex="0"
    :aria-sort="sort.ariaSort(col)"
    @click="sort.sortBy(col)"
    @keydown.enter="sort.sortBy(col)"
    @keydown.space.prevent="sort.sortBy(col)"
  >
    <span class="th-label"><slot /><SortIcon :dir="sort.sortDir(col)" /></span>
  </th>
</template>

<script setup>
import SortIcon from './SortIcon.vue'

defineProps({
  /** The table's useTableSort(). */
  sort: { type: Object, required: true },
  /** The key this column sorts on. */
  col: { type: String, required: true },
})
</script>
