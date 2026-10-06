<template>
  <!-- NO `fade-in` here, for the reason AdminView gives: it leaves a transform
       on the element, and the health dialog is position: fixed. -->
  <!-- The top bar is the organization's (OrgShell.vue), drawn once for all its pages. -->
  <div>

    <div class="org-page container">
      <AuthCard v-if="!user" title="Sign in to open the organization" @authenticated="onAuthenticated">
        Sign in with a GitHub account that owns <strong>{{ org }}</strong>.
        Sessions last 8 hours. If you were signed in earlier, it has expired.
      </AuthCard>

      <template v-else>
        <ControlRepoUnreadable
          v-if="access"
          :org="org"
          :access="access"
          :viewer-login="user?.login || ''"
          @retry="load"
        />
        <div v-else-if="loadError" class="org-load-error">
          <p class="text-secondary">{{ loadError }}</p>
          <button class="btn btn-sm" type="button" @click="load">Retry</button>
        </div>

        <!-- WHAT NEEDS YOU, OR THAT NOTHING DOES - the lecturer's part of the page
             (2026-10-06). One line each, linked; the whole text on request. Its
             own small loading line, never a spinner over the page: the page
             waited for some 35 reads, a run list for a folded section among
             them, before it showed anything. -->
        <section v-else class="card org-needs" aria-labelledby="org-needs-title">
          <p v-if="loading" class="org-needs-loading text-secondary">
            <span class="spinner-sm" aria-hidden="true"></span>
            Reading what needs you…
          </p>
          <template v-else-if="noticesState === 'unreadable'">
            <h2 id="org-needs-title" class="org-needs-title">
              <span class="status-dot dot-warning"></span>
              Couldn't read the notifications.
            </h2>
            <p class="text-secondary">
              This is not "nothing needs you" - it is unknown.
              <a v-if="issueUrl" :href="issueUrl" target="_blank" rel="noopener">Open the notifications on GitHub</a>
            </p>
            <button class="btn btn-sm" type="button" @click="load">Try again</button>
          </template>
          <template v-else-if="needsYou.length">
            <h2 id="org-needs-title" class="org-needs-title">
              <span class="status-dot dot-warning"></span>
              {{ needsYou.length === 1 ? '1 thing needs you' : `${needsYou.length} things need you` }}
            </h2>
            <p class="text-secondary text-sm">From the last {{ NEEDS_YOU_DAYS }} days.</p>
            <ul class="org-needs-list">
              <li v-for="n in needsYou" :key="n.key || n.at" class="org-needs-item">
                <div class="org-needs-head">
                  <router-link
                    v-if="!isOrgNotice(n)"
                    :to="{ name: 'assignment-detail', params: { org, assignmentId: n.assignmentId } }"
                    class="org-needs-what"
                  >{{ titleOf(n.assignmentId) }}</router-link>
                  <span v-else class="org-needs-what">{{ ORG_NOTICE_LABELS[n.assignmentId] }}</span>
                  <span class="text-muted text-xs">{{ fmt(n.at) }}</span>
                </div>
                <p class="org-needs-text">{{ noticeLines(n.details).first }}</p>
                <details v-if="noticeLines(n.details).rest" class="org-needs-more">
                  <summary>More</summary>
                  <p class="org-needs-rest">{{ noticeLines(n.details).rest }}</p>
                </details>
              </li>
            </ul>
            <p class="text-muted text-sm">
              <a v-if="issueUrl" :href="issueUrl" target="_blank" rel="noopener">All notifications, on GitHub</a>
            </p>
          </template>
          <template v-else>
            <h2 id="org-needs-title" class="org-needs-title">
              <span class="status-dot dot-success"></span>
              All quiet - nothing needs you.
            </h2>
            <p class="text-secondary text-sm">
              <template v-if="lastNightly">
                The nightly check last ran {{ formatRelative(lastNightly.at) }}
                <template v-if="lastNightly.ok === false">and did not finish cleanly</template>.
              </template>
              <template v-else>Nothing has been reported in the last {{ NEEDS_YOU_DAYS }} days.</template>
            </p>
          </template>
        </section>

        <!-- THE ORGANIZATION ITSELF (2026-10-06): its plan and what that means for
             a course, who is in it, Actions this month, repositories. Every line
             only from what GitHub answered (lib/org-facts.mjs); GitHub answers
             most of it to owners only, and the card says so instead of guessing.
             Its own loading line, so it never holds up what needs you. -->
        <section v-if="!access && !loadError" class="card org-about" aria-labelledby="org-about-title">
          <h2 id="org-about-title" class="org-about-title">{{ org }}</h2>
          <p v-if="factsState === 'loading'" class="org-needs-loading text-secondary">
            <span class="spinner-sm" aria-hidden="true"></span>
            Reading the organization…
          </p>
          <p v-else-if="factsState === 'unreadable'" class="text-secondary text-sm">
            GitHub did not answer about this organization just now.
            <button class="btn btn-sm" type="button" @click="retryFacts">Try again</button>
          </p>
          <p v-else-if="facts.ownerOnly" class="text-secondary text-sm">
            Only an owner of this organization can see its plan, who is in it and its usage.
          </p>
          <template v-else>
            <p class="org-about-plan"><strong>{{ facts.plan.name }}</strong></p>
            <ul v-if="facts.plan.lines.length" class="org-about-lines">
              <li v-for="line in facts.plan.lines" :key="line">{{ line }}</li>
            </ul>
            <details v-if="facts.plan.more.length" class="org-about-more">
              <summary>What this means</summary>
              <ul class="org-about-lines">
                <li v-for="line in facts.plan.more" :key="line">{{ line }}</li>
              </ul>
              <a v-if="facts.plan.upgradeUrl" :href="facts.plan.upgradeUrl" target="_blank" rel="noopener">Upgrade to GitHub Team on GitHub Education</a>
            </details>
            <dl class="org-about-facts">
              <template v-if="facts.people || facts.membersRead">
                <dt>People</dt>
                <dd>
                  <template v-if="facts.people">{{ facts.people }}</template>
                  <span v-if="facts.membersRead" class="org-about-note">{{ facts.membersRead }}</span>
                </dd>
              </template>
              <template v-if="facts.actions">
                <dt>Actions</dt>
                <dd>{{ facts.actions }}</dd>
              </template>
              <template v-if="facts.repositories">
                <dt>Repositories</dt>
                <dd>{{ facts.repositories }}</dd>
              </template>
            </dl>
          </template>
        </section>

        <!-- ADVANCED: what the organization costs, whether it is healthy, how it
             is connected, and the runs behind it - folded, and nothing in it is
             read until it is opened. OUTSIDE every state above, on purpose: the
             health check is most needed exactly when this page cannot load -
             GitHub not answering, a control repository this account cannot read
             - and a check that only appears once everything has loaded is never
             there when it is needed. Not a card: the sections inside are cards,
             and a card in a card is DESIGN.md §1.1's box prison. -->
        <details class="org-advanced" :open="advancedOpen" @toggle="onAdvancedToggle">
          <summary>
            <h2 class="org-advanced-title">Advanced</h2>
            <span class="text-muted text-sm">usage, system health, connection, recent runs</span>
          </summary>
          <div v-if="advancedOpen" class="org-advanced-body">
            <UsagePanel :org="org" />

            <!-- In the page, run when opened (2026-10-06): a button that opened
                 a dialog was one step too many for the one thing this section
                 is for. Bounded: every read has a time limit and the whole pass
                 a budget, so GitHub not answering ends in a report that says so. -->
            <details class="card org-fold org-health" @toggle="healthOpen = $event.target.open">
              <summary><h3>System health</h3></summary>
              <p class="text-secondary text-sm">
                Checks your sign-in, the GitHub App, the control repository, the assignments, their
                acceptance repositories and the published pages, and offers a fix where one exists.
              </p>
              <SystemHealthModal inline :is-open="healthOpen" :org="org" />
            </details>

            <details class="card org-fold">
              <summary><h3>Connection &amp; setup</h3></summary>
              <ul class="org-links">
                <li>
                  <a :href="`https://github.com/${org}/${config.controlRepo}`" target="_blank" rel="noopener">The control repository</a>
                  <span class="text-muted text-sm"> - where this organization's assignments, roster and records are kept</span>
                </li>
                <li>
                  <a :href="`https://github.com/organizations/${org}/settings/installations`" target="_blank" rel="noopener">The GitHub App installation</a>
                  <span class="text-muted text-sm"> - which repositories it can reach (it needs all of them)</span>
                </li>
                <li>
                  <router-link :to="{ name: 'setup' }">Setup</router-link>
                  <span class="text-muted text-sm"> - connecting another organization, or checking this one's setup</span>
                </li>
              </ul>
            </details>

            <details class="card org-fold" @toggle="onRunsToggle">
              <summary><h3>Recent runs</h3></summary>
              <p class="text-muted text-sm">
                Runs that can be tied to {{ org }}. A failed acceptance run is often a refusal the
                system handled; the assignment's own page says what it was.
              </p>
              <p v-if="runsLoading" class="text-secondary text-sm"><span class="spinner-sm" aria-hidden="true"></span> Reading the runs…</p>
              <ul v-else class="org-runs">
                <li v-for="r in runs" :key="r.id">
                  <span class="status-dot" :class="runDot(r)"></span>
                  <a :href="r.html_url" target="_blank" rel="noopener">{{ r.label }}</a>
                  <span class="text-muted text-xs">{{ runOutcome(r) }} · {{ formatRelative(r.created_at) }}</span>
                </li>
                <li v-if="runsUnreadable" class="text-secondary">The run list could not be read.</li>
                <li v-else-if="runsRead && !runs.length" class="text-secondary">No recent runs.</li>
              </ul>
            </details>
          </div>
        </details>
      </template>
    </div>
  </div>
