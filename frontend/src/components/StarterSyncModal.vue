<template>
  <div class="modal-overlay" @click.self="$emit('close')">
    <div class="modal card modal-wide starter-sync-modal" role="dialog" aria-modal="true" aria-labelledby="starter-sync-title">
      <header class="modal-head flex justify-between items-center">
        <div>
          <h3 id="starter-sync-title">Sync Starter Code: <code>{{ assignment.id }}</code></h3>
          <span class="text-secondary text-sm">
            Template: <code>{{ templateFullName }}</code>
          </span>
        </div>
        <button class="modal-close" type="button" @click="$emit('close')" :disabled="dispatching" aria-label="Close">×</button>
      </header>

      <div class="modal-body flex flex-col gap-lg">
        <!-- Step 1: Template Changes & File Selector -->
        <section class="sync-section card">
          <div class="section-header flex justify-between items-center">
            <h4 class="section-title">1. Template Updates</h4>
            <span v-if="loadingTemplate" class="text-xs text-secondary">Loading template commits…</span>
            <span v-else-if="templateCommits.length" class="text-xs text-secondary">
              Latest commit: <code class="mono">{{ targetSha.slice(0, 7) }}</code>
            </span>
          </div>

          <div v-if="loadingTemplate" class="loading-state flex items-center gap-sm">
            <div class="spinner" style="width:16px;height:16px;border-width:2px;"></div>
            <span class="text-sm text-secondary">Inspecting template repository…</span>
          </div>

          <div v-else-if="templateError" class="text-error text-sm">
            {{ templateError }}
          </div>

          <div v-else class="template-diff-container flex flex-col gap-sm">
            <div class="commit-summary-box">
              <span class="commit-msg-headline font-semibold">{{ targetCommitTitle }}</span>
              <div class="text-xs text-muted">
                Committed by {{ targetCommitAuthor }} · {{ formatRelativeDate(targetCommitDate) }}
              </div>
            </div>

            <!-- Changed Files Selection -->
            <div class="file-selector-box">
              <div class="flex justify-between items-center mb-xs">
                <span class="text-xs font-semibold uppercase text-secondary">
                  Files to Synchronize ({{ selectedFileCount }}/{{ templateFiles.length }})
                </span>
                <div class="flex gap-xs">
                  <button type="button" class="btn-link text-xs" @click="selectAllFiles(true)">Select all</button>
                  <span class="text-muted text-xs">·</span>
                  <button type="button" class="btn-link text-xs" @click="selectAllFiles(false)">Deselect all</button>
                </div>
              </div>

              <div class="file-list-scrollable flex flex-col gap-xs">
                <div
                  v-for="file in templateFiles"
                  :key="file.filename"
                  class="file-row-box card"
                  :class="{ selected: file.selected }"
                  style="padding: 6px 10px; background: var(--bg-surface); border: 1px solid var(--border-default);"
                >
                  <div class="file-row flex items-center justify-between">
                    <label class="flex items-center gap-sm" style="cursor: pointer; margin: 0;">
                      <input type="checkbox" v-model="file.selected" @change="onFilesChanged" />
                      <code class="file-path">{{ file.filename }}</code>
                    </label>
                    <div class="flex items-center gap-sm">
                      <span class="file-diff-stat text-xs mono">
                        <span v-if="file.additions" class="stat-green">+{{ file.additions }}</span>
                        <span v-if="file.deletions" class="stat-red">-{{ file.deletions }}</span>
                      </span>
                      <button
                        v-if="file.patch"
                        type="button"
                        class="btn btn-xs btn-secondary diff-toggle-btn"
                        @click="toggleFileDiff(file.filename)"
                      >
                        {{ expandedDiffs[file.filename] ? 'Hide Diff' : 'View Diff' }}
                      </button>
                    </div>
                  </div>

                  <!-- Diff Patch View -->
                  <div v-if="expandedDiffs[file.filename]" class="diff-patch-view-container" style="margin-top: 8px;">
                    <pre class="diff-patch-pre mono text-xs" style="background: var(--bg-canvas); border-radius: 4px; max-height: 200px; overflow-y: auto; margin: 0; padding: 8px; line-height: 1.4;"><template v-for="(line, idx) in formatPatchLines(file.patch)" :key="idx"><span :style="line.type === 'diff-line-add' ? 'color: var(--accent-green); display: block; background: var(--tint-success-muted);' : line.type === 'diff-line-del' ? 'color: var(--accent-red); display: block; background: var(--tint-danger-muted);' : line.type === 'diff-line-hunk' ? 'color: var(--accent-blue); display: block;' : 'color: var(--text-muted); display: block;'">{{ line.text }}</span></template></pre>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <!-- Step 2: Preliminary Conflict & Merge Pre-Flight Scan -->
        <section class="sync-section card">
          <div class="section-header flex justify-between items-center">
            <h4 class="section-title">2. Student Repository Pre-Flight Analysis</h4>
            <button
              type="button"
              class="btn btn-xs btn-secondary btn-with-icon"
              @click="runPreFlightScan"
              :disabled="scanning || loadingTemplate"
            >
              <Icon name="refresh-cw" :size="12" />
              <span>{{ scanning ? 'Scanning…' : 'Re-scan' }}</span>
            </button>
          </div>

          <div v-if="scanning" class="scanning-box flex flex-col gap-xs">
            <div class="flex justify-between text-xs text-secondary">
              <span>Analyzing student branches for conflicts…</span>
              <span>{{ scanProgress.current }} / {{ scanProgress.total }}</span>
            </div>
            <div class="progress-bar-container">
              <div
                class="progress-bar-fill"
                :style="{ width: `${scanPercent}%` }"
              ></div>
            </div>
          </div>

          <div v-else class="preflight-summary-grid">
            <div class="preflight-card clean">
              <span class="preflight-count stat-green">{{ scanResults.autoMerged.length }}</span>
              <span class="status-indicator" style="margin-top: 4px;">
                <span class="status-dot dot-success"></span>
                <strong class="preflight-label">Clean Auto-Merge</strong>
              </span>
              <span class="preflight-desc">Merges cleanly to main (Zero student action required)</span>
            </div>

            <div class="preflight-card conflict">
              <span class="preflight-count stat-yellow">{{ scanResults.conflicts.length }}</span>
              <span class="status-indicator" style="margin-top: 4px;">
                <span class="status-dot dot-warning"></span>
                <strong class="preflight-label">Safe Pull Requests</strong>
              </span>
              <span class="preflight-desc">Conflicting edits detected; opens PR to protect student code</span>
            </div>

            <div class="preflight-card skipped">
              <span class="preflight-count text-muted">{{ scanResults.skipped.length }}</span>
              <span class="status-indicator" style="margin-top: 4px;">
                <span class="status-dot dot-neutral"></span>
                <strong class="preflight-label">Up to Date / Skipped</strong>
              </span>
              <span class="preflight-desc">Already at target SHA or repository unprovisioned</span>
            </div>
          </div>
        </section>

        <!-- Step 3: Message, Options & Dispatch -->
        <section class="sync-section card">
          <h4 class="section-title mb-sm">3. Update Details &amp; Notification</h4>

          <div class="form-group flex flex-col gap-sm">
            <div class="field">
              <label for="sync-pr-title" class="field-label">Commit / PR Title</label>
              <input
                id="sync-pr-title"
                v-model="customPrTitle"
                type="text"
                class="form-control"
                placeholder="Starter Code Update: description"
              />
            </div>

            <div class="field">
              <label for="sync-pr-body" class="field-label">Student Instructions (Markdown)</label>
              <textarea
                id="sync-pr-body"
                v-model="customPrBody"
                rows="3"
                class="form-control mono text-sm"
                placeholder="Optional instructions for students when merging..."
              ></textarea>
            </div>

            <label class="checkbox-row flex items-center gap-sm">
              <input type="checkbox" v-model="createIssue" />
              <span>Open an informational tracking Issue in each student repository</span>
            </label>
          </div>
        </section>

        <!-- Live Dispatch Status Banner -->
        <div v-if="dispatchStatus" class="dispatch-banner" :class="dispatchStatus.type">
          <span>{{ dispatchStatus.message }}</span>
          <a
            v-if="dispatchStatus.workflowUrl"
            :href="dispatchStatus.workflowUrl"
            target="_blank"
            rel="noopener"
            class="workflow-link"
          >
            View workflow run
          </a>
        </div>
      </div>

      <footer class="modal-foot flex justify-between items-center">
        <button class="btn btn-secondary" type="button" @click="$emit('close')" :disabled="dispatching">
          Cancel
        </button>
        <button
          class="btn btn-primary btn-with-icon"
          type="button"
          @click="handleDispatchSync"
          :disabled="dispatching || loadingTemplate || selectedFileCount === 0"
        >
          <Icon name="git-pull-request" :size="14" />
          <span>{{ dispatching ? 'Dispatching Sync…' : `Apply Starter Update (${targetStudentCount} repos)` }}</span>
        </button>
      </footer>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import Icon from './Icon.vue'
