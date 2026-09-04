<template>
  <div class="modal-overlay" @click.self="cancel">
    <div class="modal card autograde-setup-modal" role="dialog" aria-modal="true" aria-labelledby="autograde-title">
      <header class="modal-head flex justify-between items-center">
        <h3 id="autograde-title" class="flex items-center gap-sm">
          <Icon name="check-circle" :size="18" />
          <span>Autograding</span>
        </h3>
        <button class="modal-close" type="button" @click="cancel" aria-label="Close">×</button>
      </header>

      <div class="modal-body flex flex-col gap-md">
        <!-- (1) What this does. Always visible, because "Enable autograding"
             told a lecturer nothing about what they were turning on. -->
        <p class="ag-lede">
          Run the same checks against every submission and record a score per student.
          Scores appear in the assignment's report and in the CSV export.
        </p>

        <!-- (2) WHO DEFINES THE CHECKS. One question, asked first, because
             "checks I define here" and "the workflow that came with my
             template" are two answers to it - and the form used to present
             them as unrelated features, so a cloud exam read "Off" beside a
             hand-in commit message.
             Not stored, and it does not need to be: checks on the assignment
             mean one, a hand-in message means the other. It is a route to the
             right controls, so it opens on the branch the assignment is
             already in - and on the TEMPLATE branch for an assignment that is
             in neither, because that is the answer every live course gives
             (OPEN-ITEMS §5). -->
        <fieldset class="ag-section">
          <legend>
            Who defines the checks?
            <HelpButton topic="autograding" label="who defines the checks" />
          </legend>
          <div class="ag-cards">
            <label
              v-for="s in SOURCES"
              :key="s.value"
              :class="['ag-card', { selected: draft.source === s.value }]"
            >
              <span class="ag-card-head">
                <input type="radio" :value="s.value" v-model="draft.source" name="ag-source" />
                <span class="ag-card-title">{{ s.title }}</span>
              </span>
              <span class="ag-card-what">{{ s.what }}</span>
            </label>
          </div>
        </fieldset>

        <!-- (2b) The template branch. The only thing there is to configure is
             WHEN that workflow grades, because everything else about it is in
             the template. -->
        <fieldset v-if="draft.source === 'template'" class="ag-section">
          <legend>When does that workflow grade?</legend>
          <label class="ag-choice">
            <input type="radio" value="every-push" v-model="draft.markerMode" name="ag-marker-mode" />
            <span>
              <strong>On every push.</strong> Nothing to set here. Scores are read from each
              student's last commit.
            </span>
          </label>
          <label class="ag-choice">
            <input type="radio" value="hand-in" v-model="draft.markerMode" name="ag-marker-mode" />
            <span>
              <strong>Only on a hand-in commit.</strong> For a workflow gated on one commit message.
            </span>
          </label>
          <!-- `for`/`id` rather than wrapping the input: a wrapping <label>
               makes the hint part of the field's accessible name, so a screen
               reader announces two sentences where the name should be two
               words. -->
          <div v-if="draft.markerMode === 'hand-in'" class="ag-marker">
            <label class="ag-marker-label" for="ag-marker-value">Commit message</label>
            <input id="ag-marker-value" v-model="draft.markerValue" maxlength="200" placeholder="einde examen" />
            <span class="ag-marker-hint">
              Matched exactly, as your workflow matches it.
            </span>

            <!-- Beside the message, because it is the same decision continued:
                 having said what a hand-in looks like, WHICH one counts is the
                 only thing left to say about it. Ticked by default - a student
                 who spots a mistake and hands in again has done what handing in
                 again is for. -->
            <label class="ag-marker-again">
              <input type="checkbox" v-model="draft.markerMultiple" />
              <span>They may hand in more than once</span>
            </label>
            <span class="ag-marker-hint">
              {{ draft.markerMultiple
                ? 'The last hand-in on or before the deadline counts, so handing in again replaces the one before it.'
                : 'The first hand-in counts. A later one does not replace it.' }}
              A hand-in after the deadline is never graded.
            </span>
          </div>

          <!-- WHETHER THE TEMPLATE ACTUALLY HAS ONE. Last, because the starter
               this offers to write is gated on the message above it, so the
               message has to exist before the button means anything.
               A status line and an inline button, not a panel: the modal is one
               box and the cards are the second, and a bordered well here would
               be DESIGN.md §1.1's third. -->
          <div class="ag-template-state">
            <span class="status-indicator">
              <span :class="['status-dot', templateDot]"></span>
              <span>{{ templateSays }}</span>
            </span>

            <!-- Only when we have LOOKED and found none. An unread template is
                 not an empty one (§1.5), so the button does not appear beside
                 "could not read" or beside "checking". -->
            <button
              v-if="template.state === 'absent'"
              class="btn btn-secondary btn-sm"
              type="button"
              :disabled="template.writing || (draft.markerMode === 'hand-in' && !draft.markerValue.trim())"
              @click="$emit('add-starter-workflow', { handInMessage: draft.markerMode === 'hand-in' ? draft.markerValue.trim() : '' })"
            >{{ template.writing ? 'Adding…' : 'Add a starter workflow' }}</button>

            <!-- The template's wording wins by being the one the runner
                 actually compares. Copying it into the assignment is a change
                 to THIS form; rewriting the lecturer's workflow is not offered,
                 because overwriting a file somebody wrote is not a repair. -->
            <button
              v-if="gateDisagrees"
              class="btn btn-secondary btn-sm"
              type="button"
              @click="draft.markerValue = template.gate"
            >Use the template's wording</button>
          </div>
          <p v-if="template.added" class="ag-marker-hint">
            Added to your template repository. Students who accepted before now keep their copy
            until you run Sync Starter Code on this assignment.
          </p>
        </fieldset>

        <!-- (3) What choosing the less-travelled branch actually commits you
             to. The cards say what each answer is FOR; this says what happens
             next, because "I define them here" is three more questions and a
             table, and a lecturer who picked it by accident should be able to
             tell before filling any of it in. -->
        <p v-if="draft.source === 'here'" class="ag-lede">
          You list the checks below. They run either in each student's repository or on your
          machine, which is the next question. Only this answer can keep the checks out of the
          student's repository, and only it gives a score per check.
        </p>

        <!-- (4) Where they run. The trade-off IS the decision, so it is two
             cards with the consequences on them, not a <select>. -->
        <fieldset v-if="draft.source === 'here'" class="ag-section">
          <legend>Where do they run?</legend>
          <div class="ag-cards">
            <label
              v-for="place in PLACES"
              :key="place.value"
              :class="['ag-card', { selected: draft.execution_environment === place.value }]"
            >
              <span class="ag-card-head">
                <input type="radio" :value="place.value" v-model="draft.execution_environment" name="ag-where" />
                <span class="ag-card-title">{{ place.title }}</span>
              </span>
              <span class="ag-card-what">{{ place.what }}</span>
              <dl class="ag-card-facts">
                <div><dt>Cost</dt><dd>{{ place.cost }}</dd></div>
                <div><dt>Students see</dt><dd>{{ place.students }}</dd></div>
                <div><dt>Checks are</dt><dd>{{ place.tests }}</dd></div>
              </dl>
            </label>
          </div>
        </fieldset>

        <!-- (5) Only a question when the checks are in the student's repo. -->
        <fieldset v-if="draft.source === 'here' && draft.execution_environment === 'github_actions'" class="ag-section">
          <legend>Can students read the checks?</legend>
          <label class="ag-choice">
            <input type="radio" value="public" v-model="draft.visibility" name="ag-visibility" />
            <span>
              <strong>Yes</strong> - the checks are committed to each student's repository.
              Simplest, and students can run them locally.
            </span>
          </label>
          <label class="ag-choice">
            <input type="radio" value="private" v-model="draft.visibility" name="ag-visibility" />
            <span>
              <strong>No</strong> - the checks stay in the control repository and run from there.
            </span>
          </label>
        </fieldset>

        <!-- (6) The checks themselves. -->
        <fieldset v-if="draft.source === 'here'" class="ag-section">
          <legend>
            The checks
            <span v-if="draft.tests.length" class="ag-total">{{ total }} points total</span>
          </legend>

          <p v-if="!draft.tests.length" class="ag-none text-secondary">
            No checks yet. Add one below - each comes pre-filled with a working example you can edit.
          </p>

          <table v-else class="ag-table">
            <thead>
              <tr>
                <th scope="col">ID</th>
                <th scope="col">What it does</th>
                <th scope="col">{{ hasPython ? 'Command / script' : 'Command' }}</th>
                <th scope="col" class="ag-num">Points</th>
                <th scope="col"><span class="sr-only">Remove</span></th>
              </tr>
            </thead>
            <tbody>
              <template v-for="(t, i) in draft.tests" :key="i">
                <tr :class="{ 'ag-row-bad': problems[i] }">
                  <td>
                    <input v-model="t.id" class="ag-id" :aria-label="`Check ${i + 1} ID`" />
                  </td>
                  <td class="text-secondary">{{ describe(t) }}</td>
                  <td>
                    <textarea
                      v-if="t.type === 'python'"
                      v-model="t.script"
                      rows="3"
                      :aria-label="`Check ${i + 1} Python script`"
                    ></textarea>
                    <input v-else v-model="t.command" :aria-label="`Check ${i + 1} command`" />
                  </td>
                  <td class="ag-num">
                    <input v-model.number="t.points" type="number" min="0" class="ag-points" :aria-label="`Check ${i + 1} points`" />
                  </td>
                  <td>
                    <button
                      class="btn btn-ghost btn-icon"
                      type="button"
                      @click="draft.tests.splice(i, 1)"
                      :aria-label="`Remove check ${t.id || i + 1}`"
                    >
                      <Icon name="x" :size="13" />
                    </button>
                  </td>
                </tr>
                <!-- Type-specific fields under the row they belong to, labelled. -->
                <tr v-if="t.type === 'io'" class="ag-sub">
                  <td></td>
                  <td colspan="4">
                    <label class="ag-sub-field">
                      <span>Input (stdin)</span>
                      <textarea v-model="t.stdin" rows="2" :aria-label="`Check ${i + 1} stdin`"></textarea>
                    </label>
                    <label class="ag-sub-field">
                      <span>Expected output</span>
                      <textarea v-model="t.expected_stdout" rows="2" :aria-label="`Check ${i + 1} expected output`"></textarea>
                    </label>
                  </td>
                </tr>
                <tr v-if="problems[i]" class="ag-sub">
                  <td></td>
                  <td colspan="4" class="field-error-msg">{{ problems[i] }}</td>
                </tr>
              </template>
            </tbody>
          </table>

          <div class="ag-add">
            <span class="ag-add-label">Add a check:</span>
            <button
              v-for="preset in CHECK_PRESETS"
              :key="preset.key"
              class="btn btn-secondary btn-sm"
              type="button"
              :title="preset.hint"
              @click="add(preset.key)"
            >{{ preset.label }}</button>
          </div>
        </fieldset>
      </div>

      <footer class="modal-foot flex justify-between items-center gap-sm">
        <button
          v-if="draft.source === 'here' && draft.tests.length"
          class="btn btn-danger-outline btn-sm"
          type="button"
          @click="removeAll"
        >Turn off automated checks</button>
        <span v-else></span>
        <span class="flex gap-sm">
          <button class="btn" type="button" @click="cancel">Cancel</button>
          <!-- DESIGN.md §1.2: a modal is its own view, so this is its one
               solid button. The label follows the branch: "Save checks" over
               the template branch would name something this screen did not
               collect. -->
          <button class="btn btn-primary" type="button" :disabled="!canSave" @click="save">
            {{ draft.source === 'here' ? 'Save checks' : 'Save' }}
          </button>
        </span>
      </footer>
    </div>
  </div>
