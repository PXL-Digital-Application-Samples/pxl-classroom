<template>
  <input
    v-if="editor.isEditing(student, field)"
    :value="draft"
    @input="emit('update:draft', $event.target.value)"
    :class="['cell-edit', `cell-${field}`]"
    :type="descriptor.type || 'text'"
    :list="descriptor.list"
    :disabled="editor.state.saving"
    :placeholder="descriptor.placeholder"
    :aria-label="`${descriptor.label} for ${who}`"
    @keyup.enter="editor.save(student, field)"
    @keyup.escape="editor.cancel"
    @blur="editor.save(student, field)"
  />
  <button
    v-else
    type="button"
    :class="['cell-value', `cell-${field}`, { mono, empty: !value }]"
    :title="`Set the ${descriptor.label} for ${who}`"
    @click="editor.start(student, field)"
  >{{ value || emptyText }}</button>
</template>

<script setup>
// One editable roster cell.
//
// Extracted because the alternative was four copies of the same twenty lines in
// one table row, differing only in a placeholder - and each copy would carry
// its own chance of losing one of the three guards the save depends on
// (escape-must-not-commit, merge-never-replace, refuse-a-stale-write).
//
// The EDITOR comes in as one object rather than eight props and four emits.
// That is deliberate: there is exactly one caller, only one cell in the whole
// table may be open at a time, and the state therefore has to live in the
// parent. Threading `editing`, `saving`, `v-model`, `@start`, `@save` and
// `@cancel` through four call sites is the same duplication with more commas.
//
// It holds no state of its own. A cell that remembered its own draft would let
// two be open at once, and the second save would be built on a roster the first
// had already changed.
import { computed } from 'vue'

const props = defineProps({
  student: { type: Object, required: true },
  /** A key of the parent's EDITABLE_FIELDS: student_number, full_name, email, class_group. */
  field: { type: String, required: true },
  /** `{ fields, state, isEditing, start, save, cancel }` from RosterTab. */
  editor: { type: Object, required: true },
  /**
   * The open cell's text, as its own v-model rather than a field of `editor`.
   * The state object belongs to the parent and writing through a prop is a
   * mutation whichever way it is spelled - `vue/no-mutating-props` is right,
   * and an emit is the contract that says so out loud.
   */
  draft: { type: String, default: '' },
  /** What an empty cell shows. A dash for data, a sentence where one reads better. */
  emptyText: { type: String, default: '-' },
  mono: { type: Boolean, default: false },
})

const emit = defineEmits(['update:draft'])

const descriptor = computed(() => props.editor.fields[props.field] ?? {})
const value = computed(() => {
  const v = props.student[props.field]
  return typeof v === 'string' ? v.trim() : ''
})

// Whatever this row can be called. A promoted row has no name and no number, so
// the login is the only thing left - and an aria-label reading "name for
// undefined" is worse than no label at all.
const who = computed(() =>
  props.student.full_name || props.student.student_number || props.student.github_login || 'this student')
</script>

<style scoped>
/* Carried over from the class-group cell this generalises, comment and all,
   because the decision in it survives the move: a RESTING affordance, since
   hover is not discoverable and a title attribute is not either. Dotted rather
   than a box - 200 of these should read as a column of text you can touch, not
   as 200 controls, which is "never nest three boxes" (DESIGN.md §1.1) applied
   to a grid. */
.cell-value {
  background: none;
  border: 0;
  padding: 2px 6px;
  margin: -2px -6px;
  border-radius: var(--radius-sm);
  color: inherit;
  font: inherit;
  cursor: pointer;
  text-align: left;
  border-bottom: 1px dotted var(--border-default);
}
.cell-value:hover,
.cell-value:focus-visible {
  background: var(--bg-surface-hover);
  color: var(--text-primary);
}
.cell-value.mono { font-family: var(--font-mono); }
.cell-value.empty { color: var(--text-muted); }

.cell-edit {
  width: 100%;
  min-width: 7rem;
  padding: 1px 6px;
  font: inherit;
  font-size: 0.85em;
}
</style>
