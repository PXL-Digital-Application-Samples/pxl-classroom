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
        <template v-if="!following">
        <!-- A sync of THIS assignment already running or queued, found from
             the hub's run list by its run-name - the only thing that knows
             about one before it has written a record. On 2026-09-25 two were
             started 14 seconds apart, the second by a lecturer unsure the
             first had gone. -->
        <div v-if="activeRun" class="dispatch-banner info" data-banner="active-sync">
          <span>
            A sync of this assignment is already {{ activeRun.status === 'in_progress' ? 'running' : 'waiting to start' }}
            (started {{ formatRelativeDate(activeRun.created_at) }}{{ activeRun.actor?.login ? ` by @${activeRun.actor.login}` : '' }}).
            Starting another now waits until it ends.
          </span>
          <button type="button" class="btn btn-secondary btn-sm" @click="startFollowing({ runId: activeRun.id, htmlUrl: activeRun.html_url })">
            Follow it
          </button>
        </div>

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

          <div v-else-if="templateError" class="text-danger text-sm">
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
                  Files this commit changed ({{ templateFiles.filter((f) => f.selected).length }}/{{ templateFiles.length }} selected)
                </span>
                <div class="flex gap-xs">
                  <button type="button" class="btn-link text-xs" @click="selectAllFiles(true)">Select all</button>
                  <span class="text-muted text-xs">·</span>
                  <button type="button" class="btn-link text-xs" @click="selectAllFiles(false)">Deselect all</button>
                </div>
              </div>

              <p v-if="truncatedCommit" class="text-xs stat-yellow" style="margin: 0 0 var(--space-xs) 0;">
                This commit changed more than 300 files, and GitHub lists only the first 300 here. Every changed file is still sent.
              </p>

              <div class="file-list-scrollable flex flex-col gap-xs">
                <div
                  v-for="file in templateFiles"
                  :key="file.filename"
                  class="file-row-box"
                  :class="{ selected: file.selected }"
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
                    <pre class="diff-patch-pre mono text-xs"><template v-for="(line, idx) in formatPatchLines(file.patch)" :key="idx"><span :style="line.type === 'diff-line-add' ? 'color: var(--accent-green); display: block; background: var(--tint-success-muted);' : line.type === 'diff-line-del' ? 'color: var(--accent-red); display: block; background: var(--tint-danger-muted);' : line.type === 'diff-line-hunk' ? 'color: var(--accent-blue); display: block;' : 'color: var(--text-muted); display: block;'">{{ line.text }}</span></template></pre>
                  </div>
                </div>
              </div>

              <!-- EARLIER CHANGES SOME STUDENTS ARE STILL MISSING. Each student
                   is sent everything between where they are and this commit,
                   so a sync that stopped part-way, or a commit never synced,
                   is caught up here - listed, so it is not a surprise in a
                   student's repository. -->
              <template v-if="catchUpFiles.length">
                <span class="text-xs font-semibold uppercase text-secondary catch-up-head">
                  Earlier template changes some students are still missing
                  ({{ catchUpFiles.filter((f) => f.selected).length }}/{{ catchUpFiles.length }} selected)
                </span>
                <div class="file-list-scrollable flex flex-col gap-xs">
                  <div
                    v-for="file in catchUpFiles"
                    :key="file.filename"
                    class="file-row-box"
                    :class="{ selected: file.selected }"
                  >
                    <div class="file-row flex items-center justify-between">
                      <label class="flex items-center gap-sm catch-up-path" style="cursor: pointer; margin: 0;">
                        <input type="checkbox" v-model="file.selected" @change="onFilesChanged" />
                        <code class="file-path" :title="file.filename">{{ file.filename }}</code>
                      </label>
                      <span class="text-xs text-muted catch-up-count">
                        {{ file.status === 'removed' ? 'removed from the template' : 'missing' }} for
                        {{ file.students }} student{{ file.students === 1 ? '' : 's' }}
                      </span>
                    </div>
                  </div>
                </div>
              </template>
              <p v-if="otherTemplate.length" class="text-xs text-muted catch-up-note">
                The template changed since {{ otherTemplate.join(', ') }} accepted, so the full starter code will be
                sent: files that are still the starter code are replaced, and files they changed arrive as a pull
                request.
              </p>
              <p v-if="unknownStart" class="text-xs text-muted catch-up-note">
                For {{ unknownStart }} student{{ unknownStart === 1 ? '' : 's' }} it is not known which template
                version they started from, so they are sent only this commit's changes.
              </p>
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
              <span>Reading student repositories…</span>
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
                <strong class="preflight-label">Updated in place</strong>
              </span>
              <span class="preflight-desc">Has not touched these files, so they are written straight to main</span>
            </div>

            <div class="preflight-card conflict">
              <span class="preflight-count stat-yellow">{{ scanResults.conflicts.length }}</span>
              <span class="status-indicator" style="margin-top: 4px;">
                <span class="status-dot dot-warning"></span>
                <strong class="preflight-label">Pull request</strong>
              </span>
              <span class="preflight-desc">Has changed at least one of them; their work is not overwritten</span>
            </div>

            <div class="preflight-card skipped">
              <span class="preflight-count text-muted">{{ scanResults.skipped.length }}</span>
              <span class="status-indicator" style="margin-top: 4px;">
                <span class="status-dot dot-neutral"></span>
                <strong class="preflight-label">Nothing to do</strong>
              </span>
              <span class="preflight-desc">Already has every selected change</span>
            </div>

            <!-- A repository that could not be read is not "nothing to do".
                 The scan used to fold every failed request into the conflict
                 bucket, so an unreachable repo looked like a student who had
                 edited the file. -->
            <div v-if="scanResults.failed.length" class="preflight-card unreadable">
              <span class="preflight-count stat-red">{{ scanResults.failed.length }}</span>
              <span class="status-indicator" style="margin-top: 4px;">
                <span class="status-dot dot-danger"></span>
                <strong class="preflight-label">Could not read</strong>
              </span>
              <span class="preflight-desc">{{ scanResults.failed[0].reason }}</span>
            </div>
          </div>
          <!-- Only once the template actually loaded: `baseSha` starts null, so
               gating on it alone claims "first commit" over a failed read. -->
          <p v-if="!scanning && !loadingTemplate && !templateError && templateCommits.length && baseSha === null"
             class="text-xs text-muted" style="margin-top: var(--space-xs);">
            This is the template's first commit, so every file in it counts as new.
          </p>
        </section>

        <!-- Step 3: Message, Options & Dispatch -->
        <section class="sync-section card">
          <h4 class="section-title mb-sm">3. Update Details &amp; Notification</h4>

          <div class="form-group flex flex-col gap-sm">
            <div class="field">
              <label for="sync-pr-title">Commit / PR Title</label>
              <input
                id="sync-pr-title"
                v-model="customPrTitle"
                type="text"
                class="form-control"
                placeholder="Starter Code Update: description"
              />
            </div>

            <div class="field">
              <label for="sync-pr-body">Student Instructions (Markdown)</label>
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
        </template>

        <!-- FOLLOWING ONE RUN. Checked every 10 seconds while this dialog is
             open and not at all once it closes - the assignment page's
             Starter code line takes over from there, and can reopen this.
             The words come from lib/sync-status.mjs `describeFollow`. -->
        <section v-else class="sync-section follow-panel" :data-state="followView?.state || 'starting'" aria-live="polite">
          <h4 class="section-title">{{ followView?.done ? 'Starter code sync' : 'Syncing starter code' }}</h4>
          <p v-if="!followView" class="text-sm text-secondary">Checking the run…</p>
          <template v-else>
            <span class="status-indicator follow-headline">
              <span :class="['status-dot', followDot]"></span>
              <!-- The sha in monospace (DESIGN.md §2), cut out of the sentence
                   lib/sync-status.mjs wrote, never a second sentence. -->
              <strong><template v-for="(part, i) in followTitleParts" :key="i"><code v-if="part.code">{{ part.text }}</code><template v-else>{{ part.text }}</template></template></strong>
            </span>
            <p v-if="followView.detail" class="text-sm text-secondary follow-detail">{{ followView.detail }}</p>
            <!-- While it runs only; the sentence above already carries the
                 count, so the bar has no caption of its own. -->
            <div v-if="!followView.done && followView.progress && followView.progress.total" class="progress-bar-container">
              <div class="progress-bar-fill" :style="{ width: `${followPercent}%` }"></div>
            </div>
            <ul v-if="followView.failed.length" class="follow-failed text-sm">
              <li v-for="f in followView.failed" :key="f.login"><code>@{{ f.login }}</code>: {{ f.error }}</li>
            </ul>
          </template>
          <p class="text-xs text-muted follow-meta">
            <a v-if="following.htmlUrl" :href="following.htmlUrl" target="_blank" rel="noopener">View run</a>
            <span v-if="followView && !followView.done">
              Checked {{ lastChecked }}. Checks every 10 seconds while this is open; you can close it and follow it again from the assignment page.
            </span>
            <span v-else-if="followView?.done">Finished checking at {{ lastChecked }}.</span>
          </p>
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

      <!-- Following: closing is the only action, and it stops nothing but the
           checking - the sync runs on GitHub either way. No primary button:
           there is no decision left to make here. -->
      <footer v-if="following" class="modal-foot flex justify-end items-center">
        <button class="btn btn-secondary" type="button" @click="$emit('close')">Close</button>
      </footer>
      <footer v-else class="modal-foot flex justify-between items-center">
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
import { ref, computed, onMounted, onUnmounted } from 'vue'
import Icon from './Icon.vue'
import { config } from '../lib/config.js'
import { getToken } from '../lib/auth.js'
import { ghApi, getRepoContent, dispatchWorkflowRun } from '../lib/api.js'
import { activeSyncRun, describeFollow } from '../../../lib/sync-status.mjs'
import {
  changedPaths, outcomeFor, listTemplateCommits, planStudent, rootCommit, treeReader,
} from '../lib/starter-sync.js'
import { toast } from '../lib/toast.js'