</template>

<script setup>
// ARCHITECTURE §11.6. The configuration used to live inline in the Guardrails
// fieldset as a row editor: an "Enable autograding" checkbox that opened a
// type dropdown, four unlabelled textareas whose meaning changed with the
// dropdown, and no headers, no totals and no validation until the schema
// rejected the save three commits later.
import { computed, onMounted, onUnmounted, reactive, watch } from 'vue'
import Icon from './Icon.vue'
import HelpButton from './HelpButton.vue'
import { CHECK_PRESETS, newCheck, checkProblems, totalPoints } from '../lib/autograde.js'

const props = defineProps({
  // { execution_environment, visibility, tests }
  config: { type: Object, required: true },
  // The assignment's hand-in commit message, '' for none. A STRING, not the
  // stored object: `lib/submission-marker.mjs` owns what a marker means and
  // what matches one, and a dialog that re-derived either would be the second
  // implementation that module exists to prevent (DESIGN.md §6).
  submissionMarker: { type: String, default: '' },
  /** May a student hand in more than once? The assignment's answer, defaulting
   *  the way `readSubmissionMarker` defaults an absent field. */
  submissionMarkerMultiple: { type: Boolean, default: true },
  /**
   * What the parent found in the template repository, and nothing this dialog
   * worked out for itself. AdminView holds the token and does the reading and
   * the writing; this collects the decision and shows the answer, the way
   * `FreezeConfirmModal` takes the archive name rather than composing it
   * (DESIGN.md §6).
   *
   * `{ state: 'unknown'|'checking'|'absent'|'present'|'error', repo, path,
   *    gate, writing, added, error }`
   */
  template: {
    type: Object,
    default: () => ({ state: 'unknown' }),
  },
})
const emit = defineEmits(['save', 'close', 'check-template', 'add-starter-workflow'])

