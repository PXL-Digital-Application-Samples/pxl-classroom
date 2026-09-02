<template>
  <div class="assignment-page">
    <AppHeader :user="user" :sticky="false" @logout="handleLogout" />

    <main class="container">
      <!-- Loading state -->
      <div v-if="loading" class="center-card fade-in">
        <div class="spinner-lg spinner"></div>
        <p class="text-secondary">Loading assignment…</p>
      </div>

      <!-- Error state -->
      <div v-else-if="error" class="center-card fade-in">
        <Icon name="alert-triangle" :size="48" class="status-icon status-icon-warn" />
        <h2>Something went wrong</h2>
        <p class="text-secondary">{{ error }}</p>
        <button class="btn btn-primary" @click="retry">Try again</button>
      </div>

      <!-- The link is real, and out of date.
           A student holding a pre-migration link cannot accept with it - the
           broker refuses a legacy title once it has a public key - so the old
           digest resolves to a card that says exactly that, rather than to the
           "not found" state whose only honest wording is a guess. -->
      <div v-else-if="superseded" class="center-card fade-in">
        <Icon name="alert-triangle" :size="48" class="status-icon status-icon-warn" />
        <h2>This invitation link is out of date</h2>
        <p class="text-secondary">
          <template v-if="superseded.title">
            The link you used for <strong>{{ superseded.title }}</strong> has been replaced with a new one.
          </template>
          <template v-else>
            The link you used has been replaced with a new one.
          </template>
        </p>
        <p class="text-secondary">
          Ask your lecturer for the current invitation link. The assignment itself is unaffected -
          if you have already accepted it, your repository is untouched and you can find it under
          your GitHub account.
        </p>
        <div style="display: flex; gap: var(--space-sm); margin-top: var(--space-md); justify-content: center;">
          <router-link to="/" class="btn btn-primary">My assignments</router-link>
        </div>
      </div>

      <!-- Assignment not found -->
      <div v-else-if="!assignment" class="center-card fade-in">
        <template v-if="isPollingNotFound">
          <div class="spinner-lg spinner"></div>
          <h2>Looking for newly published assignment…</h2>
          <p class="text-secondary">
            Checking live deployment in <strong>{{ org }}</strong> (attempt {{ notFoundPollCount }} of {{ maxNotFoundPolls }}).
          </p>
          <p class="text-secondary" style="font-size: 0.85rem; margin-top: var(--space-xs);">
            If your lecturer just published this assignment, GitHub Pages takes 1 to 2 minutes to complete deployment. This page will update automatically.
          </p>
          <div style="margin-top: var(--space-md);">
            <button class="btn btn-secondary btn-sm" @click="stopNotFoundPolling">Cancel check</button>
          </div>
        </template>
        <template v-else>
          <Icon name="clipboard" :size="48" class="status-icon" />
          <h2>Assignment not found</h2>
          <p class="text-secondary">
            This invitation link doesn't match a published assignment in <strong>{{ org }}</strong>.
            It may be out of date, incomplete, or the assignment isn't open yet.
          </p>
          <p class="text-secondary">
            Ask your lecturer for a current invitation link. If the assignment was published in the
            last few minutes, wait a moment and refresh.
          </p>
          <div style="display: flex; gap: var(--space-sm); margin-top: var(--space-md); justify-content: center;">
            <button class="btn btn-primary" @click="startNotFoundPolling">Check again</button>
            <router-link to="/" class="btn btn-secondary">Home</router-link>
          </div>
        </template>
      </div>

      <!-- Assignment loaded -->
      <div v-else class="assignment-content fade-in">
        <div class="card">
          <div class="assignment-meta flex items-center gap-sm">
            <span class="status-indicator">
              <span class="status-dot" :class="assignment.state === 'published' ? 'dot-success' : (assignment.state === 'closed' ? 'dot-warning' : 'dot-neutral')"></span>
              <span class="text-sm font-medium">{{ assignment.state === 'published' ? 'Accepting Submissions' : (assignment.state === 'closed' ? 'Acceptance Closed' : assignment.state) }}</span>
            </span>
            <span v-if="assignment.acceptance_mode && assignment.acceptance_mode !== 'self-service'" class="text-xs text-muted">({{ assignment.acceptance_mode }})</span>
          </div>

          <h1 class="assignment-title">{{ assignment.title }}</h1>
          <p v-if="assignment.description" class="assignment-desc">{{ assignment.description }}</p>

          <div class="assignment-dates">
            <div class="date-item">
              <span class="date-label">Opens</span>
              <time :datetime="assignment.opens_at">{{ formatDate(assignment.opens_at, assignment.timezone) }}</time>
            </div>
            <div class="date-item">
              <span class="date-label">Deadline</span>
              <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
                <time :datetime="assignment.deadline_at" :class="{ 'text-warning': isPastDeadline }">
                  {{ formatDate(assignment.deadline_at, assignment.timezone) }}
                </time>
                <span v-if="timeRemainingStr" :class="['badge', timeRemainingBadgeClass]" style="text-transform: none; font-size: 0.7rem; padding: 2px 8px;">
                  {{ timeRemainingStr }}
                </span>
              </div>
            </div>
          </div>
        </div>

        <!-- Not authenticated -->
        <AuthCard v-if="!user" @authenticated="onAuthenticated">
          Authenticate with your GitHub account to accept this assignment.
        </AuthCard>

        <!-- Authenticated - Group Assignment Flow -->
        <GroupAcceptanceCard
          v-else-if="assignment && assignment.assignment_type === 'group'"
          :assignment="assignment"
          :org="org"
          :user="user"
          :invite-token="inviteToken"
        />

        <!-- Authenticated - Individual acceptance flow -->
        <div v-else class="acceptance-card card">
          <!-- Not yet accepted -->
          <div v-if="acceptState === 'ready'">
            <div v-if="assignment && (assignment.state === 'closed' || (assignment.deadline_at && new Date() > new Date(assignment.deadline_at)))" class="text-center">
              <Icon name="lock" :size="48" class="status-icon" />
              <h2>Assignment closed</h2>
              <p class="text-secondary">
                New registrations for this assignment are currently closed.
              </p>
            </div>
            <!-- An absent cap is no cap: accept.mjs enforces the limit only
                 when the field is set, so a default here would refuse an
                 acceptance the server would have granted. -->
            <div v-else-if="assignment && assignment.max_acceptances && assignment.accepted_count >= assignment.max_acceptances" class="text-center">
              <h2>Registration cap reached</h2>
              <p class="text-secondary">
                This assignment has reached its registration limit. Please contact your lecturer.
              </p>
            </div>
            <div v-else-if="assignment && (assignment.state === 'draft' || (assignment.opens_at && new Date() < new Date(assignment.opens_at)))" class="text-center">
              <Icon name="clock" :size="48" class="status-icon" />
              <h2>Assignment not open yet</h2>
              <p class="text-secondary">
                {{ assignment.state === 'draft' ? 'This assignment is currently in draft mode.' : `Opens ${formatDate(assignment.opens_at, assignment.timezone)}` }}
              </p>
            </div>
            <div v-else>
              <h2>Accept assignment</h2>
              <p class="text-secondary">
                You're signed in as <strong>{{ user.login }}</strong>.
                Click below to accept this assignment and get your repository.
              </p>
              <!-- Under `claim` the address IS the enrolment, so it is asked
                   for before the button rather than behind it. -->
              <ClaimAddressCard
                v-if="needsClaim"
                :assignment="assignment"
                :org="org"
                :token="authToken"
                @update:claim="claim = $event"
              />
              <p v-if="needsClaim && !claimKeyReady" class="text-sm claim-unavailable">
                Claiming is not set up for this course yet. Ask your lecturer to
                finish setting up the assignment.
              </p>
              <button
                class="btn btn-success btn-lg btn-with-icon"
                @click="acceptAssignment"
                :disabled="accepting || (needsClaim && (!claim || !claimKeyReady))"
              >
                <template v-if="accepting">
                  <div class="spinner" style="width:18px;height:18px;border-width:2px"></div>
                  <span>Accepting…</span>
                </template>
                <template v-else>
                  <Icon name="check" :size="18" />
                  <span>Accept assignment</span>
                </template>
              </button>
            </div>
          </div>

          <!-- Accepted, waiting for provisioning -->
          <div v-else-if="acceptState === 'pending'" class="pending-state">
            <Icon name="clock" :size="48" class="status-icon status-icon-pulse" />
            <h2>Setting up your repository…</h2>
            <!-- "Less than a minute" set the wrong expectation: provisioning is
                 TWO chained Actions runs (broker -> repository_dispatch -> hub),
                 so twenty to forty seconds is the ordinary case and ten seconds
                 never was. A student who expects ten and waits thirty concludes
                 the tool is broken. -->
            <p class="text-secondary">
              Your assignment has been accepted. Two GitHub Actions runs create your private
              repository from the template, which usually takes <strong>20 to 40 seconds</strong> -
              longer when GitHub is busy.
            </p>
            <div class="progress-bar">
              <div class="progress-bar-fill"></div>
            </div>
            <!-- Elapsed time, not "attempt 7 every 3s". The poll cadence is
                 this page's business; how long they have been waiting is
                 theirs. -->
            <p class="text-muted">Waiting {{ waitedSeconds }}s…</p>

            <!-- Reassurance, deliberately NOT a diagnosis. What stood here
                 asserted a cause ("GitHub may be waiting for you to accept an
                 invitation") on nothing but a timer, and handed over a link
                 that 404s until the repository exists - which at fifteen
                 seconds it usually does not. -->
            <p v-if="pollCount >= 5" class="text-secondary">
              Still going, and that is normal. Leave this page open - it updates by itself
              the moment the repository appears.
            </p>

            <!-- The guessed link, and the ONLY place it belongs while waiting:
                 we asked GitHub for your invitations and could not get an
                 answer, so we cannot tell whether one is waiting for you. It
                 is held back to ~30s because before that the repository
                 probably does not exist and the link would 404. -->
            <div v-if="pollCount >= 10 && showInvitationGuess" class="invitation-hint" role="status">
              <p class="text-secondary">
                We could not check your GitHub invitations from here. If you are not already a
                member of <strong>{{ org }}</strong>, there may be one waiting:
              </p>
              <a :href="invitationUrl" target="_blank" rel="noopener" class="btn btn-primary">
                Look for a repository invitation
              </a>
              <p class="text-muted" style="margin-top: var(--space-xs);">
                A "404" there just means the repository is not ready yet - come back to this page.
              </p>
            </div>

            <div class="flex justify-center gap-sm mt-md">
              <button class="btn btn-sm btn-secondary btn-with-icon" type="button" @click="showDiagnosticsModal = true">
                <Icon name="help-circle" :size="14" />
                <span>Troubleshoot Access</span>
              </button>
            </div>
          </div>

          <!-- Repository ready -->
          <div v-else-if="acceptState === 'provisioned'" class="provisioned-state fade-in">
            <Icon name="check-circle" :size="48" class="status-icon status-icon-success" />
            <h2>Your repository is ready!</h2>
            <div class="repo-link-card">
              <a :href="repoUrl" target="_blank" rel="noopener" class="repo-link">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65S8.93 17.38 9 18v4"/>
                  <path d="M9 18c-4.51 2-5-2-7-2"/>
                </svg>
                {{ repoFullName }}
              </a>
              <button class="btn btn-with-icon" @click="copyRepoUrl" :aria-label="repoCopied ? 'Copied' : 'Copy URL'">
                <Icon v-if="repoCopied" name="check" :size="14" />
                <Icon v-else name="copy" :size="14" />
                <span>{{ repoCopied ? 'Copied' : 'Copy URL' }}</span>
              </button>
            </div>
            <p class="text-secondary">You have administrator access. Clone it and start working!</p>

            <!-- Student Submission Status & Deadline Countdown Card -->
            <div class="student-status-card card flex flex-col gap-sm" style="margin-top: var(--space-md); padding: 14px; background: var(--bg-surface); border: 1px solid var(--border-default); border-radius: 8px; text-align: left;">
              <!-- Active Extension Announcement -->
              <div v-if="studentOverride" class="override-alert-banner flex items-center gap-xs">
                <Icon name="check-circle" :size="16" class="stat-green" />
                <span class="text-xs font-semibold text-primary">
                  🎉 Deadline Extended to {{ new Date(studentOverride.value).toLocaleString() }} ({{ studentOverride.reason || 'Approved extension' }})
                </span>
              </div>

              <!-- Status & Countdown Row -->
              <div class="flex justify-between items-center flex-wrap gap-xs">
                <div class="flex items-center gap-xs">
                  <span class="text-xs font-semibold text-secondary">Submission Status:</span>
                  <span :class="['badge', studentSubmissionStatus === 'on-time' ? 'badge-success' : studentSubmissionStatus === 'late' ? 'badge-warning' : 'badge-neutral']">
                    {{ studentSubmissionStatus === 'on-time' ? 'Submitted on-time' : studentSubmissionStatus === 'late' ? 'Submitted late' : 'No commits pushed' }}
                  </span>
                </div>

                <!-- Countdown Timer -->
                <div v-if="deadlineCountdown" class="deadline-countdown flex items-center gap-xs text-xs">
                  <Icon name="clock" :size="14" :class="isPastDeadline ? 'stat-red' : 'stat-blue'" />
                  <span :class="isPastDeadline ? 'stat-red font-semibold' : 'text-secondary'">
                    {{ deadlineCountdown }}
                  </span>
                </div>
              </div>

              <!-- Latest commit line if present -->
              <div v-if="studentLatestCommit" class="latest-commit-info text-xs text-muted flex items-center gap-xs">
                <span>Latest commit:</span>
                <code class="mono">{{ studentLatestCommit.sha.slice(0, 7) }}</code>
                <span v-if="studentLatestCommit.date">· {{ studentLatestCommit.date }}</span>
              </div>
            </div>

            <!-- Tagged-submission indicator. Shown only when a tag exists: tagging is
                 optional (ARCHITECTURE.md §11.1a) and an untagged repo is not a gap. -->
            <div v-if="latestSubmitTag" class="submit-tag-banner" role="status">
              <svg class="submit-tag-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M20.59 13.41 13.42 20.58a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/>
                <circle cx="7" cy="7" r="1"/>
              </svg>
              <div>
                <strong>Submission tagged</strong>
                <div class="text-muted submit-tag-name"><code>{{ latestSubmitTag.tag }}</code></div>
                <div class="text-muted">The tagged commit is graded instead of the tip of your default branch.</div>
              </div>
            </div>
          </div>

          <!-- Invitation pending -->
          <div v-else-if="acceptState === 'invited'" class="invited-state fade-in">
            <Icon name="inbox" :size="48" class="status-icon" />
            <h2>Repository invitation pending</h2>
            <p class="text-secondary">
              Your repository has been created, but you need to accept the collaboration invitation first.
            </p>
            <button v-if="pendingInvitation" class="btn btn-primary btn-lg" @click="handleAcceptInvitation">
              Accept invitation
            </button>
            <a v-else href="https://github.com/notifications" target="_blank" class="btn btn-primary btn-lg">
              Check GitHub notifications
            </a>
          </div>

          <!-- Timeout state -->
          <!-- The acceptance issue we opened no longer exists. GitHub does
               this to accounts it has restricted: the request succeeds, the
               content is removed moments later, and no event ever reaches the
               broker. Nothing the lecturer can fix, so say so plainly rather
               than blaming load. -->
          <div v-else-if="acceptState === 'blocked-account'" class="timeout-state fade-in">
            <Icon name="alert-triangle" :size="48" class="status-icon status-icon-warn" />
            <h2>GitHub is blocking your request</h2>
            <p class="text-secondary">
              Your acceptance was submitted, but GitHub removed it immediately. That normally means
              your GitHub account is flagged or restricted, which this page cannot work around.
            </p>
            <p class="text-secondary">
              Contact GitHub Support about the restriction on <strong>{{ user.login }}</strong>, and
              let your lecturer know so they can provision your repository another way in the meantime.
            </p>
            <button class="btn btn-secondary" @click="acceptState = 'ready'">Back</button>
          </div>

          <div v-else-if="acceptState === 'timeout'" class="timeout-state fade-in">
            <Icon name="timer" :size="48" class="status-icon status-icon-warn" />
            <!-- Two different situations, and they used to share one headline
                 that guessed at the friendlier of them. If we could read your
                 invitations and there was none, "One more step - accept your
                 invitation" is telling a student whose provisioning actually
                 FAILED to go and accept something that does not exist, with a
                 link that 404s. -->
            <h2 v-if="showInvitationGuess">One more step - accept your invitation</h2>
            <h2 v-else>Your repository has not appeared</h2>

            <template v-if="showInvitationGuess">
              <p class="text-secondary">
                We could not check your invitations from this page. Unless you are already a member of
                <strong>{{ org }}</strong>, GitHub adds you by invitation - and it needs you to accept it
                before you can see the repository.
              </p>
              <a :href="invitationUrl" target="_blank" rel="noopener" class="btn btn-primary btn-lg">
                Accept your repository invitation
              </a>
              <p class="text-muted" style="margin-top: var(--space-sm);">
                It is also waiting in your GitHub notifications and in the email GitHub sent you.
                Once accepted, come back and press <strong>Check again</strong>.
                If that page shows a "404", the repository was never created - the causes below apply instead.
              </p>
            </template>
            <p v-else class="text-secondary">
              GitHub has no repository for you and no invitation waiting, so setup did not finish.
              This is not something you can fix from here.
            </p>

            <p class="text-secondary">
              {{ showInvitationGuess ? 'Less commonly, setup can stall because:' : 'The usual causes:' }}
            </p>
            <ul class="text-secondary" style="text-align: left; margin: var(--space-md) auto; max-width: 420px; line-height: 1.5;">
              <li>The assignment registration cap has been reached.</li>
              <li v-if="rosterMatchesLogin(rosterMode)">You are not on the lecturer's roster for this course.</li>
              <!-- Named per mode, like the roster cause above. Under `claim`
                   the roster is still the gate but the key is the ADDRESS, so
                   "you are not on the roster" would send a student to check
                   the wrong thing - and these are causes they can actually
                   check themselves. -->
              <template v-if="needsClaim">
                <li>
                  The address you confirmed is not the one your lecturer registered
                  for you - check for a typo, or ask which address they used.
                </li>
                <li>
                  Someone has already claimed that address. If that was not you,
                  tell your lecturer - they can unlink it.
                </li>
              </template>
              <li>GitHub is currently experiencing high load or rate limits.</li>
            </ul>
            <p class="text-secondary">
              If your repository does not appear after accepting, please contact your lecturer.
            </p>
            <div class="flex justify-center gap-sm mt-md">
              <button class="btn btn-secondary" @click="checkAgain" :disabled="checkingAgain">
                {{ checkingAgain ? 'Checking…' : 'Check again' }}
              </button>
              <button class="btn btn-secondary btn-with-icon" type="button" @click="showDiagnosticsModal = true">
                <Icon name="help-circle" :size="14" />
                <span>Troubleshoot Access</span>
              </button>
            </div>
          </div>

          <!-- Error state -->
          <div v-else-if="acceptState === 'error'">
            <Icon name="x-circle" :size="48" class="status-icon status-icon-error" />
            <h2>Something went wrong</h2>
            <p class="text-secondary">{{ acceptError }}</p>
            <div class="flex justify-center gap-sm mt-md">
              <button class="btn btn-primary" @click="retry">Try again</button>
              <button class="btn btn-secondary btn-with-icon" type="button" @click="showDiagnosticsModal = true">
                <Icon name="help-circle" :size="14" />
                <span>Troubleshoot Access</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </main>

    <!-- Student Diagnostics Modal (1.A) -->
    <StudentDiagnosticsModal
      :show="showDiagnosticsModal"
      :user="user"
      :assignment="assignment"
      :accept-state="acceptState"
      :pending-invitation="pendingInvitation"
      :roster-status="rosterStatus"
      @close="showDiagnosticsModal = false"
    />
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import AppHeader from '../components/AppHeader.vue'
import AuthCard from '../components/AuthCard.vue'
import GroupAcceptanceCard from '../components/GroupAcceptanceCard.vue'
import StudentDiagnosticsModal from '../components/StudentDiagnosticsModal.vue'
import ClaimAddressCard from '../components/ClaimAddressCard.vue'
import Icon from '../components/Icon.vue'
import { config } from '../lib/config.js'
import { ROSTER_PATH } from '../lib/roster.js'
import { brokerRepoName } from '../../../lib/broker-repo.mjs'
import { overridePath } from '../../../lib/control-layout.mjs'
import { getToken, getUser, isAuthenticated, clearAuth } from '../lib/auth.js'
import { getRepo, getInvitations, acceptInvitation, ghApi, getRepoContent } from '../lib/api.js'
import { signedAcceptanceIssueTitle, inviteDataUrl } from '../lib/invite.js'
import { buildAcceptanceBody, hubClaimKey, encryptClaim } from '../lib/claim.js'
import { hasWebCrypto } from '../../../lib/acceptance-signature.mjs'
import { effectiveDeadlineFor } from '../lib/deadline.js'
import { formatDate } from '../lib/format.js'
import { countdownParts, formatDeadlineCountdown } from '../lib/countdown.js'
import { toast } from '../lib/toast.js'
import { copyText } from '../lib/clipboard.js'
// Shared with acceptance/accept.mjs, so the page and the gate agree on which
// mode is in force - fail-closed fallback included.
import { normalizeRosterMode, rosterMatchesLogin } from '../../../lib/roster-mode.mjs'

const props = defineProps({
  org: { type: String, required: true },
  // Supplied by the /:org/i/:inviteToken route. The assignment id is not
  // readable from the token - it carries a hash of it - so it is resolved by
  // matching against the org's published assignments.
  inviteToken: { type: String, default: '' },
})

// The assignment id, once the token has resolved to one. Everything that
// derives a repo or broker name needs it, and none of it runs before load.
const resolvedId = computed(() => assignment.value?.id || '')

// State
const loading = ref(true)
const error = ref(null)
const assignment = ref(null)
// Set when the card at this digest says the link it came from has been
// replaced. Distinct from `assignment` and from "not found", because the three
// call for three different sentences.
const superseded = ref(null)
const user = ref(getUser())
const acceptState = ref('ready')  // ready | pending | provisioned | invited | error
const accepting = ref(false)
const acceptError = ref(null)
const repoUrl = ref(null)
const repoFullName = ref(null)
const pendingInvitation = ref(null)
// Number of the acceptance issue opened on the broker, so we can tell a
// restricted account apart from a slow one when polling gives up.
const acceptanceIssue = ref(null)
const repoCopied = ref(false)

// Student Diagnostics & Account Checker State (1.A)
const showDiagnosticsModal = ref(false)
const rosterStatus = ref('enrolled') // 'enrolled' | 'missing' | 'unknown'

// The mode actually in force, decided by the same rule accept.mjs applies -
// including its fail-closed fallback, so the page never promises a student
// looser access than the gate will grant.
const rosterMode = computed(() => normalizeRosterMode(assignment.value?.roster_mode))

// Under `claim` the student proves an institutional address before they can
// accept. The key is bundled at build time, so `claimKeyReady` is a fact about
// this deployment rather than a request that can fail at the button.
const claim = ref(null)
const authToken = ref('')
// Under `claim` the address IS the gate, so it is always required. Under `open`
// it is opt-in and off by default: `open` exists for cohorts a lecturer does not
// know up front - an exam, most often - and making that identify itself by
// accident is the opposite of the point. Ticked, the address becomes required
// to accept, which is what makes reconciling logins to students possible
// afterwards instead of merely hoped for.
const needsClaim = computed(() =>
  rosterMode.value === 'claim' ||
  (rosterMode.value === 'open' && assignment.value?.require_claim === true))
const claimKeyReady = computed(() => Boolean(hubClaimKey()))

async function checkRosterStatus() {
  // Only `enforced` gates on the roster. Under `open` a
  // student who is not on it is not blocked by it, so checking would report a
  // problem that does not exist.
  if (!user.value || normalizeRosterMode(assignment.value?.roster_mode) !== 'enforced') {
    rosterStatus.value = 'enrolled'
    return
  }
  try {
    const token = getToken()
    const content = await getRepoContent(token, props.org, config.controlRepo, ROSTER_PATH)
    if (content) {
      const { parse: parseYaml } = await import('yaml')
      const parsed = parseYaml(content)
      const onRoster = (parsed?.students || []).some(
        (s) => s.github_login?.toLowerCase() === user.value.login.toLowerCase() ||
               (s.email && user.value.email && s.email.toLowerCase() === user.value.email.toLowerCase())
      )
      rosterStatus.value = onRoster ? 'enrolled' : 'missing'
    }
  } catch {
    rosterStatus.value = 'enrolled'
  }
}

// Latest submit/ tag observed on the student's repo. Parsed from the GitHub
// matching-refs response. null when no tag exists.
const latestSubmitTag = ref(null)

// Device flow

// Polling
// 3s, deliberately not slower. The wait FEELS long because the page used to
// promise "less than a minute" and then accuse GitHub of waiting on the
// student after fifteen seconds - not because it checks too often. Polling
// less often only adds dead time after the repository appears, and costs
// nothing worth saving: each student polls with their own user token against
// their own 5,000/hr limit, so a thirty-second wait is about ten requests.
const pollInterval = ref(3000)
const pollCount = ref(0)
const waitedMs = ref(0)
let pollStartedAt = 0
const waitedSeconds = computed(() => Math.max(0, Math.round(waitedMs.value / 1000)))
let pollTimer = null

const now = ref(new Date())
let nowInterval = null

const isPastDeadline = computed(() => {
  if (!assignment.value?.deadline_at) return false
  return now.value > new Date(assignment.value.deadline_at)
})

// The header badge counts down the ASSIGNMENT's deadline; deadlineCountdown
// below counts down this student's effective one. Different numbers, same
// arithmetic - which is why it comes from the shared module rather than a
// fourth copy of it.
const timeRemainingStr = computed(() => {
  const parts = countdownParts(assignment.value?.deadline_at, now.value)
  if (!parts) return ''
  return parts.passed ? 'Closed' : `${parts.duration} left`
})

const timeRemainingBadgeClass = computed(() => {
  if (!assignment.value?.deadline_at) return 'badge-neutral'
  const diffMs = new Date(assignment.value.deadline_at) - now.value
  if (diffMs <= 0) return 'badge-error'
  
  const diffHours = Math.floor(diffMs / 3600000)
  if (diffHours < 24) return 'badge-warning'
  return 'badge-success'
})


// Lifecycle
onMounted(async () => {
  // The ticking clock is started FIRST, and on purpose. It drives the deadline
  // countdown, and it used to sit after two awaits with no error handling
  // between - so a single rejected lookup left the hook dead, the countdown
  // frozen at whatever it said on load, and a Vue warning in a console nobody
  // is reading. Nothing above it can now stop it.
  nowInterval = setInterval(() => {
    now.value = new Date()
  }, 30000)

  // loadAssignment already calls checkExistingState (beside checkRosterStatus)
  // once the card has loaded and the student is signed in. Calling it again
  // here ran BOTH of a student's lookups twice on every page load - measured:
  // two GET /repos/<org>/<repo> and two GET /user/repository_invitations - for
  // no result the first pair had not already produced.
  await loadAssignment()
})

const notFoundPollCount = ref(0)
const maxNotFoundPolls = 6
const isPollingNotFound = ref(false)
let notFoundPollTimer = null

function stopNotFoundPolling() {
  if (notFoundPollTimer) {
    clearTimeout(notFoundPollTimer)
    notFoundPollTimer = null
  }
  isPollingNotFound.value = false
}

function startNotFoundPolling() {
  stopNotFoundPolling()
  notFoundPollCount.value = 0
  loadAssignment(false)
}

onUnmounted(() => {
  stopNotFoundPolling()
  if (pollTimer) clearTimeout(pollTimer)
  if (nowInterval) clearInterval(nowInterval)
})

// Load assignment from public metadata with cache-busting and polite auto-polling.
// A missing assignment (or missing org data file) is NOT an error - it renders
// the dedicated "not found" state with guidance. Only transport failures land
// in the retryable error state.
async function loadAssignment(isRetry = false) {
  if (!isRetry) {
    loading.value = true
  }
  error.value = null
  superseded.value = null

  // Finding the card requires hashing the link secret, and signing needs the
  // same API. Without this the failure arrives as a TypeError inside the fetch
  // and reads as a network problem, sending the student to check a connection
  // that is fine. Pages is HTTPS, so in practice this is a local http:// dev
  // server or a browser without WebCrypto.
  if (!hasWebCrypto()) {
    error.value =
      'This page needs Web Crypto, which your browser only provides over HTTPS. ' +
      'Open the link over https://, or try a current version of Chrome, Firefox, Edge or Safari.'
    loading.value = false
    stopNotFoundPolling()
    return
  }

  try {
    // Fetched by the digest of the invitation, not by assignment id: the
    // org-wide index no longer carries the acceptance card, so holding the link
    // is what makes this file findable at all (ARCHITECTURE §4.3.3).
    const url = `${await inviteDataUrl(props.org, props.inviteToken)}?t=${Date.now()}`
    const res = await fetch(url, { cache: 'no-store' })
    if (res.ok) {
      // A non-JSON body (e.g. an HTML fallback for a missing data file)
      // means there is no such invitation - that's "not found", not an error.
      let data = null
      try { data = await res.json() } catch { /* treat as not found */ }
      // Checked BEFORE the assignment shape, and it carries no `assignment`
      // key, so neither branch can be mistaken for the other.
      if (data?.superseded) {
        superseded.value = { id: data.assignment_id || null, title: data.title || null }
        stopNotFoundPolling()
      } else if (data?.assignment?.id) {
        assignment.value = { ...data.assignment }
        stopNotFoundPolling()
      }
    }
  } catch (e) {
    error.value = `Couldn't load the assignment data (${e.message}). Check your connection and try again.`
    stopNotFoundPolling()
  }

  // THE STUDENT'S OWN STATE IS A SEPARATE QUESTION, and its failure must not
  // take the assignment down with it.
  //
  // These two ran inside the fetch's try, so a rejected repository or
  // invitation lookup - one aborted request is enough - replaced a perfectly
  // well-loaded assignment with a full-page "couldn't load the assignment data,
  // check your connection". The assignment data was already in hand. Same rule
  // as the tracking page: a secondary failure may not remove the primary
  // content.
  //
  // Swallowed rather than surfaced, because the honest fallback IS the default
  // view: not knowing whether a student already has a repository shows them the
  // Accept button, and accepting again is idempotent.
  if (assignment.value && isAuthenticated()) {
    user.value = getUser()
    authToken.value = getToken() || ""
    try {
      await Promise.all([checkExistingState(), checkRosterStatus()])
    } catch { /* the page works without it */ }
  }

  loading.value = false

  // Auto-poll when assignment is not yet present on Pages (e.g. freshly
  // published). A superseded card is a definite answer, so polling it six times
  // would only stall the student on a spinner before showing what the first
  // response already said.
  if (!assignment.value && !error.value && !superseded.value) {
    if (notFoundPollCount.value < maxNotFoundPolls) {
      isPollingNotFound.value = true
      notFoundPollCount.value++
      notFoundPollTimer = setTimeout(() => {
        loadAssignment(true)
      }, 5000)
    } else {
      isPollingNotFound.value = false
    }
  }
}

const SUBMIT_TAG_PATTERN = /^refs\/tags\/(submit\/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)-[0-9a-f]{7,40})$/