import { config } from '../lib/config.js'
import { getToken } from '../lib/auth.js'
import { ghApi, triggerWorkflow } from '../lib/api.js'
import { formatDate } from '../lib/format.js'
import { toast } from '../lib/toast.js'

const props = defineProps({
  assignment: { type: Object, required: true },
  org: { type: String, required: true },
  students: { type: Array, default: () => [] },
})

const emit = defineEmits(['close', 'synced'])

const loadingTemplate = ref(true)
const templateError = ref(null)
const templateCommits = ref([])
const targetSha = ref('')
const templateFiles = ref([])
const customPrTitle = ref('')
const customPrBody = ref('')
const createIssue = ref(true)
const scanning = ref(false)
const scanProgress = ref({ current: 0, total: 0 })
const dispatching = ref(false)
const dispatchStatus = ref(null)

const scanResults = ref({
  autoMerged: [],
  conflicts: [],
  skipped: [],
})

const templateFullName = computed(() => {
  const owner = props.assignment.template?.owner || props.org
  const repo = props.assignment.template?.repository
  return `${owner}/${repo}`
})

const targetCommitTitle = computed(() => {
  if (!templateCommits.value.length) return ''
  return templateCommits.value[0].commit?.message?.split('\n')[0] || 'Starter update'
})

const targetCommitAuthor = computed(() => {
  if (!templateCommits.value.length) return 'Author'
  return templateCommits.value[0].commit?.author?.name || templateCommits.value[0].author?.login || 'Template Maintainer'
})

