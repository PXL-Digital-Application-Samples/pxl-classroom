<!--
  The arrow on a sorted column heading.

  It was a four-line render helper defined inside `AssignmentDetailView.vue`,
  which was fine while one table sorted. The Roster tab sorts now, and a second
  copy of it is the fork this project has a rule against - so it moved here and
  both tables import it.

  `dir` is "asc" | "desc" | null. Null renders NOTHING, so the columns that are
  not sorted stay quiet rather than showing a greyed-out arrow apiece; the
  heading's own `aria-sort` is what a screen reader reads, and this is the
  sighted half of the same statement.
-->
<template>
  <Icon v-if="dir" :name="dir === 'asc' ? 'arrow-up' : 'arrow-down'" :size="11" class="sort-glyph" />
</template>

<script setup>
import Icon from './Icon.vue'

defineProps({
  dir: { type: String, default: null },
})
</script>