// Look up the latest refs/tags/submit/* tag on the student's repo. Lexicographic
// sort on the ISO-Z timestamp = chronological. Silent on failure - the banner
// just renders the "no tag yet" hint.
async function refreshSubmitTag(org, repoName) {
  const token = getToken()
  if (!token) return
  try {
    const res = await ghApi(token, 'GET', `/repos/${org}/${repoName}/git/matching-refs/tags/submit/?per_page=100`)
    if (!res.ok || !Array.isArray(res.data) || res.data.length === 0) {
      latestSubmitTag.value = null
      return
    }
    const candidates = res.data
      .map((entry) => {
        const m = SUBMIT_TAG_PATTERN.exec(entry.ref || '')
        return m ? { tag: m[1], declared_at: m[2] } : null
      })
      .filter(Boolean)
    candidates.sort((a, b) => (a.tag < b.tag ? 1 : a.tag > b.tag ? -1 : 0))
    latestSubmitTag.value = candidates[0] || null
  } catch (e) {
    console.error('Failed to fetch submit tag:', e)
  }
}

const studentLatestCommit = ref(null)
const studentOverride = ref(null)

const effectiveDeadline = computed(() => {
  if (studentOverride.value?.value) {
    return new Date(studentOverride.value.value)
  }
  return assignment.value?.deadline_at ? new Date(assignment.value.deadline_at) : null
})

