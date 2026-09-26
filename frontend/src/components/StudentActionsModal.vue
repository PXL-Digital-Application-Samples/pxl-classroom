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

      <!-- HAND-INS, only under a hand-in cap. The numbers arrive decided
           (lib/hand-in-allowance.mjs, the grading summary): this dialog shows
           them and collects the lecturer's answer, the way the extension above
           leaves "later than the current deadline" to its module. -->
      <section v-if="handIns" class="modal-section" data-section="hand-ins">
        <h4>Hand-ins</h4>
        <p class="text-secondary">
          <template v-if="handIns.count">
            {{ handIns.count.used }} made on or before the deadline, of which
            {{ Math.min(handIns.count.used, handIns.count.allowed) }} count.
          </template>
          <template v-else>Not counted yet: the count appears once their score has been read.</template>
          The limit is {{ handIns.base }} for everyone<template v-if="handIns.extra">, plus {{ handIns.extra }} for
          {{ handIns.grantedTo && handIns.grantedTo !== ownLogin ? `their team (granted to @${handIns.grantedTo})` : 'this student' }}</template>.
        </p>
        <p v-if="handIns.allowance && handIns.allowance.extra > 0" class="text-secondary text-sm">
          +{{ handIns.allowance.extra }} granted by @{{ handIns.allowance.by }}
          on {{ formatDate(handIns.allowance.at) }}: "{{ handIns.allowance.reason }}"
        </p>
        <p v-else-if="handIns.allowance" class="text-secondary text-sm">
          An earlier grant was revoked by @{{ handIns.allowance.by }}
          on {{ formatDate(handIns.allowance.at) }}: "{{ handIns.allowance.reason }}"
        </p>

        <div class="field">
          <label for="hand-in-extra">Extra hand-ins for this student</label>
          <input id="hand-in-extra" v-model="hand.extra" type="number" min="1" max="50" step="1" class="hand-in-extra" />
          <small>On top of the limit of {{ handIns.base }}. This replaces any earlier grant rather than adding to it.</small>
        </div>
        <div class="field">
          <label for="hand-in-deadline">Also extend their deadline to (optional)</label>
          <input id="hand-in-deadline" v-model="hand.deadline_local" type="datetime-local" />
          <small>For a hand-in made after the deadline that should count too.</small>
        </div>
        <div class="field">
          <label for="hand-in-reason">Reason (recorded, and in the CSV export)</label>
          <textarea id="hand-in-reason" v-model="hand.reason" rows="2" placeholder="Lab environment crashed during the exam / approved by the program coordinator"></textarea>
        </div>
        <p v-if="hand.reason.trim() && handProblem" class="field-error-msg">{{ handProblem }}</p>
        <div class="hand-in-actions">
          <button
            class="btn"
            type="button"
            :disabled="busy || !!handProblem"
            @click="emit('grant-hand-ins', { extra: Number(hand.extra), reason: hand.reason.trim(), deadline_local: hand.deadline_local })"
          >
            {{ savingHandIns ? 'Saving…' : 'Allow extra hand-ins' }}
          </button>
          <button
            v-if="handIns.allowance && handIns.allowance.extra > 0"
            class="btn btn-danger-outline"
            type="button"
            :disabled="busy || !hand.reason.trim()"
            @click="emit('revoke-hand-ins', { reason: hand.reason.trim() })"
          >
            Revoke the extra hand-ins
          </button>
        </div>
        <p class="text-secondary text-sm">
          Their score is read again right away, so a hand-in that was over the limit can count.
          Revoking keeps any deadline extension.
        </p>
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
              <template v-if="unlock.permission">
                Their access was also reduced at the deadline, so this restores it to
                <code>{{ unlock.permission }}</code>.
              </template>
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
      <!-- GRADING: three actions that answer three different questions
           (2026-09-26). Read score again - the rules, unchanged. Re-grade a
           commit - YOU pick the commit (late, over the limit, before a
           mistake). Set score by hand - a score, no run. The last two are
           stored per student (lib/grade-override.mjs) and outrank the rules
           until removed; what is in force is said first. -->
      <section v-if="regrade" class="modal-section" data-section="grading">
        <h4>Grading</h4>
        <p class="text-secondary">
          <template v-if="grading && grading.current">
            Now <strong>{{ grading.current.earned_points }}/{{ grading.current.total_points }}</strong><template v-if="grading.current.graded_sha">,
              on commit <code class="mono">{{ grading.current.graded_sha.slice(0, 7) }}</code></template>.
          </template>
          <template v-else>No score has been read for this student yet.</template>
          <template v-if="!decision"> Graded by the rules.</template>
        </p>
        <p v-if="decision" class="text-secondary text-sm" data-decision>
          <template v-if="decision.kind === 'score'">
            Score <strong>{{ decision.earned }}/{{ decision.total }}</strong> set by hand
          </template>
          <template v-else>
            Graded on commit <code class="mono">{{ decision.sha.slice(0, 7) }}</code>, chosen
          </template>
          by @{{ decision.by }} on {{ formatDate(decision.at) }}: "{{ decision.reason }}"
        </p>

        <!-- Where there is nothing to read, the reason REPLACES the buttons
             (DESIGN.md §1.5): a disabled control explains nothing. A score by
             hand below still works - it reads nothing. -->
        <div v-if="regrade.can || student.repo_name" class="grading-actions">
          <button
            v-if="regrade.can"
            class="btn"
            type="button"
            :disabled="busy"
            @click="emit('regrade')"
          >{{ regrading ? 'Reading…' : 'Read score again' }}</button>
          <button
            v-if="student.repo_name"
            class="btn"
            type="button"
            :disabled="busy"
            @click="emit('choose-commit')"
          >Re-grade a commit…</button>
        </div>
        <p v-if="!regrade.can" class="text-secondary text-sm">{{ regrade.reason }}</p>
        <p v-else class="text-secondary text-sm">
          <strong>Read score again</strong> reads the grading run again<template v-if="!decision"> by the rules</template>
          <template v-else>, keeping your decision</template>; nothing in their repository changes.
          <template v-if="regrade.commitNote && !decision">{{ regrade.commitNote }}</template>
        </p>

        <details class="manual-score" :open="decision?.kind === 'score'">
          <summary>Set score by hand</summary>
          <div class="manual-score-fields">
            <label class="field">
              <span>Score</span>
              <input v-model="manual.earned" type="number" min="0" step="any" class="form-control manual-number" aria-label="Score" />
            </label>
            <label class="field">
              <span>out of</span>
              <input v-model="manual.total" type="number" min="0" step="any" class="form-control manual-number" aria-label="Out of" />
            </label>
          </div>
          <label class="field">
            <span>Reason (recorded with the score)</span>
            <textarea v-model="manual.reason" rows="2" placeholder="Oral defence / the grading run failed for a reason outside the student's control"></textarea>
          </label>
          <p v-if="manual.reason.trim() && manualProblem" class="form-hint text-danger">{{ manualProblem }}</p>
          <button
            class="btn"
            type="button"
            :disabled="busy || !!manualProblem"
            @click="emit('decide', { type: 'manual_score', value: { earned: Number(manual.earned), total: Number(manual.total) }, reason: manual.reason.trim() })"
          >Set score</button>
        </details>

        <!-- Undoing a decision is its own act with its own reason, recorded
             like the decision was. -->
        <div v-if="decision" class="field">
          <label>Reason for going back</label>
          <input v-model="undoReason" type="text" class="form-control" placeholder="Decided after the appeal" />
          <button
            class="btn-link"
            type="button"
            :disabled="busy || !undoReason.trim()"
            @click="emit('decide', { type: decision.kind === 'score' ? 'manual_score' : 'submission_sha', value: null, reason: undoReason.trim() })"
          >{{ decision.kind === 'score' ? 'Remove the score set by hand' : 'Go back to the rules' }}</button>
        </div>
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
import { allowanceProblem } from '../../../lib/hand-in-allowance.mjs'
import { decisionProblem } from '../../../lib/grade-override.mjs'

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
  /**
   * The hand-in limit for this student, already decided, or null when the
   * assignment has no cap (the section does not appear):
   * `{ base, extra, limit, grantedTo, allowance, count }` - `allowance` from
   * lib/hand-in-allowance.mjs (`extra: 0` is a revoked grant), `count` from
   * the grading summary (null until a score has been read).
   */
  handIns: { type: Object, default: null },
  savingHandIns: { type: Boolean, default: false },
  /**
   * What this student's grade is now and who decided it, already decided:
   * `{ current, decision, defaultTotal }` - `current` the grading summary row
   * (or null), `decision` from lib/grade-override.mjs (null = the rules).
   */
  grading: { type: Object, default: null },
  deciding: { type: Boolean, default: false },
})