const props = defineProps({
  assignment: { type: Object, required: true },
  org: { type: String, required: true },
  students: { type: Array, default: () => [] },
  /**
   * `{ runId, htmlUrl }` to open straight into following that run - the
   * assignment page's Follow on a sync that is going. Null for the ordinary
   * dialog.
   */
  followRun: { type: Object, default: null },
})

// `settled`: the run being followed has finished and its outcome is known, so
// the assignment page reads its status line again.
const emit = defineEmits(['close', 'synced', 'settled'])

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
  failed: [],
})

// Every tree read once per open - the template's at each starting point, and
// each student's - blob shas only. Each student is planned from where THEY
// are (lib/starter-sync.mjs `startingPointFor`), exactly as the workflow will
// plan them; a single-commit preview is what hid lab 3 from 43 students.
const baseSha = ref(null)
const headTree = ref(new Map())
const studentTrees = ref(new Map())
const unreadable = ref(new Map())
const truncatedCommit = ref(false)
// Plain values, not refs: caches, never rendered.
let readTemplateTree = null
let syncRecords = []
let allTemplateCommits = []
// Whether that listing was read whole: without it no student is treated as
// having a repository from another template (lib/starter-sync-cohort.mjs).
let templateHistoryComplete = false
const rootCache = new Map()
// Files some student is behind on that the newest commit did not change,
// found by the scan. Tickable like the others; see `catchUpFiles`.
const catchUpFiles = ref([])
// Students whose starting point could not be established: they are sent only
// the newest commit's changes, as every sync did before, and the dialog says so.
const unknownStart = ref(0)
// Students whose repository came from a DIFFERENT template - the assignment's
// template was changed after they accepted. Named, not counted: they are sent
// the full starter code, and the lecturer who changed the template needs to
// know whose repositories that is.
const otherTemplate = ref([])

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