const targetCommitDate = computed(() => {
  if (!templateCommits.value.length) return null
  return templateCommits.value[0].commit?.author?.date || null
})

const selectedFileCount = computed(() => templateFiles.value.filter((f) => f.selected).length)
const scanPercent = computed(() => {
  if (!scanProgress.value.total) return 0
  return Math.round((scanProgress.value.current / scanProgress.value.total) * 100)
})

const targetStudentCount = computed(() => {
  return scanResults.value.autoMerged.length + scanResults.value.conflicts.length
})

function formatRelativeDate(isoStr) {
  if (!isoStr) return ''
  try {
    const d = new Date(isoStr)
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

const expandedDiffs = ref({})

function toggleFileDiff(filename) {
  expandedDiffs.value[filename] = !expandedDiffs.value[filename]
}

function formatPatchLines(patch) {
  if (!patch) return [{ text: 'No diff patch available for this file.', type: 'diff-line-ctx' }]
  return patch.split('\n').map((line) => {
    if (line.startsWith('+') && !line.startsWith('+++')) {
      return { text: line, type: 'diff-line-add' }
    }
    if (line.startsWith('-') && !line.startsWith('---')) {
      return { text: line, type: 'diff-line-del' }
    }
    if (line.startsWith('@@')) {
      return { text: line, type: 'diff-line-hunk' }
    }
    return { text: line, type: 'diff-line-ctx' }
  })
}

function selectAllFiles(val) {
  for (const f of templateFiles.value) {
    f.selected = val
  }
}

function onFilesChanged() {
  // Re-run fast classification
  classifyStudents()
}

async function fetchTemplateData() {
  loadingTemplate.value = true
  templateError.value = null
  const token = getToken()

  try {
    const owner = props.assignment.template?.owner || props.org
    const repo = props.assignment.template?.repository
    if (!repo) {
      throw new Error('Assignment does not define a template repository.')
    }

    // 1. Fetch template commits
    const commitsRes = await ghApi(token, 'GET', `/repos/${owner}/${repo}/commits?per_page=5`)
    if (!commitsRes.ok || !commitsRes.data?.length) {
      throw new Error(`Failed to fetch template commits (HTTP ${commitsRes.status})`)
    }

    templateCommits.value = commitsRes.data
    const latest = commitsRes.data[0]
    targetSha.value = latest.sha
    customPrTitle.value = `Starter Code Update: ${latest.commit?.message?.split('\n')[0] || 'Template fixes'}`
    customPrBody.value = `### Starter Code Update\n\nThis update synchronizes fixes from \`${owner}/${repo}\` (commit \`${latest.sha.slice(0, 7)}\`).\n\n- Run \`git pull\` in your workspace to pull the latest changes.\n- If this is a PR, review the diff and click **Merge pull request**.`

    // 2. Fetch commit details for changed files
    const detailRes = await ghApi(token, 'GET', `/repos/${owner}/${repo}/commits/${latest.sha}`)
    if (detailRes.ok && detailRes.data?.files) {
      templateFiles.value = detailRes.data.files.map((f) => ({
        filename: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        patch: f.patch || null,
        selected: true,
      }))
    } else {
      templateFiles.value = [{ filename: 'All template files', selected: true, additions: 0, deletions: 0, patch: null }]
    }

    // 3. Trigger initial scan
    await runPreFlightScan()
  } catch (err) {
    templateError.value = err.message
  } finally {
    loadingTemplate.value = false
  }
}

async function runPreFlightScan() {
  scanning.value = true
  const token = getToken()
  const activeStudents = (props.students || []).filter((s) => s.repo_name)
  scanProgress.value = { current: 0, total: activeStudents.length }

  const clean = []
  const conflicted = []
  const skipped = []

  const CONCURRENCY = 4
  let cursor = 0

  async function worker() {
    while (cursor < activeStudents.length) {
      const idx = cursor++
      const s = activeStudents[idx]
      const repoName = s.repo_name?.split('/')[1] || s.repo_name

      try {
        const compRes = await ghApi(token, 'GET', `/repos/${props.org}/${repoName}/compare/${targetSha.value}...main`)
        if (compRes.ok && compRes.data) {
          if (compRes.data.status === 'identical') {
            skipped.push(s)
          } else if (compRes.data.status === 'behind') {
            // Student has no commits beyond template baseline
            clean.push(s)
          } else {
            // Check if student modified overlapping files
            const studentFiles = (compRes.data.files || []).map((f) => f.filename)
            const selectedTemplateFiles = templateFiles.value.filter((f) => f.selected).map((f) => f.filename)
            const overlap = studentFiles.some((f) => selectedTemplateFiles.includes(f))

            if (overlap) {
              conflicted.push(s)
            } else {
              clean.push(s)
            }
          }
        } else {
          // If compare fails, default to safe PR
          conflicted.push(s)
        }
      } catch {
        conflicted.push(s)
      }

      scanProgress.value.current++
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, activeStudents.length) }, worker))

  scanResults.value = {
    autoMerged: clean,
    conflicts: conflicted,
    skipped,
  }
  scanning.value = false
}

