<template>
  <div class="modal-overlay" @click.self="requestClose">
    <div
      class="modal card modal-consequences"
      ref="el"
      role="dialog"
      aria-modal="true"
      aria-label="Confirm Immediate Freeze and Lockdown"
      @keydown="onKeydown"
    >
      <header class="modal-head flex justify-between items-center">
        <div class="flex items-center gap-xs">
          <Icon name="alert-triangle" :size="18" class="stat-yellow" />
          <h3 class="modal-consequences-title">Confirm Immediate Freeze &amp; Lockdown</h3>
        </div>
        <button class="modal-close" type="button" @click="requestClose" :disabled="busy" aria-label="Close">×</button>
      </header>

      <div class="modal-body flex flex-col gap-md">
        <div class="card freeze-warning">
          <p class="text-sm font-semibold freeze-warning-title">
            ⚠️ Immediate Submissions Lockdown
          </p>
          <p class="text-xs text-secondary freeze-warning-body">
            You are initiating an administrative freeze for assignment <strong>{{ assignment?.id }}</strong> across all {{ eligibleCount }} student repositories.
          </p>
        </div>

        <div class="consequences-list flex flex-col gap-sm text-sm">
          <div class="consequence-item flex gap-sm items-start">
            <Icon name="lock" :size="16" class="stat-red consequence-icon" />
            <div>
              <strong>Demotes Student Permissions to Read-Only:</strong>
              <p class="text-xs text-secondary consequence-body">
                All students and team members will be demoted from Admin/Write to Read (<code>pull</code>). They will not be able to push new commits.
              </p>
            </div>
          </div>

          <div class="consequence-item flex gap-sm items-start">
            <Icon name="archive" :size="16" class="stat-green consequence-icon" />
            <div>
              <strong>Snapshots Immutable Archive Commits:</strong>
              <p class="text-xs text-secondary consequence-body">
                The current <code>HEAD</code> commit of each student repository is cloned and committed into this assignment's private archive repository (<code>{{ archiveRepoName }}</code>) as the authoritative grading snapshot.
              </p>
            </div>
          </div>

          <div class="consequence-item flex gap-sm items-start">
            <Icon name="clock" :size="16" class="stat-blue consequence-icon" />
            <div>
              <strong>Locks Deadline Classification:</strong>
              <p class="text-xs text-secondary consequence-body">
                The lockdown timestamp is recorded. Any future commits pushed after this moment will require an explicit lecturer deadline extension to count toward grading.
              </p>
            </div>
          </div>
        </div>

        <footer class="modal-foot flex justify-end gap-sm">
          <button class="btn btn-secondary" type="button" @click="requestClose" :disabled="busy">
            Cancel
          </button>
          <button class="btn btn-danger btn-with-icon" type="button" :disabled="busy" @click="emit('confirm')">
            <Icon name="lock" :size="14" />
            <span>{{ busy ? 'Executing Lockdown…' : 'Confirm Freeze &amp; Lockdown' }}</span>
          </button>
        </footer>
      </div>
    </div>
  </div>
</template>

<script setup>
// "Freeze and preserve this cohort now", and what that actually costs.
//
// Every consequence listed is a thing lockdown.mjs does: the demotion, the
// archive push, and the lockdown_at that every later deadline comparison is
// measured against. DESIGN.md §1.5 - the UI must not describe behaviour the
// system does not have - applies hardest to a confirmation dialog, because its
// entire job is to be believed.
//
// `archiveRepoName` is a PROP rather than derived here: lib/archive-repo.mjs is
// the only thing allowed to decide where a preservation goes (CLAUDE.md), and a
// dialog composing the name itself is exactly the second implementation that
// rule forbids.
import Icon from './Icon.vue'
import { useFocusTrap } from '../composables/useFocusTrap.js'

const props = defineProps({
  assignment: { type: Object, default: null },
  eligibleCount: { type: Number, required: true },
  /** From lib/archive-repo.mjs, via the parent. Never built here. */
  archiveRepoName: { type: String, default: '' },
  busy: { type: Boolean, default: false },
})

const emit = defineEmits(['close', 'confirm'])

const { el, onKeydown } = useFocusTrap()

function requestClose() {
  // The lockdown run has been dispatched and cannot be recalled; closing over
  // it would hide the only progress indicator there is.
  if (props.busy) return
  emit('close')
}
</script>

<style scoped>
/* Declarations that were inline on the elements above. Nothing here is new -
   the dialog looked like this already, it just carried its appearance in
   `style=` attributes where DESIGN.md §5 rule 1 forbids colour. */
.modal-consequences {
  max-width: 560px;
}

.modal-head {
  border-bottom: 1px solid var(--border-default);
  padding: 14px 18px;
}

.modal-consequences-title {
  margin: 0;
  font-size: 1.05rem;
}

.modal-body {
  padding: 16px 18px;
}

.freeze-warning {
  background: var(--tint-attention-subtle);
  border: 1px solid var(--tint-attention-emphasis);
  padding: 12px;
  border-radius: var(--radius-sm);
}

.freeze-warning-title {
  margin-bottom: 4px;
  color: var(--accent-yellow);
}

.freeze-warning-body {
  margin: 0;
}

.consequence-icon {
  margin-top: 2px;
  flex-shrink: 0;
}

.consequence-body {
  margin: 2px 0 0 0;
}

.modal-foot {
  padding-top: 14px;
  border-top: 1px solid var(--border-default);
  margin-top: 6px;
}
</style>