const selectedFileCount = computed(
  () => [...templateFiles.value, ...catchUpFiles.value].filter((f) => f.selected).length,
)
const scanPercent = computed(() => {
  if (!scanProgress.value.total) return 0
  return Math.round((scanProgress.value.current / scanProgress.value.total) * 100)
})

// Students touched, not rows added up: the same student appears under both
// headings when some of their files land in place and others need a PR.
const targetStudentCount = computed(() => {
  const seen = new Set()
  for (const s of scanResults.value.autoMerged) seen.add(s.repo_name)
  for (const s of scanResults.value.conflicts) seen.add(s.repo_name)
  return seen.size
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
  for (const f of [...templateFiles.value, ...catchUpFiles.value]) {
    f.selected = val
  }
  classifyStudents()
}

function onFilesChanged() {
  // Free: the trees are already in hand, so changing the selection re-decides
  // locally instead of re-reading every student repository. This used to fire a
  // full scan - one API call per student - on every checkbox click.
  classifyStudents()
}

// The transport lib/starter-sync-cohort.mjs reads through. ghApi resolves
// `{ ok, status, data, headers }` and never throws, which is what it expects.
const get = (path) => ghApi(getToken(), 'GET', path)

/**
 * Every sync record already written for this assignment - where each student
 * starts. A record that cannot be read is skipped: it can only make a student
 * start EARLIER, which sends more, never less.
 */
async function loadSyncRecords() {
  const res = await get(`/repos/${props.org}/${config.controlRepo}/contents/syncs/${props.assignment.id}`)
  if (!res.ok || !Array.isArray(res.data)) return []
  const out = []
  for (const f of res.data.filter((x) => x.type === 'file' && x.name.endsWith('.json'))) {
    try {
      const text = await getRepoContent(getToken(), props.org, config.controlRepo, f.path)
      if (text) out.push(JSON.parse(text))
    } catch {
      /* skipped - see above */
    }
  }
  return out
}

/** The selection, exactly as the workflow will read it (lib/starter-sync.mjs
 *  `resolveSelection`): everything, minus what was unticked. */
function selectionPayload() {
  const unticked = [...templateFiles.value, ...catchUpFiles.value].filter((f) => !f.selected).map((f) => `!${f.filename}`)
  return ['*', ...unticked]
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
    customPrBody.value = `### Starter Code Update\n\nAn update from the starter template \`${owner}/${repo}\` (commit \`${latest.sha.slice(0, 7)}\`).\n\nYou changed these files, so they were not overwritten. Review the diff and merge when you are ready.`

    // 2. Fetch commit details for changed files
    const detailRes = await ghApi(token, 'GET', `/repos/${owner}/${repo}/commits/${latest.sha}`)
    if (!detailRes.ok || !detailRes.data) {
      throw new Error(`Failed to read template commit ${latest.sha.slice(0, 7)} (HTTP ${detailRes.status})`)
    }

    // A rename is an add plus a delete, and the old path has to be in the
    // selection or it survives in every student repository beside the new one.
    const renames = new Map()
    for (const f of detailRes.data.files || []) {
      if (f.previous_filename) renames.set(f.previous_filename, f.filename)
    }
    // GitHub returns at most 300 entries in `files`. Saying so beats offering
    // a list that silently stops - the same rule the pagination sweep applies:
    // where a read is capped, the capped case may not report itself as whole.
    truncatedCommit.value = (detailRes.data.files || []).length >= 300

    const byName = new Map((detailRes.data.files || []).map((f) => [f.filename, f]))
    templateFiles.value = changedPaths(detailRes.data.files).map((path) => {
      const f = byName.get(path)
      return {
        filename: path,
        status: f ? f.status : (renames.has(path) ? 'removed' : 'modified'),
        additions: f?.additions || 0,
        deletions: f?.deletions || 0,
        patch: f?.patch || null,
        selected: true,
      }
    })

    // 3. What every student's plan is built from, read once per open: the
    //    template at the newest commit, its commit list (where a student with
    //    no sync record starts is the commit whose tree their first commit
    //    carries), and the sync records. Starting-point trees are read, and
    //    cached, as students need them.
    baseSha.value = detailRes.data.parents?.[0]?.sha || null
    readTemplateTree = treeReader(get)
    headTree.value = await readTemplateTree(`${owner}/${repo}`, latest.sha)
    const [listed, records] = await Promise.all([listTemplateCommits(get, `${owner}/${repo}`), loadSyncRecords()])
    allTemplateCommits = listed.commits
    templateHistoryComplete = listed.ok && listed.complete
    syncRecords = records

    // 4. Trigger initial scan
    await runPreFlightScan()
  } catch (err) {
    templateError.value = err.message
  } finally {
    loadingTemplate.value = false
  }
}

