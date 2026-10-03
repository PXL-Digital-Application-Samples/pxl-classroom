<template>
  <div class="dashboard-page">
    <!-- The top bar - the organization picker and the org's tabs - is the
         organization's (OrgShell.vue), drawn once for all its pages. It was
         this page's own, which is why the picker existed here only. System
         health and Usage & limits are on the Organization tab. -->

    <main class="container">
      <!-- Stuck Hub Pipeline Alert Banner (Visible to Hub Staff) -->
      <div v-if="user && hubWritable && hubStuckRun" class="pipeline-stuck-banner card flex items-center justify-between gap-md" role="alert">
        <div class="flex items-center gap-sm">
          <Icon name="alert-triangle" :size="16" class="text-warning" />
          <div class="text-sm">
            <strong>Pipeline Warning:</strong> Workflow <code>{{ hubStuckRun.name }}</code> (#{{ hubStuckRun.id }}) has been {{ hubStuckRun.status }} for {{ hubStuckRun.durationMin }}m.
          </div>
        </div>
        <div class="flex items-center gap-sm">
          <button class="btn btn-danger-outline btn-sm btn-with-icon" type="button" @click="cancelStuckRun(hubStuckRun.id)" :disabled="cancellingRun">
            <Icon name="x-circle" :size="13" />
            <span>{{ cancellingRun ? 'Cancelling…' : 'Cancel Run' }}</span>
          </button>
          <button class="btn btn-secondary btn-sm" type="button" @click="showHealthModal = true">
            <span>Diagnostics</span>
          </button>
        </div>
      </div>

      <!-- GitHub's installation page has no route back here, so returning
           lecturers were left guessing. This stays until an org appears. -->
      <div v-if="connectPending && user" class="connect-pending card flex items-center justify-between gap-md">
        <div class="flex items-center gap-sm">
          <Icon name="info" :size="16" class="text-blue" />
          <span class="text-sm">Finished installing on GitHub?</span>
        </div>
        <div class="flex items-center gap-sm">
          <button class="btn btn-sm btn-with-icon" type="button" @click="refreshOrgsNow">
            <Icon name="refresh-cw" :size="13" />
            <span>Check now</span>
          </button>
          <button class="btn btn-sm btn-ghost" type="button" @click="connectPending = false">Dismiss</button>
        </div>
      </div>

      <!-- "New look", once. Staff only, and only once the page has established
           it: a student whose installation reaches this org must never be told
           about a lecturer's screens. Above every state of the page, so a
           lecturer in a course with no assignments yet is told too. -->
      <WhatsNewCard v-if="user && staffVerdict === true" />

      <!-- Not authenticated -->
      <AuthCard v-if="!user" title="Sign in to access the dashboard" @authenticated="onAuthenticated">
        Sign in with a GitHub account that owns an organization with PXL Classroom installed.
      </AuthCard>

      <!-- Loading -->
      <div v-else-if="loadingData" class="center-card fade-in">
        <div class="spinner-lg spinner"></div>
        <p class="text-secondary">Loading dashboard data…</p>
      </div>

      <!-- Orgs load error -->
      <div v-else-if="orgsLoadError" class="center-card fade-in">
        <h2>Couldn't load your organizations</h2>
        <p class="text-secondary" role="alert" style="margin-bottom: var(--space-md);">
          {{ orgsLoadError }}
        </p>
        <button class="btn btn-primary" @click="loadOrgs">Retry</button>
      </div>

      <!-- Dashboard Load Error -->
      <div v-else-if="selectedOrg && dashError" class="center-card fade-in">
        <h2 class="text-danger">Failed to load dashboard</h2>
        <p class="text-secondary" style="margin-bottom: var(--space-md);">{{ dashError }}</p>
        <button class="btn btn-primary" @click="loadDashboard">Retry</button>
      </div>

      <!-- No installation visible to this account (Student or unconfigured lecturer) -->
      <!-- Two audiences land here: a lecturer whose org is not connected yet,
           and an actual student who followed a stray link. Name both paths
           instead of asserting which one they are - and give the lecturer an
           action rather than a RUNBOOK link. -->
      <div v-else-if="orgsLoaded && orgs.length === 0" class="center-card fade-in">
        <h2>No course organizations yet</h2>
        <p class="text-secondary">
          <strong>{{ user.login }}</strong> has no organization with PXL Classroom installed.
        </p>
        <a :href="appInstallUrl" target="_blank" rel="noopener" class="btn btn-primary btn-with-icon" @click="onConnectClicked">
          <Icon name="plus" :size="14" />
          <span>Connect an organization</span>
        </a>
        <p class="text-muted text-xs" style="max-width: 420px; line-height: 1.5;">
          GitHub will ask which organization to install it on - you will only see
          the ones you can install on. Come back here afterwards; it appears
          automatically.
        </p>
        <p class="text-secondary text-sm" style="margin-top: var(--space-md);">
          Enrolled in a course instead?
          <router-link to="/">View your assignments</router-link>.
        </p>
      </div>

      <!-- No org selected -->
      <div v-else-if="!selectedOrg" class="center-card fade-in">
        <h2>Select an organization</h2>
        <p class="text-secondary">Choose an organization from the dropdown above.</p>
      </div>

      <!-- No assignments - say WHY, each cause has a different remedy -->
      <div v-else-if="assignments.length === 0 && drafts.length === 0" class="center-card fade-in">
        <!-- NOT STAFF HERE, and it must say so rather than describe a
             half-configured organization.
             The org reaches the switcher for anyone whose App installation
             touches it, which accepting one assignment is enough to do - so a
             student landed on the onboarding screen, badged Lecturer, told
             this organization "needs its control repository" and offered a
             Setup Organization button. The repository exists; they cannot read
             it. Nothing was ever exposed - every read behind this screen is the
             private control repo and every write is refused by GitHub - but a
             surface that hands a student a staff console and an admin button
             is its own defect (DESIGN.md §1.5). -->
        <template v-if="dashState === 'no-access'">
          <Icon name="lock" :size="48" class="status-icon" />
          <h2>This is a lecturer view for {{ selectedOrg }}</h2>
          <p class="text-secondary">
            Your account does not have access to this organization's course data, so there is
            nothing to show here.
          </p>
          <p class="text-secondary">
            <strong>{{ selectedOrg }}</strong> appears above because you have access to at least
            one repository in it - accepting an assignment is enough. That is not the same as
            teaching the course.
          </p>
          <p class="text-secondary">
            If you are a student, your assignments are on your own page. If you are a lecturer for
            this course, ask a PXL Classroom administrator to set the organization up and to give
            you access to its control repository.
          </p>
          <div class="flex justify-center gap-sm mt-md">
            <router-link to="/" class="btn btn-primary">My assignments</router-link>
          </div>
        </template>

        <!-- SET UP, AND NOT READABLE BY THIS ACCOUNT. An account that can run
             Setup Organization (write on the hub) but does not own this org.
             It was shown the onboarding card below and a Set up button, over
             a course that had been running for days (2026-09-17) - and ran it
             twice. The hub registry says the org is set up, so the only thing
             missing is access, and that is granted by the organization. -->
        <template v-else-if="dashState === 'no-org-access'">
          <Icon name="lock" :size="48" class="status-icon" />
          <h2>{{ selectedOrg }} is set up, but not for this account</h2>
          <p class="text-secondary">
            Its course data is in a private repository this account can't read. Running
            Setup Organization again won't change that: access comes from the organization,
            not from the hub.
          </p>
          <p class="text-secondary">
            To teach this course, ask an owner of <strong>{{ selectedOrg }}</strong> to add you
            as an owner, then check again.
            <span v-if="budgetOwner && !budgetOwnerIsViewer">Its budget owner is <strong>@{{ budgetOwner }}</strong>.</span>
          </p>
          <div class="flex justify-center gap-sm mt-md">
            <button class="btn btn-primary btn-with-icon" type="button" @click="loadDashboard()">
              <Icon name="refresh-cw" :size="14" />
              <span>Check again</span>
            </button>
          </div>
        </template>

        <!-- The same account, and the registry did not load. Unreadable is not
             evidence: this may be a course that is not set up or one this
             account cannot read, so it offers neither Set up nor a refusal. -->
        <template v-else-if="dashState === 'registry-unknown'">
          <Icon name="lock" :size="48" class="status-icon" />
          <h2>Couldn't tell whether {{ selectedOrg }} is set up</h2>
          <p class="text-secondary">
            This account can't read {{ selectedOrg }}'s control repository, and the hub's list of
            set-up organizations didn't load - so this page can't tell a course that isn't set up
            from one you haven't been given access to.
          </p>
          <div class="flex justify-center gap-sm mt-md">
            <button class="btn btn-primary btn-with-icon" type="button" @click="loadDashboard()">
              <Icon name="refresh-cw" :size="14" />
              <span>Check again</span>
            </button>
          </div>
        </template>

        <template v-else-if="dashState === 'no-control-repo'">
          <!-- Was a dead end pointing at ADMIN.md §1. The org is already in the
               switcher, so the App IS installed - only the control repo is
               missing, and whether the lecturer can create it themselves
               depends on their hub access. -->
          <div class="setup-required-card">
            <div class="onboarding-head">
              <Icon name="zap" :size="24" class="text-blue" />
              <div>
                <h2>Almost there - {{ selectedOrg }} needs its control repository</h2>
                <p class="text-secondary">
                  One more step before you can create assignments. This runs once per organization.
                </p>
              </div>
            </div>

            <div class="onboarding-steps">
              <div class="onboarding-step" :class="{ 'is-complete': orgIsInstalled }">
                <div class="step-icon">
                  <Icon v-if="orgIsInstalled" name="check-circle" :size="16" class="text-green" />
                  <Icon v-else name="alert-triangle" :size="16" class="text-yellow" />
                </div>
                <div class="step-body">
                  <strong v-if="orgIsInstalled">PXL Classroom is installed on {{ selectedOrg }}</strong>
                  <strong v-else>PXL Classroom is not installed on {{ selectedOrg }} yet</strong>
                  <p v-if="orgIsInstalled">That is why this organization appears in your switcher.</p>
                  <p v-else>
                    Install it first - the step below cannot run until it is.
                    <a :href="appInstallUrl" target="_blank" rel="noopener">Install PXL Classroom</a>.
                  </p>
                </div>
              </div>

              <div class="onboarding-step">
                <div class="step-icon"><Icon name="inbox" :size="16" class="text-yellow" /></div>
                <div class="step-body">
                  <strong>Create the course control repository</strong>
                  <p v-if="hubWritable">
                    One click below creates it. Takes about a minute - this page
                    updates by itself when it is done.
                  </p>
                  <p v-else>
                    A hub admin runs <strong>Setup Organization</strong> for
                    <code>{{ selectedOrg }}</code> - you do not have write access to the hub
                    repository, so this one has to be run for you. It takes about a minute.
                  </p>
                </div>
              </div>
            </div>

            <div class="onboarding-actions">
              <!-- If they can dispatch it, do it FOR them: no hub repo to find,
                   no Actions tab, no branch to pick, no org name to type. -->
              <button
                v-if="hubWritable && orgIsInstalled"
                class="btn btn-primary btn-with-icon"
                type="button"
                :disabled="settingUp"
                @click="runSetupOrg"
              >
                <Icon name="zap" :size="14" :class="{ 'spin-icon': settingUp }" />
                <span>{{ settingUp ? 'Setting up…' : `Set up ${selectedOrg}` }}</span>
              </button>
              <a
                v-else-if="orgIsInstalled"
                :href="`https://github.com/${config.hubOwner}/${config.hubRepo}/actions/workflows/setup-org.yml`"
                target="_blank"
                rel="noopener"
                class="btn btn-primary btn-with-icon"
              >
                <Icon name="external-link" :size="14" />
                <span>Open Setup Organization</span>
              </a>
              <a
                v-else
                :href="appInstallUrl"
                target="_blank"
                rel="noopener"
                class="btn btn-primary btn-with-icon"
              >
                <Icon name="plus" :size="14" />
                <span>Install PXL Classroom</span>
              </a>
              <button class="btn btn-with-icon" type="button" :disabled="settingUp" @click="loadDashboard()">
                <Icon name="refresh-cw" :size="14" />
                <span>Recheck</span>
              </button>
            </div>
          </div>
        </template>
        <template v-else-if="dashState === 'onboarding'">
          <div class="onboarding-readiness-card">
            <div class="onboarding-head">
              <Icon name="award" :size="24" class="text-blue" />
              <div>
                <h2>Welcome to {{ selectedOrg }}</h2>
                <p class="text-secondary">Your course organization is connected to PXL Classroom. Follow these simple steps to launch your first assignment:</p>
              </div>
            </div>

            <div class="onboarding-steps">
              <div class="onboarding-step is-complete">
                <div class="step-icon"><Icon name="check-circle" :size="16" class="text-green" /></div>
                <div class="step-body">
                  <strong>1. Course Organization Connected</strong>
                  <p>PXL Classroom Provisioner App is installed and active on <code>{{ selectedOrg }}</code>.</p>
                </div>
              </div>

              <div class="onboarding-step">
                <div class="step-icon"><Icon name="git-branch" :size="16" class="text-yellow" /></div>
                <div class="step-body">
                  <strong>2. Prepare Starter Code Template</strong>
                  <p>Have an exercise repository for students? Create a repo in <code>{{ selectedOrg }}</code> on GitHub and check <em>"Template repository"</em> under its Settings.</p>
                </div>
              </div>

              <div class="onboarding-step">
                <div class="step-icon"><Icon name="plus-circle" :size="16" class="text-blue" /></div>
                <div class="step-body">
                  <strong>3. Create &amp; Publish Assignment</strong>
                  <p>Create an assignment, select your template, and publish it to get the student invitation link.</p>
                </div>
              </div>
            </div>

            <div class="onboarding-actions">
              <router-link :to="{ name: 'assignment-new', params: { org: selectedOrg } }" class="btn btn-primary btn-with-icon">
                <Icon name="plus" :size="14" />
                <span>Create Your First Assignment</span>
              </router-link>
              <button class="btn btn-with-icon" type="button" @click="showHealthModal = true">
                <Icon name="activity" :size="14" />
                <span>Check System Health</span>
              </button>
            </div>
          </div>
        </template>
        <template v-else-if="dashState === 'no-dashboard'">
          <h2>No dashboard data yet</h2>
          <p class="text-secondary">
            The control repo exists, but <code>reports/dashboard.json</code> hasn't been generated yet.
            It appears when an assignment is published (and refreshes nightly).
            <span style="display: block; margin-top: var(--space-xs);">
              Published assignments appear here once the first report is generated.
            </span>
          </p>
          <router-link :to="{ name: 'assignment-new', params: { org: selectedOrg } }" class="btn btn-primary">New assignment</router-link>
        </template>
        <!-- The state the page cannot explain.
             "Assignments in this organization are closed or archived" was
             asserted here whenever the list was empty and nothing had set a
             dashState - and it was a GUESS: nothing on this branch has read an
             assignment's state. It was shown over six published assignments on
             PXL-Automation-II (2026-09-05), which is the one thing it must not
             be able to say. Closed and archived assignments are IN this list
             anyway, so an empty list never means "they are all closed".
             Unreadable is not evidence, and neither is unexplained. -->
        <template v-else>
          <h2>Nothing to show for {{ selectedOrg }}</h2>
          <p class="text-secondary">
            No assignments came back for this organization. If you know there are some,
            this is a failed load rather than an empty course - reload, and tell whoever
            maintains this deployment if it keeps happening.
          </p>
          <router-link :to="{ name: 'assignment-new', params: { org: selectedOrg } }" class="btn btn-primary">New assignment</router-link>
        </template>
      </div>

      <!-- Assignment grid -->
      <div v-else class="fade-in">
        <div class="section-toolbar flex items-center justify-between">
          <div class="flex items-center gap-md">
            <h2 class="section-title">Assignments</h2>
            <span v-if="selectedOrg" class="status-indicator" :title="getOrgStatusTitle(selectedOrg)">
              <span class="status-dot" :class="`dot-${getOrgStatusDot(selectedOrg)}`"></span>
              <span class="text-secondary text-sm">{{ getOrgStatusLabel(selectedOrg) }}</span>
            </span>
            <label v-if="archivedCount > 0" class="archived-toggle flex items-center gap-xs text-sm text-secondary">
              <input type="checkbox" v-model="showArchived" />
              <span>Show archived ({{ archivedCount }})</span>
            </label>
          </div>
          <div class="flex items-center gap-sm">
            <router-link :to="{ name: 'assignment-new', params: { org: selectedOrg } }" class="btn btn-primary btn-with-icon">
              <Icon name="plus" :size="14" />
              <span>New assignment</span>
            </router-link>
          </div>
        </div>

        <!-- Drafts first and apart: nothing to track yet, so a name and a
             deadline, and a click opens the settings, where a draft's work is. -->
        <section v-if="drafts.length" class="drafts-row" aria-label="Drafts">
          <h3 class="drafts-row-title text-secondary text-sm">Drafts</h3>
          <div class="drafts-row-list">
            <router-link
              v-for="d in drafts"
              :key="d.id"
              :to="{ name: 'assignment-detail', params: { org: selectedOrg, assignmentId: d.id }, query: { tab: 'settings' } }"
              class="draft-chip card"
            >
              <span class="status-dot dot-neutral"></span>
              <span class="draft-chip-title">{{ d.title || d.id }}</span>
              <span v-if="d.deadline_at" class="text-muted text-xs">due {{ formatDate(d.deadline_at, d.timezone) }}</span>
            </router-link>
          </div>
        </section>

        <div v-if="visibleAssignments.length === 0 && drafts.length" class="center-card text-secondary" style="padding: var(--space-xl); margin-top: var(--space-lg);">
          Nothing published yet. Publish a draft to hand out its invitation link.
        </div>
        <div v-else-if="visibleAssignments.length === 0" class="center-card text-secondary" style="padding: var(--space-xl); margin-top: var(--space-lg);">
          No active assignments right now.
        </div>
        <div v-else class="assignment-grid">
          <router-link
            v-for="a in visibleAssignments"
            :key="a.id"
            :to="{ name: 'assignment-detail', params: { org: selectedOrg, assignmentId: a.id } }"
            class="assignment-card card"
            :class="{ 'assignment-card-closed': a.state !== 'published' }"
            style="text-decoration: none; color: inherit; display: block;"
          >
            <div class="card-header flex items-center justify-between">
              <span class="status-indicator">
                <span class="status-dot" :class="a.state === 'published' ? 'dot-success' : 'dot-neutral'"></span>
                <span class="status-text">{{ assignmentStateLabel(a.state) }}</span>
              </span>
              <span class="flex items-center gap-xs">
                <span class="text-muted text-xs mono">{{ a.id }}</span>
                <!-- dashboard.json carries no invitation token - it must not,
                     and does not need to: the component reads it from the
                     control repo on click, so a card costs nothing until
                     somebody actually wants the link (ARCHITECTURE §10.3). -->
                <InvitationShare
                  v-if="a.state === 'published'"
                  :org="selectedOrg"
                  :assignment="{ ...a, timezone: a.timezone, accepted_count: typeof a.accepted === 'number' ? a.accepted : null }"
                  variant="compact"
                />
              </span>
            </div>
            <h3 class="assignment-card-title">{{ a.title }}</h3>
            <p class="deadline-text">
              <span>Deadline: {{ formatDate(a.deadline_at, a.timezone) }}</span>
              <span
                v-if="a.deadline_at && formatRelative(a.deadline_at)"
                class="font-medium"
                :class="{ 'stat-red': a.state === 'published' && isPast(a.deadline_at) }"
              > · {{ formatRelative(a.deadline_at) }}</span>
            </p>
            <div class="stats-row">
              <div class="stat">
                <span class="stat-value">{{ a.accepted ?? '-' }}</span>
                <span class="stat-label">Accepted</span>
              </div>
              <div class="stat">
                <span class="stat-value" :class="{ 'stat-green': a.state === 'published' && a.on_time > 0 }">{{ a.on_time ?? '-' }}</span>
                <span class="stat-label">On time</span>
              </div>
              <div class="stat">
                <span class="stat-value" :class="{ 'stat-yellow': a.state === 'published' && a.late > 0 }">{{ a.late ?? '-' }}</span>
                <span class="stat-label">Late</span>
              </div>
              <div class="stat">
                <span class="stat-value" :class="{ 'stat-red': a.state === 'published' && a.no_submission > 0 }">{{ a.no_submission ?? '-' }}</span>
                <span class="stat-label">No submission</span>
              </div>
              <!-- Named for what it is. "Warnings" counted three things, two of
                   which merely restated other columns and no longer render
                   anywhere, so the badge sent a lecturer looking for something
                   that was not on the page. -->
              <!-- Only once somebody has a score. Read from the assignment's
                   grade summary, not dashboard.json: that is regenerated by a
                   workflow, and a Re-grade on the assignment page would not
                   reach this card until it ran. -->
              <div class="stat" v-if="gradedCounts.get(gradedKey(a.id)) > 0">
                <span class="stat-value">{{ gradedCounts.get(gradedKey(a.id)) }}</span>
                <span class="stat-label">Graded</span>
              </div>
              <div class="stat" v-if="a.with_repo_faults">
                <span class="stat-value" :class="{ 'stat-orange': a.state === 'published' }">{{ a.with_repo_faults }}</span>
                <span class="stat-label">Repo faults</span>
              </div>
            </div>
          </router-link>
        </div>
      </div>

      <!-- Unified Health Diagnostics Modal -->
      <SystemHealthModal
        :is-open="showHealthModal"
        :org="selectedOrg"
        @close="showHealthModal = false"
      />
    </main>
  </div>
</template>

<script setup>
import { ref, watch, onMounted, onUnmounted, computed } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import AuthCard from '../components/AuthCard.vue'
import SystemHealthModal from '../components/SystemHealthModal.vue'
import InvitationShare from '../components/InvitationShare.vue'
import Icon from '../components/Icon.vue'
import WhatsNewCard from '../components/WhatsNewCard.vue'
import { config } from '../lib/config.js'
import { assignmentStateLabel } from '../lib/status-labels.js'
import { getToken, getUser, isAuthenticated } from '../lib/auth.js'
import { getRepoContent, getRepo, listRepoDir, triggerWorkflow, explainDispatchFailure, ghApi } from '../lib/api.js'
import {
  orgs, orgsLoaded, orgsLoadError, connectPending, setOrgStatus, isInstalled, markStaff,
  orgStatusTitle, orgStatusLabel, orgStatusDot, loadOrgs as loadSharedOrgs, rememberOrg, rememberedOrg,
} from '../lib/org-session.js'
import { toast } from '../lib/toast.js'
import { APP_INSTALL_URL } from '../../../lib/audit.mjs'
import { sameLogin } from '../../../lib/github-login.mjs'
import { gradingSummaryPath } from '../../../lib/control-layout.mjs'
import { countGraded } from '../../../lib/grading-summary.mjs'
import { classifyUnreadableControlRepo, readOrgRegistration } from '../lib/control-repo-access.js'
import { formatDate, formatRelative, isPast } from '../lib/format.js'

const props = defineProps({
  org: { type: String, required: false }
})

const router = useRouter()
const route = useRoute()

const user = ref(getUser())
const selectedOrg = ref(props.org || '')
const assignments = ref([])
const loadingData = ref(false)
const showHealthModal = ref(false)

// The organizations, their status lights and the picker are the shared top
// bar's (OrgShell.vue, OrgPicker.vue, lib/org-session.js). This page lights
// the selected org from its own fuller read (setOrgStatus below) and shows
// the same light in its toolbar.
const getOrgStatusTitle = orgStatusTitle
const getOrgStatusLabel = orgStatusLabel
const getOrgStatusDot = orgStatusDot

// Why the assignment list is empty: '' | 'no-control-repo' | 'no-access' |
// 'no-org-access' | 'registry-unknown' | 'onboarding' | 'no-dashboard' | 'empty'
const dashState = ref('')
// What an unreadable control repository means, as control-repo-access.js
// judges it, spelled as the states this view renders.
const DASH_STATE_FOR_VERDICT = Object.freeze({
  'not-set-up': 'no-control-repo',
  'no-access': 'no-access',
  'no-org-access': 'no-org-access',
  unknown: 'registry-unknown',
})
// The states in which this account has NOT shown it can read this org's course
// data. The Lecturer tag and the usage panel are both claims about this org, so
// neither renders in them. `no-control-repo` is not here: an owner's 404 is a
// course that genuinely has no control repository yet.
const CANNOT_READ_ORG = new Set(['no-access', 'no-org-access', 'registry-unknown'])
const staffHere = computed(() => !CANNOT_READ_ORG.has(dashState.value))
const hubWritable = ref(false)
const hubStuckRun = ref(null)
const cancellingRun = ref(false)

async function checkHubPipelines() {
  if (!hubWritable.value) {
    hubStuckRun.value = null
    return
  }
  const token = getToken()
  if (!token) return
  try {
    const [waitingRes, progressRes] = await Promise.all([
      ghApi(token, 'GET', `/repos/${config.hubOwner}/${config.hubRepo}/actions/runs?status=waiting`),
      ghApi(token, 'GET', `/repos/${config.hubOwner}/${config.hubRepo}/actions/runs?status=in_progress`),
    ])
    const now = Date.now()
    const candidates = []
    if (waitingRes.ok && Array.isArray(waitingRes.data?.workflow_runs)) {
      for (const r of waitingRes.data.workflow_runs) {
        const ageMs = now - new Date(r.created_at).getTime()
        if (ageMs > 15 * 60 * 1000) {
          candidates.push({ id: r.id, name: r.name || 'Workflow', status: r.status, durationMin: Math.max(1, Math.round(ageMs / 60000)) })
        }
      }
    }
    if (progressRes.ok && Array.isArray(progressRes.data?.workflow_runs)) {
      for (const r of progressRes.data.workflow_runs) {
        const ageMs = now - new Date(r.created_at).getTime()
        if (ageMs > 45 * 60 * 1000) {
          candidates.push({ id: r.id, name: r.name || 'Workflow', status: r.status, durationMin: Math.max(1, Math.round(ageMs / 60000)) })
        }
      }
    }
    hubStuckRun.value = candidates[0] || null
  } catch {
    // Non-blocking
  }
}

async function cancelStuckRun(runId) {
  const token = getToken()
  if (!token) return
  cancellingRun.value = true
  try {
    const res = await ghApi(token, 'POST', `/repos/${config.hubOwner}/${config.hubRepo}/actions/runs/${runId}/cancel`)
    if (res.ok || res.status === 202) {
      toast.success(`Workflow run #${runId} cancellation requested!`)
      hubStuckRun.value = null
      setTimeout(checkHubPipelines, 3000)
    } else {
      toast.error(`Failed to cancel run #${runId}: ${res.data?.message || 'unknown error'}`)
    }
  } catch (err) {
    toast.error(`Cancellation error: ${err.message}`)
  } finally {
    cancellingRun.value = false
  }
}

watch(hubWritable, (writable) => {
  if (writable) checkHubPipelines()
  else hubStuckRun.value = null
})
// Set with the verdict. Only an owner can watch for the control repository
// after Setup Organization - anyone else is watching for a repository they will
// never be able to see - and the registry's budget owner is the one name this
// page can give a non-member to ask.
const orgAdminHere = ref(false)
const budgetOwner = ref(null)
const budgetOwnerIsViewer = computed(() => sameLogin(budgetOwner.value, user.value?.login))
const settingUp = ref(false)
// Set when the lecturer leaves for GitHub's installation page, cleared as soon
// as an org appears. Without it, "install finished, now what?" has no answer
// in this UI at all.
// `connectPending` is the shared one: the top bar's picker sets it too.
function onConnectClicked() {
  connectPending.value = true
}
async function refreshOrgsNow() {
  const before = orgs.value.length
  lastOrgRefresh = Date.now()
  await loadOrgs()
  if (orgs.value.length > before) {
    connectPending.value = false
    toast.success('Organization connected.')
  } else {
    toast.info('No new organization yet. Finish installing on GitHub, then try again.')
  }
}

// Reaching this view by URL does not imply the App is on that org - the org
// switcher only lists installations, but /dashboard/<anything> is routable.
const orgIsInstalled = computed(() =>
  isInstalled(selectedOrg.value)
)
// Bumped on org switch and on unmount, so a poll in flight can tell that its
// answer is no longer wanted. Same reason SystemHealthModal carries one.
let setupGeneration = 0
// selectedOrg is initialised from the route param and then possibly CORRECTED
// by loadOrgs() when that org has no installation - so two loads can be in
// flight for different orgs. Without this, the slower one wins and the
// dashboard shows the abandoned org's state.
let dashGeneration = 0

// The whole point of the button: a beginner should not have to find the hub
// repo, open Actions, pick the workflow, choose a branch and type their own org
// name into a form field. Dispatch it for them, then watch for the outcome we
// actually care about - the control repository existing - and advance by
// itself. Never fire-and-forget (CLAUDE.md).
const SETUP_POLL_MS = 5000
const SETUP_TIMEOUT_MS = 4 * 60 * 1000

async function runSetupOrg() {
  const token = getToken()
  const org = selectedOrg.value
  if (!token || !org || settingUp.value) return

  // FIX 5: the workflow declares this required. Dispatching an empty string
  // would register a blank budget owner in participating-orgs.yml, and the
  // weekly usage report @-mentions that login.
  const budgetOwner = user.value?.login
  if (!budgetOwner) {
    toast.error('Could not determine your GitHub login. Sign in again, then retry.')
    return
  }

  const generation = ++setupGeneration
  settingUp.value = true
  try {
    const res = await triggerWorkflow(token, config.hubOwner, config.hubRepo, 'setup-org.yml', {
      target_org: org,
      budget_owner_login: budgetOwner,
    })
    if (!res.ok && res.status !== 204) {
      toast.error(explainDispatchFailure(res, 'Could not start Setup Organization'))
      settingUp.value = false
      return
    }
    toast.success(`Setting up ${org}. This takes about a minute.`)

    const deadline = Date.now() + SETUP_TIMEOUT_MS
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, SETUP_POLL_MS))
      // Superseded: the lecturer switched org or left. Stop silently rather
      // than reloading a dashboard they are not on and toasting about an org
      // they are no longer looking at.
      if (generation !== setupGeneration) return
      const repo = await getRepo(token, org, config.controlRepo)
      if (generation !== setupGeneration) return
      if (repo.ok) {
        toast.success(`${org} is ready.`)
        await loadDashboard(org)
        return
      }
      // A NON-OWNER NEVER SEES THE REPOSITORY APPEAR. Setup creates it inside an
      // org this account cannot read, so waiting for it ran the full four minutes
      // and then said Setup was "taking longer than expected" about a run that had
      // succeeded. Registration is Setup's last step, so it is the finish line an
      // outsider can see. Not for an owner: re-running Setup to recreate a deleted
      // control repository leaves the org listed from before, and that must not
      // end the wait before the repository exists.
      if (!orgAdminHere.value) {
        const registration = await readOrgRegistration(
          (method, path) => ghApi(token, method, path),
          { org, hubOwner: config.hubOwner, hubRepo: config.hubRepo },
        )
        if (generation !== setupGeneration) return
        if (registration.state === 'listed') {
          toast.success(`${org} is set up.`)
          await loadDashboard(org)
          return
        }
      }
    }
    if (generation !== setupGeneration) return
    toast.error(
      `Setup Organization is taking longer than expected for ${org}. ` +
        'Check the run in the hub repository, then use Recheck.',
      { link: { href: `https://github.com/${config.hubOwner}/${config.hubRepo}/actions/workflows/setup-org.yml`, text: 'View run' } }
    )
  } catch (e) {
    if (generation === setupGeneration) toast.error(`Could not start Setup Organization: ${e.message}`)
  } finally {
    if (generation === setupGeneration) settingUp.value = false
  }
}
const dashError = ref(null)

