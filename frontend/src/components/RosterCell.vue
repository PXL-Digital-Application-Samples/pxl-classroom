<template>
  <!-- KEYDOWN, not keyup. A button activates on Enter's KEYDOWN, so opening a
       cell from the keyboard mounts this input and focuses it while that same
       Enter is still down - and the keyup then landed HERE and committed the
       suggestion the box had only just offered. One keystroke opened the cell
       and accepted an address nobody had read. -->
  <input
    v-if="editing"
    ref="input"
    :value="draft"
    @input="emit('update:draft', $event.target.value)"
    :class="['cell-edit', `cell-${field}`, { suggested }]"
    :type="descriptor.type || 'text'"
    :list="descriptor.list"
    size="1"
    :disabled="editor.state.saving"
    :placeholder="descriptor.placeholder"
    :aria-label="suggested
      ? `${descriptor.label} for ${who} - suggested from their commits, press Enter to accept`
      : `${descriptor.label} for ${who}`"
    :title="suggested ? 'Suggested from their commits. Enter accepts it; clicking away does not.' : null"
    @keydown.enter="editor.save(student, field, 'enter')"
    @keydown.escape="editor.cancel"
    @blur="editor.save(student, field, 'blur')"
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
import { computed, nextTick, ref, watch } from 'vue'

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

const editing = computed(() => props.editor.isEditing(props.student, props.field))

/**
 * Is the box still showing the parent's suggestion, untouched?
 *
 * Compared against the draft rather than remembered, so it stops being true the
 * moment the lecturer types - at which point the value is theirs and the box
 * should stop flagging itself. The same comparison decides whether a blur may
 * commit, and it is deliberately ONE expression in the parent so the tint and
 * the write cannot disagree about what is a suggestion.
 */
const suggested = computed(() => !!props.editor.state.suggestion && props.draft === props.editor.state.suggestion)

// The button is replaced by the input, so the click that opened it leaves focus
// on an element that no longer exists: without this you had to click the cell
// twice to type in it. Playwright's `fill()` focuses on your behalf, which is
// why eight passing tests never noticed.
const input = ref(null)
watch(editing, async (open) => {
  if (!open) return
  await nextTick()
  input.value?.focus()
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
/* The resting cell and the open one are ONE box, deliberately the same height.
   Not cosmetic: closing a cell used to shrink its row, and since a click that
   moves from one open cell straight to another closes the first on MOUSEDOWN,
   the row below shifted before the mouseup - so the click landed on nothing and
   the second cell never opened. `tests/e2e/63` measures the row rather than
   trusting this arithmetic. */
.cell-value,
.cell-edit {
  box-sizing: border-box;
  min-height: 24px;
  line-height: 18px;
}

.cell-value {
  background: none;
  border: 0;
  padding: 2px 6px;
  margin: 0 -6px;
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
  /* `width: 100%` AND `size="1"` on the element, and it needs both. An input
     carries an intrinsic width - `size` defaults to about 20 characters - and
     an auto-layout table sizes its columns from intrinsic contributions, where
     a percentage counts as auto. So the column grew to fit a box CSS had
     already told to be 100%, opening a cell pushed every column to its right
     along, and closing one pulled them back. Clicking straight from an open
     cell to another closes the first on MOUSEDOWN, so the target had slid 44px
     sideways before the mouseup landed - on bare table, opening nothing.
     Removing the old `min-width: 7rem` was not enough; the intrinsic width is
     the half that does the damage. The column is at least as wide as its own
     heading, and 100% of that is room enough. */
  width: 100%;
  padding: 1px 5px;
  /* `font: inherit` and no size of its own: the box has to match the resting
     value it replaces, and text that shrinks when you click it was never the
     point of the smaller size. */
  font: inherit;
  line-height: 18px;
}

/* A value nobody has vouched for yet, so it must not read as stored data. The
   tint goes as soon as the lecturer types, because from then on it is theirs -
   which makes the colour mean one thing exactly: press Enter and this becomes
   the roster's answer. Attention rather than accent: blue is the focus ring
   here, and an input that is both focused and suggested would say neither. */
.cell-edit.suggested {
  background: var(--tint-attention-subtle);
  border-color: var(--tint-attention-emphasis);
}
</style>
