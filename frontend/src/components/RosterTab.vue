<template>
  <section class="roster-tab">
    <div class="roster-header">
      <h3>Roster - {{ org }}</h3>
      <p class="text-secondary">
        Import or update <code>students/roster.yml</code> in <code>{{ org }}/{{ controlRepo }}</code>.
        Drop a CSV (header row required) or paste below. The diff is previewed before commit.
      </p>
    </div>

    <div class="roster-grid">
      <!-- INPUT -->
      <div
        :class="['input-pane', { dragging }]"
        @dragover.prevent="dragging = true"
        @dragleave="dragging = false"
        @drop.prevent="onDrop"
      >
        <div class="field">
          <label>Upload CSV</label>
          <input type="file" accept=".csv,text/csv" @change="onFileChange" />
          <small>
            Required columns: <code>student_number</code>, <code>full_name</code>. Optional: <code>email</code>, <code>class_group</code>, <code>github_login</code>, <code>github_id</code>, <code>active</code>, <code>team_slug</code>, <code>team_name</code>.
            <button class="btn-link" type="button" @click="downloadSampleCsv">Download sample CSV</button>
          </small>
        </div>

        <div class="field">
          <label>or paste CSV</label>
          <textarea
            v-model="csvText"
            rows="10"
            placeholder="student_number,full_name,email,class_group,github_login,team_slug,team_name&#10;0123456,Alice Example,alice@student.pxl.be,3A,alice-test,team-alpha,Alpha Team"
            @input="onCsvInput"
          ></textarea>
        </div>

        <div v-if="parseError" class="validation-errors">
          <strong>Parse error:</strong>
          <p>{{ parseError }}</p>
        </div>

        <div v-if="validationErrors.length" class="validation-errors">
          <strong>Schema validation failed:</strong>
          <ul>
            <li v-for="(e, i) in validationErrors" :key="i">{{ e }}</li>
          </ul>
        </div>
      </div>

      <!-- DIFF + COMMIT -->
      <div class="diff-pane">
        <div v-if="!parsedRoster && !existingRoster" class="empty-state">
          <h4>Drop a CSV to start</h4>
          <p>If no roster exists yet, the file will be created.</p>
        </div>
        <div v-else-if="!parsedRoster && existingRoster" class="existing-summary">
          <div class="roster-overview-header flex justify-between items-center w-full">
            <div>
              <h4 style="margin: 0 0 var(--space-xs) 0;">Committed Roster</h4>
              <p class="text-secondary text-sm" style="margin: 0;">
                <strong>{{ existingRoster.students?.length || 0 }}</strong> enrolled student(s) in <code>{{ org }}/{{ controlRepo }}</code><template
                  v-if="autoLinkedCount > 0"
                >, <strong>{{ autoLinkedCount }}</strong> linked to a GitHub account</template>.
              </p>
            </div>
            <div class="flex gap-xs flex-wrap">
              <button class="btn btn-sm btn-primary" type="button" @click="openQuickAddModal">
                + Add student
              </button>
              <button
                class="btn btn-sm btn-secondary"
                type="button"
                :disabled="unlinkedStudents.length === 0"
                @click="copyUnlinkedEmails"
                :title="unlinkedStudents.length === 0 ? 'All students are linked' : `Copy ${unlinkedStudents.length} unlinked email(s)`"
              >
                Copy unlinked emails ({{ unlinkedStudents.length }})
              </button>
              <button class="btn btn-sm btn-secondary" type="button" @click="exportRosterCsv">Export CSV</button>

              <!-- Adding the students who accepted an assignment writes THIS
                   file, so the action lives here as well as on the assignment
                   that prompts it. It is per-assignment and the roster is
                   org-wide, so it asks which first rather than guessing.
                   Absent entirely when there is no open assignment to add
                   from - under `enforced` and `claim` everyone who accepted was
                   already on the roster, so there would be nobody to add. -->
              <!-- Its own anchor rather than AssignmentDetailView's
                   `.dropdown-container`, which is scoped there and would render
                   this unstyled (DESIGN.md §7). One line of positioning is not
                   shared vocabulary worth moving to style.css for. -->
              <div v-if="promotableAssignments.length > 0" class="promote-picker-anchor" ref="promotePickerRef">
                <button
                  class="btn btn-sm btn-secondary"
                  type="button"
                  :aria-expanded="promotePickerOpen"
                  aria-haspopup="true"
                  @click.stop="promotePickerOpen = !promotePickerOpen"
                >Add students who accepted</button>

                <div v-if="promotePickerOpen" class="promote-picker" role="menu">
                  <p class="promote-picker-head">From which assignment?</p>
                  <button
                    v-for="a in promotableAssignments"
                    :key="a.id"
                    class="promote-picker-item"
                    type="button"
                    role="menuitem"
                    @click="pickPromotionSource(a)"
                  >
                    <span class="promote-picker-title">{{ a.title || a.id }}</span>
                    <span class="promote-picker-sub">{{ a.id }}</span>
                  </button>
                </div>
              </div>
            </div>
          </div>

          <!-- WHAT THE NIGHTLY COULD NOT DECIDE.
               Verified claims link themselves overnight. These three kinds do
               not, because each is a decision: an address the student typed
               rather than confirmed, a claim naming a different account than
               the row already holds, and an address two accounts claim. They
               used to exist only in the workflow log, which is not where a
               lecturer looks. Only rendered when there is something to decide -
               an empty review box is a chore that is never finished. -->
          <div v-if="heldClaims.length > 0" class="claim-review w-full">
            <div class="claim-review-head flex items-center gap-xs">
              <span class="status-dot dot-warning"></span>
              <strong>{{ heldClaims.length }} need{{ heldClaims.length === 1 ? 's' : '' }} your decision</strong>
              <span class="text-secondary text-sm">
                — everything else linked automatically
              </span>
            </div>
            <ul class="claim-review-list">
              <li v-for="row in heldClaims" :key="row.key" class="claim-review-row">
                <span class="claim-review-who">
                  <code>{{ row.email }}</code>
                  <span v-if="row.full_name" class="text-secondary"> · {{ row.full_name }}</span>
                </span>
                <span class="claim-review-why text-secondary text-sm">
                  <template v-if="row.login">@{{ row.login }} — </template>{{ row.reason }}
                </span>
                <button
                  v-if="row.canLink"
                  class="btn btn-sm btn-secondary"
                  type="button"
                  :disabled="linkingEmail === row.email"
                  :title="`Accept this address and link it to @${row.login}`"
                  @click="linkAnyway(row)"
                >{{ linkingEmail === row.email ? 'Linking…' : 'Link anyway' }}</button>
                <!-- No button where one click cannot settle it: a conflict needs
                     the account in the way unlinked first (the row below), and
                     an address two accounts claim needs one of them removed.
                     Offering a control that would refuse is worse than none. -->
                <span v-else class="text-muted text-sm claim-review-hint">Unlink below to resolve</span>
              </li>
            </ul>
          </div>

          <!-- Roster Filter Chips -->
          <div class="roster-filter-chips flex gap-xs items-center w-full">
            <button
              :class="['chip-btn', { active: rosterFilter === 'all' }]"
              type="button"
              @click="rosterFilter = 'all'"
            >
              All ({{ existingRoster.students?.length || 0 }})
            </button>
            <button
              :class="['chip-btn', { active: rosterFilter === 'linked' }]"
              type="button"
              @click="rosterFilter = 'linked'"
            >
              Linked ({{ linkedStudents.length }})
            </button>
            <button
              :class="['chip-btn', { active: rosterFilter === 'unlinked' }]"
              type="button"
              @click="rosterFilter = 'unlinked'"
            >
              Unlinked / Pending ({{ unlinkedStudents.length }})
            </button>
          </div>

          <!-- Student List Table -->
          <div class="roster-table-wrapper w-full">
            <table class="roster-table w-full text-left text-sm" style="border-collapse: collapse;">
              <thead>
                <tr style="border-bottom: 1px solid var(--border-default); color: var(--text-secondary);">
                  <th style="padding: 6px 8px;">Number</th>
                  <th style="padding: 6px 8px;">Name</th>
                  <th style="padding: 6px 8px;">Email</th>
                  <th style="padding: 6px 8px;">Group</th>
                  <th style="padding: 6px 8px;">GitHub Account</th>
                  <th style="padding: 6px 8px;"></th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="s in filteredRosterStudents"
                  :key="rosterKey(s)"
                  style="border-bottom: 1px solid var(--border-default);"
                >
                  <td style="padding: 6px 8px;"><code>{{ s.student_number || '-' }}</code></td>
                  <td style="padding: 6px 8px; font-weight: 500;">
                    <span v-if="s.full_name">{{ s.full_name }}</span>
                    <span v-else class="text-muted">Not yet identified</span>
                  </td>
                  <td style="padding: 6px 8px; color: var(--text-secondary);">{{ s.email || '-' }}</td>
                  <td style="padding: 6px 8px; color: var(--text-muted);">{{ s.class_group || '-' }}</td>
                  <!-- The account this student can actually accept with.
                       `github_login` alone was the whole answer under
                       `enforced`; under `claim` the binding lives in
                       students/claims/<github_id>.json and the roster column is
                       often deliberately empty, so a badge reading "Pending
                       linking" over a student who claimed an hour ago is the
                       opposite of the truth. -->
                  <td style="padding: 6px 8px;">
                    <span
                      v-if="bindingFor(s).state === 'claimed'"
                      class="badge badge-success mono"
                      :title="`Claimed ${bindingFor(s).claim.email}${bindingFor(s).verified ? ', verified by GitHub' : ', address typed by the student'}`"
                    >@{{ bindingFor(s).login }}</span>
                    <span
                      v-else-if="bindingFor(s).state === 'conflict'"
                      class="badge badge-warning mono"
                      :title="`Claimed by @${bindingFor(s).login}, but the roster names @${bindingFor(s).rosterLogin}. One of the two is wrong.`"
                    >@{{ bindingFor(s).login }} &ne; roster</span>
                    <span v-else-if="bindingFor(s).state === 'roster'" class="badge badge-success mono">@{{ bindingFor(s).login }}</span>
                    <span
                      v-else-if="bindingFor(s).state === 'unclaimable'"
                      class="badge badge-neutral text-xs"
                      title="No email on this roster entry, so it can never be claimed. Re-import with an address."
                    >No address</span>
                    <!-- One label, deliberately mode-neutral. This tab is
                         ORG-scoped and an org can hold `enforced` and `claim`
                         assignments at once, so it cannot know which mechanism
                         a given student is waiting on. An earlier version chose
                         the wording from whether the org had any claims at all,
                         which meant unlinking the last student silently
                         relabelled every other row. -->
                    <span v-else class="badge badge-neutral text-xs">Pending linking</span>
                    <span
                      v-if="bindingFor(s).state === 'claimed' && !bindingFor(s).verified"
                      class="text-xs text-muted"
                      style="margin-left: 4px;"
                      title="The student typed this address rather than confirming one GitHub had already verified."
                    >unverified</span>
                  </td>
                  <td style="padding: 6px 8px; text-align: right;">
                    <!-- Unlink ships WITH the feature, deliberately: a wrong
                         binding a lecturer cannot undo is the mistake GitHub
                         Classroom made. -->
                    <button
                      v-if="bindingFor(s).claim"
                      class="btn btn-sm btn-danger-outline"
                      type="button"
                      :disabled="unlinking"
                      :title="`Remove the binding so this student can claim again`"
                      @click="confirmUnlink(s, bindingFor(s))"
                    >Unlink</button>
                  </td>
                </tr>
                <tr v-if="filteredRosterStudents.length === 0">
                  <td colspan="7" class="text-center text-muted" style="padding: 16px;">
                    No students match the current filter.
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
        <div v-else>
          <h4>Diff vs. committed roster</h4>
          <div v-if="!existingRoster" class="diff-info">
            No existing <code>students/roster.yml</code> in <code>{{ org }}/{{ controlRepo }}</code>. This will create one.
          </div>

          <div class="diff-summary">
            <span class="diff-badge added">+ {{ diff.added.length }} added</span>
            <span class="diff-badge updated">~ {{ diff.updated.length }} updated</span>
            <span class="diff-badge removed">- {{ diff.removed.length }} removed</span>
          </div>

          <details v-if="diff.added.length" open>
            <summary>Added ({{ diff.added.length }})</summary>
            <ul>
              <li v-for="s in diff.added" :key="rosterKey(s)">
                {{ describeRosterEntry(s) }}
                <span v-if="s.class_group"> · {{ s.class_group }}</span>
              </li>
            </ul>
          </details>

          <details v-if="diff.updated.length">
            <summary>Updated ({{ diff.updated.length }})</summary>
            <ul>
              <li v-for="u in diff.updated" :key="rosterKey(u.after)">
                {{ describeRosterEntry(u.after) }}
                <span class="changed-fields">[{{ changedFields(u).join(', ') }}]</span>
              </li>
            </ul>
          </details>

          <!-- Removed is the destructive part of the diff - always expanded. -->
          <details v-if="diff.removed.length" open>
            <summary>Removed ({{ diff.removed.length }})</summary>
            <ul>
              <li v-for="s in diff.removed" :key="rosterKey(s)">
                {{ describeRosterEntry(s) }}
              </li>
            </ul>
          </details>

          <div v-if="diff.added.length + diff.updated.length + diff.removed.length === 0" class="diff-empty">
            Roster matches what's already committed. Nothing to do.
          </div>

          <div class="actions">
            <button
              class="btn btn-primary"
              type="button"
              :disabled="!canCommit || committing"
              @click="commitRoster"
            >
              {{ committing ? 'Committing…' : 'Commit roster' }}
            </button>
          </div>
        </div>

        <div v-if="loadingExisting" class="loading-inline">
          <div class="spinner sm"></div> Loading committed roster…
        </div>
      </div>
    </div>

    <!-- Modal: Quick Add Student (2.A) -->
    <div v-if="showQuickAddModal" class="modal-overlay" @click.self="showQuickAddModal = false">
      <div class="modal card" style="max-width: 500px;">
        <header class="modal-head flex justify-between items-center">
          <h3 style="margin: 0;">Add Student to Roster</h3>
          <button class="modal-close" type="button" @click="showQuickAddModal = false" aria-label="Close">×</button>
        </header>
        <form @submit.prevent="submitQuickAddStudent" class="modal-body flex flex-col gap-md" style="padding: var(--space-md);">
          <div v-if="quickAddError" class="validation-errors" style="margin-bottom: 0;">
            <p style="margin: 0;">{{ quickAddError }}</p>
          </div>

          <div class="field" style="margin-bottom: 0;">
            <label>Student Number <span class="req" style="color: var(--accent-red);">*</span></label>
            <input
              v-model="quickAddForm.student_number"
              type="text"
              class="form-control"
              placeholder="e.g. 0123456"
              required
            />
          </div>

          <div class="field" style="margin-bottom: 0;">
            <label>Full Name <span class="req" style="color: var(--accent-red);">*</span></label>
            <input
              v-model="quickAddForm.full_name"
              type="text"
              class="form-control"
              placeholder="e.g. Alice Example"
              required
            />
          </div>

          <div class="field" style="margin-bottom: 0;">
            <label>Email Address <span class="req" style="color: var(--accent-red);">*</span></label>
            <input
              v-model="quickAddForm.email"
              type="email"
              class="form-control"
              placeholder="e.g. alice.example@student.pxl.be"
              required
            />
          </div>

          <div class="flex gap-sm">
            <div class="field" style="flex: 1; margin-bottom: 0;">
              <label>Class Group (Optional)</label>
              <input
                v-model="quickAddForm.class_group"
                type="text"
                class="form-control"
                placeholder="e.g. 1TIN-A"
              />
            </div>
            <div class="field" style="flex: 1; margin-bottom: 0;">
              <label>GitHub Login (Optional)</label>
              <input
                v-model="quickAddForm.github_login"
                type="text"
                class="form-control"
                placeholder="e.g. alice-dev"
              />
            </div>
          </div>

          <footer class="modal-foot flex justify-end gap-sm">
            <button class="btn btn-secondary" type="button" @click="showQuickAddModal = false">Cancel</button>
            <button class="btn btn-primary" type="submit" :disabled="quickAddSaving">
              {{ quickAddSaving ? 'Adding…' : 'Add Student' }}
            </button>
          </footer>
        </form>
      </div>
    </div>

    <!-- The same modal the assignment's own menu opens. One component, so the
         two entry points cannot drift about what promotion writes. -->
    <PromoteRosterModal
      v-if="promoteFrom"
      :org="org"
      :assignment="promoteFrom"
      @close="promoteFrom = null"
      @promoted="onPromoted"
    />
  </section>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { csvToRoster, diffRosters, rosterKey, describeRosterEntry } from '../lib/csv.js'