const deadlineCountdown = computed(() => formatDeadlineCountdown(effectiveDeadline.value, now.value))

const studentSubmissionStatus = computed(() => {
  if (!studentLatestCommit.value) return 'no-submission'
  if (!effectiveDeadline.value) return 'on-time'
  const commitTime = new Date(studentLatestCommit.value.date)
  return commitTime <= effectiveDeadline.value ? 'on-time' : 'late'
})

async function refreshStudentSubmissionMeta(org, repoName) {
  const token = getToken()
  if (!token) return
  try {
    const res = await ghApi(token, 'GET', `/repos/${org}/${repoName}/commits?per_page=1`)
    if (res.ok && Array.isArray(res.data) && res.data.length > 0) {
      const c = res.data[0]
      studentLatestCommit.value = {
        sha: c.sha,
        date: c.commit?.author?.date || c.commit?.committer?.date,
        message: c.commit?.message,
      }
    }
  } catch (e) {
    console.error('Failed to fetch latest commit:', e)
  }

  // Load student override if exists. The rule is shared with the backend
  // (lib/effective-deadline.mjs): the LAST grant in the append-only history is
  // the one in force, and an extension only ever extends. Reading the first
  // entry here used to show a student a deadline a later grant had already
  // superseded.
  try {
    const overrideFile = await getRepoContent(token, props.org, config.controlRepo, overridePath(resolvedId.value, user.value.login))
    if (overrideFile) {
      const eff = effectiveDeadlineFor(assignment.value, user.value.login, {
        overrides: [JSON.parse(overrideFile)],
      })
      if (eff.extended) {
        studentOverride.value = { value: eff.deadline.toISOString(), reason: eff.reason }
      }
    }
  } catch {
    // optional override
  }
}

