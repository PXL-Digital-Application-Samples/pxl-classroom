<template>
  <section class="roster-tab">
    <div class="roster-header">
      <h3>Roster — {{ org }}</h3>
      <p class="text-secondary">
        Import or update <code>students/roster.yml</code> in <code>{{ org }}/{{ controlRepo }}</code>.
        Drop a CSV (header row required) or paste below. The diff is previewed before commit.
      </p>
    </div>

    <div class="roster-grid">
      <!-- INPUT -->
      <div class="input-pane">
        <div class="field">
          <label>Upload CSV</label>
          <input type="file" accept=".csv,text/csv" @change="onFileChange" />
          <small>Required columns: <code>student_number</code>, <code>full_name</code>. Optional: <code>email</code>, <code>class_group</code>, <code>github_login</code>, <code>github_id</code>, <code>active</code>.</small>
        </div>

        <div class="field">
          <label>or paste CSV</label>
          <textarea
            v-model="csvText"
            rows="10"
            placeholder="student_number,full_name,email,class_group,github_login&#10;0123456,Alice Example,alice@stud.pxl.be,3A,alice-test"
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
        <div v-else>
          <h4>Diff vs. committed roster</h4>
          <div v-if="!existingRoster" class="diff-info">
            No existing <code>students/roster.yml</code> in <code>{{ org }}/{{ controlRepo }}</code> — this will create one.
          </div>

          <div class="diff-summary">
            <span class="diff-badge added">+ {{ diff.added.length }} added</span>
            <span class="diff-badge updated">~ {{ diff.updated.length }} updated</span>
            <span class="diff-badge removed">- {{ diff.removed.length }} removed</span>
          </div>

          <details v-if="diff.added.length" open>
            <summary>Added ({{ diff.added.length }})</summary>
            <ul>
              <li v-for="s in diff.added" :key="s.student_number">
                <code>{{ s.student_number }}</code> {{ s.full_name }}
                <span v-if="s.github_login"> · @{{ s.github_login }}</span>
                <span v-if="s.class_group"> · {{ s.class_group }}</span>
              </li>
            </ul>
          </details>

          <details v-if="diff.updated.length">
            <summary>Updated ({{ diff.updated.length }})</summary>
            <ul>
              <li v-for="u in diff.updated" :key="u.after.student_number">
                <code>{{ u.after.student_number }}</code> {{ u.after.full_name }}
                <span class="changed-fields">[{{ changedFields(u).join(', ') }}]</span>
              </li>
            </ul>
          </details>

          <details v-if="diff.removed.length">
            <summary>Removed ({{ diff.removed.length }})</summary>
            <ul>
              <li v-for="s in diff.removed" :key="s.student_number">
                <code>{{ s.student_number }}</code> {{ s.full_name }}
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
  </section>
</template>

<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { csvToRoster, diffRosters } from '../lib/csv.js'
import { validateAgainst } from '../lib/validate.js'
import { getToken } from '../lib/auth.js'
import { commitFile, getRepoContent } from '../lib/api.js'
import { config } from '../lib/config.js'
import { toast } from '../lib/toast.js'

const props = defineProps({ org: { type: String, required: true } })

const controlRepo = config.controlRepo

const csvText = ref('')
const parsedRoster = ref(null)
const parseError = ref('')
const validationErrors = ref([])

const existingRoster = ref(null)
const loadingExisting = ref(false)
const committing = ref(false)

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

async function loadExisting() {
  loadingExisting.value = true
  try {
    const token = getToken()
    const text = await getRepoContent(token, props.org, controlRepo, 'students/roster.yml')
    existingRoster.value = text ? parseYaml(text) : null
  } catch (e) {
    if (e?.status === 401) {
      toast.error('Session expired — sign in again.')
      return
    }
    console.error('Failed to load roster', e)
    existingRoster.value = null
  } finally {
    loadingExisting.value = false
  }
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
      validationErrors.value = errors.map((e) =>
        `${e.instancePath || '(root)'} ${e.message}` + (e.params?.allowedValue !== undefined ? ` (allowed: ${JSON.stringify(e.params.allowedValue)})` : ''))
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

async function onFileChange(ev) {
  const file = ev.target.files?.[0]
  if (!file) return
  const text = await file.text()
  csvText.value = text
  await parseAndValidate()
}

async function commitRoster() {
  if (!canCommit.value) return
  committing.value = true
  try {
    const token = getToken()
    const yaml = stringifyYaml(parsedRoster.value)
    const message = `Update students/roster.yml via Admin Panel (+${diff.value.added.length} ~${diff.value.updated.length} -${diff.value.removed.length})`
    const res = await commitFile(token, props.org, controlRepo, 'students/roster.yml', yaml, message)
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

watch(() => props.org, () => loadExisting())

onMounted(loadExisting)
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

.diff-info {
  padding: var(--space-sm) var(--space-md);
  background: rgba(46,160,67,0.08);
  border-left: 3px solid #56d364;
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
.diff-badge.added   { background: rgba(46,160,67,0.15);  color: #56d364; }
.diff-badge.updated { background: rgba(187,128,9,0.15);  color: #e3b341; }
.diff-badge.removed { background: rgba(248,81,73,0.15);  color: var(--accent-red); }

.diff-pane details { border: 1px solid var(--border-default); border-radius: 6px; padding: var(--space-sm); margin-bottom: var(--space-sm); }
.diff-pane summary { cursor: pointer; font-weight: 600; padding: var(--space-xs); }
.diff-pane ul { list-style: none; padding: 0 var(--space-sm); margin: var(--space-xs) 0 0 0; max-height: 240px; overflow-y: auto; }
.diff-pane li { font-size: 0.9rem; padding: 2px 0; }
.diff-pane code { background: var(--bg-tertiary); padding: 0 4px; border-radius: 3px; font-family: var(--font-mono); font-size: 0.85em; }
.changed-fields { color: var(--text-muted); font-size: 0.8rem; font-family: var(--font-mono); margin-left: 6px; }

.diff-empty { padding: var(--space-md); color: var(--text-secondary); text-align: center; }

.validation-errors {
  background: rgba(248,81,73,0.08);
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
</style>