import { validateAgainst } from '../lib/validate.js'
import { ROSTER_PATH } from '../lib/roster.js'
import { getToken, getUser } from '../lib/auth.js'
import { commitFile, getRepoContent, listClaims, deleteFile } from '../lib/api.js'
// The one join between a claim and a roster entry. See lib/claim-bindings.mjs.
import { indexClaims, bindingForEntry } from '../lib/claim-bindings.js'
import { normalizeEmail } from '../lib/claim.js'
// The SAME planner the nightly runs. Imported, never re-implemented: a review
// list computed a second way could show a lecturer something different from
// what was actually held back, which is worse than showing nothing.
import { planClaimPromotion } from '../../../lib/promote-roster.mjs'
import PromoteRosterModal from './PromoteRosterModal.vue'
import { config } from '../lib/config.js'
import { toast } from '../lib/toast.js'
import { copyText } from '../lib/clipboard.js'

const props = defineProps({
  org: { type: String, required: true },
  // The org's assignments, so this tab can offer to add the students who
  // accepted one. Optional: the tab works without them, it simply has nothing
  // to offer.
  assignments: { type: Array, default: () => [] },
})

const controlRepo = config.controlRepo

const csvText = ref('')
const parsedRoster = ref(null)
const parseError = ref('')
const validationErrors = ref([])

