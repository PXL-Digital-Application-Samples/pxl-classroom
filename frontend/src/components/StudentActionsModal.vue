<template>
  <div class="modal-overlay" @click.self="requestClose">
    <div
      class="modal"
      ref="el"
      role="dialog"
      aria-modal="true"
      :aria-label="`Actions for ${student.github_login}`"
      @keydown="onKeydown"
    >
      <header class="modal-head">
        <h3>Actions: <code>{{ student.github_login }}</code></h3>
        <button class="modal-close" type="button" @click="requestClose" :disabled="busy" aria-label="Close">×</button>
      </header>

      <section class="modal-section">
        <h4>Grant deadline extension</h4>
        <p v-if="extension" class="text-secondary">
          Currently extended to <strong>{{ formatDate(extension.value) }}</strong>
          ("{{ extension.reason }}"). Granting again adds a new extension to their override history.
        </p>
        <div class="field">
          <label>New deadline (just for this student)</label>
          <input type="datetime-local" v-model="ext.deadline_local" />
        </div>
        <div class="field">
          <label>Reason (recorded in the override)</label>
          <textarea v-model="ext.reason" rows="2" placeholder="Medical certificate / approved by program coordinator / etc."></textarea>
        </div>
        <button
          class="btn btn-primary"
          type="button"
          @click="emit('grant', { ...ext })"
          :disabled="busy || !ext.deadline_local || !ext.reason.trim()"
        >
          {{ extending ? 'Granting…' : 'Grant extension' }}
        </button>
      </section>

      <section class="modal-section">
        <h4>Retry acceptance</h4>
        <p class="text-secondary">Wipes the half-done state and re-runs the full pipeline. Use when a student's acceptance got stuck (e.g. rate-limit during a burst).</p>
        <button class="btn" type="button" @click="emit('retry')" :disabled="retrying">
          {{ retrying ? 'Triggering…' : 'Retry acceptance' }}
        </button>
      </section>

      <section
        v-if="student.preservation_status === 'preserved' && student.preserved_sha && archiveUrl"
        class="modal-section"
      >
        <h4>Preserved Submission Archive</h4>
        <p class="text-secondary">
          Preserved commit SHA: <code class="mono">{{ student.preserved_sha }}</code>
        </p>
        <a :href="archiveUrl" target="_blank" rel="noopener" class="btn btn-secondary btn-with-icon archive-open-link">
          <Icon name="external-link" :size="14" />
          <span>View Preserved Code in Archive</span>
        </a>
      </section>
    </div>
  </div>
</template>

<script setup>
// Per-student actions: grant an extension, retry a stuck acceptance, open the
// preserved submission.
//
// Lifted out of AssignmentDetailView, where the dialog's markup, its form state
// (`actionExt`), its focus trap (`modalEl` + `trapTab` + a module-scope
// `modalReturnFocus`) and its two handlers were spread across 2,100 lines of
// script. The form belongs to the dialog: it is created when the dialog opens
// and meaningless when it is closed, which is exactly what a component's own
// state is for.
//
// The VALIDATION stays in the parent, deliberately. "An extension must move the
// deadline forward" needs the student's current effective deadline and the
// assignment's, and lib/effective-deadline.mjs is the one thing allowed to
// decide that (CLAUDE.md). A dialog that re-derived it would be the second
// implementation that rule exists to prevent.
import { computed, reactive } from 'vue'
import Icon from './Icon.vue'
import { formatDate } from '../lib/format.js'
import { utcToLocalInput } from '../lib/assignment-doc.js'
import { useFocusTrap } from '../composables/useFocusTrap.js'

const props = defineProps({
  student: { type: Object, required: true },
  /** The extension currently in force, or null. `{ value, reason }`. */
  extension: { type: Object, default: null },
  /** Where the preserved submission lives, or null when there is nothing to link. */
  archiveUrl: { type: String, default: null },
  extending: { type: Boolean, default: false },
  retrying: { type: Boolean, default: false },
})

const emit = defineEmits(['close', 'grant', 'retry'])

const { el, onKeydown } = useFocusTrap()

// Seeded from the deadline that applies to THIS student, so a lecturer edits
// the date rather than typing it from scratch.
const ext = reactive({
  deadline_local: props.student.effective_deadline_at
    ? utcToLocalInput(props.student.effective_deadline_at)
    : '',
  reason: '',
})

// A computed, not a function: the template binds `:disabled="busy"`, and a bare
// function reference there is an object - always truthy, so every control would
// render permanently disabled.
const busy = computed(() => props.extending || props.retrying)

function requestClose() {
  // Never close over work in flight: the run has been dispatched and the result
  // lands on this dialog.
  if (busy.value) return
  emit('close')
}
</script>

<style scoped>
/* Was an inline style on the anchor. A link styled as a button still needs its
   underline removed and its icon aligned. */
.archive-open-link {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  text-decoration: none;
}
</style>