// DRAFTS ARE A ROW OF THEIR OWN, above the cards (BETA-UX.md, 2026-10-02):
// nothing to track yet, so no figures, and each opens its settings, which is
// where a draft's work is. Set wherever the list is, never cleared ahead of
// its replacement.
const drafts = ref([])
const draftCount = computed(() => drafts.value.length)
const showArchived = ref(false)

const archivedCount = computed(() => {
  return assignments.value.filter(a => a.state === 'archived').length
})

// STUDENTS WITH A SCORE, per card - from each assignment's grade summary,
// read when the list is shown (a card's Graded stat). Keyed by org as well as
// id, so switching organization never shows one org's count on another's
// card. A summary that is absent or unreadable shows no count at all: nothing
// is known, and a 0 would read as "graded, and nobody passed".
const gradedCounts = ref(new Map())
const gradedKey = (id) => `${String(selectedOrg.value || '').toLowerCase()}/${id}`
let gradedGeneration = 0
async function loadGradedCounts(org, list) {
  const generation = ++gradedGeneration
  const token = getToken()
  if (!token || !org) return
  const ids = list.filter((a) => a.state !== 'draft').map((a) => a.id)
  const next = new Map()
  let cursor = 0
  const worker = async () => {
    while (cursor < ids.length) {
      const id = ids[cursor++]
      try {
        const text = await getRepoContent(token, org, config.controlRepo, gradingSummaryPath(id))
        if (text) next.set(`${org.toLowerCase()}/${id}`, countGraded(JSON.parse(text)?.students))
      } catch {
        // absent (never graded) or unreadable: no count
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, ids.length) }, worker))
  if (generation === gradedGeneration) gradedCounts.value = next
}
watch(assignments, (list) => { loadGradedCounts(selectedOrg.value, list) })