// The TEMPLATE card is first and is the default, and that is a statement about
// which one lecturers actually use. Every assignment across every participating
// organization is graded by a workflow that came with its template - a GitHub
// Classroom `classroom.yml`, which is where these courses come from. Not one
// has ever defined checks in this panel. Offering the unused answer first, with
// a table of empty rows behind it, described the system backwards.
const SOURCES = [
  {
    value: 'template',
    title: 'They come with my template',
    what: 'Your template repository ships its own workflow - a GitHub Classroom classroom.yml, or anything like it. PXL Classroom leaves it alone and reads the score it produces.',
  },
  {
    value: 'here',
    title: 'I define them here',
    what: 'For checks students must not see, or grading you run yourself after the deadline. Choose this when your template does not grade itself.',
  },
]

const PLACES = [
  {
    value: 'lecturer_local',
    title: 'On your machine',
    what: 'You run pxl-classroom grade after the deadline.',
    cost: 'No Actions minutes.',
    students: 'Results when you publish them.',
    tests: 'Never in the student repo.',
  },
  {
    value: 'github_actions',
    title: "In each student's repo",
    what: 'GitHub Actions runs them on every push.',
    cost: "Uses the organization's Actions minutes.",
    students: 'A pass/fail on every push.',
    tests: 'In the repo, unless hidden.',
  },
]

