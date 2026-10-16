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
            ⚠️ Tonight's deadline check, now
          </p>
          <p class="text-xs text-secondary freeze-warning-body" data-freeze-scope>
            This runs the nightly check for the whole organization now. It locks every assignment whose deadline has
            passed and that is not locked yet - <strong>{{ assignment?.id }}</strong> with its {{ eligibleCount }} student
            repositories, and any other in this organization that is waiting for the same.
          </p>
        </div>

        <div class="consequences-list flex flex-col gap-sm text-sm">
          <div class="consequence-item flex gap-sm items-start">
            <Icon name="lock" :size="16" class="stat-red consequence-icon" />
            <div>
              <strong>{{ lockLine.title }}</strong>
              <p class="text-xs text-secondary consequence-body" data-freeze-lock>{{ lockLine.body }}</p>
            </div>
          </div>

          <div class="consequence-item flex gap-sm items-start">
            <Icon name="archive" :size="16" class="stat-green consequence-icon" />
            <div>
              <strong>Their work is archived</strong>
              <p class="text-xs text-secondary consequence-body">
                The last commit before the deadline is copied to this assignment's archive
                (<code>{{ archiveRepoName }}</code>) as what is graded. Where pushing stopped at the deadline, that is
                what the repository holds now.
              </p>
            </div>
          </div>

          <div class="consequence-item flex gap-sm items-start">
            <Icon name="clock" :size="16" class="stat-blue consequence-icon" />
            <div>
              <strong>Who is left out</strong>
              <p class="text-xs text-secondary consequence-body" data-freeze-left-out>
                Students with an extension still running, and students you reopened, are not locked now: they are locked at
                their own deadline. An extension granted after this does not reopen anyone - Reopen does.
              </p>
            </div>
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
</template>

<script setup>
// "Lock everyone out now", and what that actually does.
//
// Every consequence listed is a thing the run does. DESIGN.md §1.5 - the UI
// must not describe behaviour the system does not have - applies hardest to a
// confirmation dialog, because its entire job is to be believed. It described
// a demotion on every assignment, HEAD as the snapshot, every repository, and
// later commits counted with an extension - none of which is so (review
// 2026-10-16, R7-10): the button dispatches the organization's nightly, which
// locks with the assignment's own answer to "After the deadline" (a ruleset,
// read-only as well, or nothing), archives the last commit before the deadline,
// and leaves out the extended and the reopened.
//
// `archiveRepoName` is a PROP rather than derived here: lib/archive-repo.mjs is
// the only thing allowed to decide where a preservation goes (CLAUDE.md), and a
// dialog composing the name itself is exactly the second implementation that
// rule forbids.
import { computed } from 'vue'
import Icon from './Icon.vue'
import { useFocusTrap } from '../composables/useFocusTrap.js'
import { takesAccessAtDeadline } from '../../../lib/lock-scope.mjs'

const props = defineProps({
  assignment: { type: Object, default: null },
  eligibleCount: { type: Number, required: true },
  /** From lib/archive-repo.mjs, via the parent. Never built here. */
  archiveRepoName: { type: String, default: '' },
  busy: { type: Boolean, default: false },
})

const emit = defineEmits(['close', 'confirm'])

// The assignment's own "After the deadline" answer (RUNBOOK §3.4): late_policy
// and lock_down_enabled, read as lockdown.mjs reads them.
const lockLine = computed(() => {
  const block = props.assignment?.late_policy === 'block'
  const readOnly = takesAccessAtDeadline(props.assignment)
  if (block && readOnly) {
    return { title: 'Pushing stops, and the repository becomes read-only', body: 'The submission branch is locked, and students lose the repository\'s Actions, secrets and settings until you reopen it.' }
  }
  if (block) {
    return { title: 'Pushing stops', body: 'The submission branch is locked. Students keep the repository and its tools; they cannot push, force-push or delete that branch.' }
  }
  if (readOnly) {
    return { title: 'The repository becomes read-only', body: 'Students lose write access. Work pushed before that still counts, as this assignment\'s "After the deadline" answer says.' }
  }
  return { title: 'Nothing is locked', body: 'This assignment\'s "After the deadline" answer is that nothing is locked: students can still push, and late commits are flagged in the report.' }
})

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
