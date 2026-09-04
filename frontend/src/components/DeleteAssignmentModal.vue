<template>
  <div class="modal-overlay" @click.self="requestClose">
    <div
      class="modal card modal-consequences"
      ref="el"
      role="dialog"
      aria-modal="true"
      aria-label="Delete assignment"
      @keydown="onKeydown"
    >
      <header class="modal-head flex justify-between items-center">
        <div class="flex items-center gap-xs">
          <Icon name="alert-triangle" :size="18" class="stat-red" />
          <h3 class="modal-consequences-title">Delete {{ assignmentId }}</h3>
        </div>
        <button class="modal-close" type="button" @click="requestClose" :disabled="busy" aria-label="Close">×</button>
      </header>

      <div class="modal-body flex flex-col gap-md">
        <!-- WHAT SURVIVES, FIRST. The word "delete" beside a cohort of student
             repositories is the fear this dialog exists to answer, and GitHub
             Classroom earns it: deleting an assignment there deletes every
             student repository. Saying what is kept before what goes is the
             whole point. -->
        <div class="flex flex-col gap-sm text-sm">
          <div class="flex gap-sm items-start">
            <Icon name="check-circle" :size="16" class="stat-green consequence-icon" />
            <div><strong>Student repositories are untouched.</strong> Nobody's work is deleted.</div>
          </div>

          <div class="flex gap-sm items-start">
            <Icon name="archive" :size="16" class="stat-green consequence-icon" />
            <div>
              <!-- The space before <code> is written, not implied: Vue's
                   `whitespace: 'condense'` drops a whitespace-only text node
                   that contains a newline, so "kept." ran straight into the
                   repository name. -->
              <strong>The archive is kept.</strong> <code>{{ archiveRepoName }}</code> still holds each submission as preserved at the deadline.
            </div>
          </div>

          <div class="flex gap-sm items-start">
            <Icon name="file-text" :size="16" class="stat-blue consequence-icon" />
            <div>
              <strong>Grades and the report move to</strong> <code>retired/{{ assignmentId }}/</code>, with a note of what was removed and by whom. Nothing reads that folder.
            </div>
          </div>

          <div class="flex gap-sm items-start">
            <Icon name="x-circle" :size="16" class="stat-red consequence-icon" />
            <div>
              <strong>The rest goes:</strong> the assignment, its acceptances, observations,
              repository records, lockdowns, teams and overrides, and the broker
              <code>{{ brokerRepoName }}</code>. Only the broker is unrecoverable; the files stay in
              git history.
            </div>
          </div>
        </div>

        <!-- Typed slug. The same guard Classroom50 puts on its delete: an
             action this wide should not be one misplaced click. -->
        <div class="field">
          <label for="delete-assignment-confirm">
            Type <code>{{ assignmentId }}</code> to confirm
          </label>
          <input
            id="delete-assignment-confirm"
            v-model="typed"
            autocomplete="off"
            spellcheck="false"
            :disabled="busy"
            :placeholder="assignmentId"
          />
        </div>

        <footer class="modal-foot flex justify-end gap-sm">
          <button class="btn btn-secondary" type="button" @click="requestClose" :disabled="busy">
            Cancel
          </button>
          <button
            class="btn btn-danger btn-with-icon"
            type="button"
            :disabled="busy || !matches"
            @click="emit('confirm')"
          >
            <Icon name="x-circle" :size="14" />
            <span>{{ busy ? 'Deleting…' : 'Delete assignment' }}</span>
          </button>
        </footer>
      </div>
    </div>
  </div>
</template>

<script setup>
// "Delete this assignment", and what that actually costs.
//
// GitHub Classroom deletes every student repository when an assignment is
// deleted, which is the reputation the word carries into this dialog.
// Classroom50 does the opposite - its delete removes the assignment record and
// keeps the repositories - and so does this. The dialog leads with that,
// because a confirmation's whole job is to be believed (DESIGN.md §1.5).
//
// The two repository names are PROPS. `lib/archive-repo.mjs` and
// `lib/broker-repo.mjs` are the only things allowed to decide where a
// preservation lives and what a broker is called; a dialog composing either
// itself would be the second implementation those modules exist to prevent
// (DESIGN.md §6).
import { computed, ref } from 'vue'
import Icon from './Icon.vue'
import { useFocusTrap } from '../composables/useFocusTrap.js'

const props = defineProps({
  assignmentId: { type: String, required: true },
  /** From lib/archive-repo.mjs, via the parent. Never built here. */
  archiveRepoName: { type: String, default: '' },
  /** From lib/broker-repo.mjs, via the parent. Never built here. */
  brokerRepoName: { type: String, default: '' },
  busy: { type: Boolean, default: false },
})

const emit = defineEmits(['close', 'confirm'])

const { el, onKeydown } = useFocusTrap()
const typed = ref('')

// Exact, and trimmed only at the edges - a pasted id with a stray space is the
// lecturer meaning this assignment, and a different id is not.
const matches = computed(() => typed.value.trim() === props.assignmentId)

function requestClose() {
  if (props.busy) return
  emit('close')
}
</script>

<style scoped>
.modal-consequences {
  max-width: 560px;
}

.modal-head {
  border-bottom: 1px solid var(--border-default);
  padding-bottom: var(--space-sm);
}

.modal-consequences-title {
  margin: 0;
}

/* Scoped, not borrowed. `FreezeConfirmModal` declares a class of this name in
   ITS scoped block, which cannot reach here - DESIGN.md §7, the failure that
   shipped 86 times. */
.consequence-icon {
  flex-shrink: 0;
  margin-top: 2px;
}

.modal-foot {
  border-top: 1px solid var(--border-default);
  padding-top: var(--space-sm);
}
</style>