const existingRoster = ref(null)
const loadingExisting = ref(false)
const committing = ref(false)

// Filter & Quick Add State (2.A)
const rosterFilter = ref('all')
const showQuickAddModal = ref(false)
const quickAddSaving = ref(false)
const quickAddError = ref('')
const quickAddForm = ref({
  student_number: '',
  full_name: '',
  email: '',
  class_group: '',
  github_login: '',
})

const linkedStudents = computed(() =>
  (existingRoster.value?.students || []).filter((s) => !!s.github_login)
)

const unlinkedStudents = computed(() =>
  (existingRoster.value?.students || []).filter((s) => !s.github_login)
)

const filteredRosterStudents = computed(() => {
  const all = existingRoster.value?.students || []
  if (rosterFilter.value === 'linked') return linkedStudents.value
  if (rosterFilter.value === 'unlinked') return unlinkedStudents.value
  return all
})

function copyUnlinkedEmails() {
  const emails = unlinkedStudents.value
    .map((s) => s.email)
    .filter(Boolean)
  if (emails.length === 0) {
    toast.info('No unlinked student emails found.')
    return
  }
  const formatted = emails.join('; ')
  // `copyText`, not navigator.clipboard directly: the API rejects outright when
  // the document is not focused, and lib/clipboard.js carries the execCommand
  // fallback that exists because of it.
  copyText(formatted).then((ok) => {
    if (ok) toast.success(`Copied ${emails.length} unlinked email(s) to clipboard`)
    else toast.error('Failed to copy emails to clipboard')
  })
}