const emit = defineEmits(['close', 'grant', 'retry', 'unlock', 'regrade', 'grant-hand-ins', 'revoke-hand-ins', 'choose-commit', 'decide'])

const decision = computed(() => props.grading?.decision || null)

// The score-by-hand form, seeded with the score in force or the total the
// assignment grades out of, so a lecturer edits rather than retypes.
const manual = reactive({
  earned: String(decision.value?.kind === 'score' ? decision.value.earned : (props.grading?.current?.earned_points ?? '')),
  total: String(decision.value?.kind === 'score' ? decision.value.total : (props.grading?.current?.total_points || props.grading?.defaultTotal || '')),
  reason: '',
})
// The module that refuses it decides, so the disabled button and the refusal agree.
const manualProblem = computed(() => decisionProblem({
  type: 'manual_score',
  value: { earned: manual.earned === '' ? NaN : Number(manual.earned), total: manual.total === '' ? NaN : Number(manual.total) },
  reason: manual.reason,
}))
const undoReason = ref('')

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

// The hand-in grant form, seeded with the grant in force so a lecturer edits
// it rather than retyping it. The number is what they will have, not an
// increment: the stored entry is the extra in force (lib/hand-in-allowance.mjs).
const hand = reactive({
  extra: String(props.handIns?.allowance?.extra > 0 ? props.handIns.allowance.extra : 1),
  deadline_local: '',
  reason: '',
})
// Asked of the module that judges it, so the disabled button and the refusal
// cannot disagree.
const handProblem = computed(() => allowanceProblem({ extra: hand.extra, reason: hand.reason }))
const ownLogin = computed(() => String(props.student.github_login || '').toLowerCase())

// A computed, not a function: the template binds `:disabled="busy"`, and a bare
// function reference there is an object - always truthy, so every control would
// render permanently disabled.
const busy = computed(
  () => props.extending || props.retrying || props.unlocking || props.regrading || props.savingHandIns || props.deciding,
)

function requestClose() {
  // Never close over work in flight: the run has been dispatched and the result
  // lands on this dialog.
  if (busy.value) return
  emit('close')
}
</script>

<style scoped>
.hand-in-extra {
  max-width: 10ch;
}
.grading-actions {
  display: flex;
  gap: var(--space-sm);
  flex-wrap: wrap;
}
.manual-score {
  margin-top: var(--space-sm);
}
.manual-score-fields {
  display: flex;
  gap: var(--space-sm);
  align-items: flex-end;
}
.manual-number {
  max-width: 10ch;
}

.hand-in-actions {
  display: flex;
  gap: var(--space-sm);
  flex-wrap: wrap;
}

/* Was an inline style on the anchor. A link styled as a button still needs its
   underline removed and its icon aligned. */
.archive-open-link {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  text-decoration: none;
}
</style>