</template>

<script setup>
// The organization's own page. It replaced "Admin" (BETA-UX.md, 2026-10-02),
// and on 2026-10-06 it was turned around for the lecturer: what needs them,
// short and linked, first; everything else - usage, health, connection, runs -
// in one Advanced section that reads nothing until it is opened. The "Course
// activity" list went with it: it repeated the assignment cards.

import { computed, ref, watch, onMounted } from 'vue'
import AuthCard from '../components/AuthCard.vue'
import ControlRepoUnreadable from '../components/ControlRepoUnreadable.vue'
import SystemHealthModal from '../components/SystemHealthModal.vue'
import UsagePanel from '../components/UsagePanel.vue'
import { getToken, getUser, isAuthenticated } from '../lib/auth.js'
import { markStaff, readProvisioned, setNeedsYou } from '../lib/org-session.js'
import { getRepo, getRepoContent, ghApi, listRepoDir } from '../lib/api.js'
import { config } from '../lib/config.js'
import { classifyUnreadableControlRepo } from '../lib/control-repo-access.js'
import { readTrackingIssue } from '../lib/tracking-issue.js'
import { formatDate, formatRelative } from '../lib/format.js'
import { NEEDS_YOU_DAYS, ORG_NOTICE_LABELS, assignmentsToSettle, isOrgNotice, noticeLines, noticesForLecturer } from '../../../lib/org-notices.mjs'
import { ASSIGNMENTS_DIR, DASHBOARD_PATH, assignmentIdFromFile } from '../../../lib/control-layout.mjs'
import { RUN_NAME_PREFIX } from '../../../lib/acceptance-run-name.mjs'
import { orgFacts } from '../../../lib/org-facts.mjs'
import { TIMED_OUT, withDeadline } from '../lib/section-deadline.js'