const visibleAssignments = computed(() => {
  return assignments.value.filter(a => {
    if (a.state === 'archived' && !showArchived.value) return false
    return true
  })
})

// True once /user/installations has answered - gates the "no installation
// visible" empty state so it can't flash during the initial load.


function onGlobalKeydown(e) {
  if (e.key === 'Escape') {
    showHealthModal.value = false
  }
}

const appInstallUrl = APP_INSTALL_URL

// "Connect an organization" opens github.com in a new tab, so the install
// completes somewhere this app cannot observe. Re-checking when the tab regains
// focus makes the new org simply appear, instead of leaving the lecturer on a
// stale page wondering whether it worked. Only refetches when the answer could
// have changed - a signed-in lecturer with the dashboard in front of them.
let lastOrgRefresh = 0
const ORG_REFRESH_MIN_GAP_MS = 3000

async function refreshOrgsOnReturn() {
  if (document.visibilityState !== 'visible') return
  if (!isAuthenticated()) return
  // Deliberately unconditional. An earlier version only refetched when the
  // current view "could change", which excluded the normal case - a lecturer
  // on a healthy dashboard adding a SECOND org - so returning from GitHub did
  // nothing and the new org only appeared after a manual reload. One request
  // on tab focus is cheap; being stranded is not.
  if (Date.now() - lastOrgRefresh < ORG_REFRESH_MIN_GAP_MS) return
  lastOrgRefresh = Date.now()
  const before = orgs.value.length
  await loadOrgs()
  if (orgs.value.length > before) {
    connectPending.value = false
    toast.success('Organization connected.')
  }
}