// Read each student's tree ONCE, then classify locally. The scan used to ask
// `compare/{templateSha}...main` on every student repository, which answers
// `404 No common ancestor` for every repository created from a template -
// verified live - and the catch-all put all of them under "conflicts". So the
// preview said "everyone conflicts" whatever the cohort had actually done.
async function runPreFlightScan() {
  scanning.value = true
  const activeStudents = (props.students || []).filter((s) => s.repo_name)
  scanProgress.value = { current: 0, total: activeStudents.length }
  // A re-scan reads the repositories again: what they hold may have changed.
  studentTrees.value = new Map()
  unreadable.value = new Map()
  const readStudentTree = treeReader(get)

  const CONCURRENCY = 4
  let cursor = 0

  async function worker() {
    while (cursor < activeStudents.length) {
      const s = activeStudents[cursor++]
      try {
        studentTrees.value.set(s.repo_name, await readStudentTree(s.repo_name, 'main'))
      } catch (err) {
        // Unreadable is its own answer, and it is not "no changes needed".
        unreadable.value.set(s.repo_name, err.message)
      }
      scanProgress.value.current++
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, activeStudents.length) }, worker))

  await findCatchUpFiles()
  await classifyStudents()
  scanning.value = false
}

/** One student's plan under `selected`, through the planner the workflow uses. */
function planFor(s, selected) {
  const repo = s.repo_name
  if (!rootCache.has(repo)) rootCache.set(repo, rootCommit(get, repo, 'main'))
  return planStudent({
    login: s.github_login,
    studentRepo: repo,
    studentTree: studentTrees.value.get(repo),
    readTree: readTemplateTree,
    root: () => rootCache.get(repo),
    templateFullName: templateFullName.value,
    headSha: targetSha.value,
    headTree: headTree.value,
    templateCommits: allTemplateCommits,
    records: syncRecords,
    fallbackSha: baseSha.value,
    selected,
    historyComplete: templateHistoryComplete,
  })
}