const props = defineProps({
  org: { type: String, required: true },
})

const user = ref(null)
const loading = ref(true)
const loadError = ref('')
const access = ref(null)
// Whether the System health section is open: the checks run while it is.
const healthOpen = ref(false)

// The assignments by id - from the folder listing, so it is the whole list -
// and their titles from the dashboard file, falling back to the id.
const assignmentIds = ref(null)
const titles = ref({})
const comments = ref([])
const noticesState = ref('ok')
const issueUrl = ref(null)
const lastNightly = ref(null)

// The organization card (lib/org-facts.mjs): 'loading' | 'ok' | 'unreadable'.
const factsState = ref('loading')
const facts = ref(null)

const runs = ref([])
const runsRead = ref(false)
const runsLoading = ref(false)
const runsUnreadable = ref(false)

const fmt = (iso) => (iso ? formatDate(iso) : '')
const titleOf = (id) => titles.value[id] || id

// Who has a repository, per assignment with a notice about one student: what
// settles those notices. Null when it could not be read - nothing is settled.
const provisioned = ref(null)
const needsYou = computed(() => noticesForLecturer(comments.value, { assignmentIds: assignmentIds.value, provisioned: provisioned.value }))

// The Advanced section stays as the viewer left it: a per-browser convenience,
// so a lecturer who never needs it never sees it open, and one who does is not
// asked to open it every visit.
const ADVANCED_KEY = 'pxl_org_advanced_open'
function storedAdvanced() {
  try { return localStorage.getItem(ADVANCED_KEY) === '1' } catch { return false }
}
const advancedOpen = ref(storedAdvanced())
function onAdvancedToggle(e) {
  advancedOpen.value = !!e.target.open
  try { localStorage.setItem(ADVANCED_KEY, advancedOpen.value ? '1' : '0') } catch { /* private window: not remembered */ }
}