function openQuickAddModal() {
  quickAddForm.value = {
    student_number: '',
    full_name: '',
    email: '',
    class_group: '',
    github_login: '',
  }
  quickAddError.value = ''
  showQuickAddModal.value = true
}

async function submitQuickAddStudent() {
  quickAddError.value = ''
  const num = quickAddForm.value.student_number?.trim()
  const name = quickAddForm.value.full_name?.trim()
  const email = quickAddForm.value.email?.trim()
  const group = quickAddForm.value.class_group?.trim()
  const login = quickAddForm.value.github_login?.trim()

  if (!num || !name || !email) {
    quickAddError.value = 'Student number, full name, and email are required.'
    return
  }

  const currentStudents = [...(existingRoster.value?.students || [])]
  if (currentStudents.some((s) => String(s.student_number).toLowerCase() === num.toLowerCase())) {
    quickAddError.value = `Student number "${num}" already exists in the roster.`
    return
  }

  const newStudent = {
    student_number: num,
    full_name: name,
    email,
    ...(group ? { class_group: group } : {}),
    ...(login ? { github_login: login } : {}),
  }

  const updatedDoc = {
    schema_version: existingRoster.value?.schema_version || 2,
    students: [...currentStudents, newStudent],
  }

  // Validate before commit
  const { valid, errors } = await validateAgainst('roster', updatedDoc)
  if (!valid) {
    quickAddError.value = errors.map((e) => e.message).join(', ')
    return
  }

  quickAddSaving.value = true
  try {
    const token = getToken()
    const yaml = stringifyYaml(updatedDoc)
    const message = `Add student ${num} (${name}) to roster`
    const res = await commitFile(token, props.org, controlRepo, ROSTER_PATH, yaml, message)
    if (res.ok) {
      toast.success(`Student ${name} added to roster`)
      showQuickAddModal.value = false
      await loadExisting()
    } else {
      quickAddError.value = `Commit failed: ${res.data?.message || 'unknown error'}`
    }
  } catch (e) {
    quickAddError.value = `Error saving student: ${e.message}`
  } finally {
    quickAddSaving.value = false
  }
}

const diff = computed(() => parsedRoster.value
  ? diffRosters(existingRoster.value, parsedRoster.value)
  : { added: [], updated: [], removed: [] })

const canCommit = computed(() =>
  parsedRoster.value
  && !parseError.value
  && validationErrors.value.length === 0
  && diff.value.added.length + diff.value.updated.length + diff.value.removed.length > 0)

function changedFields(u) {
  const keys = new Set([...Object.keys(u.before), ...Object.keys(u.after)])
  return [...keys].filter((k) => JSON.stringify(u.before[k]) !== JSON.stringify(u.after[k]))
}

// "There is no roster" and "the roster could not be read" are different facts,
// and the assignment form turns the first into "nobody can accept". Conflating
// them would put that warning on screen because a token expired.
const rosterReadFailed = ref(false)

// Claims are org-scoped and live in separate files, so the account a student
// can actually accept with is not in roster.yml at all.
const claims = ref([])
const claimsFailed = ref(0)
const claimsReadFailed = ref(false)
const unlinking = ref(false)

const claimIndex = computed(() => indexClaims(claims.value))

