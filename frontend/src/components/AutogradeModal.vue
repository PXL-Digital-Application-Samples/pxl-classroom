<template>
  <div class="modal-overlay" @click.self="cancel">
    <div class="modal card autograde-setup-modal" role="dialog" aria-modal="true" aria-labelledby="autograde-title">
      <header class="modal-head flex justify-between items-center">
        <h3 id="autograde-title" class="flex items-center gap-sm">
          <Icon name="check-circle" :size="18" />
          <span>Automated checks</span>
        </h3>
        <button class="modal-close" type="button" @click="cancel" aria-label="Close">×</button>
      </header>

      <div class="modal-body flex flex-col gap-md">
        <!-- (1) What this does. Always visible, because "Enable autograding"
             told a lecturer nothing about what they were turning on. -->
        <p class="ag-lede">
          Run the same checks against every submission and record a score per student.
          Results appear in the assignment's report and in the CSV export.
        </p>

        <!-- (2) Where they run. The trade-off IS the decision, so it is two
             cards with the consequences on them, not a <select>. -->
        <fieldset class="ag-section">
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

        <!-- (3) Only a question when the checks are in the student's repo. -->
        <fieldset v-if="draft.execution_environment === 'github_actions'" class="ag-section">
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

        <!-- (4) The checks themselves. -->
        <fieldset class="ag-section">
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
          v-if="draft.tests.length"
          class="btn btn-danger-outline btn-sm"
          type="button"
          @click="removeAll"
        >Turn off automated checks</button>
        <span v-else></span>
        <span class="flex gap-sm">
          <button class="btn" type="button" @click="cancel">Cancel</button>
          <!-- DESIGN.md §1.2: a modal is its own view, so this is its one
               solid button. -->
          <button class="btn btn-primary" type="button" :disabled="!canSave" @click="save">Save checks</button>
        </span>
      </footer>
    </div>
  </div>
</template>

<script setup>
// UX_PLAN §6.2. The configuration used to live inline in the Guardrails
// fieldset as a row editor: an "Enable autograding" checkbox that opened a
// type dropdown, four unlabelled textareas whose meaning changed with the
// dropdown, and no headers, no totals and no validation until the schema
// rejected the save three commits later.
import { computed, onMounted, onUnmounted, reactive } from 'vue'
import Icon from './Icon.vue'
import { CHECK_PRESETS, newCheck, checkProblems, totalPoints } from '../lib/autograde.js'

const props = defineProps({
  // { execution_environment, visibility, tests }
  config: { type: Object, required: true },
})
const emit = defineEmits(['save', 'close'])

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
const canSave = computed(() => draft.tests.length > 0 && problems.value.every((p) => !p))

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
  emit('save', { enabled: false, execution_environment: draft.execution_environment, visibility: draft.visibility, tests: [] })
}

function save() {
  emit('save', {
    enabled: true,
    execution_environment: draft.execution_environment,
    visibility: draft.visibility,
    tests: draft.tests,
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
.ag-card-facts {
  margin: 0;
  font-size: 0.78rem;
  color: var(--text-secondary);
}
.ag-card-facts > div {
  display: flex;
  gap: 6px;
}
.ag-card-facts dt {
  font-weight: 600;
  min-width: 8ch;
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