function runDot(r) {
  if (r.status !== 'completed') return 'dot-info'
  return r.conclusion === 'success' ? 'dot-success' : r.conclusion === 'failure' ? 'dot-warning' : 'dot-neutral'
}
function runOutcome(r) {
  if (r.status !== 'completed') return r.status === 'queued' ? 'waiting for GitHub to start it' : 'running'
  return r.conclusion === 'success' ? 'finished' : r.conclusion === 'cancelled' ? 'stopped' : r.conclusion === 'failure' ? 'failed' : r.conclusion || 'finished'
}

let generation = 0
let nightlyRuns = []

/** The nightly's last few runs: the "All quiet" line, and the run list later. */
async function loadNightly(token) {
  const hub = `${config.hubOwner}/${config.hubRepo}`
  const res = await ghApi(token, 'GET', `/repos/${hub}/actions/workflows/daily-activity.yml/runs?per_page=5`)
  if (!res.ok) return null
  return (res.data?.workflow_runs || []).map((r) => ({ ...r, label: 'Nightly check (all organizations)' }))
}

/** Read when "Recent runs" is first opened, never before: one page of 100 runs is the slowest read the page had. */
async function onRunsToggle(e) {
  if (!e.target.open || runsRead.value || runsLoading.value) return
  runsLoading.value = true
  // Closing and opening it again is how a failed read is tried again.
  runsUnreadable.value = false
  const mine = generation
  try {
    const hub = `${config.hubOwner}/${config.hubRepo}`
    const acceptance = await ghApi(getToken(), 'GET', `/repos/${hub}/actions/workflows/acceptance-handler.yml/runs?per_page=100`)
    if (mine !== generation) return
    if (!acceptance.ok) {
      runsUnreadable.value = true
      return
    }
    // An acceptance run is named after its attempt, `acceptance <org>/<broker>#<n>`
    // (lib/acceptance-run-name.mjs), which is what ties it to this organization.
    const mineRuns = (acceptance.data?.workflow_runs || [])
      .filter((r) => String(r.display_title || '').startsWith(`${RUN_NAME_PREFIX}${props.org}/`))
      .slice(0, 15)
      .map((r) => ({ ...r, label: `Acceptance ${String(r.display_title).slice(RUN_NAME_PREFIX.length + props.org.length + 1)}` }))
    runs.value = [...mineRuns, ...nightlyRuns].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
    runsRead.value = true
  } catch {
    if (mine === generation) runsUnreadable.value = true
  } finally {
    if (mine === generation) runsLoading.value = false
  }
}

// ONE PAGE IS NOT THE LIST. A count of members is the whole walk or nothing:
// past the cap, or on any failed page, it is unknown (null), never the part read.
const MEMBER_PAGES = 10
async function countAll(token, path) {
  let total = 0
  for (let page = 1; page <= MEMBER_PAGES; page++) {
    const res = await ghApi(token, 'GET', `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`)
    if (!res.ok || !Array.isArray(res.data)) return null
    total += res.data.length
    if (res.data.length < 100) return total
  }
  return null
}

// A GET to GitHub REJECTS when it times out (http.js) - the one way the
// resolve-don't-throw helpers in api.js throw - so a read that must not take
// its section down with it is settled here: its answer, or null.
async function settle(promise) {
  try {
    return await promise
  } catch {
    return null
  }
}

function retryFacts() {
  loadFacts(getToken(), generation)
}