// WHAT THE NIGHTLY COULD NOT DECIDE.
//
// Verified claims fold themselves into the roster overnight. Three kinds do not
// - a typed address GitHub never verified, a claim naming a different account
// than the row already holds, and an address two accounts claim - because each
// is a decision and there is nobody there to make it. They were only visible in
// the workflow log, which is not where a lecturer looks.
//
// Computed with `verifiedOnly: true`, which is exactly what the nightly passes,
// so this list IS that list rather than a second opinion about it.
const claimReview = computed(() => {
  if (!existingRoster.value || claims.value.length === 0) return null
  const plan = planClaimPromotion({
    claims: claims.value,
    roster: existingRoster.value,
    verifiedOnly: true,
  })
  return plan?.ok ? plan : null
})

/** One flat list, each row saying which decision it is waiting for. */
const heldClaims = computed(() => {
  const p = claimReview.value
  if (!p) return []
  return [
    ...p.unverified.map((u) => ({
      key: `u:${u.email}`,
      email: u.email,
      full_name: u.full_name,
      login: u.claim_login,
      reason: 'typed by the student, not verified by GitHub',
      // The only one a single button can settle: the lecturer IS the check
      // that GitHub could not perform.
      canLink: true,
    })),
    ...p.conflicts.map((c) => ({
      key: `c:${c.email}`,
      email: c.email,
      full_name: c.full_name,
      login: c.claim_login,
      reason: `the roster already names @${c.roster_login}`,
      // Not a one-click fix: something has to give first, and choosing which
      // account is the lecturer's call. Unlink below is that action.
      canLink: false,
    })),
    ...p.ambiguous.map((a) => ({
      key: `a:${a.email}`,
      email: a.email,
      full_name: a.full_name,
      login: null,
      reason: 'claimed by more than one account',
      canLink: false,
    })),
  ]
})

const autoLinkedCount = computed(() => linkedCount.value)
const linkingEmail = ref('')

// --- adding the students who accepted an assignment -------------------------
//
// Per-assignment, offered from the org-wide roster, so the tab has to ask WHICH
// before it can do anything. Only `open` assignments qualify: under `enforced`
// and `claim` a student had to be on the roster to accept at all, so there is
// nobody to add.
const promoteFrom = ref(null)
const promotePickerOpen = ref(false)

const promotableAssignments = computed(() =>
  (props.assignments || []).filter((a) => a?.roster_mode === 'open' && a?.state !== 'draft'))

function pickPromotionSource(assignment) {
  promotePickerOpen.value = false
  promoteFrom.value = assignment
}

async function onPromoted() {
  promoteFrom.value = null
  await loadExisting()
}

/**
 * Link one held claim, on the lecturer's say-so.
 *
 * Scoped to a SINGLE claim rather than re-running the whole plan, so the button
 * does exactly what its row says and cannot quietly fold somebody else's
 * unverified address at the same time.
 */
async function linkAnyway(row) {
  const claim = claims.value.find((c) => normalizeEmail(c.email) === normalizeEmail(row.email))
  if (!claim) return

  const plan = planClaimPromotion({
    claims: [claim],
    roster: existingRoster.value,
    actor: getUser()?.login || 'lecturer',
  })
  if (!plan.ok || plan.updated.length === 0) {
    toast.error('Nothing to link - the roster may have changed since this list was drawn.')
    return
  }

  const { valid, errors } = await validateAgainst('roster', plan.nextRoster)
  if (!valid) {
    toast.error(`Refusing to write an invalid roster: ${errors.map((e) => e.message).join(', ')}`)
    return
  }

  linkingEmail.value = row.email
  try {
    const res = await commitFile(
      getToken(),
      props.org,
      controlRepo,
      ROSTER_PATH,
      stringifyYaml(plan.nextRoster),
      `Link ${row.email} to @${claim.github_login} (reviewed)`,
    )
    if (res.ok) {
      toast.success(`${row.email} linked to @${claim.github_login}.`)
      await loadExisting()
    } else {
      toast.error(`Commit failed: ${res.data?.message || 'unknown error'}`)
    }
  } catch (e) {
    toast.error(`Could not link: ${e.message}`)
  } finally {
    linkingEmail.value = ''
  }
}
function bindingFor(entry) {
  return bindingForEntry(entry, claimIndex.value)
}

async function loadClaims() {
  claimsReadFailed.value = false
  try {
    const { records, failed } = await listClaims(getToken(), props.org, controlRepo)
    claims.value = records
    claimsFailed.value = failed
  } catch (e) {
    // Unreadable is not evidence of none. An empty list here would paint every
    // claimed student as "Not claimed" and offer no Unlink on the one screen
    // that fixes a wrong binding.
    claimsReadFailed.value = true
    claims.value = []
    claimsFailed.value = 0
    if (e?.status !== 401) console.error('Failed to load claims', e)
  }
}

