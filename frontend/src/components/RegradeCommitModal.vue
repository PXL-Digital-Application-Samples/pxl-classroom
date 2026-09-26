<template>
  <div class="modal-overlay" @click.self="requestClose">
    <div
      class="modal regrade-commit"
      ref="el"
      role="dialog"
      aria-modal="true"
      :aria-label="`Re-grade a commit for ${student.github_login}`"
      @keydown="onKeydown"
    >
      <header class="modal-head">
        <h3>Re-grade a commit: <code>{{ student.github_login }}</code></h3>
        <button class="modal-close" type="button" @click="requestClose" :disabled="saving" aria-label="Close">×</button>
      </header>

      <section class="modal-section">
        <p class="text-secondary">
          <template v-if="marker">Every hand-in ("{{ marker.value }}") this student made, newest first.</template>
          <template v-else>The commits on <code>{{ branch }}</code>, newest first.</template>
          The one you pick is graded instead of what the rules pick - late, over the limit, or earlier -
          until you go back to the rules.<template v-if="teamSize > 1"> It applies to the whole team ({{ teamSize }} students).</template>
        </p>

        <p v-if="loading" class="text-secondary"><span class="spinner-sm"></span> Reading their commits…</p>
        <p v-else-if="loadError" class="text-danger">{{ loadError }}</p>
        <p v-else-if="!rows.length" class="text-secondary">
          {{ marker ? 'They have not handed anything in.' : 'There are no commits on this branch.' }}
        </p>

        <ul v-else class="commit-list" role="radiogroup" aria-label="Commits">
          <li v-for="r in rows" :key="r.sha" class="commit-row" :class="{ chosen: selected === r.sha }">
            <label class="commit-pick">
              <input
                v-model="selected"
                type="radio"
                name="regrade-commit"
                :value="r.sha"
                :disabled="r.result.state !== 'graded'"
              />
              <span v-if="r.number" class="commit-number">#{{ r.number }}</span>
              <code class="mono">{{ r.sha.slice(0, 7) }}</code>
              <span class="text-secondary">{{ r.date ? formatDate(r.date) : 'unknown time' }}</span>
              <span v-if="!marker" class="commit-message">{{ r.message }}</span>
              <!-- Status dots, not coloured words (DESIGN.md §1.3/§4): late and
                   over the limit need a look; "graded now" is the state in
                   force, not a warning. -->
              <span v-for="f in r.flags" :key="f" class="status-indicator text-sm">
                <span class="status-dot dot-warning"></span><span>{{ f }}</span>
              </span>
              <span v-if="r.sha === currentSha" class="status-indicator text-sm">
                <span class="status-dot dot-success"></span><span>graded now</span>
              </span>
              <span class="commit-result">
                <template v-if="r.result.state === 'loading'"><span class="spinner-sm"></span></template>
                <template v-else-if="r.result.state === 'graded'"><strong>{{ r.result.earned }}/{{ r.result.total }}</strong></template>
                <template v-else-if="r.result.state === 'running'">
                  <span class="spinner-sm"></span> grading…
                </template>
                <template v-else><span class="text-secondary">no result</span></template>
              </span>
            </label>
            <!-- No result: say why, and offer what can still be done. Never a zero. -->
            <div v-if="r.result.state === 'none' || r.result.state === 'error'" class="commit-none text-sm text-secondary">
              {{ r.result.reason }}
              <template v-if="grader.available">
                <button type="button" class="btn btn-secondary btn-xs" :disabled="saving" @click="gradeNow(r)">Grade this commit now</button>
                <span>Runs the grading workflow on their {{ branch }} branch against the code of this commit. Tests written
                  in the workflow are the current ones; test files in the repository are the ones at this commit.</span>
              </template>
              <template v-if="r.rerun">
                <template v-if="r.rerun.can">
                  <button type="button" class="btn btn-secondary btn-xs" :disabled="saving" @click="rerun(r)">Run grading again</button>
                  <span>Runs the tests as they were at this commit, now. A test that needs something that no longer
                    exists (a cloud exam's sandbox) will fail.</span>
                </template>
                <template v-else-if="r.rerun.why">{{ r.rerun.why }}</template>
              </template>
              <button type="button" class="btn-link" @click="emit('manual')">Set a score by hand instead</button>
            </div>
          </li>
        </ul>
        <button v-if="hasMore && !loading" type="button" class="btn-link" @click="loadMore">Show older commits</button>
        <p v-if="grader.reason && rows.some((r) => r.result.state === 'none')" class="form-hint text-secondary">
          Grading a chosen commit now is not possible here: {{ grader.reason }}.
        </p>
      </section>

      <section class="modal-section">
        <div class="field">
          <label for="regrade-reason">Reason (recorded with the grade)</label>
          <textarea id="regrade-reason" v-model="reason" rows="2" placeholder="The wifi dropped during hand-in 4 / late by agreement"></textarea>
        </div>
        <p v-if="problem && reason.trim() && selected" class="form-hint text-danger">{{ problem }}</p>
        <div class="regrade-actions">
          <button class="btn" type="button" :disabled="saving" @click="requestClose">Cancel</button>
          <button
            class="btn btn-primary"
            type="button"
            :disabled="saving || !selectedRow || !!problem"
            @click="emit('choose', { sha: selected, reason: reason.trim(), runId: selectedRow.runId ?? null })"
          >{{ saving ? 'Saving…' : selectedRow ? `Grade on ${selectedRow.number ? '#' + selectedRow.number : selectedRow.sha.slice(0, 7)} (${selectedRow.result.earned}/${selectedRow.result.total})` : 'Pick a commit with a result' }}</button>
        </div>
      </section>
    </div>
  </div>
</template>

<script setup>
// Re-grade ONE student on a commit the lecturer chooses (2026-09-26).
//
// Lists the hand-ins (with a submission marker) or every commit on the
// submission branch (without one), each with the result its grading run
// already produced - read, never assumed. A late or over-the-limit hand-in
// usually HAS a result: every hand-in push was graded, and the rules only
// decide which one counts when it is read. Choosing one is stored as a
// `submission_sha` override by the parent (lib/grade-override.mjs), so every
// grader honours it afterwards.
//
// Where a commit has no result, the dialog says why, and offers GitHub's
// re-run where one can work: a run exists for that exact commit, it is not a
// hand-in gate that would skip again, and it is inside GitHub's 30 days. A
// re-run replays the original push, so it runs the tests AS THEY WERE at that
// commit - said beside the button. Where nothing can run, a score by hand.
//
// Where the repository's grading workflow carries the dispatch entry
// (lib/grade-dispatch.mjs), "Grade this commit now" runs it for that commit
// with the CURRENT workflow's tests - no 30-day limit, no hand-in gate. The run
// belongs to the branch tip, so the choice carries its run id and every grader
// reads that run.
//
// The data is read here and only here, while the dialog is open: it is the
// dialog's own state (DESIGN.md §6).
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { getToken } from '../lib/auth.js'
import { ghApi } from '../lib/api.js'
import { formatDate } from '../lib/format.js'
import { useFocusTrap } from '../composables/useFocusTrap.js'
import { readScoreAtCommit } from '../lib/grade-cohort.js'
import { listHandIns, selectHandIn, messageMatchesMarker } from '../../../lib/submission-marker.mjs'
import { decisionProblem } from '../../../lib/grade-override.mjs'
import { rerunAvailability } from '../../../lib/grading-rerun.mjs'
import { dispatchGrading, findGradingWorkflow, readRunScore } from '../../../lib/grade-dispatch.mjs'

const props = defineProps({
  student: { type: Object, required: true },
  /** readSubmissionMarker(assignment), with the cap already raised by any allowance. */
  marker: { type: Object, default: null },
  /** The hand-in limit in force for this student (null: no cap). */
  limit: { type: Number, default: null },
  branch: { type: String, default: 'main' },
  fallbackTotal: { type: Number, default: 0 },
  /** The commit graded now, from the summary row, to mark it. */
  currentSha: { type: String, default: null },
  teamSize: { type: Number, default: 1 },
  saving: { type: Boolean, default: false },
})
const emit = defineEmits(['close', 'choose', 'manual'])

const { el, onKeydown } = useFocusTrap()
const request = (method, path, body) => ghApi(getToken(), method, path, body)
const get = async (path) => {
  const r = await request('GET', path)
  return { status: r.status, data: r.data }
}
const repo = computed(() => props.student.repo_name)

const loading = ref(true)
const loadError = ref('')
const rows = ref([])
const page = ref(1)
const hasMore = ref(false)
const selected = ref('')
const reason = ref('')
/** The grading workflow's dispatch entry: { available, workflowId?, reason? }. */
const grader = ref({ available: false, reason: '' })
let open = true
const timers = new Set()

const selectedRow = computed(() => rows.value.find((r) => r.sha === selected.value && r.result.state === 'graded') || null)
const problem = computed(() => decisionProblem({ type: 'submission_sha', value: selected.value || null, reason: reason.value }))

const PER_PAGE = 30

function commitRow(c, extra = {}) {
  return {
    sha: c.sha,
    message: String(c.message ?? c.commit?.message ?? '').split('\n')[0],
    date: c.date ?? c.commit?.committer?.date ?? c.commit?.author?.date ?? null,
    number: null,
    flags: [],
    result: { state: 'loading' },
    rerun: null,
    runId: null,
    ...extra,
  }
}

async function loadHandIns() {
  const listed = await listHandIns(get, { repoFullName: repo.value, branch: props.branch, marker: props.marker, withRuns: true })
  if (!listed.ok) throw new Error(`Could not read their ${listed.failedRead === 'runs' ? 'run history' : 'commits'} (HTTP ${listed.status}).`)
  // A walk that hit its cap returns no hand-ins - which is NOT "they handed
  // nothing in". Said as what it is.
  if (!listed.complete) throw new Error(`They have more commits than can be read here (${listed.scanned} read), so their hand-ins cannot be listed. Set a score by hand instead.`)
  const picked = selectHandIn(listed.handIns, { until: props.student.effective_deadline_at || null, multiple: props.marker.multiple, limit: props.limit })
  const why = new Map(picked.ignored.map((i) => [i.sha, i.reason === 'late' ? 'late' : 'over the limit']))
  const out = listed.handIns.map((h, i) => commitRow(h, {
    number: i + 1,
    flags: [why.get(h.sha), h.onBranch === false ? 'no longer on the branch' : null].filter(Boolean),
  }))
  return out.reverse()
}

async function loadCommits() {
  const res = await get(`/repos/${repo.value}/commits?sha=${encodeURIComponent(props.branch)}&per_page=${PER_PAGE}&page=${page.value}`)
  if (res.status < 200 || res.status >= 300) throw new Error(`Could not read their commits (HTTP ${res.status}).`)
  const list = Array.isArray(res.data) ? res.data : []
  hasMore.value = list.length === PER_PAGE
  const deadline = props.student.effective_deadline_at ? Date.parse(props.student.effective_deadline_at) : NaN
  return list.map((c) => {
    const row = commitRow(c)
    if (Number.isFinite(deadline) && row.date && Date.parse(row.date) > deadline) row.flags.push('late')
    return row
  })
}

// One result per row, four at a time: 30 commits is at most 60 reads.
async function readResults(list) {
  let cursor = 0
  const worker = async () => {
    while (cursor < list.length && open) {
      await readOne(list[cursor++])
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, list.length) }, worker))
}

