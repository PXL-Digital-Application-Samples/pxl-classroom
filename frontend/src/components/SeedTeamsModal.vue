<template>
  <div class="modal-overlay" @click.self="close">
    <div class="modal seed-modal" role="dialog" aria-modal="true" aria-label="Seed teams">
      <header class="modal-head">
        <h3>Seed teams — {{ assignment.id }}</h3>
        <button class="modal-close" type="button" @click="close" aria-label="Close">×</button>
      </header>

      <div class="modal-body flex flex-col gap-md">
        <p class="seed-lede">
          Carry an existing grouping into this assignment. Students keep the group they already
          worked in and confirm it with one click, instead of forming teams from scratch.
        </p>

        <!-- Source -->
        <div class="field">
          <label for="seed-source">Take the groups from</label>
          <select id="seed-source" v-model="sourceKey" class="form-control" :disabled="applying">
            <option value="">Select a source…</option>
            <optgroup v-if="sourceAssignments.length" label="A previous group assignment">
              <option v-for="a in sourceAssignments" :key="a.id" :value="`assignment:${a.id}`">
                {{ a.title || a.id }}
              </option>
            </optgroup>
            <option value="roster">The roster’s team_slug / team_name columns</option>
          </select>
          <small class="form-hint">
            <template v-if="loadingSources">Looking for group assignments in {{ org }}…</template>
            <template v-else-if="sourceAssignments.length === 0">
              No other group assignment exists in this organization yet — the roster columns are the
              only source. Fill them from the Roster tab’s CSV import.
            </template>
            <template v-else>
              The most recent grouping is the safest source: it reflects every switch and dropout.
            </template>
          </small>
        </div>

        <!-- Loading -->
        <div v-if="loading" class="seed-status">
          <span class="spinner-sm"></span>
          <span class="text-secondary">Reading {{ loadingLabel }}…</span>
        </div>

        <!-- Read failure -->
        <div v-else-if="loadError" class="diag-banner seed-banner-danger">
          <div>
            <strong>Could not read the source.</strong>
            <p class="seed-banner-text">{{ loadError }}</p>
          </div>
        </div>

        <template v-else-if="plan">
          <!-- Blocking errors -->
          <div v-if="!plan.ok" class="diag-banner seed-banner-danger">
            <div>
              <strong>Nothing was seeded.</strong>
              <ul class="seed-list">
                <li v-for="(e, i) in plan.errors" :key="i">{{ e.message }}</li>
              </ul>
            </div>
          </div>

          <template v-else>
            <!-- Summary -->
            <div class="seed-summary">
              <div class="seed-stat">
                <span class="seed-stat-value">{{ plan.stats.teams }}</span>
                <span class="seed-stat-label">teams</span>
              </div>
              <div class="seed-stat">
                <span class="seed-stat-value">{{ plan.stats.students }}</span>
                <span class="seed-stat-label">students</span>
              </div>
              <div v-if="plan.stats.skipped" class="seed-stat">
                <span class="seed-stat-value">{{ plan.stats.skipped }}</span>
                <span class="seed-stat-label">skipped</span>
              </div>
              <span class="status-indicator seed-summary-note">
                <span class="status-dot" :class="plan.warnings.length ? 'dot-warning' : 'dot-success'"></span>
                <span>{{ plan.warnings.length ? 'Ready, with notes' : 'Ready to seed' }}</span>
              </span>
            </div>

            <!-- Warnings -->
            <div v-if="plan.warnings.length" class="diag-banner seed-banner-warn">
              <div>
                <strong>Worth checking first</strong>
                <ul class="seed-list">
                  <li v-for="(w, i) in plan.warnings" :key="i">{{ w.message }}</li>
                </ul>
              </div>
            </div>

            <!-- Everything in the source is already covered here -->
            <p v-if="plan.teams.length === 0" class="seed-footnote">
              Nothing left to seed — every team from this source already exists in
              <code>{{ assignment.id }}</code>, or its members have joined other teams here.
            </p>

            <!-- Preview -->
            <div v-else class="seed-preview">
              <div class="seed-preview-head">
                <span class="text-secondary text-sm">Teams to create</span>
                <span class="text-muted text-xs">members are added as listed</span>
              </div>
              <ul class="seed-preview-list">
                <li v-for="t in plan.teams" :key="t.team_slug" class="seed-preview-row">
                  <div class="seed-preview-team">
                    <strong>{{ t.team_name }}</strong>
                    <code class="seed-preview-slug">{{ t.team_slug }}</code>
                  </div>
                  <div class="seed-preview-members">
                    <span v-for="m in t.members" :key="m" class="seed-member">@{{ m }}</span>
                  </div>
                  <span class="mono text-xs text-muted">{{ t.members.length }}/{{ t.max_members }}</span>
                </li>
              </ul>
            </div>

            <p v-if="plan.teams.length" class="seed-footnote">
              Teams are written to the control repository now and become visible to students when
              the assignment is published. Nothing is provisioned until a student accepts.
            </p>
          </template>
        </template>
      </div>

      <footer class="modal-foot">
        <button class="btn btn-secondary" type="button" :disabled="applying" @click="close">Cancel</button>
        <button
          class="btn btn-primary"
          type="button"
          :disabled="!canApply"
          @click="apply"
        >
          {{ applying ? 'Seeding…' : plan?.ok ? `Seed ${plan.stats.teams} team(s)` : 'Seed teams' }}
        </button>
      </footer>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted } from 'vue'