// Check if the user already has a repo for this assignment
async function checkExistingState() {
  const token = getToken()
  if (!token || !assignment.value) return

  const org = props.org
  const pattern = assignment.value.repository_name_pattern || `${resolvedId.value}-{github_login}`
  const expectedName = pattern.replace('{github_login}', user.value.login)

  // Check if repo exists
  const repo = await getRepo(token, org, expectedName)
  if (repo.ok) {
    repoUrl.value = repo.data.html_url
    repoFullName.value = repo.data.full_name
    acceptState.value = 'provisioned'
    await refreshSubmitTag(org, expectedName)
    await refreshStudentSubmissionMeta(org, expectedName)
    return
  }

  // Check for pending invitation
  const invites = await getInvitations(token)
  if (invites.ok && Array.isArray(invites.data)) {
    const match = invites.data.find(
      (inv) => inv.repository?.name === expectedName && inv.repository?.owner?.login === org
    )
    if (match) {
      pendingInvitation.value = match
      repoUrl.value = match.repository.html_url
      repoFullName.value = match.repository.full_name
      acceptState.value = 'invited'
      return
    }
  }

  // Did they already accept in a tab they closed? Acceptance is an issue on the
  // broker now, not a star, so that is what "in progress" looks like. The
  // broker closes and locks it once dispatched, hence state=all.
  //
  // Only a RECENT issue counts: a failed attempt from weeks ago would otherwise
  // put every returning student straight into a three-minute poll. We only get
  // here when there is no repo and no invitation, so an old issue means an
  // acceptance that never completed - they should be offered Accept again.
  const brokerRepo = brokerRepoName({ assignment: assignment.value, assignmentId: resolvedId.value })
  const mine = await ghApi(
    token, 'GET',
    `/repos/${org}/${brokerRepo}/issues?creator=${encodeURIComponent(user.value.login)}&state=all&per_page=5`,
  )
  if (mine.ok && Array.isArray(mine.data)) {
    const cutoff = Date.now() - 15 * 60 * 1000
    const inFlight = mine.data.some(
      (issue) =>
        typeof issue.title === 'string' &&
        issue.title.startsWith('pxl-accept:') &&
        new Date(issue.created_at).getTime() > cutoff,
    )
    if (inFlight) {
      acceptState.value = 'pending'
      startPolling()
      return
    }
  }

  acceptState.value = 'ready'
}