onMounted(async () => {
  // GitHub appends ?installation_id=N&setup_action=install when the App's
  // Setup URL points back here. Treat that as "just connected" and clear the
  // params so a reload does not repeat it.
  if (route.query.setup_action === 'install') {
    connectPending.value = true
    router.replace({ query: { ...route.query, setup_action: undefined, installation_id: undefined } })
  }
  window.addEventListener('keydown', onGlobalKeydown)
  document.addEventListener('visibilitychange', refreshOrgsOnReturn)
  if (isAuthenticated()) {
    user.value = getUser()
    await loadOrgs({ force: false })
  }
})

onUnmounted(() => {
  window.removeEventListener('keydown', onGlobalKeydown)
  document.removeEventListener('visibilitychange', refreshOrgsOnReturn)
  setupGeneration++
})

// immediate so navigating back to /dashboard/<org> from the breadcrumb
// triggers loadDashboard even when selectedOrg is already set from the URL
// param at init (re-assigning the same value doesn't fire a normal watcher).
watch(selectedOrg, async (org) => {
  setupGeneration++
  if (org) {
    rememberOrg(org)
    if (route.params.org !== org) {
      router.replace({ name: 'dashboard', params: { org } })
    }
    await loadDashboard(org)
  }
}, { immediate: true })