function classifyStudents() {
  // Fast re-scan with updated file selections
  runPreFlightScan()
}

async function handleDispatchSync() {
  dispatching.value = true
  dispatchStatus.value = null
  const token = getToken()

  try {
    const selectedFilesPayload = JSON.stringify(
      templateFiles.value.filter((f) => f.selected).map((f) => f.filename)
    )

    const inputs = {
      org: props.org,
      assignment_id: props.assignment.id,
      selected_files: selectedFilesPayload,
      pr_title: customPrTitle.value,
      pr_body: customPrBody.value,
      create_issue: String(createIssue.value),
    }

    const res = await triggerWorkflow(token, config.hubOwner, config.hubRepo, 'sync-starter-code.yml', inputs)
    if (!res.ok) {
      throw new Error(`Failed to dispatch sync workflow: ${res.error || 'Unknown error'}`)
    }

    dispatchStatus.value = {
      type: 'success',
      message: 'Starter code synchronization workflow dispatched successfully.',
      workflowUrl: `https://github.com/${config.hubOwner}/${config.hubRepo}/actions/workflows/sync-starter-code.yml`,
    }
    toast.success('Starter sync workflow dispatched.')
    emit('synced')
  } catch (err) {
    dispatchStatus.value = {
      type: 'error',
      message: err.message,
    }
    toast.error(err.message)
  } finally {
    dispatching.value = false
  }
}