async function confirmUnlink(student, binding) {
  const who = student.full_name || student.email || `@${binding.login}`
  // Refuse on a partial read: unlinking off an incomplete list can remove the
  // wrong binding, and "no such claim" for a file that would not load reads as
  // success. Same rule PromoteRosterModal carries for acceptances.
  if (claimsFailed.value > 0 || claimsReadFailed.value) {
    toast.error(`Cannot unlink: ${claimsFailed.value || 'some'} claim record(s) could not be read, so the bindings shown are incomplete.`)
    return
  }
  const ok = window.confirm(
    `Unlink @${binding.login} from ${binding.claim.email}?\n\n` +
    `${who} will be able to claim again with any allowed address. ` +
    `Their repository and acceptance are untouched.`
  )
  if (!ok) return

  unlinking.value = true
  try {
    const token = getToken()
    const id = binding.claim.github_id
    const message = `Unlink claim for @${binding.login} (${binding.claim.email})`
    // deleteFile RESOLVES `{ ok: false, status }`; it does not throw, so the
    // catch below never sees a 403 or a conflict. Announcing the unlink
    // without reading this told the lecturer the binding was gone while the
    // student stayed locked to the old address.
    const claimRes = await deleteFile(token, props.org, controlRepo, `students/claims/${id}.json`, message)
    if (!claimRes.ok) {
      toast.error(
        `Could not unlink @${binding.login}: the claim record could not be removed (HTTP ${claimRes.status}). The binding is unchanged.`
      )
      await loadClaims()
      return
    }
    // The attempt counter goes too, and that is the point rather than tidiness:
    // a lecturer unlinks because the binding is wrong, which usually means the
    // student has been failing to claim - and an exhausted counter locks them
    // out of the door that was just reopened.
    //
    // 404 is the end state we wanted: a student who never exhausted their
    // attempts has no counter file, which is the common case and not a failure.
    const attemptsRes = await deleteFile(token, props.org, controlRepo, `students/claim-attempts/${id}.json`, message)
    if (!attemptsRes.ok && attemptsRes.status !== 404) {
      toast.warning(
        `Unlinked @${binding.login}, but their failed-attempt counter could not be cleared (HTTP ${attemptsRes.status}). If they are locked out, clear it before they retry.`
      )
    } else {
      toast.success(`Unlinked @${binding.login}. They can claim again.`)
    }
    await loadClaims()
  } catch (e) {
    toast.error(`Could not unlink: ${e?.message || e}`)
  } finally {
    unlinking.value = false
  }
}

async function loadExisting() {
  loadingExisting.value = true
  rosterReadFailed.value = false
  try {
    const token = getToken()
    // getRepoContent resolves to null on a 404 and throws on anything else, so
    // a falsy body here is a genuine absence.
    const text = await getRepoContent(token, props.org, controlRepo, ROSTER_PATH)
    existingRoster.value = text ? parseYaml(text) : null
  } catch (e) {
    rosterReadFailed.value = true
    existingRoster.value = null
    if (e?.status === 401) {
      toast.error('Session expired. Sign in again.')
      return
    }
    console.error('Failed to load roster', e)
  } finally {
    loadingExisting.value = false
  }
}

function formatRosterValidationError(e, doc) {
  const match = e.instancePath.match(/^\/students\/(\d+)(?:\/([a-zA-Z0-9_]+))?$/)
  if (match) {
    const idx = parseInt(match[1], 10)
    const rowNo = idx + 2
    const field = match[2]
    
    const student = doc?.students?.[idx]
    const studentDesc = student
      ? ` (${student.full_name || 'Unknown'} - SIS: ${student.student_number || 'N/A'})`
      : ''

    let friendlyMsg = e.message
    if (field) {
      if (e.keyword === 'format' && e.params?.format === 'email') {
        friendlyMsg = `'${field}' is not a valid email address.`
      } else if (e.keyword === 'minLength') {
        friendlyMsg = `'${field}' cannot be blank.`
      } else {
        friendlyMsg = `'${field}' ${e.message}.`
      }
      return `Row ${rowNo}${studentDesc}: ${friendlyMsg}`
    } else {
      return `Row ${rowNo}${studentDesc}: ${e.message}`
    }
  }
  return `${e.instancePath || '(root)'} ${e.message}` + (e.params?.allowedValue !== undefined ? ` (allowed: ${JSON.stringify(e.params.allowedValue)})` : '')
}

async function parseAndValidate() {
  parseError.value = ''
  validationErrors.value = []
  parsedRoster.value = null
  if (!csvText.value.trim()) return
  try {
    const doc = csvToRoster(csvText.value)
    const { valid, errors } = await validateAgainst('roster', doc)
    if (!valid) {
      validationErrors.value = errors.map((e) => formatRosterValidationError(e, doc))
      return
    }
    parsedRoster.value = doc
  } catch (e) {
    parseError.value = e.message
  }
}

function onCsvInput() {
  parseAndValidate()
}

const CSV_COLUMNS = ['student_number', 'full_name', 'email', 'class_group', 'github_login', 'github_id', 'active', 'team_slug', 'team_name']

function csvEscape(v) {
  let str = Array.isArray(v) ? v.join('; ') : String(v ?? '')
  if (/^[=+\-@]/.test(str)) {
    str = `'${str}`
  }
  return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str
}