// Auth. Sign-in failures stay inside the auth card - the assignment loaded
// fine, so the page-level error state (which replaces it) is wrong here.
async function onAuthenticated(authedUser) {
  user.value = authedUser
  authToken.value = getToken() || ''
  await checkExistingState()
}


function handleLogout() {
  clearAuth()
  user.value = null
  // The claim is bound to the account that made it, so it must not survive a
  // sign-out: the next student on this browser would otherwise inherit a
  // half-filled address and seal it under their own id.
  authToken.value = ''
  claim.value = null
  acceptState.value = 'ready'
}

// Accept assignment by opening the invitation issue on the broker.
// Reopening is safe: the acceptance script returns already-accepted and
// provisioning returns reused, so the student lands on the same repository.
async function acceptAssignment() {
  accepting.value = true
  acceptError.value = null
  try {
    const token = getToken()
    const org = props.org
    const brokerRepo = brokerRepoName({ assignment: assignment.value, assignmentId: resolvedId.value })

    // Everything the broker needs is in the TITLE. It never reads the body of
    // an issue on a repository that holds App credentials (ARCHITECTURE
    // §4.3.1), and the `pxl-accept:` prefix is its job-level filter - GitHub
    // evaluates that before allocating a runner, so an issue carrying no valid
    // invitation costs nothing at all.
    // SIGNED, not pasted. The title lands in a public event that GH Archive
    // keeps forever, so the old form published a reusable credential. This
    // signs a fresh assertion naming this student's own account - see
    // ARCHITECTURE §4.3.2.
    const title = await signedAcceptanceIssueTitle({
      inviteSecret: props.inviteToken,
      assignmentId: resolvedId.value,
      githubId: user.value?.id,
    })

    // Seal the address to the hub's public key. Only ciphertext travels: the
    // title and body land in a public event GH Archive keeps forever, which is
    // the whole reason this is encrypted rather than sent in the clear.
    let claimField = null
    if (needsClaim.value) {
      const hubKey = hubClaimKey()
      if (!hubKey) {
        throw new Error(
          'Claiming is not set up for this course yet. Ask your lecturer to finish setting up the assignment.',
        )
      }
      if (!claim.value) {
        throw new Error('Confirm your school email address before accepting.')
      }
      claimField = {
        payload: await encryptClaim({
          publicKey: hubKey.publicKey,
          email: claim.value.email,
          githubId: user.value?.id,
          assignmentId: resolvedId.value,
        }),
        verified: claim.value.verified,
      }
    }

    const res = await ghApi(token, 'POST', `/repos/${org}/${brokerRepo}/issues`, {
      title,
      body: buildAcceptanceBody({ claim: claimField }),
    })
    if (!res.ok) {
      if (res.status === 404) {
        throw new Error('Acceptance is not open for this assignment yet. Ask your lecturer to publish it.')
      }
      throw new Error(`Failed to accept assignment (HTTP ${res.status}).`)
    }

    acceptanceIssue.value = res.data?.number ?? null
    acceptState.value = 'pending'
    startPolling()
  } catch (e) {
    acceptState.value = 'error'
    acceptError.value = e.message
  }
  accepting.value = false
}