// The top bar's picker navigates, and this page stays mounted under the bar
// with a new `org`.
watch(() => props.org, (org) => {
  if (org && org !== selectedOrg.value) selectedOrg.value = org
})

/**
 * The installations, from the shared list (lib/org-session.js) - `force`
 * refetches, for coming back from GitHub's install page - and, with no org in
 * the address, the one to open: the remembered org, or the only one there is.
 * An org in the address that has no installation is corrected the same way.
 */
async function loadOrgs({ force = true } = {}) {
  const token = getToken()
  if (!token) return
  await loadSharedOrgs(token, { force })
  if (props.org && (isInstalled(props.org) || orgsLoadError.value)) return
  const savedOrg = rememberedOrg()
  if (savedOrg && isInstalled(savedOrg)) {
    selectedOrg.value = orgs.value.find((o) => sameLogin(o.login, savedOrg)).login
  } else if (orgs.value.length === 1) {
    selectedOrg.value = orgs.value[0].login
  }
}

async function loadDashboard(orgArg) {
  // Callers include @click handlers, which pass a PointerEvent as the first
  // argument, and runSetupOrg, which passes nothing. Anything that is not a
  // non-empty string means "whichever org is selected".
  const org = typeof orgArg === 'string' && orgArg ? orgArg : selectedOrg.value

  const generation = ++dashGeneration
  const superseded = () => generation !== dashGeneration

  // NOTHING IS CLEARED BEFORE THERE IS A REPLACEMENT.
  //
  // This used to empty `assignments` and `dashState` here, at the top, and then
  // return early on two paths that ALSO turned the spinner off without asking
  // whether they still owned it. So a run that superseded another, wiped the
  // list and then bailed on `!org` or `!token` left the page with no
  // assignments, no dashState and no spinner - which renders "No active
  // assignments right now - assignments in this organization are closed or
  // archived" over six published ones. The superseded run then finished,
  // correctly declined to write, and nothing ever refilled the list; a reload
  // fixed it, which is the signature of overlapping loads rather than of stale
  // data. Guarding only the `finally` (2026-09-04) fixed one of the three
  // exits and left these two.
  //
  // The spinner branch renders ahead of the list, so holding the previous
  // org's assignments in memory while a new one loads shows nobody anything
  // stale - and it means no early return, present or future, can leave the
  // page asserting that an organization has nothing in it.
  if (!org) { if (!superseded()) loadingData.value = false; return }

  const token = getToken()
  if (!token) { if (!superseded()) loadingData.value = false; return }

  loadingData.value = true
  dashError.value = null
  // Scalars, not the list: these describe the run and every authoritative exit
  // sets them. `assignments` stays until a replacement exists.
  dashState.value = ''
  hubWritable.value = false

  try {
    // 1 single API call: Fetch aggregated dashboard report directly
    let reportData = null
    try {
      const content = await getRepoContent(token, org, config.controlRepo, 'reports/dashboard.json')
      if (content) {
        reportData = JSON.parse(content)
      }
    } catch (e) {
      // dashboard.json not found or parse failed
    }

    if (reportData?.assignments && Object.keys(reportData.assignments).length > 0) {
      const stateOrder = { published: 1, closed: 2, archived: 3 }
      const displayList = Object.entries(reportData.assignments)
        .map(([id, a]) => ({ id, ...a }))
        .filter(a => a.state !== 'draft')
        .sort((a, b) => {
          const diff = (stateOrder[a.state] || 99) - (stateOrder[b.state] || 99)
          if (diff !== 0) return diff
          return (a.id || '').localeCompare(b.id || '')
        })

      // THE ASSIGNMENTS DIRECTORY DECIDES WHICH ASSIGNMENTS EXIST.
      //
      // `reports/dashboard.json` is GENERATED, and the fallback below only ran
      // when it was missing or empty - so a present-but-stale one was trusted
      // completely and an assignment published since the last regeneration was
      // simply absent. A lecturer saw "No active assignments right now", opened
      // the Admin Panel (which reads the YAML directly), found them all there,
      // and came back to a dashboard that had meanwhile caught up. Reported
      // 2026-09-02.
      //
      // dashboard.json still supplies the STATS - it is the only thing that has
      // them - but it no longer decides the roll call. Anything on disk and not
      // in it is shown from its own YAML, without figures, rather than hidden.
      const extra = await assignmentsMissingFrom(token, org, reportData.assignments)
      // Guarded like every other write below it. An older run landing here
      // after a newer one has moved to another organization would put that
      // organization's assignments under this one's name.
      if (superseded()) return
      assignments.value = [...displayList, ...extra.filter((a) => a.state !== 'draft')].sort((a, b) => {
        const diff = (stateOrder[a.state] || 99) - (stateOrder[b.state] || 99)
        if (diff !== 0) return diff
        return (a.id || '').localeCompare(b.id || '')
      })
      drafts.value = [
        ...Object.entries(reportData.assignments).map(([id, a]) => ({ id, ...a })).filter((a) => a.state === 'draft'),
        ...extra.filter((a) => a.state === 'draft'),
      ].sort((a, b) => (a.id || '').localeCompare(b.id || ''))

      const now = new Date()
      const hasActive = assignments.value.some((a) => {
        if (a.state !== 'published') return false
        if (a.opens_at && now < new Date(a.opens_at)) return false
        if (a.deadline_at && now > new Date(a.deadline_at)) return false
        return true
      })
      if (superseded()) return
      dashState.value = assignments.value.length === 0 ? (draftCount.value > 0 ? 'no-dashboard' : 'empty') : ''
      setOrgStatus(org, hasActive ? 'active' : (assignments.value.length > 0 ? 'inactive' : 'empty'))
      return
    }

    // Fallback only if dashboard.json is missing or empty (e.g. newly onboarded org before first cron)
    const repoRes = await getRepo(token, org, config.controlRepo)
    if (!repoRes.ok) {
      if (repoRes.status === 404) {
        if (superseded()) return

        // A 404 HERE IS TWO DIFFERENT ANSWERS, and this used to pick the
        // friendlier one. GitHub returns 404 rather than 403 for a private
        // repository you cannot see, so "the control repo does not exist" and
        // "the control repo exists and you are not staff here" arrive
        // identically - and the org appears in the switcher for anyone whose
        // installation touches it, which one accepted assignment is enough to
        // do. A student saw "Almost there - <org> needs its control repository"
        // with an Open Setup Organization button, badged Lecturer, about a
        // repository that exists and that they simply cannot read.
        //
        // So the 404 stops being evidence of absence, and the page asks a
        // question it CAN answer: has this account demonstrated any staff
        // capability at all? Write on the hub is what Setup Organization needs
        // anyway (ADMIN.md §1.4), so the check that gates the button now also
        // gates the screen - and a lecturer who has just been made an org owner
        // without hub write is told to ask a hub admin, from a state that does
        // not call them Lecturer or offer them a button that would 403.
        //
        // AND whether this account owns the organization, which keeps a real
        // lecturer out of the refusal: a lecturer onboarding a NEW org has no
        // hub write and produces the identical 404 a student does.
        //
        // AND - since 2026-09-17 - HUB WRITE IS NOT STAFF HERE. It means this
        // account can RUN Setup Organization, and says nothing about whether it
        // can read this org: an owner of the hub org has it on every course. A
        // hub admin who was only an outside collaborator on PXL-Java-Essentials
        // was shown "needs its control repository" and a Set up button over a
        // course that had been running for days, and ran it twice. For a
        // non-owner the public hub registry now says whether the org is set up.
        //
        // One judge for this and the Admin Panel, every signal positive, and an
        // unreadable registry is `unknown` rather than "not set up":
        // frontend/src/lib/control-repo-access.js.
        const access = await classifyUnreadableControlRepo(
          (method, path) => ghApi(token, method, path),
          { org, hubOwner: config.hubOwner, hubRepo: config.hubRepo },
        )
        if (superseded()) return
        hubWritable.value = access.hubWritable
        orgAdminHere.value = access.orgAdmin
        budgetOwner.value = access.budgetOwner

        // The new org's answer replaces the old org's list. Without this the
        // cards from the organization you just switched away from stay on
        // screen under the new one's name.
        assignments.value = []
        drafts.value = []
        dashState.value = DASH_STATE_FOR_VERDICT[access.verdict]
        setOrgStatus(org, access.verdict === 'not-set-up' ? 'empty' : 'no-access')
        return
      }
    }

    // Check if ANY assignment has been created in assignments/ folder
    let assignmentFiles = []
    try {
      assignmentFiles = await listRepoDir(token, org, config.controlRepo, 'assignments')
    } catch (e) {
      assignmentFiles = []
    }
    const ymls = (assignmentFiles || []).filter(f => f.type === 'file' && (f.name.endsWith('.yml') || f.name.endsWith('.yaml')))

    if (ymls.length === 0) {
      // Zero assignments created in this organization!
      // This is the beginning lecturer state - show the onboarding readiness card!
      if (superseded()) return
      assignments.value = []
      drafts.value = []
      dashState.value = 'onboarding'
      setOrgStatus(org, 'empty')
      return
    } else {
      // Assignments HAVE been created in this organization (e.g. drafts or awaiting dashboard.json generation).
      //
      // "Draft" is a claim about state, and this counted files - so a lecturer
      // who had just published two assignments was told they had two drafts to
      // publish. What is missing here is reports/dashboard.json, not the
      // publish; read each YAML's own state and say only what is true.
      const found = await listDraftAssignments(token, org, ymls)
      if (superseded()) return
      drafts.value = found
      assignments.value = []
      dashState.value = 'no-dashboard'
      setOrgStatus(org, 'empty')
      return
    }
  } catch (e) {
    console.error('Failed to load dashboard:', e)
    if (e instanceof SyntaxError) {
      dashError.value = `Dashboard data is corrupted (JSON parse error). Recovering it means restoring the control repository from its own history, which is a hub administrator's job - your assignments and student repositories are unaffected.`
    } else {
      dashError.value = `Failed to load dashboard: ${e.message || String(e)}`
    }
  } finally {
    // ONLY THE CURRENT RUN OWNS THE SPINNER.
    //
    // This was unconditional, and every run begins by wiping `assignments`. So
    // a superseded run finishing announced "loaded" for a load still in
    // flight, and the page rendered the wiped list under "No active
    // assignments right now - assignments in this organization are closed or
    // archived" while six published ones sat in dashboard.json. Reported
    // 2026-09-04: it appeared on the first load after signing in, and a reload
    // fixed it - which is the signature of two overlapping loads, not of stale
    // data. Entering the dashboard can start more than one: the `selectedOrg`
    // watcher is `immediate`, and `router.replace` re-triggers it.
    //
    // A superseded run leaves the flag alone; the run that superseded it turns
    // it off when IT finishes.
    if (!superseded()) {
      loadingData.value = false
      loadedOrg.value = org
    }
  }
}

