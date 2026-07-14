<template>
  <div class="admin-page container fade-in">
    <header class="admin-header">
      <router-link :to="{ name: 'dashboard', params: { org } }" class="btn btn-with-icon">
        <Icon name="arrow-left" :size="14" />
        <span>Dashboard</span>
      </router-link>
      <h2>Admin Panel — {{ org }}</h2>
    </header>

    <nav class="admin-tabs" role="tablist">
      <button
        type="button"
        role="tab"
        :aria-selected="activeTab === 'assignments'"
        :tabindex="activeTab === 'assignments' ? 0 : -1"
        :class="['tab', { active: activeTab === 'assignments' }]"
        @click="setTab('assignments')"
        @keydown="onTabKeydown"
      >Assignments</button>
      <button
        type="button"
        role="tab"
        :aria-selected="activeTab === 'roster'"
        :tabindex="activeTab === 'roster' ? 0 : -1"
        :class="['tab', { active: activeTab === 'roster' }]"
        @click="setTab('roster')"
        @keydown="onTabKeydown"
      >Roster</button>
    </nav>

    <RosterTab v-if="activeTab === 'roster'" :org="org" />

    <div v-show="activeTab === 'assignments'" class="admin-layout">
      <!-- LEFT: assignment list -->
      <aside class="list-pane">
        <button class="btn btn-primary new-btn btn-with-icon" @click="newAssignment">
          <Icon name="plus" :size="14" />
          <span>New assignment</span>
        </button>

        <div v-if="loadingList" class="list-loading"><div class="spinner"></div></div>
        <div v-else-if="assignments.length === 0" class="list-empty">
          No assignments yet. Create one to begin.
        </div>
        <ul v-else class="assignment-list">
          <li
            v-for="a in assignments"
            :key="a.id"
            :class="{ active: editing && editing.id === a.id }"
            role="button"
            tabindex="0"
            @click="editAssignment(a)"
            @keyup.enter="editAssignment(a)"
            @keydown.space.prevent="editAssignment(a)"
          >
            <div class="title">{{ a.title || a.id }}</div>
            <div class="slug">{{ a.id }}</div>
            <div class="meta">
              <span class="badge" :class="`badge-${a.state}`">{{ a.state }}</span>
              <span v-if="a.deadline_at" class="deadline">{{ formatDate(a.deadline_at) }}</span>
            </div>
          </li>
        </ul>
      </aside>

      <!-- RIGHT: editor -->
      <main class="editor-pane">
        <div v-if="!editing" class="empty-state">
          <h3>Pick an assignment to edit</h3>
          <p>Or click <strong>+ New assignment</strong> to create one.</p>
        </div>

        <form v-else class="editor-form" @submit.prevent>
          <div class="editor-title">
            <h3 v-if="isNew">New assignment</h3>
            <h3 v-else>Edit: <code>{{ form.id }}</code> <span class="badge" :class="`badge-${form.state}`">{{ form.state }}</span></h3>
          </div>

          <!-- BASICS -->
          <fieldset>
            <legend>Basics</legend>
            <div class="field">
              <label>Title <span class="req">*</span></label>
              <input v-model="form.title" @input="autoSyncSlug" placeholder="e.g. Linux Processes 2026" />
            </div>
            <div class="field">
              <label>Slug (URL identifier) <span class="req">*</span></label>
              <input
                v-model="form.id"
                :disabled="!isNew"
                @input="manualSlug = true"
                placeholder="linux-processes-2026"
              />
              <small v-if="isNew">Auto-derived from title. Edit to override.</small>
              <small v-else>Locked — changing the slug would orphan the YAML file.</small>
            </div>
            <div class="field">
              <label>Description</label>
              <textarea v-model="form.description" rows="2" placeholder="Optional"></textarea>
            </div>
          </fieldset>

          <!-- TEMPLATE -->
          <fieldset>
            <legend>Template</legend>
            <div class="field">
              <label>Template repository <span class="req">*</span></label>
              <div v-if="loadingTemplates" class="loading-inline"><div class="spinner sm"></div> Loading templates from {{ org }}…</div>
              <select v-else v-model="form.template" :disabled="templates.length === 0">
                <option value="">— pick a template —</option>
                <option v-for="t in templates" :key="t.full_name" :value="t.full_name">
                  {{ t.full_name }}{{ t.is_template ? '' : ' — not a template repo' }}{{ t._foreign ? ' (cross-org)' : '' }}
                </option>
              </select>
              <small v-if="!loadingTemplates && templates.length === 0">
                No <code>template-*</code> repos found in <code>{{ org }}</code>. Create one and mark it as a template in repo Settings.
              </small>
              <small v-else-if="!loadingTemplates">
                Found {{ templates.length }} repo<span v-if="templates.length !== 1">s</span> matching <code>template-*</code>.
              </small>
            </div>
            <div class="field">
              <label>Repository name pattern <span class="req">*</span></label>
              <input v-model="form.repository_name_pattern" placeholder="linux-processes-{github_login}" />
              <small>Must contain <code>{github_login}</code>. The student's repo will be named per this pattern.</small>
            </div>
          </fieldset>

          <!-- SCHEDULE -->
          <fieldset>
            <legend>Schedule</legend>
            <div class="field">
              <label>Opens at <span class="req">*</span></label>
              <input type="datetime-local" v-model="form.opens_at_local" />
              <small>{{ utcHint(form.opens_at_local) }}</small>
            </div>
            <div class="field">
              <label>Deadline <span class="req">*</span></label>
              <input type="datetime-local" v-model="form.deadline_at_local" />
              <small>{{ utcHint(form.deadline_at_local) }}</small>
            </div>
          </fieldset>

          <!-- GUARDRAILS -->
          <fieldset>
            <legend>Guardrails</legend>
            <div class="field">
              <label>Max acceptances</label>
              <input type="number" v-model.number="form.max_acceptances" min="1" />
              <small v-if="form.max_acceptances">Hard cap on accepted students. Acceptances beyond this are rejected.</small>
              <small v-else class="text-warning">Empty = <strong>no cap</strong> — any number of students can accept. Set a number to keep the guardrail.</small>
            </div>
            <div class="field checkbox">
              <label>
                <input type="checkbox" v-model="form.lock_down_enabled" />
                Lock down student repos at the deadline (demote admin → pull)
              </label>
            </div>
            <div class="field checkbox">
              <label>
                <input type="checkbox" v-model="form.feedback_pr" />
                Open a draft Feedback PR for each student (pxl-baseline protected branch)
              </label>
              <small>
                Provisioning creates a frozen <code>{{ form.feedback_pr_baseline_branch || 'pxl-baseline' }}</code> branch and protects it.
                PRs are opened lazily via <code>pxl-classroom feedback open --assignment {{ form.id || 'ID' }}</code> once students push commits.
              </small>
            </div>
            <div class="field checkbox">
              <label>
                <input type="checkbox" v-model="form.autograde_enabled" />
                Enable autograding
              </label>
              <small>Define tests below; run them lecturer-side via the CLI, or student-side via GitHub Actions.</small>
            </div>
            <div v-if="form.autograde_enabled" class="field autograde-banner">
              <label>Execution Environment</label>
              <select v-model="form.autograde_execution_environment">
                <option value="lecturer_local">Lecturer Local (CLI)</option>
                <option value="github_actions">GitHub Actions (Student Repo)</option>
              </select>
              <div v-if="form.autograde_execution_environment === 'github_actions'" style="margin-top: 8px;">
                <label>Test Visibility</label>
                <select v-model="form.autograde_visibility">
                  <option value="private">Private (Hidden via reusable workflow)</option>
                  <option value="public">Public (Visible in student repo)</option>
                </select>
              </div>

              <div class="tests-editor">
                <label>Tests ({{ (form.autograde_tests || []).length }})</label>
                <div v-for="(t, i) in form.autograde_tests" :key="i" class="test-row">
                  <div class="test-row-head">
                    <input v-model="t.id" placeholder="test-id (lowercase, dashes)" class="test-id" aria-label="Test ID" />
                    <select v-model="t.type" aria-label="Test type">
                      <option value="run">run — shell command, exit 0 passes</option>
                      <option value="io">io — stdin in, compare stdout</option>
                      <option value="python">python — run a script</option>
                    </select>
                    <input v-model.number="t.points" type="number" min="0" placeholder="pts" class="test-points" aria-label="Points" />
                    <button class="btn test-remove" type="button" @click="removeTest(i)" :aria-label="`Remove test ${t.id || i + 1}`">
                      <Icon name="x" :size="13" />
                    </button>
                  </div>
                  <textarea v-if="t.type !== 'python'" v-model="t.command" rows="1" :placeholder="t.type === 'io' ? 'executable + args, e.g. ./greet' : 'shell command, e.g. make test'" aria-label="Command"></textarea>
                  <textarea v-else v-model="t.script" rows="3" placeholder="Python source" aria-label="Python script"></textarea>
                  <template v-if="t.type === 'io'">
                    <textarea v-model="t.stdin" rows="1" placeholder="stdin payload" aria-label="Stdin"></textarea>
                    <textarea v-model="t.expected_stdout" rows="1" placeholder="expected stdout (trimmed, newline-normalized)" aria-label="Expected stdout"></textarea>
                  </template>
                </div>
                <button class="btn btn-with-icon" type="button" @click="addTest">
                  <Icon name="plus" :size="13" />
                  <span>Add test</span>
                </button>
              </div>

              <small style="display:block; margin-top: 8px;">
                <template v-if="form.autograde_execution_environment === 'lecturer_local'">
                  Execution stays off-platform — run <code>pxl-classroom grade --org {{ org }} --assignment {{ form.id || 'ID' }}</code> from your machine.
                  Results land in <code>grading/{{ form.id || 'ID' }}/</code>.
                </template>
                <template v-else>
                  Executed automatically via GitHub Actions in the student repositories. Results sync back as a
                  <strong>pass/fail</strong> CI signal per student.
                </template>
              </small>
            </div>
          </fieldset>

          <!-- ADVANCED -->
          <details class="advanced">
            <summary>Advanced</summary>
            <div class="field">
              <label>Late policy</label>
              <select v-model="form.late_policy">
                <option value="report">report — observe and report late activity</option>
                <option value="block">block — refuse late pushes</option>
              </select>
            </div>
            <div class="field">
              <label>Student permission</label>
              <select v-model="form.student_permission">
                <option value="admin">admin (recommended — required for Actions/runners exercises)</option>
                <option value="maintain">maintain</option>
                <option value="push">push</option>
                <option value="triage">triage</option>
                <option value="pull">pull</option>
              </select>
            </div>
            <div class="field">
              <label>Submission ref</label>
              <input v-model="form.submission_ref" placeholder="refs/heads/main" />
            </div>
            <div class="field">
              <label>Timezone (display)</label>
              <input v-model="form.timezone" placeholder="Europe/Brussels" />
            </div>
            <div class="field">
              <label>Acceptance mode</label>
              <select v-model="form.acceptance_mode">
                <option value="self-service">self-service (student stars broker)</option>
                <option value="pre-provisioned">pre-provisioned (lecturer creates repos in advance)</option>
              </select>
            </div>
          </details>

          <!-- YAML PREVIEW -->
          <details class="yaml-preview-section">
            <summary>YAML preview</summary>
            <pre class="yaml-code"><code>{{ generatedYaml }}</code></pre>
          </details>

          <!-- VALIDATION ERRORS -->
          <div v-if="validationErrors.length" class="validation-errors">
            <strong>Fix these before saving:</strong>
            <ul>
              <li v-for="(e, i) in validationErrors" :key="i">{{ e }}</li>
            </ul>
          </div>

          <!-- SAVE ACTIONS -->
          <div class="actions">
            <button class="btn" type="button" @click="cancelEdit" :disabled="saving">Cancel</button>
            <!-- "Save as draft" only while the assignment IS a draft — on a
                 published assignment it would silently unpublish. -->
            <button
              v-if="isNew || form.state === 'draft'"
              class="btn"
              type="button"
              @click="saveAssignment('draft')"
              :disabled="saving || !canSave"
            >{{ saving ? 'Saving…' : 'Save as draft' }}</button>
            <button
              class="btn btn-primary"
              type="button"
              @click="saveAndPublish"
              :disabled="saving || !canSave"
            >{{ saving ? 'Saving…' : (form.state === 'published' ? 'Save' : 'Save & publish') }}</button>
          </div>

          <!-- LIFECYCLE ACTIONS for existing -->
          <div v-if="!isNew" class="lifecycle">
            <h4>Lifecycle</h4>
            <div class="lifecycle-actions">
              <button class="btn btn-with-icon" type="button" @click="publishExisting" :disabled="form.state === 'published' || publishing">
                <template v-if="publishing">Publishing…</template>
                <template v-else-if="form.state === 'published'">
                  <Icon name="check" :size="14" />
                  <span>Already published</span>
                </template>
                <template v-else>Publish (create broker, enable nightly)</template>
              </button>
              <button class="btn" type="button" @click="setState('closed')" :disabled="form.state === 'closed' || saving">
                Close (stop accepting)
              </button>
              <button class="btn" type="button" @click="setState('archived')" :disabled="form.state === 'archived' || saving">
                Archive
              </button>
              <button v-if="form.state === 'published'" class="btn btn-with-icon" type="button" @click="copyAcceptLink">
                <Icon name="copy" :size="14" />
                <span>Copy accept link</span>
              </button>
              <button v-if="form.state === 'draft'" class="btn btn-danger" type="button" @click="deleteDraft" :disabled="deleting">
                {{ deleting ? 'Deleting…' : 'Delete draft' }}
              </button>
            </div>

            <div v-if="publishWatch === 'watching'" class="publish-watch">
              <div class="spinner sm"></div>
              <span class="text-secondary">Publish triggered — waiting for the broker repo to appear… (checked {{ publishPollCount }}×)</span>
            </div>
            <div v-else-if="publishWatch === 'ready'" class="publish-watch publish-ready">
              <Icon name="check-circle" :size="15" />
              <span>Broker is live — the accept link works now.</span>
              <button class="link-btn" type="button" @click="copyAcceptLink">Copy accept link</button>
            </div>
            <div v-else-if="publishWatch === 'timeout'" class="publish-watch">
              <span class="text-warning">
                Broker not visible after 2 minutes — check the
                <a :href="`https://github.com/${config.hubOwner}/${config.hubRepo}/actions/workflows/publish-assignment.yml`" target="_blank" rel="noopener">publish workflow run</a>.
              </span>
            </div>

            <details class="lifecycle-section">
              <summary>Grant deadline extension</summary>
              <div class="field">
                <label>Student GitHub login</label>
                <input v-model="extForm.login" placeholder="octocat" />
              </div>
              <div class="field">
                <label>New deadline (just for this student)</label>
                <input type="datetime-local" v-model="extForm.deadline_local" />
                <small>{{ utcHint(extForm.deadline_local) }}</small>
              </div>
              <div class="field">
                <label>Reason (recorded in the override)</label>
                <textarea v-model="extForm.reason" rows="2" placeholder="Medical certificate / approved by program coordinator / etc."></textarea>
              </div>
              <button class="btn btn-primary" type="button" @click="grantExtension" :disabled="extending || !extForm.login || !extForm.reason">
                {{ extending ? 'Granting…' : 'Grant extension' }}
              </button>
            </details>

            <details class="lifecycle-section">
              <summary>Retry a failed acceptance</summary>
              <p class="text-secondary">Use this when a student's acceptance got stuck (e.g. rate-limit during a burst). Wipes the half-done state and re-runs the full pipeline.</p>
              <div class="field">
                <label>Student GitHub login</label>
                <input v-model="retryForm.login" placeholder="octocat" />
              </div>
              <button class="btn btn-primary" type="button" @click="retryAcceptance" :disabled="retrying || !retryForm.login">
                {{ retrying ? 'Triggering…' : 'Retry acceptance' }}
              </button>
            </details>
          </div>
        </form>
      </main>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import { config } from '../lib/config.js'