async function readOne(row) {
  try {
    const out = await readScoreAtCommit(request, { repoFullName: repo.value, sha: row.sha, marker: props.marker, fallbackTotal: props.fallbackTotal })
    if (out.verdict === 'graded') {
      row.result = { state: 'graded', earned: out.parsed.earned, total: out.parsed.total > 0 ? out.parsed.total : props.fallbackTotal }
      row.rerun = null
      return
    }
    row.result = { state: out.verdict === 'api-failed' ? 'error' : 'none', reason: sentence(out.reason) }
    const runs = await get(`/repos/${repo.value}/actions/runs?head_sha=${row.sha}&per_page=20`)
    row.rerun = rerunAvailability({
      runs: runs.status === 200 ? runs.data?.workflow_runs : null,
      marker: props.marker,
      isHandIn: props.marker ? messageMatchesMarker(row.message, props.marker) : null,
    })
  } catch (e) {
    row.result = { state: 'error', reason: `Could not read its result: ${e.message}.` }
  }
}

const sentence = (s) => {
  const t = String(s || '').trim()
  return t ? t.charAt(0).toUpperCase() + t.slice(1) + (/[.!?]$/.test(t) ? '' : '.') : ''
}

async function rerun(row) {
  row.result = { state: 'running' }
  const current = await get(`/repos/${repo.value}/actions/runs/${row.rerun.runId}`)
  const before = current.status === 200 ? (current.data?.run_attempt ?? 1) : 0
  const res = await request('POST', `/repos/${repo.value}/actions/runs/${row.rerun.runId}/rerun`)
  if (!res.ok) {
    row.result = {
      state: 'none',
      reason: res.status === 403
        ? 'GitHub refused to start the run (HTTP 403): the PXL Classroom app needs permission to run Actions in this organization, and you need admin access to this repository.'
        : `GitHub refused to start the run (HTTP ${res.status}${res.data?.message ? `: ${res.data.message}` : ''}).`,
    }
    return
  }
  whenDone(row.rerun.runId, async () => {
    row.result = { state: 'loading' }
    await readOne(row)
  }, row, before)
}