function downloadBlob(text, filename, type) {
  // UTF-8 BOM on CSVs so Excel decodes accented names correctly.
  const payload = type.startsWith('text/csv') ? '﻿' + text : text
  const blob = new Blob([payload], { type })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

function downloadSampleCsv() {
  const sample = [
    CSV_COLUMNS.join(','),
    '0123456,Alice Example,alice@student.pxl.be,3A,alice-gh,,true,team-alpha,Alpha Team',
    '0123457,Bob Example,bob@student.pxl.be,3B,,,true,team-alpha,Alpha Team',
  ].join('\n') + '\n'
  downloadBlob(sample, 'roster-sample.csv', 'text/csv')
}

function exportRosterCsv() {
  const students = existingRoster.value?.students || []
  if (students.length === 0) return
  const lines = [CSV_COLUMNS.join(',')]
  for (const s of students) {
    lines.push(CSV_COLUMNS.map((c) => csvEscape(s[c])).join(','))
  }
  downloadBlob(lines.join('\n') + '\n', `roster-${props.org}.csv`, 'text/csv')
}

async function onFileChange(ev) {
  const file = ev.target.files?.[0]
  if (!file) return
  const text = await file.text()
  csvText.value = text
  ev.target.value = ''
  await parseAndValidate()
}

// The pane's copy says "drop a CSV" - honor it.
const dragging = ref(false)
async function onDrop(ev) {
  dragging.value = false
  const file = ev.dataTransfer?.files?.[0]
  if (!file) return
  csvText.value = await file.text()
  await parseAndValidate()
}

async function commitRoster() {
  if (!canCommit.value) return
  // Removals are the destructive part - one extra look before they land.
  if (diff.value.removed.length > 0 && !window.confirm(
    `This commit removes ${diff.value.removed.length} student(s) from the roster ` +
    `(listed under "Removed"). Continue?`,
  )) return
  committing.value = true
  try {
    const token = getToken()
    const yaml = stringifyYaml(parsedRoster.value)
    const message = `Update ${ROSTER_PATH} via Admin Panel (+${diff.value.added.length} ~${diff.value.updated.length} -${diff.value.removed.length})`
    const res = await commitFile(token, props.org, controlRepo, ROSTER_PATH, yaml, message)
    if (res.ok) {
      toast.success(`Roster committed (${parsedRoster.value.students.length} students)`)
      await loadExisting()
    } else {
      toast.error(`Commit failed: ${res.data?.message || 'unknown error'}`)
    }
  } finally {
    committing.value = false
  }
}

// Claims are loaded beside the roster and switched with it: they are org-scoped,
// so a stale list from the previous org would show bindings that belong to
// somebody else's cohort. Deliberately NOT awaited together - a failed claim
// read must not take the roster down with it, the rule the acceptance card
// learned when one rejected lookup replaced a loaded assignment with an error.
watch(() => props.org, () => { loadExisting(); loadClaims() })
watch(csvText, () => parseAndValidate())

const promotePickerRef = ref(null)

// Closes on an outside click and on Escape, like every other menu in the app.
function onDocumentClick(e) {
  if (promotePickerRef.value && !promotePickerRef.value.contains(e.target)) {
    promotePickerOpen.value = false
  }
}
function onEscape(e) {
  if (e.key === 'Escape') promotePickerOpen.value = false
}

onMounted(() => {
  loadExisting()
  loadClaims()
  document.addEventListener('click', onDocumentClick)
  window.addEventListener('keydown', onEscape)
})
onUnmounted(() => {
  document.removeEventListener('click', onDocumentClick)
  window.removeEventListener('keydown', onEscape)
})

// A parsed import with an uncommitted diff is unsaved work - the parent
// includes it in the route-leave / beforeunload guards.
//
// The count is exposed because the assignment form has to say whether anyone
// can accept at all under `roster_mode: enforced`, and this component has
// already fetched `students/roster.yml` on mount. Re-reading it there would be
// a second request for a file that is open in the next tab - and two readers
// that could disagree. `loadExisting()` runs again after a commit, so the
// number the form shows follows an import without being told.
// null means "not known": still loading, or the read failed. A roster file that
// does not exist is 0 - that is a known fact, and it is the one that stops
// every acceptance under `roster_mode: enforced`.
const studentCount = computed(() => {
  if (loadingExisting.value || rosterReadFailed.value) return null
  const students = existingRoster.value?.students
  return Array.isArray(students) ? students.length : 0
})

// `github_login` is the optional column, and `accept.mjs` matches on it and
// nothing else - so a roster of 200 students imported before anyone handed in
// their username lets exactly nobody accept. "200 students on the roster" is
// true and answers the wrong question.
const linkedCount = computed(() => {
  const students = existingRoster.value?.students
  if (!Array.isArray(students)) return 0
  return students.filter((s) => typeof s?.github_login === 'string' && s.github_login.trim()).length
})

defineExpose({
  isDirty: () => canCommit.value,
  studentCount,
  linkedCount,
  // The roster as read, so the assignment form can offer this org's real class
  // groups and say who a cohort restriction would shut out. It has already
  // fetched the file; a second read there would be the same request twice.
  rosterStudents: computed(() => existingRoster.value?.students || []),
})
</script>

<style scoped>
.roster-tab { display: flex; flex-direction: column; gap: var(--space-md); }
.roster-header h3 { margin: 0 0 var(--space-xs) 0; }
.roster-header p { margin: 0; }

.roster-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-lg);
  align-items: start;
}
@media (max-width: 900px) { .roster-grid { grid-template-columns: 1fr; } }

.input-pane, .diff-pane {
  background: var(--bg-secondary);
  border: 1px solid var(--border-default);
  border-radius: 8px;
  padding: var(--space-md);
}
.input-pane.dragging {
  border-color: var(--accent-blue);
  box-shadow: var(--ring-focus);
}

.field { display: flex; flex-direction: column; gap: 4px; margin-bottom: var(--space-md); }
.field label { font-weight: 500; font-size: 0.9rem; color: var(--text-secondary); }
.field small { color: var(--text-muted); font-size: 0.8rem; }
.field input[type="file"] { padding: var(--space-xs) 0; }
.field textarea {
  width: 100%;
  padding: 8px 10px;
  background: var(--bg-primary);
  border: 1px solid var(--border-default);
  border-radius: 4px;
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-size: 0.85rem;
  resize: vertical;
}

.empty-state { text-align: center; padding: var(--space-2xl) 0; color: var(--text-secondary); }
.empty-state h4 { margin: 0 0 var(--space-xs) 0; }

.existing-summary { text-align: center; padding: var(--space-xl) 0; display: flex; flex-direction: column; gap: var(--space-md); align-items: center; }
.existing-summary p { margin: 0; }
.text-secondary { color: var(--text-secondary); }


.diff-info {
  padding: var(--space-sm) var(--space-md);
  background: var(--tint-success-subtle);
  border-left: 3px solid var(--accent-green-bright);
  border-radius: 4px;
  margin-bottom: var(--space-md);
}