import { getToken, getUser } from '../lib/auth.js'
import { listTeams, commitFiles, getRepoContent, listRepoDir, triggerWorkflow } from '../lib/api.js'
import { config } from '../lib/config.js'
import { toast } from '../lib/toast.js'
import { planSeed, teamsFromRoster, seedCommitMessage } from '../../../lib/seed-teams.mjs'
import { parse as parseYaml } from 'yaml'

const props = defineProps({
  org: { type: String, required: true },
  // Target assignment document (needs id, assignment_type, group_config,
  // repository_name_pattern, roster_mode, max_acceptances).
  assignment: { type: Object, required: true },
  // Candidate sources. Callers that already hold the org's assignment list pass
  // it; the rest leave it empty and only the roster source is offered.
  assignments: { type: Array, default: () => [] },
})

const emit = defineEmits(['close', 'seeded'])

const sourceKey = ref('')
const discovered = ref([])
const loadingSources = ref(false)
const loading = ref(false)
const loadError = ref(null)
const plan = ref(null)
const applying = ref(false)

const sourceAssignments = computed(() => {
  const list = (props.assignments || []).length ? props.assignments : discovered.value
  return list
    .filter((a) => a.assignment_type === 'group' && a.id !== props.assignment.id)
    .sort((a, b) => String(b.deadline_at || '').localeCompare(String(a.deadline_at || '')))
})

// Callers that already hold the org's assignments pass them; the assignment
// detail page only knows its own, so the modal discovers the rest itself.
onMounted(async () => {
  if ((props.assignments || []).length) return
  loadingSources.value = true
  const token = getToken()
  try {
    const files = (await listRepoDir(token, props.org, config.controlRepo, 'assignments')).filter(
      (f) => f.type === 'file' && f.name.endsWith('.yml')
    )
    const docs = []
    let cursor = 0
    const worker = async () => {
      while (cursor < files.length) {
        const f = files[cursor++]
        try {
          const text = await getRepoContent(token, props.org, config.controlRepo, f.path)
          if (!text) continue
          const doc = parseYaml(text)
          docs.push({ ...doc, id: doc.id || f.name.replace(/\.yml$/, '') })
        } catch { /* one unreadable assignment must not hide the others */ }
      }
    }
    await Promise.all(Array.from({ length: Math.min(6, files.length || 1) }, worker))
    discovered.value = docs
  } catch {
    // Discovery is a convenience: the roster source stays available.
  } finally {
    loadingSources.value = false
  }
})

const sourceAssignment = computed(() => {
  if (!sourceKey.value.startsWith('assignment:')) return null
  const id = sourceKey.value.slice('assignment:'.length)
  return sourceAssignments.value.find((a) => a.id === id) || null
})

const loadingLabel = computed(() =>
  sourceKey.value === 'roster' ? 'the roster' : sourceAssignment.value?.title || 'the source assignment'
)

const canApply = computed(
  () => !!plan.value?.ok && plan.value.teams.length > 0 && !applying.value && !loading.value
)

watch(sourceKey, () => {
  plan.value = null
  loadError.value = null
  if (sourceKey.value) buildPlan()
})