// True when the acceptance issue we just opened is no longer readable, which is
// how a restricted account presents: the POST succeeds, the content disappears,
// and no webhook ever fires. Treated as unknown (false) if we cannot tell.
async function acceptanceIssueVanished() {
  if (!acceptanceIssue.value || !assignment.value) return false
  const brokerRepo = brokerRepoName({ assignment: assignment.value, assignmentId: resolvedId.value })
  try {
    const res = await ghApi(getToken(), 'GET', `/repos/${props.org}/${brokerRepo}/issues/${acceptanceIssue.value}`)
    return res.status === 404
  } catch {
    return false
  }
}

// A GUESS at where the invitation would be, derived from the naming pattern.
// GitHub serves the accept/decline page at /<owner>/<repo>/invitations and
// redirects to the repo if you are already a collaborator - but it 404s when
// the repository does not exist yet, which during provisioning is the normal
// case for the first half-minute.
const invitationUrl = computed(() => {
  if (!assignment.value || !user.value?.login) return null
  const pattern = assignment.value.repository_name_pattern || `${resolvedId.value}-{github_login}`
  const repo = pattern.replace('{github_login}', user.value.login)
  return `https://github.com/${props.org}/${repo}/invitations`
})

// null until the poll has asked once; true when GET /user/repository_invitations
// answered, false when it did not.
//
// This is the only thing that may put the guessed link on screen, and the
// reasoning is worth keeping because a comment beside the old hint claimed the
// opposite of what the polling code does:
//
//   * The API answers and names a match -> we are in `invited`, holding the
//     real invitation and an in-app Accept button. No guess needed.
//   * The API answers and names nothing -> there is no invitation. Either the
//     repository does not exist yet, or it does and we were added directly
//     (an org owner or member is - no invitation is ever sent), in which case
//     getRepo already succeeded and we are in `provisioned`. Both ways the
//     guessed link 404s, and offering it asserts a cause that is not true.
//   * The API fails -> we are blind, and a guess is the best on offer.
//
// So: only when we are blind.
const invitationsReadable = ref(null)
const showInvitationGuess = computed(
  () => invitationsReadable.value === false && Boolean(invitationUrl.value),
)