// A copy: Cancel has to leave the assignment exactly as it was, and the rows
// are edited in place.
const draft = reactive({
  // Which branch the assignment is already in. A hand-in message is the only
  // evidence a template workflow is in charge, and checks outrank it: an
  // assignment carrying both is one somebody configured here.
  // Checks on the assignment are the only reason to open on "here"; everything
  // else - a hand-in message, or nothing configured at all - opens on the
  // template branch, which is what these courses actually do.
  source: (props.config.tests || []).length ? 'here' : 'template',
  markerMode: props.submissionMarker ? 'hand-in' : 'every-push',
  markerValue: props.submissionMarker || '',
  markerMultiple: props.submissionMarkerMultiple !== false,
  execution_environment: props.config.execution_environment || 'lecturer_local',
  visibility: props.config.visibility || 'private',
  // A whole-object copy, not a field list: `timeout_s` has no control here and
  // must still survive an edit. Rebuilding a record from the fields a form
  // happens to show is how buildDoc used to delete invitation tokens.
  tests: JSON.parse(JSON.stringify(props.config.tests || [])),
})

const problems = computed(() => checkProblems(draft.tests))
const total = computed(() => totalPoints(draft.tests))
const hasPython = computed(() => draft.tests.some((t) => t.type === 'python'))
// Zero checks is not a saveable state - `tests` has minItems: 1, and an
// enabled-but-empty configuration is a promise the system cannot keep. Turning
// it off is the other button.
//
// The template branch saves a message or nothing: "on every push" is the
// absence of a marker, and saving it clears one. An empty hand-in message is
// refused rather than stored, because a blank marker would match a commit with
// an empty message.
const canSave = computed(() => {
  if (draft.source === 'template') {
    return draft.markerMode !== 'hand-in' || !!draft.markerValue.trim()
  }
  return draft.tests.length > 0 && problems.value.every((p) => !p)
})