// What this load showed about the account in this org, for the shared top
// bar's tabs (lib/org-session.js). Only from a load that FINISHED for this org:
// `staffHere` is true before anything is known, which is the reason the tabs
// used to wait for `!loadingData`. Not staff, not installed, or no control
// repository: the tabs lead nowhere this account can go.
const loadedOrg = ref('')
const staffVerdict = computed(() => {
  if (!selectedOrg.value || loadedOrg.value !== selectedOrg.value || loadingData.value) return null
  if (dashError.value || !orgsLoaded.value) return null
  return orgIsInstalled.value && staffHere.value && dashState.value !== 'no-control-repo'
})
watch(staffVerdict, (verdict) => {
  if (verdict !== null) markStaff(selectedOrg.value, verdict)
}, { immediate: true })

/**
 * Assignments that exist on disk but are not in `reports/dashboard.json` yet.
 *
 * dashboard.json is generated, so it lags: publish an assignment and it is
 * absent from the dashboard until the next regeneration, while the Admin Panel
 * - which reads the YAML - shows it immediately. That gap read as "my
 * assignments have disappeared" (2026-09-02).
 *
 * Returned WITHOUT figures, because there genuinely are none yet: an entry here
 * has never been reported on. It is listed rather than hidden, since "exists
 * but has no numbers" is the truth and "does not exist" is not.
 *
 * Drafts are included, with their state; the caller puts them in the drafts
 * row rather than among the cards.
 */