/** The organization card, read beside the rest and shown when it arrives. */
async function loadFacts(token, mine) {
  factsState.value = 'loading'
  try {
    const orgRes = await settle(ghApi(token, 'GET', `/orgs/${props.org}`))
    if (mine !== generation) return
    if (!orgRes?.ok) {
      factsState.value = 'unreadable'
      return
    }
    // Owner-only fields absent: nothing more to read that would be shown.
    if (!orgRes.data?.plan?.name) {
      facts.value = orgFacts({ org: orgRes.data })
      factsState.value = 'ok'
      return
    }
    // Each one on its own: a count that times out is left out of the card,
    // never the card. The member walks also have a deadline as a whole.
    const now = new Date()
    const counted = (path) => withDeadline(countAll(token, path))
      .then((n) => (n === TIMED_OUT ? null : n))
      .catch(() => null)
    const [owners, members, billing] = await Promise.all([
      counted(`/orgs/${props.org}/members?role=admin`),
      counted(`/orgs/${props.org}/members`),
      settle(ghApi(token, 'GET', `/organizations/${encodeURIComponent(props.org)}/settings/billing/usage?year=${now.getUTCFullYear()}&month=${now.getUTCMonth() + 1}`)),
    ])
    if (mine !== generation) return
    facts.value = orgFacts({
      org: orgRes.data,
      owners,
      members,
      billingItems: billing?.ok && Array.isArray(billing.data?.usageItems) ? billing.data.usageItems : null,
    })
    factsState.value = 'ok'
  } catch {
    if (mine === generation) factsState.value = 'unreadable'
  }
}

async function load() {
  const mine = ++generation
  loading.value = true
  loadError.value = ''
  access.value = null
  runs.value = []
  runsRead.value = false
  runsUnreadable.value = false
  const token = getToken()
  // Not awaited: the card has its own loading line.
  loadFacts(token, mine)
  try {
    // ALL AT ONCE. These were read one after another, and then the lock record
    // of every past assignment, and then a run list, before anything showed.
    //
    // EACH ONE FAILS ON ITS OWN. A read that times out (http.js) or fails is
    // "unknown" for its own part of the page - the notices, the titles, the
    // nightly line - never the whole page; and the notices walk pages, so they
    // also get a deadline as a whole (lib/section-deadline.js).
    const [repoRes, files, dash, tracking, nightly] = await Promise.all([
      settle(getRepo(token, props.org, config.controlRepo)).then((r) => r || { ok: false, status: 0 }),
      listRepoDir(token, props.org, config.controlRepo, ASSIGNMENTS_DIR).catch((e) => (e?.status === 404 ? [] : null)),
      getRepoContent(token, props.org, config.controlRepo, DASHBOARD_PATH).catch(() => null),
      withDeadline(readTrackingIssue(token, { org: props.org, controlRepo: config.controlRepo }))
        .then((t) => (t === TIMED_OUT ? { state: 'unreadable' } : t))
        .catch(() => ({ state: 'unreadable' })),
      loadNightly(token).catch(() => null),
    ])
    if (mine !== generation) return
    if (!repoRes.ok) {
      if (repoRes.status === 404) {
        const verdict = await withDeadline(classifyUnreadableControlRepo(
          (method, path) => ghApi(token, method, path),
          { org: props.org, hubOwner: config.hubOwner, hubRepo: config.hubRepo },
        )).catch(() => TIMED_OUT)
        if (mine !== generation) return
        if (verdict === TIMED_OUT) {
          loadError.value = `GitHub did not answer in time about ${props.org}. Try again in a minute.`
          return
        }
        access.value = verdict
        markStaff(props.org, false)
      } else {
        loadError.value = repoRes.status
          ? `Couldn't read ${props.org}'s control repository (HTTP ${repoRes.status}).`
          : `GitHub did not answer in time about ${props.org}'s control repository. Try again in a minute.`
      }
      return
    }
    // Read the control repository: staff here, and the org's tabs can show.
    markStaff(props.org, true)

    // A listing that failed is not "no assignments": the ids are unknown, and
    // then no notice is hidden for naming one (noticesForLecturer).
    assignmentIds.value = files ? new Set(files.map((f) => assignmentIdFromFile(f.name)).filter(Boolean)) : null
    let parsed = null
    try { parsed = dash ? JSON.parse(dash) : null } catch { parsed = null }
    titles.value = Object.fromEntries(
      Object.entries(parsed?.assignments || {}).map(([id, a]) => [id, a?.title || id]),
    )
    noticesState.value = tracking.state === 'unreadable' ? 'unreadable' : 'ok'
    comments.value = tracking.state === 'ok' ? tracking.comments : []
    issueUrl.value = tracking.issueUrl || null
    nightlyRuns = nightly || []
    const lastNight = nightlyRuns.find((r) => r.status === 'completed')
    lastNightly.value = lastNight ? { at: lastNight.created_at, ok: lastNight.conclusion === 'success' } : null

    // Notices about one student settle when that student has their
    // repository: read the reports of the assignments that have any.
    const toSettle = assignmentsToSettle(comments.value).filter((id) => !assignmentIds.value || assignmentIds.value.has(id))
    const settled = toSettle.length
      ? await withDeadline(readProvisioned(token, props.org, config.controlRepo, toSettle)).catch(() => TIMED_OUT)
      : new Map()
    if (mine !== generation) return
    provisioned.value = settled === TIMED_OUT ? null : settled

    // The tab's count, from what this page just read - the same rule, so the
    // count and the list agree. Unknown when either half could not be read.
    setNeedsYou(props.org, noticesState.value === 'ok' && assignmentIds.value ? needsYou.value.length : null)
  } catch (e) {
    if (mine !== generation) return
    console.error('Failed to load the organization page', e)
    loadError.value = `Couldn't load ${props.org}${e?.status ? ` (HTTP ${e.status})` : ''}.`
  } finally {
    if (mine === generation) loading.value = false
  }
}