.diff-summary { display: flex; gap: var(--space-sm); margin-bottom: var(--space-md); flex-wrap: wrap; }
.diff-badge {
  display: inline-block;
  padding: 4px 10px;
  border-radius: 4px;
  font-size: 0.85rem;
  font-family: var(--font-mono);
}
.diff-badge.added   { background: var(--tint-success-muted);  color: var(--accent-green-bright); }
.diff-badge.updated { background: var(--tint-attention-muted);  color: var(--accent-yellow-bright); }
.diff-badge.removed { background: var(--tint-danger-muted);  color: var(--accent-red); }

.diff-pane details { border: 1px solid var(--border-default); border-radius: 6px; padding: var(--space-sm); margin-bottom: var(--space-sm); }
.diff-pane summary { cursor: pointer; font-weight: 600; padding: var(--space-xs); }
.diff-pane ul { list-style: none; padding: 0 var(--space-sm); margin: var(--space-xs) 0 0 0; max-height: 240px; overflow-y: auto; }
.diff-pane li { font-size: 0.9rem; padding: 2px 0; }
.diff-pane code { background: var(--bg-tertiary); padding: 0 4px; border-radius: 3px; font-family: var(--font-mono); font-size: 0.85em; }
.changed-fields { color: var(--text-muted); font-size: 0.8rem; font-family: var(--font-mono); margin-left: 6px; }

.diff-empty { padding: var(--space-md); color: var(--text-secondary); text-align: center; }

.validation-errors {
  background: var(--tint-danger-subtle);
  border: 1px solid var(--accent-red);
  border-radius: 6px;
  padding: var(--space-sm) var(--space-md);
  color: var(--accent-red);
  margin-bottom: var(--space-md);
}
.validation-errors ul { margin: var(--space-xs) 0 0 var(--space-md); padding: 0; }

.actions { display: flex; justify-content: flex-end; padding-top: var(--space-md); border-top: 1px solid var(--border-default); }

.loading-inline { display: flex; align-items: center; gap: var(--space-sm); color: var(--text-secondary); padding: var(--space-sm); }
.spinner.sm { width: 14px; height: 14px; border-width: 2px; }

.chip-btn {
  background: var(--bg-tertiary);
  border: 1px solid var(--border-default);
  color: var(--text-secondary);
  border-radius: 16px;
  padding: 3px 10px;
  font-size: 0.8rem;
  cursor: pointer;
  transition: all 0.15s ease;
}
.chip-btn:hover {
  background: var(--bg-primary);
  color: var(--text-primary);
}
.chip-btn.active {
  background: var(--accent-blue);
  color: var(--text-on-emphasis);
  border-color: var(--accent-blue);
}

.modal-overlay {
  position: fixed;
  inset: 0;
  background: var(--bg-scrim);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  backdrop-filter: blur(2px);
}
.modal {
  background: var(--bg-secondary);
  border: 1px solid var(--border-default);
  border-radius: 8px;
  width: 90%;
  box-shadow: var(--shadow-lg, 0 10px 25px var(--shadow-color-modal));
}
.modal-head {
  padding: var(--space-md);
  border-bottom: 1px solid var(--border-default);
}
.modal-close {
  background: none;
  border: none;
  font-size: 1.4rem;
  color: var(--text-muted);
  cursor: pointer;
}
.modal-close:hover {
  color: var(--text-primary);
}
.mono {
  font-family: var(--font-mono);
}

/* ------------------------------------------------------------------------
   Vocabulary that was carried INLINE.

   Each class below was written in the markup beside a `style="…"` that said
   what it meant, so the class itself was declared nowhere and the look lived on
   the element. Moving the declarations here changes nothing on screen - the
   values are unchanged - but it takes them off the undeclared-class register
   and puts the appearance where DESIGN.md says it belongs.
   ------------------------------------------------------------------------ */

/* Anchor for the "which assignment?" picker. */
.promote-picker-anchor { position: relative; display: inline-flex; }
.promote-picker {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  z-index: 100;
  min-width: 240px;
  max-height: 320px;
  overflow-y: auto;
  padding: var(--space-xs);
  background: var(--bg-surface);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-lg);
  text-align: left;
}
.promote-picker-head {
  margin: 0 0 var(--space-2xs);
  padding: 4px 8px;
  font-size: 0.78rem;
  color: var(--text-muted);
}
.promote-picker-item {
  display: flex;
  flex-direction: column;
  gap: 1px;
  width: 100%;
  padding: 6px 8px;
  background: none;
  border: 0;
  border-radius: var(--radius-xs);
  text-align: left;
  cursor: pointer;
  color: var(--text-primary);
}
.promote-picker-item:hover { background: var(--bg-surface-hover); }
.promote-picker-title { font-size: 0.9rem; }
.promote-picker-sub { font-family: var(--font-mono); font-size: 0.75rem; color: var(--text-muted); }

/* The review box. A tonal step with a single attention edge rather than a
   bordered card - this sits inside the roster panel, which is already a box
   (DESIGN.md §1.1), and the colour is the warning token because it needs a look
   rather than an alarm (§4). */
.claim-review {
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
  padding: var(--space-sm) var(--space-md);
  background: var(--bg-inset);
  border-radius: var(--radius-sm);
  box-shadow: inset 2px 0 0 var(--accent-yellow);
}
.claim-review-head {
  flex-wrap: wrap;
}
.claim-review-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-xs);
}
.claim-review-row {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  flex-wrap: wrap;
}
.claim-review-who { flex: 0 1 auto; min-width: 0; }
/* Takes the slack so the action stays at the right edge on a wide row, and
   wraps under rather than squeezing the button on a narrow one. */
.claim-review-why { flex: 1 1 16ch; min-width: 0; }
.claim-review-hint { white-space: nowrap; }

.roster-filter-chips {
  margin-top: var(--space-sm);
}

.roster-table-wrapper {
  margin-top: var(--space-sm);
  max-height: 380px;
  overflow-y: auto;
}
</style>
