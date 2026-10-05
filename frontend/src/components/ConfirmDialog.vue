<template>
  <div class="modal-overlay" @click.self="emit('cancel')">
    <div
      class="modal confirm-dialog"
      ref="el"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
      aria-describedby="confirm-dialog-body"
      @keydown="onKeydown"
      @keydown.escape="emit('cancel')"
    >
      <header class="modal-head">
        <h3 id="confirm-dialog-title">{{ title }}</h3>
      </header>
      <div id="confirm-dialog-body" class="modal-body confirm-dialog-body">
        <slot />
      </div>
      <footer class="modal-foot">
        <button ref="cancelButton" class="btn btn-secondary" type="button" @click="emit('cancel')">Cancel</button>
        <button
          ref="confirmButton"
          class="btn"
          :class="destructive ? 'btn-danger' : 'btn-primary'"
          type="button"
          @click="emit('confirm')"
        >{{ confirmLabel }}</button>
      </footer>
    </div>
  </div>
</template>

<script setup>
// A question asked inside the page, in place of `window.confirm()`.
//
// The browser's own box cannot name its button - it says OK, whatever is about
// to happen - and it cannot be styled, so on the Teams tab "Move", "Delete" and
// "Undo copy" were each confirmed by a grey system box reading "OK / Cancel"
// beside a page that otherwise speaks in full sentences (2026-10-04). Primer's
// ConfirmationDialog is the model: the button says what it does, a destructive
// one is red, and Cancel has focus when the action destroys something, so the
// Enter a lecturer presses out of habit is the harmless answer.
//
// The caller owns the text and what happens next; this only asks.
import { onMounted, ref } from 'vue'
import { useFocusTrap } from '../composables/useFocusTrap.js'

const props = defineProps({
  title: { type: String, required: true },
  confirmLabel: { type: String, required: true },
  destructive: { type: Boolean, default: false },
})

const emit = defineEmits(['confirm', 'cancel'])

const { el, onKeydown } = useFocusTrap({ autofocus: false })
const cancelButton = ref(null)
const confirmButton = ref(null)

onMounted(() => {
  ;(props.destructive ? cancelButton : confirmButton).value?.focus()
})
</script>

<style scoped>
.confirm-dialog {
  max-width: 480px;
}
.confirm-dialog-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
  font-size: 0.9rem;
}
.confirm-dialog-body :deep(p),
.confirm-dialog-body :deep(ul) {
  margin: 0;
}
</style>