// Checked every 10 seconds WHILE THIS DIALOG IS OPEN, and never after: the
// same rule the starter sync's follow obeys. Closing it leaves the run going.
// Stops after 30 minutes and says so, rather than showing "grading…" for ever
// over a run stuck in a queue.
const MAX_POLLS = 180
//
// `afterAttempt`: a re-run keeps the run's id, and right after the POST the
// OLD attempt can still read "completed" - so a re-run is done only once an
// attempt newer than the one before it has completed.
function whenDone(runId, then, row, afterAttempt = 0) {
  let polls = 0
  const poll = async () => {
    if (!open) return
    const r = await get(`/repos/${repo.value}/actions/runs/${runId}`)
    if (r.status === 200 && r.data?.status === 'completed' && (r.data.run_attempt ?? 1) > afterAttempt) return then()
    if (++polls >= MAX_POLLS) {
      if (row) row.result = { state: 'none', reason: `The run has not finished after 30 minutes (run ${runId}). Close this and pick the commit again later.` }
      return
    }
    const t = setTimeout(() => { timers.delete(t); poll() }, 10_000)
    timers.add(t)
  }
  const t = setTimeout(() => { timers.delete(t); poll() }, 10_000)
  timers.add(t)
}

async function gradeNow(row) {
  row.result = { state: 'running' }
  const res = await dispatchGrading(request, { repo: repo.value, workflowId: grader.value.workflowId, sha: row.sha, branch: props.branch })
  if (!res.ok) {
    row.result = { state: 'none', reason: sentence(res.reason) }
    return
  }
  whenDone(res.runId, async () => {
    const out = await readRunScore(request, { repoFullName: repo.value, runId: res.runId, sha: row.sha, fallbackTotal: props.fallbackTotal })
    if (out.verdict === 'graded') {
      row.result = { state: 'graded', earned: out.parsed.earned, total: out.parsed.total > 0 ? out.parsed.total : props.fallbackTotal }
      row.runId = res.runId
      row.rerun = null
      return
    }
    row.result = { state: out.verdict === 'api-failed' ? 'error' : 'none', reason: sentence(out.reason) }
  }, row)
}