// Poll for repo provisioning
function startPolling() {
  pollCount.value = 0
  waitedMs.value = 0
  pollStartedAt = Date.now()

  const tick = async () => {
    pollCount.value++
    waitedMs.value = Date.now() - pollStartedAt
    const token = getToken()
    if (!token) return

    const org = props.org
    const pattern = assignment.value.repository_name_pattern || `${resolvedId.value}-{github_login}`
    const expectedName = pattern.replace('{github_login}', user.value.login)

    // Check repo
    const repo = await getRepo(token, org, expectedName)
    if (repo.ok) {
      repoUrl.value = repo.data.html_url
      repoFullName.value = repo.data.full_name
      acceptState.value = 'provisioned'
      await refreshSubmitTag(org, expectedName)
      return
    }

    // Check invitation. Whether this call ANSWERS is itself the signal that
    // decides whether the guessed link may ever be shown - see
    // `showInvitationGuess`.
    const invites = await getInvitations(token)
    invitationsReadable.value = invites.ok && Array.isArray(invites.data)
    if (invitationsReadable.value) {
      const match = invites.data.find(
        (inv) => inv.repository?.name === expectedName && inv.repository?.owner?.login === org
      )
      if (match) {
        pendingInvitation.value = match
        repoUrl.value = match.repository.html_url
        repoFullName.value = match.repository.full_name
        acceptState.value = 'invited'
        return
      }
    }

    // Increase poll interval after many attempts (after ~1 minute, slow down to 10s)
    if (pollCount.value > 20) {
      pollInterval.value = 10000
    }
    
    // Cap polling at 30 attempts
    if (pollCount.value > 30) {
      // Before blaming GitHub load, check the acceptance issue is still there.
      // An account GitHub has restricted gets HTTP 201 on creation and then has
      // its content removed a few seconds later - the broker never sees an
      // event, so nothing downstream runs and the student waits three minutes
      // for a message about load that has nothing to do with it. Observed on a
      // real account during live testing.
      acceptState.value = (await acceptanceIssueVanished()) ? 'blocked-account' : 'timeout'
      return
    }
    
    // Continue polling if not aborted
    if (acceptState.value === 'pending') {
      pollTimer = setTimeout(tick, pollInterval.value)
    }
  }

  // Immediately, not at +3s. Re-opening the link after the repository already
  // exists is a common way to arrive here, and three seconds of "Setting up
  // your repository…" for something that is already set up is three seconds
  // of the page being wrong.
  tick()
}