async function assignmentsMissingFrom(token, org, reported) {
  let files = []
  try {
    files = await listRepoDir(token, org, config.controlRepo, 'assignments')
  } catch {
    // Unreadable is not evidence of none. The generated list still stands; this
    // only ever ADDS to it, so failing here loses the catch-up and nothing else.
    return []
  }

  const known = new Set(Object.keys(reported || {}).map((k) => k.toLowerCase()))
  const missing = (files || []).filter((f) => {
    if (f.type !== 'file') return false
    if (!f.name.endsWith('.yml') && !f.name.endsWith('.yaml')) return false
    return !known.has(f.name.replace(/\.ya?ml$/, '').toLowerCase())
  })
  if (missing.length === 0) return []

  const { parse: parseYaml } = await import('yaml')
  const out = []
  const queue = [...missing]
  const worker = async () => {
    for (let f = queue.shift(); f; f = queue.shift()) {
      try {
        const text = await getRepoContent(token, org, config.controlRepo, f.path)
        if (!text) continue
        const doc = parseYaml(text)
        // An absent state is a draft - the schema's own default.
        // Drafts too: the caller puts them in the drafts row.
        const state = doc?.state || 'draft'
        out.push({
          id: doc?.id || f.name.replace(/\.ya?ml$/, ''),
          title: doc?.title || null,
          state,
          opens_at: doc?.opens_at || null,
          deadline_at: doc?.deadline_at || null,
          // No counts: nothing has reported on this assignment yet, and a zero
          // here would read as "nobody accepted" rather than "not yet known".
          not_yet_reported: true,
        })
      } catch {
        // One unreadable YAML must not cost the others their place in the list.
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(6, queue.length) }, worker))
  return out
}