onMounted(() => {
  fetchTemplateData()
})
</script>

<style scoped>
.modal-wide {
  max-width: 720px;
  width: 95vw;
}

.sync-section {
  padding: var(--space-md);
  background: var(--bg-surface);
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-md);
}

.section-title {
  font-size: 0.95rem;
  font-weight: 600;
  margin: 0;
}

.commit-summary-box {
  padding: var(--space-xs) var(--space-sm);
  background: var(--bg-canvas);
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-sm);
}

.file-selector-box {
  margin-top: var(--space-xs);
}

.file-list-scrollable {
  max-height: 140px;
  overflow-y: auto;
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-sm);
  padding: var(--space-xs);
  background: var(--bg-canvas);
}

.file-row {
  padding: 4px 8px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  margin-bottom: 2px;
}

.file-row:hover {
  background: var(--bg-surface-hover);
}

.file-row.selected {
  background: var(--tint-accent-subtle);
}

.preflight-summary-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: var(--space-sm);
  margin-top: var(--space-sm);
}

.preflight-card {
  display: flex;
  flex-direction: column;
  padding: var(--space-sm);
  background: var(--bg-surface-hover);
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-sm);
}

.preflight-count {
  font-size: 1.3rem;
  font-weight: 700;
  line-height: 1.2;
}

.preflight-label {
  font-size: 0.8rem;
  font-weight: 600;
}

.preflight-desc {
  font-size: 0.72rem;
  color: var(--text-muted);
  margin-top: 4px;
}

.progress-bar-container {
  height: 6px;
  background: var(--bg-canvas);
  border-radius: 3px;
  overflow: hidden;
}

.progress-bar-fill {
  height: 100%;
  background: var(--accent-blue);
  transition: width 0.2s ease;
}

.dispatch-banner {
  padding: var(--space-sm);
  border-radius: var(--radius-sm);
  font-size: 0.85rem;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.dispatch-banner.success {
  background: var(--tint-success-subtle);
  border: 1px solid var(--accent-green);
  color: var(--accent-green);
}

.dispatch-banner.error {
  background: var(--tint-danger-subtle);
  border: 1px solid var(--accent-red);
  color: var(--accent-red);
}

.workflow-link {
  color: inherit;
  font-weight: 600;
  text-decoration: underline;
}

.btn-link {
  background: none;
  border: none;
  color: var(--accent-blue);
  cursor: pointer;
  padding: 0;
}

.btn-link:hover {
  text-decoration: underline;
}
</style>