// The template's gate and the assignment's message are the SAME FACT in two
// files, and nothing makes them agree. A disagreement is silent where it
// matters most - the workflow runs on its own wording, this reads scores from
// the other, and every student comes back "no grading run" - so it is said out
// loud rather than left to be discovered on results day.
const gateDisagrees = computed(
  () =>
    props.template.state === 'present' &&
    !!props.template.gate &&
    draft.markerMode === 'hand-in' &&
    !!draft.markerValue.trim() &&
    props.template.gate !== draft.markerValue.trim(),
)

const templateDot = computed(() => {
  if (gateDisagrees.value) return 'dot-warning'
  switch (props.template.state) {
    case 'present':
      return 'dot-success'
    case 'absent':
      return 'dot-warning'
    case 'error':
      // NOT danger: a template we could not read is unknown, and unknown is
      // not a failure of the assignment (DESIGN.md §4).
      return 'dot-neutral'
    default:
      return 'dot-neutral'
  }
})

/**
 * One sentence about the template repository, and never more than was read.
 *
 * "No grading workflow" is a claim, and a read that failed does not support it
 * - the same rule that stops a 403 being reported as "no score".
 */
const templateSays = computed(() => {
  const t = props.template
  if (t.state === 'checking') return 'Looking at your template repository…'
  if (t.state === 'error') {
    return `Could not read ${t.repo || 'your template repository'}, so what it grades is unknown.`
  }
  if (t.state === 'absent') return `No grading workflow in ${t.repo}.`
  if (t.state === 'present') {
    if (gateDisagrees.value) {
      return `${t.path} grades on "${t.gate}", and this assignment says "${draft.markerValue.trim()}".`
    }
    if (t.gate) return `${t.path} grades on "${t.gate}".`
    return `${t.path} grades on every push.`
  }
  return 'Pick a template repository first, and this will say what it grades.'
})

function describe(t) {
  if (t.type === 'io') return 'Input → expected output'
  if (t.type === 'python') return 'Python script'
  return 'Command must succeed'
}

function add(presetKey) {
  const check = newCheck(presetKey, draft.tests)
  if (check) draft.tests.push(check)
}

function removeAll() {
  emit('save', {
    enabled: false,
    execution_environment: draft.execution_environment,
    visibility: draft.visibility,
    tests: [],
    submissionMarker: '',
    submissionMarkerMultiple: true,
  })
}

function save() {
  // The two branches are exclusive, and each save says so for BOTH halves.
  // Leaving the other half alone would keep a hand-in message on an assignment
  // whose lecturer has just moved the checks in here - a stored value the
  // summary line no longer mentions, which is how a setting becomes invisible.
  if (draft.source === 'template') {
    emit('save', {
      enabled: false,
      execution_environment: draft.execution_environment,
      visibility: draft.visibility,
      tests: [],
      submissionMarker: draft.markerMode === 'hand-in' ? draft.markerValue.trim() : '',
      submissionMarkerMultiple: draft.markerMultiple,
    })
    return
  }
  emit('save', {
    enabled: true,
    execution_environment: draft.execution_environment,
    visibility: draft.visibility,
    tests: draft.tests,
    submissionMarker: '',
    submissionMarkerMultiple: true,
  })
}

// Closing without saving keeps whatever the assignment already had - including
// nothing.
function cancel() {
  emit('close')
}

// Escape closes it, as it does every other modal in the app (SeedTeamsModal).
// A dialog you can only leave by finding the right button is a trap.
function onKeydown(e) {
  if (e.key === 'Escape') cancel()
}
// Ask what the template holds as soon as the branch that cares is on screen -
// including on open, because the modal opens on that branch. The parent decides
// whether that costs a request.
watch(
  () => draft.source,
  (source) => {
    if (source === 'template') emit('check-template')
  },
  { immediate: true },
)

onMounted(() => window.addEventListener('keydown', onKeydown))
onUnmounted(() => window.removeEventListener('keydown', onKeydown))
</script>