import { getToken } from '../lib/auth.js'
import { commitFile, deleteFile, getRepo, triggerWorkflow, listOrgRepos, listRepoDir, getRepoContent, explainDispatchFailure } from '../lib/api.js'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { validateAgainst } from '../lib/validate.js'
import { toast } from '../lib/toast.js'
import { formatDate } from '../lib/format.js'
import RosterTab from '../components/RosterTab.vue'
import Icon from '../components/Icon.vue'

const props = defineProps({ org: { type: String, required: true } })

// ---------------------------------------------------------------- tabs

const VALID_TABS = new Set(['assignments', 'roster'])
function tabFromHash() {
  const h = (typeof window !== 'undefined' && window.location.hash || '').replace(/^#/, '')
  return VALID_TABS.has(h) ? h : 'assignments'
}
const activeTab = ref(tabFromHash())
function setTab(name) {
  if (!VALID_TABS.has(name)) return
  activeTab.value = name
  if (typeof window !== 'undefined') {
    history.replaceState(null, '', `#${name}`)
  }
}
if (typeof window !== 'undefined') {
  window.addEventListener('hashchange', () => { activeTab.value = tabFromHash() })
}

// Roving-tabindex arrow navigation for the two tabs (WAI-ARIA tabs pattern).
function onTabKeydown(e) {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
  e.preventDefault()
  setTab(activeTab.value === 'assignments' ? 'roster' : 'assignments')
  nextTick(() => document.querySelector('.admin-tabs .tab.active')?.focus())
}

// ---------------------------------------------------------------- state

const assignments = ref([])
const loadingList = ref(true)
const templates = ref([])
const loadingTemplates = ref(false)
const editing = ref(null) // current assignment being edited (null = none)
const manualSlug = ref(false)
const saving = ref(false)
const publishing = ref(false)
const extending = ref(false)
const retrying = ref(false)
const deleting = ref(false)

// '' | 'watching' | 'ready' | 'timeout' — post-publish broker watch
const publishWatch = ref('')
const publishPollCount = ref(0)
let publishPollTimer = null

const form = ref(emptyForm())

// Snapshot of the form as of the last load/save. Anything different means
// unsaved edits — guard list navigation and Cancel against silent loss.
const savedSnapshot = ref('')
function snapshotForm() {
  savedSnapshot.value = JSON.stringify(form.value)
}
function confirmDiscard() {
  if (!editing.value) return true
  if (JSON.stringify(form.value) === savedSnapshot.value) return true
  return window.confirm('Discard unsaved changes to this assignment?')
}
function hasUnsavedEdits() {
  return !!editing.value && JSON.stringify(form.value) !== savedSnapshot.value
}

// In-page navigation is guarded via confirmDiscard(); guard the two exits
// that used to lose edits silently — leaving the route (e.g. the Dashboard
// back button) and closing/refreshing the tab.
onBeforeRouteLeave(() => confirmDiscard())
function onBeforeUnload(e) {
  if (hasUnsavedEdits()) {
    e.preventDefault()
    e.returnValue = ''
  }
}

const extForm = ref({ login: '', deadline_local: '', reason: '' })
const retryForm = ref({ login: '' })

const isNew = computed(() => editing.value && editing.value.__new === true)

// ---------------------------------------------------------------- defaults / helpers

function emptyForm() {
  const now = new Date()
  const in14d = new Date(Date.now() + 14 * 86400000)
  return {
    schema_version: 1,
    id: '',
    title: '',
    description: '',
    organization: props.org,
    template: '',
    repository_name_pattern: '',
    opens_at_local: toLocalInputValue(now),
    deadline_at_local: toLocalInputValue(in14d),
    _opens_at_original: '',
    _deadline_at_original: '',
    timezone: 'Europe/Brussels',
    submission_ref: 'refs/heads/main',
    student_permission: 'admin',
    acceptance_mode: 'self-service',
    late_policy: 'report',
    state: 'draft',
    max_acceptances: 250,
    lock_down_enabled: true,
    feedback_pr: false,
    feedback_pr_baseline_branch: 'pxl-baseline',
    autograde_enabled: false,
    autograde_execution_environment: 'lecturer_local',
    autograde_visibility: 'private',
    autograde_tests: [],
  }
}

// If the user-visible HH:MM still matches what we derived from the original
// UTC value, preserve the original (with seconds/ms) rather than zeroing them.
function preserveOrLocal(localStr, originalUtc) {
  if (!originalUtc) return localToUtc(localStr)
  if (utcToLocalInput(originalUtc) === localStr) return originalUtc
  return localToUtc(localStr)
}

function toSlug(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-')
    .slice(0, 100)
    .replace(/^[^a-z0-9]+/, '')
}

function toLocalInputValue(date) {
  // Returns YYYY-MM-DDTHH:MM in browser's local time, for datetime-local input
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function localToUtc(localStr) {
  // datetime-local string -> UTC ISO. Browser interprets as local.
  if (!localStr) return ''
  return new Date(localStr).toISOString()
}

function utcToLocalInput(utcIso) {
  if (!utcIso) return ''
  return toLocalInputValue(new Date(utcIso))
}

function utcHint(localStr) {
  if (!localStr) return ''
  try {
    const utc = new Date(localStr).toISOString()
    return `Stored as: ${utc}`
  } catch {
    return ''
  }
}

function autoSyncSlug() {
  if (isNew.value && !manualSlug.value) {
    form.value.id = toSlug(form.value.title)
    // Also keep repository_name_pattern in sync with slug if it follows our default convention
    if (form.value.repository_name_pattern === '' || form.value.repository_name_pattern.endsWith('-{github_login}')) {
      form.value.repository_name_pattern = `${form.value.id}-{github_login}`
    }
  }
}

// ---------------------------------------------------------------- data loading

async function loadAssignments() {
  loadingList.value = true
  const token = getToken()
  try {
    const files = await listRepoDir(token, props.org, config.controlRepo, 'assignments')
    const ymls = files.filter((f) => f.type === 'file' && f.name.endsWith('.yml'))
    const docs = await Promise.all(
      ymls.map(async (f) => {
        try {
          const text = await getRepoContent(token, props.org, config.controlRepo, f.path)
          if (!text) return null
          const doc = parseYaml(text)
          return { ...doc, id: doc.id || f.name.replace(/\.yml$/, '') }
        } catch {
          return null
        }
      })
    )
    assignments.value = docs.filter(Boolean).sort((a, b) => {
      // draft first, then published, then closed, then archived
      const order = { draft: 0, published: 1, closed: 2, archived: 3 }
      return (order[a.state] ?? 9) - (order[b.state] ?? 9) || a.id.localeCompare(b.id)
    })
  } catch (e) {
    console.error('Failed to load assignments', e)
    toast.error('Failed to load assignments')
  }
  loadingList.value = false
}

async function loadTemplates() {
  loadingTemplates.value = true
  const token = getToken()
  try {
    const repos = await listOrgRepos(token, props.org, 'template-')
    templates.value = repos
    // Apply the "auto-select the only template" default
    if (isNew.value && repos.length === 1 && !form.value.template) {
      form.value.template = repos[0].full_name
    }
  } catch (e) {
    console.error('Failed to load templates', e)
  }
  loadingTemplates.value = false
}

// ---------------------------------------------------------------- edit flow

function newAssignment() {
  if (!confirmDiscard()) return
  editing.value = { __new: true, id: '' }
  manualSlug.value = false
  form.value = emptyForm()
  // Auto-select sole template if we already have it loaded
  if (templates.value.length === 1) form.value.template = templates.value[0].full_name
  publishWatch.value = ''
  snapshotForm()
}

function editAssignment(a) {
  if (editing.value && editing.value.id !== a.id && !confirmDiscard()) return
  editing.value = { id: a.id }
  manualSlug.value = true // existing assignments — never auto-rewrite the slug
  form.value = {
    schema_version: a.schema_version || 1,
    id: a.id,
    title: a.title || '',
    description: a.description || '',
    organization: a.organization || props.org,
    template: a.template ? `${a.template.owner}/${a.template.repository}` : '',
    repository_name_pattern: a.repository_name_pattern || '',
    opens_at_local: utcToLocalInput(a.opens_at),
    deadline_at_local: utcToLocalInput(a.deadline_at),
    _opens_at_original: a.opens_at || '',
    _deadline_at_original: a.deadline_at || '',
    timezone: a.timezone || 'Europe/Brussels',
    submission_ref: a.submission_ref || 'refs/heads/main',
    student_permission: a.student_permission || 'admin',
    acceptance_mode: a.acceptance_mode || 'self-service',
    late_policy: a.late_policy || 'report',
    state: a.state || 'draft',
    max_acceptances: a.max_acceptances ?? 250,
    lock_down_enabled: a.lock_down_enabled ?? true,
    feedback_pr: a.feedback_pr === true,
    feedback_pr_baseline_branch: a.feedback_pr_baseline_branch || 'pxl-baseline',
    autograde_enabled: a.autograde?.enabled === true,
    autograde_execution_environment: a.autograde?.execution_environment || 'lecturer_local',
    autograde_visibility: a.autograde?.visibility || 'private',
    autograde_tests: a.autograde?.tests || [],
  }
  extForm.value = { login: '', deadline_local: form.value.deadline_at_local, reason: '' }
  retryForm.value = { login: '' }
  // Pin the editing template into the dropdown even if it lives in a different
  // org than the assignment org. Drop any synthetic entry from a previous edit.
  templates.value = templates.value.filter(t => !t._foreign)
  if (form.value.template && !templates.value.some(t => t.full_name === form.value.template)) {
    const [tplOwner] = form.value.template.split('/')
    templates.value = [
      { full_name: form.value.template, is_template: true, _foreign: tplOwner !== props.org },
      ...templates.value,
    ]
  }
  publishWatch.value = ''
  snapshotForm()
}

function cancelEdit() {
  if (!confirmDiscard()) return
  editing.value = null
}

// ---------------------------------------------------------------- autograde tests

function addTest() {
  if (!Array.isArray(form.value.autograde_tests)) form.value.autograde_tests = []
  form.value.autograde_tests.push({ id: '', type: 'run', command: '', points: 1 })
}

function removeTest(i) {
  form.value.autograde_tests.splice(i, 1)
}

// Strip empty optional fields so the committed YAML stays schema-clean
// (additionalProperties: false; only the fields the test type uses).
function cleanTests() {
  return (form.value.autograde_tests || []).map((t) => ({
    id: t.id || '',
    type: t.type || 'run',
    points: Number(t.points) || 0,
    ...(t.type === 'python'
      ? { ...(t.script ? { script: t.script } : {}) }
      : { ...(t.command ? { command: t.command } : {}) }),
    ...(t.type === 'io' && t.stdin ? { stdin: t.stdin } : {}),
    ...(t.type === 'io' && t.expected_stdout ? { expected_stdout: t.expected_stdout } : {}),
    ...(t.timeout_s ? { timeout_s: Number(t.timeout_s) } : {}),
  }))
}

// ---------------------------------------------------------------- YAML generation + validation

function buildDoc(state = null) {
  const [tplOwner, tplRepo] = (form.value.template || '').split('/')
  return {
    schema_version: 1,
    id: form.value.id,
    title: form.value.title,
    ...(form.value.description ? { description: form.value.description } : {}),
    organization: form.value.organization,
    template: { owner: tplOwner || '', repository: tplRepo || '' },
    repository_name_pattern: form.value.repository_name_pattern,
    opens_at: preserveOrLocal(form.value.opens_at_local, form.value._opens_at_original),
    deadline_at: preserveOrLocal(form.value.deadline_at_local, form.value._deadline_at_original),
    timezone: form.value.timezone || 'Europe/Brussels',
    submission_ref: form.value.submission_ref || 'refs/heads/main',
    student_permission: form.value.student_permission,
    acceptance_mode: form.value.acceptance_mode,
    late_policy: form.value.late_policy,
    state: state || form.value.state,
    ...(form.value.max_acceptances ? { max_acceptances: Number(form.value.max_acceptances) } : {}),
    lock_down_enabled: !!form.value.lock_down_enabled,
    ...(form.value.feedback_pr
      ? {
          feedback_pr: true,
          feedback_pr_baseline_branch: form.value.feedback_pr_baseline_branch || 'pxl-baseline',
        }
      : {}),
    // Included whenever enabled — an empty tests list then fails schema
    // validation visibly instead of being silently dropped from the YAML.
    ...(form.value.autograde_enabled
      ? { autograde: { enabled: true, execution_environment: form.value.autograde_execution_environment, visibility: form.value.autograde_visibility, tests: cleanTests() } }
      : {}),
  }
}

const generatedYaml = computed(() => stringifyYaml(buildDoc()))

const validationErrors = ref([])

async function validate(state = null) {
  const doc = buildDoc(state)
  const { valid, errors } = await validateAgainst('assignment', doc)
  if (valid) {
    validationErrors.value = []
    return true
  }
  validationErrors.value = errors.map((e) => `${e.instancePath || '(root)'} ${e.message}`)
  return false
}

const canSave = computed(() => {
  return (
    !!form.value.id &&
    !!form.value.title &&
    !!form.value.template &&
    !!form.value.repository_name_pattern &&
    form.value.repository_name_pattern.includes('{github_login}') &&
    !!form.value.opens_at_local &&
    !!form.value.deadline_at_local
  )
})

// ---------------------------------------------------------------- save / publish

async function saveAssignment(stateOverride = null) {
  if (!(await validate(stateOverride))) {
    toast.error('Validation failed — fix the issues listed below the form.')
    return
  }
  saving.value = true
  try {
    const token = getToken()
    const path = `assignments/${form.value.id}.yml`
    const yaml = stringifyYaml(buildDoc(stateOverride))
    const res = await commitFile(token, props.org, config.controlRepo, path, yaml, isNew.value ? `Create assignment ${form.value.id}` : `Update assignment ${form.value.id}`)
    if (res.ok) {
      toast.success(`Saved ${form.value.id}`)
      form.value.state = stateOverride || form.value.state
      snapshotForm()
      await loadAssignments()
      // Stay on the edited assignment
      const stillExists = assignments.value.find((a) => a.id === form.value.id)
      if (stillExists) editing.value = { id: stillExists.id }
    } else {
      toast.error(`Save failed: ${res.data?.message || 'unknown error'}`)
    }
  } finally {
    saving.value = false
  }
}

async function saveAndPublish() {
  // Save current edits first (with state=published) then trigger publish workflow.
  if (form.value.state === 'published') {
    await saveAssignment()
    return
  }
  await saveAssignment('published')
  if (form.value.state === 'published') await publishExisting()
}

async function publishExisting() {
  publishing.value = true
  try {
    const token = getToken()
    const res = await triggerWorkflow(token, config.hubOwner, config.hubRepo, 'publish-assignment.yml', {
      org: props.org,
      assignment_id: form.value.id,
    })
    if (res.ok || res.status === 204) {
      toast.success('Publish workflow triggered — watching for the broker to appear…')
      startPublishWatch()
    } else {
      toast.error(explainDispatchFailure(res, 'Publish failed'))
    }
  } finally {
    publishing.value = false
  }
}

// Poll for the broker repo the publish workflow creates, so "published"
// isn't fire-and-forget: the lecturer sees when the accept link goes live.
function startPublishWatch() {
  stopPublishWatch()
  publishWatch.value = 'watching'
  publishPollCount.value = 0
  const brokerRepo = `broker-${form.value.id}`
  const tick = async () => {
    publishPollCount.value++
    const token = getToken()
    if (token) {
      const res = await getRepo(token, props.org, brokerRepo)
      if (res.ok) {
        publishWatch.value = 'ready'
        toast.success('Published — the accept link is live.')
        return
      }
    }
    if (publishPollCount.value >= 24) { // 24 × 5s = 2 minutes
      publishWatch.value = 'timeout'
      return
    }
    publishPollTimer = setTimeout(tick, 5000)
  }
  publishPollTimer = setTimeout(tick, 5000)
}

function stopPublishWatch() {
  if (publishPollTimer) {
    clearTimeout(publishPollTimer)
    publishPollTimer = null
  }
}

function copyAcceptLink() {
  const base = window.location.origin + (import.meta.env.BASE_URL || '/')
  const link = `${base}${props.org}/a/${form.value.id}`
  navigator.clipboard.writeText(link).then(
    () => toast.success(`Accept link copied: ${link}`),
    () => toast.error('Could not copy link'),
  )
}

async function deleteDraft() {
  if (form.value.state !== 'draft') return
  if (!window.confirm(`Delete draft "${form.value.id}"? This removes assignments/${form.value.id}.yml from the control repo.`)) return
  deleting.value = true
  try {
    const token = getToken()
    const res = await deleteFile(token, props.org, config.controlRepo, `assignments/${form.value.id}.yml`, `Delete draft assignment ${form.value.id}`)
    if (res.ok) {
      toast.success(`Deleted draft ${form.value.id}`)
      editing.value = null
      await loadAssignments()
    } else {
      toast.error(`Delete failed: ${res.data?.message || 'unknown error'}`)
    }
  } finally {
    deleting.value = false
  }
}

async function setState(newState) {
  const warnings = {
    draft: `Unpublish "${form.value.id}" back to draft? Students can no longer open the accept link.`,
    closed: `Close "${form.value.id}"? Students can no longer accept it (existing repos are unaffected).`,
    archived: `Archive "${form.value.id}"? It leaves the student-facing list and day-to-day tracking.`,
  }
  if (warnings[newState] && !window.confirm(warnings[newState])) return
  saving.value = true
  try {
    const token = getToken()
    const path = `assignments/${form.value.id}.yml`
    const yaml = stringifyYaml(buildDoc(newState))
    const res = await commitFile(token, props.org, config.controlRepo, path, yaml, `Set ${form.value.id} state to ${newState}`)
    if (res.ok) {
      form.value.state = newState
      snapshotForm()
      toast.success(`${form.value.id} → ${newState}`)
      await loadAssignments()
    } else {
      toast.error(`Update failed: ${res.data?.message || 'unknown error'}`)
    }
  } finally {
    saving.value = false
  }
}

// ---------------------------------------------------------------- extension + retry

async function grantExtension() {
  if (!extForm.value.login || !extForm.value.reason) {
    toast.error('Login and reason are required')
    return
  }
  if (!extForm.value.deadline_local) {
    toast.error('Pick a new deadline for the extension.')
    return
  }
  extending.value = true
  try {
    const token = getToken()
    const newDeadlineUtc = localToUtc(extForm.value.deadline_local)

    // An extension must move the deadline forward, not shorten it. The floor
    // is the student's *current effective* deadline: an already-granted
    // extension (if later) wins over the assignment deadline — same rule as
    // the per-row modal in the report view.
    let currentEffective = localToUtc(form.value.deadline_at_local)
    try {
      const existingText = await getRepoContent(token, props.org, config.controlRepo, `overrides/${form.value.id}/${extForm.value.login}.json`)
      if (existingText) {
        const existingDoc = JSON.parse(existingText)
        const prevExt = (existingDoc?.overrides || []).filter((o) => o.type === 'deadline_extension').pop()
        if (prevExt?.value && (!currentEffective || new Date(prevExt.value) > new Date(currentEffective))) {
          currentEffective = prevExt.value
        }
      }
    } catch { /* unreadable override — fall back to the assignment deadline */ }
    if (currentEffective && new Date(newDeadlineUtc) <= new Date(currentEffective)) {
      toast.error(`The extension must be later than ${extForm.value.login}'s current effective deadline (${formatDate(currentEffective)}).`)
      return
    }
    const overrideDoc = {
      schema_version: 1,
      assignment_id: form.value.id,
      github_login: extForm.value.login,
      overrides: [
        {
          type: 'deadline_extension',
          value: newDeadlineUtc,
          reason: extForm.value.reason,
          overridden_by: 'admin-panel',
          overridden_at: new Date().toISOString(),
        },
      ],
    }
    const { valid, errors } = await validateAgainst('override', overrideDoc)
    if (!valid) {
      toast.error('Override failed validation: ' + errors.map((e) => `${e.instancePath} ${e.message}`).join('; '))
      return
    }
    const path = `overrides/${form.value.id}/${extForm.value.login}.json`
    const res = await commitFile(token, props.org, config.controlRepo, path, JSON.stringify(overrideDoc, null, 2) + '\n', `Grant extension to ${extForm.value.login} on ${form.value.id}`)
    if (res.ok) {
      toast.success(`Extension granted to ${extForm.value.login}`)
      extForm.value = { login: '', deadline_local: form.value.deadline_at_local, reason: '' }
    } else {
      toast.error(`Extension failed: ${res.data?.message || 'unknown error'}`)
    }
  } finally {
    extending.value = false
  }
}

async function retryAcceptance() {
  if (!retryForm.value.login) return
  retrying.value = true
  try {
    const token = getToken()
    const res = await triggerWorkflow(token, config.hubOwner, config.hubRepo, 'retry-acceptance.yml', {
      org: props.org,
      assignment_id: form.value.id,
      github_login: retryForm.value.login,
    })
    if (res.ok || res.status === 204) {
      toast.success(`Retry triggered for ${retryForm.value.login}`)
      retryForm.value = { login: '' }
    } else {
      toast.error(explainDispatchFailure(res, 'Retry failed'))
    }
  } finally {
    retrying.value = false
  }
}

// ---------------------------------------------------------------- lifecycle

onMounted(async () => {
  window.addEventListener('beforeunload', onBeforeUnload)
  await Promise.all([loadAssignments(), loadTemplates()])
})

onUnmounted(() => {
  window.removeEventListener('beforeunload', onBeforeUnload)
  stopPublishWatch()
})

watch(
  () => form.value.title,
  () => {
    if (isNew.value && !manualSlug.value) autoSyncSlug()
  }
)
</script>

<style scoped>
.admin-page {
  padding-top: var(--space-xl);
  padding-bottom: var(--space-2xl);
  max-width: 1400px;
}
.admin-header {
  display: flex;
  align-items: center;
  gap: var(--space-md);
  margin-bottom: var(--space-md);
}
.btn-with-icon { display: inline-flex; align-items: center; gap: var(--space-xs); }

.admin-tabs {
  display: flex;
  gap: 4px;
  border-bottom: 1px solid var(--border-default);
  margin-bottom: var(--space-lg);
}
.admin-tabs .tab {
  background: transparent;
  border: 1px solid transparent;
  border-bottom: none;
  padding: var(--space-sm) var(--space-md);
  color: var(--text-secondary);
  cursor: pointer;
  font: inherit;
  border-radius: 6px 6px 0 0;
  margin-bottom: -1px;
}
.admin-tabs .tab:hover { background: var(--bg-elevated, var(--bg-tertiary)); color: var(--text-primary); }
.admin-tabs .tab.active {
  background: var(--bg-secondary);
  border-color: var(--border-default);
  border-bottom-color: var(--bg-secondary);
  color: var(--text-primary);
}

.admin-layout {
  display: grid;
  grid-template-columns: 320px 1fr;
  gap: var(--space-lg);
  align-items: start;
}
@media (max-width: 900px) {
  .admin-layout { grid-template-columns: 1fr; }
}

/* LIST */
.list-pane {
  position: sticky;
  top: var(--space-md);
  background: var(--bg-secondary);
  border: 1px solid var(--border-default);
  border-radius: 8px;
  padding: var(--space-md);
  max-height: calc(100vh - 100px);
  overflow-y: auto;
}
.new-btn { width: 100%; margin-bottom: var(--space-md); }
.list-loading, .list-empty {
  padding: var(--space-md);
  color: var(--text-secondary);
  text-align: center;
}
.assignment-list { list-style: none; padding: 0; margin: 0; }
.assignment-list li {
  padding: var(--space-sm) var(--space-md);
  border-radius: 6px;
  cursor: pointer;
  margin-bottom: 4px;
  border: 1px solid transparent;
}
.assignment-list li:hover { background: var(--bg-elevated, var(--bg-tertiary)); }
.assignment-list li.active {
  background: var(--bg-elevated, var(--bg-tertiary));
  border-color: var(--accent-blue);
}
.assignment-list .title { font-weight: 600; }
.assignment-list .slug { font-size: 0.8rem; color: var(--text-secondary); font-family: var(--font-mono); }
.assignment-list .meta { display: flex; gap: var(--space-sm); margin-top: 4px; font-size: 0.8rem; color: var(--text-secondary); }

/* BADGES */
.badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 0.75rem;
  text-transform: lowercase;
}
.badge-draft { background: rgba(139,148,158,0.2); color: #adbac7; }
.badge-published { background: rgba(46,160,67,0.2); color: #56d364; }
.badge-closed { background: rgba(187,128,9,0.2); color: #e3b341; }
.badge-archived { background: rgba(139,148,158,0.1); color: #768390; }

/* EDITOR */
.editor-pane {
  background: var(--bg-secondary);
  border: 1px solid var(--border-default);
  border-radius: 8px;
  padding: var(--space-lg);
}
.empty-state {
  text-align: center;
  padding: var(--space-2xl);
  color: var(--text-secondary);
}
.editor-form { display: flex; flex-direction: column; gap: var(--space-md); }
.editor-title h3 { margin: 0 0 var(--space-md) 0; display: flex; align-items: center; gap: var(--space-sm); }

fieldset {
  border: 1px solid var(--border-default);
  border-radius: 6px;
  padding: var(--space-md);
  margin: 0;
}
legend {
  font-weight: 600;
  padding: 0 var(--space-xs);
  color: var(--accent-blue);
}
.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: var(--space-md);
}
.field:last-child { margin-bottom: 0; }
.field.checkbox { flex-direction: row; align-items: center; gap: var(--space-xs); }
.field.checkbox label { display: flex; align-items: center; gap: var(--space-xs); cursor: pointer; }
.field input[type="text"],
.field input[type="number"],
.field input[type="datetime-local"],
.field input:not([type]),
.field textarea,
.field select {
  width: 100%;
  padding: 8px 10px;
  background: var(--bg-primary);
  border: 1px solid var(--border-default);
  border-radius: 4px;
  color: var(--text-primary);
  font-family: inherit;
  font-size: 0.95rem;
}
.field textarea { resize: vertical; min-height: 60px; }
.field label { font-weight: 500; font-size: 0.9rem; color: var(--text-secondary); }
.field label .req { color: var(--accent-red); margin-left: 2px; }
.field small { color: var(--text-muted); font-size: 0.8rem; }
.field code { background: var(--bg-tertiary); padding: 0 4px; border-radius: 3px; font-size: 0.85em; }

.loading-inline { display: flex; align-items: center; gap: var(--space-sm); color: var(--text-secondary); }
.spinner.sm { width: 14px; height: 14px; border-width: 2px; }

details { border: 1px solid var(--border-default); border-radius: 6px; padding: var(--space-sm); }
details > summary { cursor: pointer; font-weight: 600; padding: var(--space-xs); }
details[open] > summary { margin-bottom: var(--space-md); }
details .field { padding: 0 var(--space-sm); }

.yaml-code {
  background: var(--bg-tertiary);
  padding: var(--space-md);
  border-radius: 4px;
  font-family: var(--font-mono);
  font-size: 0.85rem;
  overflow-x: auto;
}

.validation-errors {
  background: rgba(248,81,73,0.08);
  border: 1px solid var(--accent-red);
  border-radius: 6px;
  padding: var(--space-md);
  color: var(--accent-red);
}
.validation-errors ul { margin: var(--space-xs) 0 0 var(--space-md); padding: 0; }

.actions {
  display: flex;
  gap: var(--space-sm);
  justify-content: flex-end;
  padding-top: var(--space-md);
  border-top: 1px solid var(--border-default);
}

.lifecycle {
  margin-top: var(--space-lg);
  padding-top: var(--space-lg);
  border-top: 1px solid var(--border-default);
}
.lifecycle h4 { margin: 0 0 var(--space-md) 0; }
.lifecycle-actions { display: flex; gap: var(--space-sm); flex-wrap: wrap; margin-bottom: var(--space-md); }
.lifecycle-section { margin-bottom: var(--space-sm); }
.autograde-banner small {
  display: block;
  background: rgba(88,166,255,0.08);
  border-left: 3px solid var(--accent-blue);
  padding: var(--space-sm) var(--space-md);
  color: var(--text-secondary);
}
.text-warning { color: var(--accent-yellow); }
.text-secondary { color: var(--text-secondary); }

.tests-editor { display: flex; flex-direction: column; gap: var(--space-sm); margin-top: var(--space-sm); }
.test-row {
  border: 1px solid var(--border-default);
  border-radius: 6px;
  padding: var(--space-sm);
  display: flex;
  flex-direction: column;
  gap: 6px;
  background: var(--bg-primary);
}
.test-row-head { display: flex; gap: 6px; align-items: center; }
.test-row-head .test-id { flex: 1; min-width: 0; }
.test-row-head select { flex: 2; min-width: 0; }
.test-row-head .test-points { width: 72px; flex-shrink: 0; }
.test-remove { padding: 4px 8px; flex-shrink: 0; }
.test-row textarea { font-family: var(--font-mono); font-size: 0.85rem; min-height: 34px; }

.btn-danger { border-color: var(--accent-red); color: var(--accent-red); }
.btn-danger:hover { background: rgba(248, 81, 73, 0.1); }

.publish-watch {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  margin-bottom: var(--space-md);
  font-size: 0.9rem;
}
.publish-ready { color: var(--accent-green); }
.link-btn {
  background: none;
  border: none;
  color: var(--accent-blue);
  cursor: pointer;
  padding: 0;
  font: inherit;
  text-decoration: underline;
}
</style>