async function findGrader() {
  const found = await findGradingWorkflow(request, { repo: repo.value, branch: props.branch })
  if (!open) return
  grader.value = found.ok && found.available
    ? { available: true, workflowId: found.workflowId, reason: '' }
    : {
        available: false,
        reason: !found.ok
          ? found.reason
          : found.workflowId
            ? 'this repository\'s grading workflow cannot grade a chosen commit yet - sync the updated workflow file with Sync Starter Code'
            : found.reason,
      }
}

async function load() {
  loading.value = true
  loadError.value = ''
  try {
    const list = props.marker ? await loadHandIns() : await loadCommits()
    rows.value = [...rows.value, ...list]
    loading.value = false
    await readResults(rows.value.filter((r) => r.result.state === 'loading'))
  } catch (e) {
    loadError.value = e.message
    loading.value = false
  }
}

function loadMore() {
  page.value++
  load()
}

function requestClose() {
  if (props.saving) return
  emit('close')
}

onMounted(() => {
  findGrader()
  load()
})
onUnmounted(() => {
  open = false
  for (const t of timers) clearTimeout(t)
})
</script>

<style scoped>
.regrade-commit {
  max-width: 760px;
}
.commit-list {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 50vh;
  overflow-y: auto;
}
.commit-row {
  padding: var(--space-xs) 0;
  border-bottom: 1px solid var(--border-muted);
}
.commit-row.chosen {
  background: var(--bg-inset);
}
.commit-pick {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  flex-wrap: wrap;
  cursor: pointer;
}
.commit-number {
  font-weight: 600;
}
.commit-message {
  flex: 1 1 12rem;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.commit-result {
  margin-left: auto;
}
.commit-none {
  margin: 4px 0 0 1.6rem;
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-sm);
  align-items: center;
}
.regrade-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-sm);
}
</style>