/**
 * Files some student is behind on that the newest commit did NOT change - an
 * earlier sync that stopped part-way, or a commit pushed and never synced.
 * They are sent with everything else, so they are listed where the lecturer
 * can see them and untick them, not discovered in a student's repository.
 */
async function findCatchUpFiles() {
  const listed = new Set(templateFiles.value.map((f) => f.filename))
  const wasUnticked = new Set(catchUpFiles.value.filter((f) => !f.selected).map((f) => f.filename))
  const behind = new Map()
  let unknown = 0
  const other = []
  for (const s of (props.students || []).filter((x) => x.repo_name && studentTrees.value.has(x.repo_name))) {
    const { paths, source } = await planFor(s, ['*'])
    if (source === 'unknown') unknown++
    if (source === 'first-commit') other.push(s.github_login)
    for (const p of paths) {
      if (listed.has(p)) continue
      behind.set(p, (behind.get(p) || 0) + 1)
    }
  }
  unknownStart.value = unknown
  otherTemplate.value = other
  catchUpFiles.value = [...behind.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([filename, students]) => ({
      filename,
      students,
      status: headTree.value.has(filename) ? 'catch-up' : 'removed',
      selected: !wasUnticked.has(filename),
    }))
}

// From data already in hand - trees and starting points are cached, so the
// lecturer can tick and untick files and watch the split move without a
// request. `classifyRun` drops the answer of a classification a newer tick
// has already replaced.
let classifyRun = 0
async function classifyStudents() {
  const run = ++classifyRun
  const selected = selectionPayload()
  const clean = []
  const conflicted = []
  const skipped = []
  const failed = []

  for (const s of (props.students || []).filter((x) => x.repo_name)) {
    if (unreadable.value.has(s.repo_name)) {
      failed.push({ ...s, reason: unreadable.value.get(s.repo_name) })
      continue
    }
    if (!studentTrees.value.has(s.repo_name)) continue
    let plan
    try {
      ;({ plan } = await planFor(s, selected))
    } catch (err) {
      failed.push({ ...s, reason: err.message })
      continue
    }
    const outcome = outcomeFor(plan)
    if (outcome === 'skipped-up-to-date') skipped.push(s)
    // A student can be in both: three corrections land in place and the fourth
    // needs a PR. Listed under each, and the counts are of students touched.
    if (plan.clean.length) clean.push(s)
    if (plan.conflicts.length) conflicted.push(s)
  }

  if (run !== classifyRun) return
  scanResults.value = { autoMerged: clean, conflicts: conflicted, skipped, failed }
}

