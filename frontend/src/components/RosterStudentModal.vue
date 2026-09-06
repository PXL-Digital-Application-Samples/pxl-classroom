<template>
  <div class="modal-overlay" @click.self="close">
    <div
      class="modal"
      role="dialog"
      aria-modal="true"
      :aria-label="`Edit ${who}`"
      @keydown.escape="close"
    >
      <header class="modal-head">
        <h3>Edit {{ who }}</h3>
        <button class="modal-close" type="button" :disabled="saving" aria-label="Close" @click="close">×</button>
      </header>

      <section class="modal-section">
        <div class="field">
          <label for="rsm-number">Student number</label>
          <input id="rsm-number" v-model="form.student_number" class="form-control" placeholder="e.g. 0123456" />
        </div>
        <div class="field">
          <label for="rsm-name">Name</label>
          <input id="rsm-name" v-model="form.full_name" class="form-control" placeholder="e.g. Lowie Serneels" />
        </div>
        <div class="field">
          <label for="rsm-email">Email address</label>
          <input id="rsm-email" v-model="form.email" type="email" class="form-control" :placeholder="emailPlaceholder" />
          <!-- The address a claim is matched on, so a wrong one here is not a
               cosmetic mistake - it rejects that student at acceptance. Said
               where they are typing it rather than in a manual. -->
          <p class="form-hint">
            Assignments match students to accounts on this address. It is not checked for spelling.
          </p>
        </div>
        <div class="field">
          <label for="rsm-group">Class group</label>
          <input id="rsm-group" v-model="form.class_group" class="form-control" list="roster-class-groups" placeholder="e.g. 3A" />
        </div>

        <!-- What this dialog deliberately cannot change, and why. Leaving it
             out silently would send a lecturer hunting for it. -->
        <p class="form-hint rsm-account">
          GitHub account:
          <code v-if="student.github_login">@{{ student.github_login }}</code>
          <span v-else>not known yet</span>.
          Set when they accept an assignment or use a confirm-email link, never typed here.
        </p>
      </section>

      <footer class="modal-foot">
        <button class="btn btn-secondary" type="button" :disabled="saving" @click="close">Cancel</button>
        <button class="btn btn-primary" type="button" :disabled="saving || !changed" @click="save">
          {{ saving ? 'Saving…' : 'Save' }}
        </button>
      </footer>
    </div>
  </div>
</template>

<script setup>
// One roster row, four fields, one commit.
//
// The cells are still editable in place and that is still the fast way to fix a
// single value - including the one that opens pre-filled with an address read
// off a student's commits. This exists for the other case: a row promoted from
// an acceptance arrives with a login and nothing else, so identifying it means a
// number, a name and an address. Cell by cell that is three commits to
// roster.yml within seconds of each other, and GitHub's Contents API answered
// the second of those with a stale sha on PXL-Automation-II, refusing the write.
// One dialog is one commit.
//
// It also gave editing somewhere to be FOUND. Before this the only way in was
// clicking a "-" in an empty cell, which reads as punctuation rather than a
// control.
import { computed, reactive } from 'vue'
import { CLAIM_DOMAINS } from '../lib/deployment.js'

const props = defineProps({
  student: { type: Object, required: true },
  saving: { type: Boolean, default: false },
})
const emit = defineEmits(['save', 'close'])

const FIELDS = ['student_number', 'full_name', 'email', 'class_group']

// A local copy. Writing through to the row would edit the rendered roster
// before anything is committed, so Cancel would leave the table showing a
// change that never happened.
const form = reactive(Object.fromEntries(
  FIELDS.map((f) => [f, typeof props.student[f] === 'string' ? props.student[f] : '']),
))

const who = computed(() =>
  props.student.full_name
  || props.student.student_number
  || (props.student.github_login ? `@${props.student.github_login}` : 'this student'))

// The domain comes from deployment.yml, never a literal: a fork showing a PXL
// address in its own placeholder is what tests/institution-name exists to catch.
const emailPlaceholder = computed(() => `e.g. name@${CLAIM_DOMAINS[0] || 'example.edu'}`)

/** Save is disabled until something differs, so it cannot write an empty commit. */
const changed = computed(() =>
  FIELDS.some((f) => form[f].trim() !== (typeof props.student[f] === 'string' ? props.student[f].trim() : '')))

function save() {
  emit('save', { ...form })
}

function close() {
  if (!props.saving) emit('close')
}
</script>

<style scoped>
.rsm-account {
  margin-top: var(--space-md);
}
</style>