async function buildPlan() {
  loading.value = true
  loadError.value = null
  plan.value = null
  const token = getToken()
  try {
    const existingTeams = await listTeams(token, props.org, config.controlRepo, props.assignment.id)
    let sourceTeams = []
    let roster = null

    try {
      const rosterText = await getRepoContent(token, props.org, config.controlRepo, 'students/roster.yml')
      if (rosterText) roster = parseYaml(rosterText)
    } catch {
      // No roster is a warning-level fact, not a reason to refuse to plan.
    }

    if (sourceKey.value === 'roster') {
      sourceTeams = teamsFromRoster(roster?.students || [], { assignmentId: props.assignment.id })
    } else if (sourceAssignment.value) {
      sourceTeams = await listTeams(token, props.org, config.controlRepo, sourceAssignment.value.id)
    }

    plan.value = planSeed({
      sourceTeams,
      existingTeams,
      targetAssignment: props.assignment,
      sourceAssignment: sourceKey.value === 'roster' ? null : sourceAssignment.value,
      roster,
      now: new Date().toISOString(),
      actor: getUser()?.login || 'lecturer',
      source: sourceKey.value === 'roster' ? 'roster' : 'assignment',
    })
  } catch (e) {
    loadError.value = e?.message || 'Unknown error'
  } finally {
    loading.value = false
  }
}

async function apply() {
  if (!plan.value?.ok) return
  applying.value = true
  try {
    const token = getToken()
    const sourceLabel = sourceKey.value === 'roster' ? 'the roster' : sourceAssignment.value?.id
    const res = await commitFiles(
      token,
      props.org,
      config.controlRepo,
      plan.value.changes,
      seedCommitMessage(plan.value, { targetId: props.assignment.id, sourceLabel })
    )
    if (!res.ok) {
      toast.error(`Could not write the teams: ${res.error}`)
      return
    }

    // Students read the published teams file, not the control repo. Without
    // this regeneration a seeded team exists but is invisible to them.
    await triggerWorkflow(token, config.hubOwner, config.hubRepo, 'regenerate-dashboard.yml', {
      org: props.org,
    })

    toast.success(
      `Seeded ${plan.value.stats.teams} team(s) with ${plan.value.stats.students} student(s) into ${props.assignment.id}.`
    )
    emit('seeded', { teams: plan.value.stats.teams, students: plan.value.stats.students })
    emit('close')
  } catch (e) {
    toast.error(`Seeding failed: ${e.message}`)
  } finally {
    applying.value = false
  }
}

function close() {
  if (applying.value) return
  emit('close')
}
</script>

<style scoped>
.seed-modal {
  max-width: 640px;
}

.seed-lede {
  margin: 0;
  font-size: 0.875rem;
  color: var(--text-secondary);
  line-height: 1.45;
}

.seed-status {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  font-size: 0.875rem;
}

/* Tonal wells rather than another ring of boxes (DESIGN.md §1.1): the modal
   already outlines itself, so the banners and the preview separate by tone. */
.seed-banner-danger {
  background: var(--tint-danger-subtle);
  border: 1px solid var(--tint-danger-emphasis);
  color: var(--accent-red);
}

.seed-banner-warn {
  background: var(--tint-attention-subtle);
  border: 1px solid var(--tint-attention-emphasis);
  color: var(--accent-yellow);
}

.seed-banner-text {
  margin: 2px 0 0 0;
  font-size: 0.85rem;
  color: var(--text-secondary);
}

.seed-list {
  margin: 4px 0 0 0;
  padding-left: 18px;
  font-size: 0.85rem;
  color: var(--text-secondary);
  line-height: 1.45;
}

.seed-summary {
  display: flex;
  align-items: baseline;
  gap: var(--space-lg);
  flex-wrap: wrap;
  padding: var(--space-sm) var(--space-md);
  background: var(--bg-inset);
  border-radius: var(--radius-sm);
}

.seed-stat {
  display: flex;
  align-items: baseline;
  gap: 6px;
}

.seed-stat-value {
  font-size: 1.25rem;
  font-weight: 600;
  color: var(--text-primary);
}

.seed-stat-label {
  font-size: 0.8rem;
  color: var(--text-muted);
}

.seed-summary-note {
  margin-left: auto;
  font-size: 0.8rem;
}

.seed-preview-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin-bottom: var(--space-xs);
}

.seed-preview-list {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 260px;
  overflow-y: auto;
  background: var(--bg-inset);
  border-radius: var(--radius-sm);
}

.seed-preview-row {
  display: flex;
  align-items: center;
  gap: var(--space-md);
  padding: 8px var(--space-md);
  border-bottom: 1px solid var(--border-muted);
}

.seed-preview-row:last-child {
  border-bottom: none;
}

.seed-preview-team {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 160px;
}

.seed-preview-slug {
  font-size: 0.72rem;
  color: var(--text-muted);
}

.seed-preview-members {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  flex: 1;
}

.seed-member {
  font-size: 0.72rem;
  font-family: var(--font-mono);
  color: var(--text-secondary);
}

.seed-footnote {
  margin: 0;
  font-size: 0.8rem;
  color: var(--text-muted);
  line-height: 1.45;
}
</style>