// Accept invitation
async function handleAcceptInvitation() {
  if (!pendingInvitation.value) return
  const token = getToken()
  const repoName = pendingInvitation.value.repository?.name
  const result = await acceptInvitation(token, pendingInvitation.value.id)
  if (result.ok) {
    acceptState.value = 'provisioned'
    if (repoName) await refreshSubmitTag(props.org, repoName)
  } else {
    toast.error(
      `Could not accept the invitation (HTTP ${result.status}). ` +
      `Open github.com/notifications and accept it there.`,
    )
  }
}

// Timeout state: check whether the repo actually arrived while we waited -
// only fall back to the Accept button when nothing exists yet, so students
// don't needlessly re-fire the acceptance pipeline.
const checkingAgain = ref(false)
async function checkAgain() {
  checkingAgain.value = true
  acceptError.value = null
  try {
    // Reset the poll budget in case checkExistingState() lands back in
    // 'pending' and restarts polling.
    pollInterval.value = 3000
    await checkExistingState()
  } finally {
    checkingAgain.value = false
  }
}

// Copy helpers

function copyRepoUrl() {
  if (repoUrl.value) {
    copyText(repoUrl.value).then((ok) => {
      if (ok) {
        repoCopied.value = true
        setTimeout(() => { repoCopied.value = false }, 2000)
      } else {
        toast.error('Could not copy repository URL')
      }
    })
  }
}

function retry() {
  error.value = null
  acceptState.value = 'ready'
  acceptError.value = null
  startNotFoundPolling()
}
</script>

<style scoped>
.assignment-page {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}

.assignment-header .container {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.logo {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  font-weight: 700;
  font-size: 1.125rem;
  color: var(--text-primary);
}

.user-badge {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  font-size: 0.875rem;
}

.avatar {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  border: 2px solid var(--border-default);
}

main {
  flex: 1;
  padding: var(--space-2xl) var(--space-lg);
  max-width: 640px;
  margin: 0 auto;
  width: 100%;
}


.status-icon {
  color: var(--text-secondary);
  margin-bottom: var(--space-sm);
}
.status-icon-error { color: var(--accent-red); }
.btn-with-icon {
  display: inline-flex;
  align-items: center;
  gap: var(--space-xs);
}

.assignment-content {
  display: flex;
  flex-direction: column;
  gap: var(--space-lg);
}

.assignment-meta {
  display: flex;
  gap: var(--space-sm);
  margin-bottom: var(--space-md);
}

.assignment-title {
  font-size: 1.75rem;
  font-weight: 700;
  line-height: 1.3;
  margin-bottom: var(--space-sm);
}

.assignment-desc {
  color: var(--text-secondary);
  font-size: 1rem;
  margin-bottom: var(--space-md);
}

.assignment-dates {
  display: flex;
  gap: var(--space-xl);
  padding-top: var(--space-md);
  border-top: 1px solid var(--border-muted);
}

.date-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.date-label {
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-muted);
  font-weight: 600;
}

.text-secondary { color: var(--text-secondary); }
.text-muted { color: var(--text-muted); font-size: 0.875rem; }
.text-warning { color: var(--accent-yellow); }

.auth-card, .acceptance-card {
  text-align: center;
}
.auth-card h2, .acceptance-card h2 {
  margin-bottom: var(--space-sm);
}
.auth-card p, .acceptance-card p {
  margin-bottom: var(--space-lg);
}

.auth-actions {
  padding-top: var(--space-md);
}


.device-flow-panel {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-lg);
}

.device-code-display {
  text-align: center;
}
.device-code-label {
  margin: var(--space-sm) 0;
  color: var(--text-secondary);
}
.device-code {
  display: flex;
  align-items: center;
  gap: var(--space-md);
  justify-content: center;
  margin-top: var(--space-sm);
}
.device-code code {
  font-family: var(--font-mono);
  font-size: 2rem;
  font-weight: 700;
  letter-spacing: 0.15em;
  color: var(--accent-blue);
  background: var(--bg-tertiary);
  padding: var(--space-sm) var(--space-lg);
  border-radius: var(--radius-md);
  border: 1px solid var(--border-default);
}

.device-flow-status {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
}


/* Surfaced mid-poll once waiting stops being the likely explanation. */

.progress-bar {
  width: 100%;
  height: 4px;
  background: var(--bg-tertiary);
  border-radius: var(--radius-full);
  overflow: hidden;
}
.progress-bar-fill {
  height: 100%;
  background: var(--gradient-brand);
  border-radius: var(--radius-full);
  animation: progress 2s ease-in-out infinite;
}
@keyframes progress {
  0% { width: 0%; margin-left: 0; }
  50% { width: 60%; margin-left: 20%; }
  100% { width: 0%; margin-left: 100%; }
}

.repo-link-card {
  display: flex;
  align-items: center;
  gap: var(--space-md);
  background: var(--bg-tertiary);
  padding: var(--space-md) var(--space-lg);
  border-radius: var(--radius-md);
  border: 1px solid var(--border-default);
}

.submit-tag-banner {
  display: flex;
  align-items: flex-start;
  gap: var(--space-sm);
  background: var(--bg-tertiary);
  padding: var(--space-md) var(--space-lg);
  border-radius: var(--radius-md);
  border: 1px solid var(--accent-green);
  text-align: left;
  width: 100%;
}
.submit-tag-icon {
  color: var(--accent-green);
  flex-shrink: 0;
  margin-top: 2px;
}
.submit-tag-name code {
  font-family: var(--font-mono);
  font-size: 0.8rem;
}


@media (max-width: 640px) {
  .assignment-dates {
    flex-direction: column;
    gap: var(--space-md);
  }
  .device-code code {
    font-size: 1.5rem;
  }
  .repo-link-card {
    flex-direction: column;
  }
}
</style>