<style scoped>
.autograde-setup-modal {
  max-width: 760px;
  width: 100%;
}
.ag-lede {
  margin: 0;
  color: var(--text-secondary);
}
.ag-section {
  border: 0;
  margin: 0;
  padding: 0;
}
.ag-section legend {
  font-weight: 600;
  font-size: 0.9rem;
  padding: 0;
  margin-bottom: var(--space-xs);
}
.ag-total {
  font-weight: 400;
  font-size: 0.8rem;
  color: var(--text-secondary);
  margin-left: var(--space-xs);
}

/* Two cards, tonal rather than outlined: the modal is already a box and its
   sections must not become a second and third one (DESIGN.md §1.1). Selection
   shows as a ring, which is the state that needs to be obvious. */
.ag-cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: var(--space-sm);
}
.ag-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: var(--space-sm);
  border-radius: var(--radius-md);
  background: var(--bg-inset);
  border: 1px solid transparent;
  cursor: pointer;
}
.ag-card.selected {
  border-color: var(--border-strong);
  box-shadow: var(--ring-focus);
}
.ag-card-head {
  display: flex;
  align-items: center;
  gap: 6px;
}
.ag-card-title {
  font-weight: 600;
}
.ag-card-what {
  font-size: 0.82rem;
  color: var(--text-secondary);
}
/* ONE grid for the whole list, so every value starts at the same x.
   It was a flex row per pair with `min-width: 8ch` on the term - which pads
   "Cost" out to eight characters and does nothing at all for "Students see",
   so the three values landed at three different offsets and the short label
   looked like it had a hole punched after it. `display: contents` drops the
   per-pair wrapper out of the box tree and lets the terms share one column,
   measured from the longest of them. */
.ag-card-facts {
  margin: 0;
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  column-gap: 10px;
  row-gap: 3px;
  font-size: 0.78rem;
  color: var(--text-secondary);
}
.ag-card-facts > div {
  display: contents;
}
.ag-card-facts dt {
  font-weight: 600;
}
.ag-card-facts dd {
  margin: 0;
}

.ag-choice {
  display: flex;
  gap: 6px;
  align-items: flex-start;
  padding: 4px 0;
  font-size: 0.85rem;
  cursor: pointer;
}

/* The hand-in message, indented under the radio that reveals it so it reads as
   that answer's detail rather than as a third question. No box: `.ag-section`
   carries none either, and a bordered panel inside the modal's own card would
   be DESIGN.md §1.1's third box. */
.ag-marker {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 4px 0 4px 22px;
  font-size: 0.85rem;
}

.ag-marker-label {
  font-weight: 600;
}

.ag-marker input {
  max-width: 320px;
}

.ag-marker-hint {
  color: var(--text-secondary);
}

/* A line, not a panel. `.status-indicator` and `.status-dot` are the global
   vocabulary for a state (DESIGN.md §4), so this only has to place them. */
.ag-template-state {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  padding-top: 8px;
  font-size: 0.85rem;
}

.ag-marker-again {
  display: flex;
  gap: 6px;
  align-items: center;
  padding-top: 4px;
  cursor: pointer;
}

.ag-none {
  font-size: 0.85rem;
  margin: 0 0 var(--space-sm) 0;
}
.ag-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.85rem;
}
.ag-table th {
  text-align: left;
  font-size: 0.75rem;
  text-transform: none;
  color: var(--text-secondary);
  padding: 0 6px 4px 6px;
  border-bottom: 1px solid var(--border-muted);
}
.ag-table td {
  padding: 6px;
  vertical-align: top;
}
.ag-table tr.ag-row-bad td {
  background: var(--tint-danger-subtle);
}
.ag-table input,
.ag-table textarea {
  width: 100%;
  font-family: var(--font-mono);
  font-size: 0.8rem;
}
.ag-id {
  min-width: 9ch;
}
.ag-num {
  text-align: right;
  width: 7ch;
}
.ag-points {
  text-align: right;
}
.ag-sub td {
  padding-top: 0;
}
.ag-sub-field {
  display: block;
  margin-bottom: var(--space-xs);
}
.ag-sub-field span {
  display: block;
  font-size: 0.75rem;
  color: var(--text-secondary);
  margin-bottom: 2px;
}
.ag-add {
  display: flex;
  align-items: center;
  gap: var(--space-xs);
  flex-wrap: wrap;
  margin-top: var(--space-sm);
}
.ag-add-label {
  font-size: 0.8rem;
  color: var(--text-secondary);
}
</style>