async function handleDispatchSync() {
  dispatching.value = true
  dispatchStatus.value = null
  const token = getToken()

  try {
    // Everything, minus what was unticked - the same selection the scan
    // previewed. An inclusion list could not carry a student's catch-up files.
    const selectedFilesPayload = JSON.stringify(selectionPayload())

    const inputs = {
      org: props.org,
      assignment_id: props.assignment.id,
      selected_files: selectedFilesPayload,
      pr_title: customPrTitle.value,
      pr_body: customPrBody.value,
      create_issue: String(createIssue.value),
    }

    const res = await dispatchWorkflowRun(token, config.hubOwner, config.hubRepo, 'sync-starter-code.yml', inputs)
    if (!res.ok) {
      throw new Error(`Failed to dispatch sync workflow: ${res.error || res.data?.message || `HTTP ${res.status}`}`)
    }
    emit('synced')

    // FOLLOW IT. "Dispatched successfully" and then nothing was the whole of
    // what a lecturer saw on 2026-09-25 while two syncs were cut off.
    if (res.runId) {
      startFollowing({ runId: res.runId, htmlUrl: res.htmlUrl })
      return
    }
    // GitHub started it without saying which run it is. Say so, rather than
    // follow a run guessed from a list.
    dispatchStatus.value = {
      type: 'success',
      message: 'The sync was started, but GitHub did not say which run it is, so it cannot be followed here. The assignment page shows it once it has started.',
      workflowUrl: `https://github.com/${config.hubOwner}/${config.hubRepo}/actions/workflows/sync-starter-code.yml`,
    }
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

// --- following one run -------------------------------------------------------

const FOLLOW_EVERY_MS = 10_000
const following = ref(null) // { runId, htmlUrl }
const followView = ref(null)
const lastChecked = ref('')
const activeRun = ref(null)
let followTimer = null
let followStopped = false
// Once this run's record is found, its path is read directly each time.
let followRecordPath = null

const followDot = computed(() => ({
  success: 'dot-success', warning: 'dot-warning', danger: 'dot-danger', neutral: 'dot-neutral',
})[followView.value?.tone] || 'dot-neutral')

const followTitleParts = computed(() => {
  const { title = '', commit = '' } = followView.value || {}
  const at = commit ? title.indexOf(commit) : -1
  if (at < 0) return [{ text: title }]
  return [
    { text: title.slice(0, at) },
    { text: commit, code: true },
    { text: title.slice(at + commit.length) },
  ]
})

const followPercent = computed(() => {
  const p = followView.value?.progress
  return p?.total ? Math.round((p.reached / p.total) * 100) : 0
})

/** This run's record, found by `run_id` among the newest few - or null. */
async function findRunRecord(runId) {
  if (followRecordPath) {
    try {
      const text = await getRepoContent(getToken(), props.org, config.controlRepo, followRecordPath)
      return text ? JSON.parse(text) : null
    } catch {
      return null
    }
  }
  const listing = await get(`/repos/${props.org}/${config.controlRepo}/contents/syncs/${props.assignment.id}`)
  if (!listing.ok || !Array.isArray(listing.data)) return null
  const newest = listing.data
    .filter((f) => f.type === 'file' && f.name.endsWith('.json'))
    .sort((a, b) => b.name.localeCompare(a.name))
    .slice(0, 3)
  for (const f of newest) {
    try {
      const doc = JSON.parse(await getRepoContent(getToken(), props.org, config.controlRepo, f.path))
      if (doc?.run_id === runId) {
        followRecordPath = f.path
        return doc
      }
    } catch {
      /* not this one */
    }
  }
  return null
}

async function followTick() {
  followTimer = null
  if (followStopped || !following.value) return
  const { runId } = following.value
  // A request can THROW - the API client times out by rejecting - and one that
  // escaped here would end the following for good with the dialog still saying
  // "Checking the run…". Any failure is "could not read it this time", and the
  // next check is still scheduled.
  let run = null
  let record = null
  try {
    const runRes = await get(`/repos/${config.hubOwner}/${config.hubRepo}/actions/runs/${runId}`)
    run = runRes.ok ? runRes.data : null
    record = await findRunRecord(runId)
  } catch {
    run = null
  }
  if (followStopped) return
  followView.value = describeFollow({ run, record })
  lastChecked.value = new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  if (followView.value.done) {
    emit('settled')
    return
  }
  followTimer = setTimeout(followTick, FOLLOW_EVERY_MS)
}

function startFollowing(run) {
  following.value = run
  followView.value = null
  followRecordPath = null
  followStopped = false
  if (followTimer) clearTimeout(followTimer)
  followTick()
}

/** Is a sync of this assignment already going? One read, when the dialog opens. */
async function checkActiveSync() {
  const res = await get(`/repos/${config.hubOwner}/${config.hubRepo}/actions/workflows/sync-starter-code.yml/runs?per_page=20`)
  if (!res.ok) return
  activeRun.value = activeSyncRun(res.data?.workflow_runs, props.org, props.assignment.id)
}

onMounted(() => {
  // Opened FROM a running sync (the assignment page's Follow): no template
  // read and no scan of every student repository - just the run.
  if (props.followRun) {
    startFollowing(props.followRun)
    return
  }
  fetchTemplateData()
  checkActiveSync()
})

onUnmounted(() => {
  // Closing stops the checking, and only the checking.
  followStopped = true
  if (followTimer) clearTimeout(followTimer)
})
</script>

<style scoped>
.modal-wide {
  max-width: 720px;
  width: 95vw;
}

/* A file row is a tonal step, not a box (DESIGN.md §1.1). It sat, outlined,
   in an outlined scroller in an outlined section in the modal - four boxes.
   The scroller is now a borderless --bg-canvas well and each row a
   --bg-surface step up out of it; that pair differs in BOTH themes, where
   --bg-inset would have been #0d1117 on #0d1117 in dark. Was an inline style
   on each row, and `.card` besides. */
.file-row-box {
  padding: 6px 10px;
  background: var(--bg-surface);
  border-radius: var(--radius-sm);
}

.dispatch-banner.info {
  background: var(--tint-accent-subtle);
  color: var(--text-primary);
  gap: var(--space-sm);
}

.follow-panel {
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
}

.follow-headline {
  gap: var(--space-sm);
}

.follow-detail,
.follow-meta {
  margin: 0;
}

.follow-meta {
  display: flex;
  gap: var(--space-md);
  flex-wrap: wrap;
}

.follow-failed {
  margin: 0;
  padding-left: var(--space-md);
}

.catch-up-head {
  display: block;
  margin: var(--space-sm) 0 var(--space-xs);
}

.catch-up-note {
  margin: var(--space-xs) 0 0;
}

/* A long path gives way, never the count beside it: "missing for 1 student"
   wrapped onto two lines under a deep Lab03_Mvc path. */
.catch-up-path {
  min-width: 0;
  flex: 1 1 auto;
}

.catch-up-path .file-path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.catch-up-count {
  flex: 0 0 auto;
  white-space: nowrap;
  margin-left: var(--space-sm);
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

/* A --bg-canvas well in a --bg-surface section: the tone separates it in both
   themes, so no outline (DESIGN.md §1.1 - it was the third nested box). */
.commit-summary-box {
  padding: var(--space-xs) var(--space-sm);
  background: var(--bg-canvas);
  border-radius: var(--radius-sm);
}

.file-selector-box {
  margin-top: var(--space-xs);
}

.file-list-scrollable {
  max-height: 140px;
  overflow-y: auto;
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
  /* auto-fit so the fourth card (unreadable repositories) only takes a column
     when it is rendered, and minmax(0, …) per DESIGN.md §7 - a bare 1fr floors
     at its content's min-content width and pushes the modal sideways. */
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 150px), 1fr));
  gap: var(--space-sm);
  margin-top: var(--space-sm);
}

