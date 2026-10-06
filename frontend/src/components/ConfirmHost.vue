<template>
  <!-- The one place a confirmation is drawn (lib/confirm.js). Beside the
       router view in App.vue, after it, so it stacks over every page's own
       dialog: a question is often asked from inside one (Move, from Manage),
       and two overlays at one z-index stack by document order. Keyed by the
       question, so a new question is a new dialog: its focus goes to its own
       button, and the old one's focus trap is gone with it. -->
  <ConfirmDialog
    v-if="pendingConfirm"
    :key="pendingConfirm.id"
    :title="pendingConfirm.title"
    :confirm-label="pendingConfirm.confirmLabel"
    :destructive="pendingConfirm.destructive"
    @confirm="answerConfirm(true)"
    @cancel="answerConfirm(false)"
  >
    <p v-for="(p, i) in pendingConfirm.paragraphs" :key="`p-${i}`">{{ p }}</p>
    <ul v-if="pendingConfirm.list.length" class="confirm-dialog-list">
      <li v-for="(item, i) in pendingConfirm.list" :key="`l-${i}`">{{ item }}</li>
    </ul>
    <p v-for="(p, i) in pendingConfirm.after" :key="`a-${i}`">{{ p }}</p>
    <!-- askText: one line to type, in place of window.prompt(). Enter
         answers, as the button does; Escape cancels, as on any question. -->
    <div v-if="pendingConfirm.input" class="field confirm-dialog-input">
      <label :for="`confirm-input-${pendingConfirm.id}`">{{ pendingConfirm.input.label }}</label>
      <input
        :id="`confirm-input-${pendingConfirm.id}`"
        ref="inputEl"
        v-model="pendingConfirm.input.value"
        type="text"
        class="form-control"
        autocomplete="off"
        spellcheck="false"
        @keydown.enter.prevent="answerConfirm(true)"
      />
    </div>
  </ConfirmDialog>
</template>

<script setup>
import { nextTick, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import ConfirmDialog from './ConfirmDialog.vue'
import { pendingConfirm, answerConfirm, dismissConfirm } from '../lib/confirm.js'

// A question belongs to the page that asked it. When a navigation completes,
// one still open is answered "no", so it cannot act on a page nobody is on
// (lib/confirm.js). A leave guard's question is answered before its
// navigation completes, so this never dismisses the question that allowed it.
const route = useRoute()
watch(() => route.fullPath, () => dismissConfirm())

// A question with something to type starts in its field, not on a button:
// ConfirmDialog has already focused one by now, so this runs after it.
const inputEl = ref(null)
watch(
  () => pendingConfirm.value?.id,
  async () => {
    if (!pendingConfirm.value?.input) return
    await nextTick()
    inputEl.value?.focus()
    inputEl.value?.select()
  },
)
</script>

<style scoped>
/* A long list (ten addresses to fill in) scrolls with the body, which is the
   part of a dialog that scrolls (style.css, `.modal`); this only keeps it
   from running into the text after it. */
.confirm-dialog-list {
  margin: 0;
  padding-left: 1.25rem;
  word-break: break-word;
}
.confirm-dialog-input {
  margin: 0;
}
</style>
