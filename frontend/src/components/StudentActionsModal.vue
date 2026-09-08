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

      <section v-if="unlock" class="modal-section">
        <h4>Reopen the repository</h4>
        <!-- The verdict arrives decided. lib/repo-unlock.mjs owns "may this be
             reopened", the same way lib/effective-deadline.mjs owns the
             extension rule above - a dialog that re-derived either would be the
             second implementation DESIGN.md §6 exists to prevent. -->
        <p v-if="!unlock.can" class="text-secondary">{{ unlock.reason }}</p>
        <template v-else>
          <p class="text-secondary">
            Lets this student push again. The deadline snapshot is already in the archive and does not
            move, so what you grade is unaffected.
            <template v-if="unlock.method === 'demotion'">
              They were frozen by having their access reduced, so this restores it to
              <code>{{ unlock.permission }}</code>.
            </template>
            <template v-else>
              Their repository was frozen with a ruleset, which is switched off rather than deleted -
              so the deadline can be re-applied later without rebuilding it.
            </template>
          </p>
          <div class="field">
            <label>Reason (recorded beside the lockdown)</label>
            <textarea
              v-model="unlockReason"
              rows="2"
              placeholder="Medical certificate / appeal upheld / resit agreed with the program coordinator"
            ></textarea>
          </div>
          <button
            class="btn"
            type="button"
            @click="emit('unlock', { reason: unlockReason.trim() })"
            :disabled="busy || !unlockReason.trim()"
          >
            {{ unlocking ? 'Reopening…' : 'Reopen repository' }}
          </button>
        </template>
      </section>

      <!-- CHASING ONE STUDENT IS THE ORDINARY CASE, and re-grading forty to fix
           one was the only thing on offer. The verdict arrives decided, like
           the reopen above: lib/autograde-source.mjs owns "does this assignment
           grade in CI at all", so this dialog never asks it a second way. -->
      <section v-if="regrade" class="modal-section">
        <h4>Re-grade this student</h4>
        <p v-if="!regrade.can" class="text-secondary">{{ regrade.reason }}</p>
        <template v-else>
          <p class="text-secondary">
            Reads this student's grading run again and replaces their row in the results. Nobody
            else's score is touched, and nothing in their repository changes - the run has already
            happened, this only reads it.
            <template v-if="regrade.commitNote">{{ regrade.commitNote }}</template>
          </p>
          <button class="btn" type="button" @click="emit('regrade')" :disabled="busy">
            {{ regrading ? 'Reading…' : 'Re-grade this student' }}
          </button>
        </template>
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
import { computed, reactive, ref } from 'vue'
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
  /**
   * Whether the repository can be reopened, already decided:
   * `{ can, method, permission, reason }` from lib/repo-unlock.mjs. Null when
   * the section should not appear at all - an assignment whose deadline has not
   * run has nothing to say here, and a heading over "nothing has been locked"
   * is noise on every student in a live cohort.
   */
  unlock: { type: Object, default: null },
  unlocking: { type: Boolean, default: false },
  /**
   * Whether this student's score can be read again, already decided:
   * `{ can, reason, commitNote }`. Null when the section should not appear at
   * all - an assignment that grades nothing has nothing to say here, and a
   * heading over "there is no grading" is noise on every row of every cohort.
   * The same shape and the same reason as `unlock`.
   */
  regrade: { type: Object, default: null },
  regrading: { type: Boolean, default: false },
})

const emit = defineEmits(['close', 'grant', 'retry', 'unlock', 'regrade'])

// The dialog's own state, not the view's: it is created when the dialog opens
// and meaningless when it is closed (DESIGN.md §6).
const unlockReason = ref('')

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
const busy = computed(
  () => props.extending || props.retrying || props.unlocking || props.regrading,
)

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