/* The outcome cards are TINTS, not boxes (DESIGN.md §1.1): each already says
   what it is by its wash and its dot, and an outline on top made the third
   nested box - modal, section, card. Every tint differs from the section's
   --bg-surface in both themes (solid in light, a wash in dark). */
.preflight-card {
  display: flex;
  flex-direction: column;
  padding: var(--space-sm);
  background: var(--bg-surface-hover);
  border-radius: var(--radius-sm);
}

/* The three outcomes of a pre-flight scan, told apart. Each card already
   carries its verdict on the count (`.stat-green` / `.stat-yellow` /
   `.text-muted`) and on its status dot, but the three MODIFIERS were declared
   nowhere - so the cards themselves were identical and the colour was carried
   by two small elements inside them. Only the tint and the border move, the
   same way `.published-info-card.is-warning` does: DESIGN.md §1.1 forbids
   turning a card inside a modal into a third box. */
.preflight-card.clean {
  background: var(--tint-success-subtle);
}

.preflight-card.conflict {
  background: var(--tint-attention-subtle);
}

/* Neutral, deliberately: "nothing to do" is not a warning. An empty population
   is not a failure (DESIGN.md §4). */
.preflight-card.skipped {
  background: var(--tint-neutral-subtle);
}

/* A repository that could not be read: something did not happen (§4). */
.preflight-card.unreadable {
  background: var(--tint-danger-subtle);
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

/* ------------------------------------------------------------------------
   Vocabulary that was carried INLINE.

   Each class below was written in the markup beside a `style="…"` that said
   what it meant, so the class itself was declared nowhere and the look lived on
   the element. Moving the declarations here changes nothing on screen - the
   values are unchanged - but it takes them off the undeclared-class register
   and puts the appearance where DESIGN.md says it belongs.
   ------------------------------------------------------------------------ */

.diff-patch-pre {
  background: var(--bg-canvas);
  border-radius: 4px;
  max-height: 200px;
  overflow-y: auto;
  margin: 0;
  padding: 8px;
  line-height: 1.4;
}
</style>