function onAuthenticated(authedUser) {
  user.value = authedUser
  load()
}

watch(() => props.org, () => { if (user.value) load() })

onMounted(() => {
  if (!isAuthenticated()) { loading.value = false; return }
  user.value = getUser()
  load()
})
</script>

<style scoped>
/* The width every other page of the org has (`.container`), so moving between
   the tabs does not move the content's edges. */
.org-page { padding-top: var(--space-xl); padding-bottom: var(--space-2xl); }
.org-load-error { text-align: center; padding: var(--space-lg); }
.org-needs { padding: var(--space-lg); margin-bottom: var(--space-lg); }
.org-needs-loading { display: flex; align-items: center; gap: var(--space-sm); margin: 0; }
.org-needs-title { display: flex; align-items: center; gap: var(--space-sm); font-size: 1.1rem; margin: 0 0 var(--space-xs); }
.org-needs-list { list-style: none; padding: 0; margin: var(--space-md) 0; display: flex; flex-direction: column; gap: var(--space-md); }
.org-needs-item { padding-bottom: var(--space-md); border-bottom: 1px solid var(--border-muted); }
.org-needs-item:last-child { padding-bottom: 0; border-bottom: none; }
.org-needs-head { display: flex; align-items: baseline; gap: var(--space-sm); flex-wrap: wrap; }
.org-needs-what { font-weight: 600; }
.org-needs-text { margin: var(--space-xs) 0 0; color: var(--text-secondary); font-size: 0.9rem; }
.org-needs-more > summary { cursor: pointer; color: var(--text-secondary); font-size: 0.85rem; margin-top: var(--space-xs); }
.org-needs-rest { margin: var(--space-xs) 0 0; white-space: pre-line; color: var(--text-secondary); font-size: 0.85rem; }
.org-about { padding: var(--space-lg); margin-bottom: var(--space-lg); }
.org-about-title { font-size: 1rem; margin: 0 0 var(--space-sm); }
.org-about-plan { margin: 0; }
.org-about-lines { margin: var(--space-xs) 0 0; padding-left: 1.25rem; color: var(--text-secondary); font-size: 0.9rem; display: flex; flex-direction: column; gap: 2px; }
.org-about-more { margin-top: var(--space-xs); }
.org-about-more > summary { cursor: pointer; color: var(--text-secondary); font-size: 0.85rem; }
.org-about-more > a { display: inline-block; margin-top: var(--space-xs); font-size: 0.9rem; }
.org-about-facts { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: var(--space-xs) var(--space-md); margin: var(--space-md) 0 0; font-size: 0.9rem; }
.org-about-facts dt { color: var(--text-muted); }
.org-about-facts dd { margin: 0; }
.org-about-note { display: block; color: var(--text-secondary); }
.org-advanced > summary { cursor: pointer; list-style-position: outside; margin-bottom: var(--space-md); }
.org-health > p { margin: var(--space-sm) 0 0; }
.org-advanced-title { display: inline; font-size: 1rem; margin: 0 var(--space-sm) 0 0; }
/* The usage panel is a component; its root takes this page's scope. */
.org-advanced-body > .usage-panel { margin-bottom: var(--space-md); }
.org-fold { padding: var(--space-md) var(--space-lg); margin-bottom: var(--space-md); }
.org-fold > summary { cursor: pointer; list-style-position: outside; }
.org-fold > summary h3 { display: inline; font-size: 1rem; margin: 0; }
.org-runs, .org-links { list-style: none; padding: 0; margin: var(--space-md) 0 0; display: flex; flex-direction: column; gap: var(--space-sm); }
.org-runs li { display: flex; gap: var(--space-sm); align-items: center; flex-wrap: wrap; }
</style>