// Which of these assignment YAMLs are actually drafts.
//
// The directory listing carries names, not contents, so each file is fetched.
// That only happens on this branch - reports/dashboard.json missing, i.e. a
// newly onboarded org - and the pool keeps a large assignments/ directory from
// firing one request per file at once. `yaml` is imported lazily so it stays
// out of the dashboard chunk for the ordinary path.
async function listDraftAssignments(token, org, files) {
  const { parse: parseYaml } = await import('yaml')
  const queue = [...files]
  const found = []
  const worker = async () => {
    for (let f = queue.shift(); f; f = queue.shift()) {
      try {
        const text = await getRepoContent(token, org, config.controlRepo, f.path)
        if (!text) continue
        const doc = parseYaml(text)
        // An absent state is a draft - the schema's own default.
        if ((doc?.state || 'draft') !== 'draft') continue
        found.push({ id: doc?.id || f.name.replace(/\.ya?ml$/, ''), title: doc?.title || null, state: 'draft', deadline_at: doc?.deadline_at || null })
      } catch {
        // Unreadable or unparseable is not evidence of a draft. Leaving it out
        // is the point: the bug being fixed was counting files as drafts.
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(6, queue.length) }, worker))
  return found.sort((a, b) => a.id.localeCompare(b.id))
}

async function onAuthenticated(authedUser) {
  user.value = authedUser
  await loadOrgs()
}


</script>

<style scoped>
.dashboard-page {
  min-height: 100vh;
}



/* The org picker's rules moved with it into OrgPicker.vue (2026-10-03). */
.connect-pending {
  padding: var(--space-sm) var(--space-md);
  margin-top: var(--space-md);
  border-color: var(--tint-accent-emphasis);
  background: var(--tint-accent-subtle);
}

/* padding-top/bottom, NOT the shorthand: `main` here is a scoped element
   selector and out-specifies .container, so `padding: X 0` silently wiped
   the horizontal padding and content sat flush to the viewport edge on
   anything narrower than the 1240px max-width. */
main {
  padding-top: var(--space-xl);
  padding-bottom: var(--space-xl);
}

.section-toolbar {
  margin-bottom: var(--space-lg);
  padding-bottom: var(--space-sm);
  border-bottom: 1px solid var(--border-muted);
}

.section-title {
  margin: 0;
  font-size: 1.2rem;
  font-weight: 600;
}

.archived-toggle {
  cursor: pointer;
  user-select: none;
}



.assignment-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: var(--space-md);
}

.assignment-card {
  cursor: pointer;
  transition: border-color var(--transition-fast), background-color var(--transition-fast);
}
.assignment-card:hover {
  border-color: var(--accent-blue);
  background: var(--bg-surface-elevated);
}
.assignment-card-closed {
  opacity: 0.9;
}
.assignment-card-closed:hover {
  opacity: 1;
}
.assignment-card-closed .stat-value {
  color: var(--text-secondary);
}

.card-header {
  margin-bottom: var(--space-sm);
}


.assignment-card-title {
  font-size: 1.05rem;
  font-weight: 600;
  margin-bottom: var(--space-xs);
}

.deadline-text {
  color: var(--text-muted);
  font-size: 0.82rem;
  margin-bottom: var(--space-md);
}

.stats-row {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: var(--space-xs);
  padding-top: var(--space-sm);
  border-top: 1px solid var(--border-muted);
}

.stat {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
}

.stat-value {
  font-size: 1.15rem;
  font-weight: 600;
  line-height: 1.2;
}
.stat-label {
  font-size: 0.65rem;
  text-transform: uppercase;
  color: var(--text-muted);
  letter-spacing: 0.02em;
  white-space: nowrap;
  line-height: 1.2;
  margin-top: 2px;
}

.stat-green { color: var(--accent-green); }
.stat-yellow { color: var(--accent-yellow); }
.stat-red { color: var(--accent-red); }
.stat-orange { color: var(--accent-orange); }


/* ONBOARDING READINESS CARD */
.onboarding-readiness-card,
.setup-required-card {
  background: var(--bg-surface);
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-md);
  padding: var(--space-xl);
  max-width: 680px;
  margin: var(--space-lg) auto;
  display: flex;
  flex-direction: column;
  gap: var(--space-lg);
}
.onboarding-head {
  display: flex;
  align-items: flex-start;
  gap: var(--space-md);
}
.onboarding-head h2 {
  margin: 0 0 var(--space-xs) 0;
  font-size: 1.15rem;
}
.onboarding-head p {
  margin: 0;
  font-size: 0.88rem;
  line-height: 1.4;
}
.onboarding-steps {
  display: flex;
  flex-direction: column;
  gap: var(--space-md);
  border-top: 1px solid var(--border-muted);
  border-bottom: 1px solid var(--border-muted);
  padding: var(--space-lg) 0;
}
.onboarding-step {
  display: flex;
  align-items: flex-start;
  gap: var(--space-sm);
}
/* A finished step, and it looked exactly like an unfinished one.
   `:class="{ 'is-complete': orgIsInstalled }"` was in the markup with nothing
   declaring it, so the checklist a lecturer follows during onboarding never
   showed progress. Dimmed rather than tinted: the point of a done step is that
   the eye skips it and lands on the next one. */
.onboarding-step.is-complete .step-body strong,
.onboarding-step.is-complete .step-body p {
  color: var(--text-muted);
}
.onboarding-step.is-complete .step-body strong {
  text-decoration: line-through;
  text-decoration-color: var(--border-strong);
}
.onboarding-step .step-icon {
  margin-top: 2px;
  flex-shrink: 0;
}
.onboarding-step .step-body strong {
  display: block;
  font-size: 0.9rem;
  margin-bottom: 2px;
}
.onboarding-step .step-body p {
  margin: 0;
  font-size: 0.82rem;
  color: var(--text-secondary);
  line-height: 1.35;
}
.onboarding-actions {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  flex-wrap: wrap;
}

.drafts-row { margin: var(--space-md) 0; }
.drafts-row-title { margin: 0 0 var(--space-xs) 0; font-weight: 600; }
.drafts-row-list { display: flex; flex-wrap: wrap; gap: var(--space-sm); }
.draft-chip {
  display: inline-flex;
  align-items: center;
  gap: var(--space-xs);
  padding: var(--space-xs) var(--space-sm);
  text-decoration: none;
  color: inherit;
  min-width: 0;
  max-width: 100%;
}
.draft-chip-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pipeline-stuck-banner {
  background: var(--tint-attention-subtle);
  border: 1px solid var(--tint-attention-emphasis);
  padding: var(--space-sm) var(--space-md);
  margin-bottom: var(--space-md);
}

@media (max-width: 640px) {
  .onboarding-actions { flex-direction: column; align-items: stretch; }
}

@media (max-width: 520px) {
  .section-toolbar { flex-direction: column; align-items: flex-start; gap: var(--space-sm); }
}
</style>
