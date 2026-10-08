<template>
  <div class="group-acceptance-card card fade-in">
    <!-- State: Already Provisioned -->
    <div v-if="acceptState === 'provisioned'" class="provisioned-state">
      <Icon name="check-circle" :size="48" class="status-icon status-icon-success" />
      <h2>Your team repository is ready!</h2>
      <div v-if="myCurrentTeam" class="team-badge-banner">
        <span>Team: <strong>{{ myCurrentTeam.team_name }}</strong> (<code>{{ myCurrentTeam.team_slug }}</code>)</span>
      </div>
      <!-- RIGHT UNDER THE NAME, where a typo or the wrong team is noticed
           (asked 2026-10-08). It sat at the bottom of this card, under the
           repository, the members, the join code and the status, and a student
           who had misspelled their team asked the lecturer to fix it instead.
           Only where the hub allows a switch: self-service, before this
           student's deadline. -->
      <p v-if="canSwitchTeam" class="team-switch-line text-sm" data-team-switch>
        Wrong team, or a typo in the name?
        <button type="button" class="btn-link" :disabled="accepting" @click="startSwitchTeam">Switch team</button>
        <br />
        <span class="text-muted">You can change team yourself until {{ switchUntil }}.</span>
      </p>

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

      <!-- Teammates section -->
      <div v-if="myCurrentTeam && myCurrentTeam.members && myCurrentTeam.members.length" class="teammates-section">
        <span class="text-muted" style="font-size: 0.85rem;">Team members:</span>
        <div class="member-chips">
          <span v-for="m in myCurrentTeam.members" :key="m" class="member-chip" :class="{ 'is-me': m.toLowerCase() === user.login.toLowerCase() }">
            @{{ m }}
          </span>
        </div>
      </div>

      <TeamJoinCode :code="myTeamCode" :team-name="myCurrentTeam?.team_name || targetTeamName" :elsewhere="myTeamCodeElsewhere" />

      <!-- Team Submission Status & Deadline Countdown Card -->
      <div class="team-status-card card flex flex-col gap-sm" style="margin-top: var(--space-md); padding: 14px; background: var(--bg-surface); border: 1px solid var(--border-default); border-radius: 8px; text-align: left;">
        <!-- Active Extension Announcement -->
        <div v-if="teamOverride" class="override-alert-banner flex items-center gap-xs">
          <Icon name="check-circle" :size="16" class="stat-green" />
          <span class="text-xs font-semibold text-primary">
            🎉 Deadline Extended to {{ new Date(teamOverride.value).toLocaleString() }} ({{ teamOverride.reason || 'Approved extension' }})
          </span>
        </div>

        <div class="flex justify-between items-center flex-wrap gap-xs">
          <div class="flex items-center gap-xs">
            <span class="text-xs font-semibold text-secondary">Team Submission:</span>
            <span :class="['badge', teamSubmissionStatus === 'on-time' ? 'badge-success' : teamSubmissionStatus === 'late' ? 'badge-warning' : 'badge-neutral']">
              {{ teamSubmissionStatus === 'on-time' ? 'Submitted on time' : teamSubmissionStatus === 'late' ? 'Submitted late' : 'No commits pushed' }}
            </span>
          </div>

          <div v-if="deadlineCountdown" class="deadline-countdown flex items-center gap-xs text-xs">
            <Icon name="clock" :size="14" :class="isPastDeadline ? 'stat-red' : 'stat-blue'" />
            <span :class="isPastDeadline ? 'stat-red font-semibold' : 'text-secondary'">
              {{ deadlineCountdown }}
            </span>
          </div>
        </div>

        <div v-if="teamLatestCommit" class="latest-commit-info text-xs text-muted flex items-center gap-xs">
          <span>Latest team commit:</span>
          <code class="mono">{{ teamLatestCommit.sha.slice(0, 7) }}</code>
          <span v-if="teamLatestCommit.date">· {{ teamLatestCommit.date }}</span>
        </div>
      </div>

    </div>

    <!-- State: Provisioning Pending -->
    <div v-else-if="acceptState === 'pending'" class="pending-state text-center">
      <Icon name="clock" :size="48" class="status-icon status-icon-pulse" />
      <h2>Setting up your team repository…</h2>
      <p class="text-secondary">
        Joining <strong>{{ targetTeamName }}</strong>. GitHub Actions is configuring collaborator
        access, which usually takes <strong>20 to 40 seconds</strong> - longer when GitHub is busy.
      </p>
      <div class="progress-bar">
        <div class="progress-bar-fill"></div>
      </div>
      <p class="text-muted">Waiting {{ waitedSeconds }}s…</p>

      <!-- Shown while it waits: the creator can hand the code out now. -->
      <TeamJoinCode :code="myTeamCode" :team-name="targetTeamName" />

      <!-- Reassurance rather than a guessed cause; see AssignmentView for the
           reasoning, which this card had a verbatim copy of. -->
      <AttemptProgress
        :steps="progressStepList"
        :message="progressText"
        :can-retry="progress.canRetry"
        :busy="accepting"
        @retry="sendAgain"
      />
      <p v-if="!progressText && pollCount >= 5" class="text-secondary">
        Still going, and that is normal. Leave this page open - it updates by itself.
      </p>

      <!-- Held back past the ordinary provisioning window; see AssignmentView. -->
      <div v-if="pollCount >= 20 && showInvitationGuess" class="invitation-hint" role="status">
        <p class="text-secondary">
          This page cannot see your GitHub invitations. If <strong>{{ org }}</strong> invited you
          rather than adding you directly, your team repository is waiting behind that invitation:
        </p>
        <a :href="invitationUrl" target="_blank" rel="noopener" class="btn btn-primary">
          Look for a repository invitation
        </a>
        <p class="text-muted" style="margin-top: var(--space-xs);">
          A "404" there just means the repository is not ready yet - come back to this page.
        </p>
      </div>
    </div>

    <!-- State: Invitation Pending -->
    <div v-else-if="acceptState === 'invited'" class="invited-state text-center">
      <Icon name="inbox" :size="48" class="status-icon" />
      <h2>Team repository invitation pending</h2>
      <p class="text-secondary">
        Your team repository exists, but you need to accept the collaboration invitation.
      </p>
      <button v-if="pendingInvitation" class="btn btn-primary btn-lg" @click="handleAcceptInvitation">
        Accept invitation
      </button>
      <!-- We know one exists because the hub said so, but this token cannot
           list it - so there is nothing to accept in-app, and the link is the
           whole affordance. Safe here: the same message proves the repository
           exists. -->
      <a
        v-else-if="invitationUrl"
        :href="invitationUrl"
        target="_blank"
        rel="noopener"
        class="btn btn-primary btn-lg"
      >
        Accept your invitation on GitHub
      </a>
      <a v-else href="https://github.com/notifications" target="_blank" rel="noopener" class="btn btn-primary btn-lg">
        Check GitHub notifications
      </a>
    </div>

    <!-- State: Refused. A refusal is not a stall: without this a refused team
         student watched the spinner, then got a guessed link that 404s. -->
    <div v-else-if="acceptState === 'rejected'" class="timeout-state text-center">
      <Icon name="alert-triangle" :size="48" class="status-icon status-icon-warn" />
      <h2>{{ refusedHeading }}</h2>
      <p class="text-secondary">{{ REJECTION_MESSAGE }}</p>
      <!-- Not a reason - the page is not told one - but the thing to check
           first when a code was typed: a typo is caught before sending, so
           what reaches the hub is a real code, and maybe another team's. -->
      <p v-if="lastJoin?.code && !lastJoin.made" class="text-secondary" data-code-refused-hint>
        If you typed a join code, check it is this team's with someone in it.
      </p>
      <p v-if="rejectionReference" class="text-muted">
        Tell them: <strong>{{ rejectionReference }}</strong>
      </p>
      <button class="btn btn-primary" @click="backToTeams">Back</button>
    </div>

    <!-- State: GitHub said the join will not finish - not passed on, stopped,
         or ended with nothing set up. Not a timeout and not a refusal. -->
    <div v-else-if="acceptState === 'not-processed'" class="timeout-state text-center">
      <Icon name="alert-triangle" :size="48" class="status-icon status-icon-warn" />
      <h2>Joining {{ targetTeamName || 'the team' }} did not go through</h2>
      <AttemptProgress
        :steps="progressStepList"
        :message="progressText"
        :can-retry="progress.canRetry"
        :busy="accepting"
        @retry="sendAgain"
      />
      <button v-if="!progress.canRetry" class="btn btn-secondary" @click="backToTeams">Back</button>
    </div>

    <!-- State: Timeout -->
    <div v-else-if="acceptState === 'timeout'" class="timeout-state text-center">
      <Icon name="timer" :size="48" class="status-icon status-icon-warn" />
      <!-- ONE headline. The page cannot see pending invitations, so it may not
           split on "we asked and there was none" - see AssignmentView. -->
      <h2>Your team repository has not appeared</h2>
      <!-- One block: the explanation is about the link, and dangles without it. -->
      <template v-if="showInvitationGuess">
        <p class="text-secondary">
          Either there is a team repository invitation you still need to accept, or setup did not
          finish. This page cannot tell which - it is not able to see your pending invitations -
          but you can, in one click:
        </p>
        <a
          :href="invitationUrl"
          target="_blank"
          rel="noopener"
          class="btn btn-primary btn-lg"
          style="margin-bottom: var(--space-sm);"
        >
          Check for a repository invitation
        </a>
        <p class="text-muted" style="margin-bottom: var(--space-sm);">
          If that page offers you an invitation, accept it, then press <strong>Check again</strong>.
          If it shows a "404", there is no invitation for you to accept - tell your lecturer.
        </p>
      </template>
      <p v-else class="text-secondary">
        Setup did not finish - tell your lecturer.
      </p>
      <button class="btn btn-secondary" @click="checkExistingState">Check again</button>
    </div>

    <!-- State: Assignment Closed / Past Deadline -->
    <div v-else-if="assignment && (assignment.state === 'closed' || (assignment.deadline_at && new Date() > new Date(assignment.deadline_at)))" class="text-center py-lg">
      <Icon name="lock" :size="48" class="status-icon" />
      <h2>Assignment closed</h2>
      <p class="text-secondary">
        New registrations and team memberships for this assignment are currently closed.
      </p>
    </div>

    <!-- State: Not Open Yet -->
    <div v-else-if="assignment && (assignment.state === 'draft' || (assignment.opens_at && new Date() < new Date(assignment.opens_at)))" class="text-center py-lg">
      <Icon name="clock" :size="48" class="status-icon" />
      <h2>Assignment not open yet</h2>
      <p class="text-secondary">
        {{ assignment.state === 'draft' ? 'This assignment is currently in draft mode.' : `Opens ${assignment.opens_at}` }}
      </p>
    </div>

    <!-- State: Ready (Pick or Create Team) -->
    <div v-else class="team-selection-flow">
      <div class="flow-header">
        <h2>Group Assignment: Team Selection</h2>
        <p class="text-secondary">
          You are signed in as <strong>@{{ user.login }}</strong>.
          Join an existing team or create a new team for this assignment (max {{ maxTeamSize }} members).
        </p>
      </div>

      <!-- The refusal, still said after Back, until the next attempt is sent.
           Back used to forget it, and the list below offered the same action
           that had just been refused. -->
      <div v-if="refusedEarlier" class="refused-earlier" role="status">
        <p><strong>{{ REFUSED_EARLIER_MESSAGE }}</strong></p>
        <p v-if="rejectionReference" class="text-secondary">Tell them: <strong>{{ rejectionReference }}</strong></p>
      </div>

      <!-- Asked once, above the team UI. The claim binds the ACCOUNT and is
           org-scoped, so it is orthogonal to which team is picked - putting it
           on each team action instead would ask the same question three times
           in three places. -->
      <ClaimAddressCard
        v-if="needsClaim"
        :assignment="assignment"
        :org="org"
        :token="claimToken"
        @update:claim="claim = $event"
      />
      <p v-if="needsClaim && !claimKeyReady" class="text-sm claim-unavailable">
        Claiming is not set up for this course yet. Ask your lecturer to finish
        setting up the assignment.
      </p>
      <p v-else-if="codesBlocked" class="text-sm claim-unavailable">
        Join codes are not set up for this course yet. Ask your lecturer to finish
        setting up the assignment.
      </p>

      <!-- The group you are already in: pre-assigned, or carried over from an
           earlier assignment. One click confirms it; switching stays open
           unless the lecturer pre-assigned the groups. -->
      <div v-if="myCurrentTeam && !showAlternatives" class="preassigned-flow text-center py-md">
        <div class="card" style="padding: var(--space-lg); background: var(--bg-secondary);">
          <Icon name="users" :size="40" class="status-icon" />
          <h3>{{ myGroupHeading }}</h3>
          <p class="text-secondary">
            <template v-if="seededFromLabel">
              Carried over from <strong>{{ seededFromLabel }}</strong> — you are in
              <code>{{ myCurrentTeam.team_slug }}</code>.
            </template>
            <template v-else-if="isPreAssignedMode">
              You are pre-assigned to team <code>{{ myCurrentTeam.team_slug }}</code>.
            </template>
            <template v-else>
              You are already listed in <code>{{ myCurrentTeam.team_slug }}</code>.
            </template>
          </p>
          <div v-if="myCurrentTeam.members && myCurrentTeam.members.length" class="member-chips" style="justify-content: center; margin-bottom: var(--space-md);">
            <span v-for="m in myCurrentTeam.members" :key="m" class="member-chip" :class="{ 'is-me': m.toLowerCase() === user.login.toLowerCase() }">
              @{{ m }}
            </span>
          </div>
          <button class="btn btn-primary btn-lg" :disabled="accepting || claimBlocked" @click="confirmJoinTeam(myCurrentTeam)">
            {{ accepting ? 'Joining…' : 'Accept & Join Team' }}
          </button>
          <div v-if="canChooseAnother" class="alt-group-action">
            <button class="btn btn-link" type="button" :disabled="accepting" @click="showAlternatives = true">
              Choose a different group
            </button>
          </div>
        </div>
      </div>

      <!-- Pre-assigned, unassigned, and the lecturer has not opened the fallback -->
      <div v-else-if="isPreAssignedMode && !unassignedFallbackOpen" class="preassigned-flow text-center py-md">
        <div class="card text-center" style="padding: var(--space-lg); background: var(--bg-secondary);">
          <Icon name="alert-circle" :size="40" class="status-icon status-icon-warn" />
          <h3>No Pre-Assigned Team</h3>
          <p class="text-secondary">
            This assignment requires teams to be pre-assigned by your lecturer, but your account (<strong>@{{ user.login }}</strong>) is not yet mapped to a team.
          </p>
          <p class="text-muted text-sm">Please contact your instructor to be assigned to a group.</p>
        </div>
      </div>

      <!-- Self-Service Flow (Join or Create Team) -->
      <template v-else>
        <div v-if="myCurrentTeam && showAlternatives" class="back-to-group">
          <button class="btn btn-link" type="button" @click="showAlternatives = false">
            ← Back to my group ({{ myCurrentTeam.team_name }})
          </button>
        </div>
        <!-- Mode Selector -->
        <div class="tab-pill-selector">
          <button 
            class="tab-pill" 
            :class="{ active: tabMode === 'join' }" 
            @click="tabMode = 'join'"
          >
            Join Existing Team ({{ openTeamsCount }} open)
          </button>
          <button 
            v-if="allowTeamCreation"
            class="tab-pill" 
            :class="{ active: tabMode === 'create' }" 
            @click="tabMode = 'create'"
          >
            + Create New Team
          </button>
        </div>

      <!-- Tab 1: Join Existing Team -->
      <div v-if="tabMode === 'join'" class="tab-content">
        <div class="search-box">
          <input 
            v-model="teamSearchQuery" 
            type="text" 
            placeholder="Search teams or member username…" 
            class="input-search"
          />
        </div>

        <p v-if="!loadingTeams && teamsListPartial" class="text-sm text-muted teams-partial" data-teams-partial>
          The full team list could not be loaded, so this one may be incomplete or out of date. Reload the
          page in a minute.
        </p>

        <div v-if="loadingTeams" class="text-center py-md">
          <div class="spinner"></div>
          <span class="text-muted" style="margin-left: 8px;">Loading teams…</span>
        </div>

        <div v-else-if="filteredTeams.length === 0" class="empty-teams text-center py-md">
          <p class="text-muted">No matching open teams found.</p>
          <button v-if="allowTeamCreation" class="btn btn-secondary btn-sm" @click="tabMode = 'create'">
            Create a new team instead
          </button>
        </div>

        <div v-else class="teams-list">
          <div 
            v-for="team in filteredTeams" 
            :key="team.team_slug" 
            class="team-item-card"
            :class="{ 'is-selected': selectedTeam?.team_slug === team.team_slug, 'is-full': team.is_full }"
          >
            <div class="team-info">
              <div class="team-header-line">
                <strong class="team-name">{{ team.team_name }}</strong>
                <span class="team-slug-badge"><code>{{ team.team_slug }}</code></span>
                <span :class="['badge', team.is_full ? 'badge-neutral' : 'badge-success']" style="font-size: 0.75rem;">
                  {{ team.member_count }}/{{ team.max_members }} members
                </span>
              </div>
              <div class="team-members-list">
                <span v-for="m in team.members" :key="m" class="member-tag">@{{ m }}</span>
                <span v-if="team.members.length === 0" class="text-muted" style="font-size: 0.8rem;">Empty team</span>
              </div>
              <p v-if="team.needs_code && !isMyTeam(team) && !team.is_full" class="team-needs-code text-xs text-muted">
                <Icon name="lock" :size="12" /> Needs a join code from someone in it
              </p>
              <form
                v-if="codeFor === team.team_slug"
                class="join-code-form"
                @submit.prevent="joinWithCode(team)"
                @keydown.esc="closeCodeField"
              >
                <label :for="`join-code-${team.team_slug}`" class="text-xs">Join code</label>
                <div class="join-code-row">
                  <input
                    :id="`join-code-${team.team_slug}`"
                    v-model="codeInput"
                    type="text"
                    class="input-text join-code-input"
                    autocomplete="off"
                    autocapitalize="characters"
                    spellcheck="false"
                    maxlength="9"
                    placeholder="K7P-4QX"
                    :aria-invalid="codeLooksWrong ? 'true' : 'false'"
                    data-join-code-input
                  />
                  <button type="submit" class="btn btn-secondary btn-sm" :disabled="!codeWellFormed || accepting || claimBlocked">
                    {{ accepting ? 'Joining…' : 'Join' }}
                  </button>
                  <button type="button" class="btn btn-link btn-sm" @click="closeCodeField">Cancel</button>
                </div>
                <p v-if="codeLooksWrong" class="field-error-msg" role="alert">
                  This code has a mistake in it. Check it with someone in the team.
                </p>
              </form>
            </div>
            <div v-if="codeFor !== team.team_slug" class="team-action-btn">
              <button
                class="btn btn-sm"
                :class="isMyTeam(team) ? 'btn-primary' : 'btn-secondary'"
                :disabled="(team.is_full && !isMyTeam(team)) || accepting || claimBlocked || (team.needs_code && !isMyTeam(team) && codesBlocked)"
                @click="confirmJoinTeam(team)"
              >
                {{ isMyTeam(team) ? 'My group' : team.is_full ? 'Full' : 'Join Team' }}
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- Tab 2: Create New Team -->
      <div v-else-if="tabMode === 'create'" class="tab-content">
        <form @submit.prevent="submitCreateTeam" class="create-team-form">
          <div class="form-group">
            <label for="new-team-name">Team Name</label>
            <input 
              id="new-team-name"
              v-model="newTeamName" 
              type="text" 
              placeholder="e.g. The Code Crusaders" 
              class="input-text"
              maxlength="60"
              required
            />
            <span class="form-hint">
              Repository slug: <code>{{ computedSlug || 'team-name' }}</code>
            </span>
          </div>

          <div v-if="slugListed" class="alert-warn" role="alert">
            A team with slug "<strong>{{ computedSlug }}</strong>" already exists. Please pick a different name or join that team.
          </div>
          <div v-else-if="slugTaken" class="alert-warn" role="alert" data-slug-taken>
            A team called <strong>{{ computedSlug }}</strong> exists. Pick another name.
          </div>

          <p v-if="takenRejoinCode" class="form-hint" data-rejoin-hint>
            You were in this team: this takes you back in, with its join code.
          </p>
          <p v-else-if="codesOn" class="form-hint" data-create-code-hint>
            Your team gets a join code. Give it to your teammates: they need it to join.
          </p>

          <button
            type="submit"
            class="btn btn-primary btn-lg"
            :disabled="!computedSlug || slugConflict || accepting || claimBlocked || codesBlocked"
          >
            <span v-if="accepting">Creating…</span>
            <span v-else>Create & Join Team</span>
          </button>
        </form>
      </div>
      </template>
    </div>

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
import { ref, computed, nextTick, onMounted, onUnmounted, watch } from 'vue'
import Icon from './Icon.vue'
import StudentDiagnosticsModal from './StudentDiagnosticsModal.vue'
import { getToken } from '../lib/auth.js'
import { config } from '../lib/config.js'
import { getRepo, getInvitations, acceptInvitation, ghApi, getRepoContent } from '../lib/api.js'
import { toast } from '../lib/toast.js'
import { copyText } from '../lib/clipboard.js'
import { signedAcceptanceIssueTitle, inviteTeamsUrl } from '../lib/invite.js'
import { invitationEvidence, mayOfferInvitationLink } from '../lib/invitation-evidence.js'
import {
  outcomeFromLabels,
  announcesInvitation,
  isRejection,
  REJECTION_MESSAGE,
  REFUSED_EARLIER_MESSAGE,
  formatRejectionReference,
} from '../lib/acceptance-outcome.js'
import {
  teamsFromBrokerIssues,
  attemptYields,
  ownAcceptanceIssue,
  RECENT_ATTEMPT_MS as SHARED_RECENT_ATTEMPT_MS,
} from '../lib/broker-teams.js'
import { INSTITUTION } from '../lib/deployment.js'
import { effectiveDeadlineFor } from '../lib/deadline.js'
import { formatDeadlineCountdown } from '../lib/countdown.js'
import { formatDate } from '../lib/format.js'
import { buildAcceptanceBody, hubClaimKey, encryptClaim, encryptTeamCode } from '../lib/claim.js'
import {
  isWellFormedJoinCode, newJoinCode, normalizeJoinCode, requiresJoinCode,
} from '../../../lib/team-join-code.mjs'
import { forgetAnyJoinCode, forgetJoinCode, rememberJoinCode, rememberedJoinCode } from '../lib/team-code-memory.js'
import { parseTeamPayload } from '../../../lib/team-payload.mjs'
import { claimRequired } from '../../../lib/roster-mode.mjs'
import { brokerRepoName } from '../../../lib/broker-repo.mjs'
import { overridePath } from '../../../lib/control-layout.mjs'
import { maxTeamSize as teamMaxSize } from '../../../lib/group-config.mjs'
import ClaimAddressCard from './ClaimAddressCard.vue'
import TeamJoinCode from './TeamJoinCode.vue'
import AttemptProgress from './AttemptProgress.vue'
import {
  GIVE_UP_MS, attemptProgress, attemptRunFromPage, hubRunsPath, progressMessage, progressSteps,
} from '../lib/acceptance-progress.js'

const props = defineProps({
  assignment: { type: Object, required: true },
  org: { type: String, required: true },
  user: { type: Object, required: true },
  // The signed invitation from the route. Acceptance carries it in the issue
  // title; without it the broker rejects before touching a credential.
  inviteToken: { type: String, default: '' },
})

// Under `claim` a group student proves an address exactly as an individual one
// does - the claim binds the ACCOUNT to a person and is org-scoped, so it is
// orthogonal to which team they join.
const claim = ref(null)
// lib/roster-mode.mjs decides, the same as the individual page and the hub.
// This asked `=== 'claim'` alone, so an open group assignment with "confirm
// their email address" ticked never showed the field and the hub refused every
// student as rejected:no-claim.
const needsClaim = computed(() => claimRequired(props.assignment))
const claimKeyReady = computed(() => Boolean(hubClaimKey()))
const claimBlocked = computed(() => needsClaim.value && (!claim.value || !claimKeyReady.value))
// Read at setup, not in onMounted: ClaimAddressCard is a child, and a child's
// onMounted runs BEFORE its parent's - so it asked GitHub for the student's
// addresses with an empty token, judged them unreadable, and offered only the
// typed (never verified) fallback. Unseen while the group page asked for an
// address under `claim` only, which no course used.
const claimToken = ref(getToken() || '')

const tabMode = ref('join')
const teamSearchQuery = ref('')
const newTeamName = ref('')
const teams = ref([])
const loadingTeams = ref(true)
const selectedTeam = ref(null)
const myCurrentTeam = ref(null)
const targetTeamName = ref('')
const acceptState = ref('ready') // ready | pending | provisioned | invited | rejected | not-processed | timeout | error
/** When this attempt was refused. Set beside every `acceptState = 'rejected'`. */
const rejectedAt = ref(null)
const rejectionReference = computed(() => formatRejectionReference({
  title: props.assignment?.title || props.assignment?.id,
  login: props.user?.login,
  at: rejectedAt.value,
}))
const accepting = ref(false)
const repoUrl = ref(null)
const repoFullName = ref(null)
const repoCopied = ref(false)
const pendingInvitation = ref(null)
const isSwitching = ref(false)
// Set when the student explicitly asks to leave their carried-over group.
const showAlternatives = ref(false)

// Student Diagnostics (1.A)
const showDiagnosticsModal = ref(false)
const rosterStatus = ref('enrolled')

// 3s, deliberately. See AssignmentView: polling less often only adds dead time
// after the repository appears.
const pollInterval = ref(3000)
const pollCount = ref(0)
const waitedMs = ref(0)
let pollStartedAt = 0
const waitedSeconds = computed(() => Math.max(0, Math.round(waitedMs.value / 1000)))
let pollTimer = null
// One loop at a time - see AssignmentView.
let pollGeneration = 0

const isPreAssignedMode = computed(() => props.assignment.group_config?.formation_mode === 'pre-assigned')
const unassignedFallbackOpen = computed(
  () => props.assignment.group_config?.unassigned_fallback === 'self-service'
)
// Pre-assigned groups are the lecturer's: accept.mjs rejects a student-initiated
// switch, so offering one here would only produce a confusing failure.
const canChooseAnother = computed(() => !isPreAssignedMode.value)
const seededFromLabel = computed(() => {
  const from = myCurrentTeam.value?.seeded_from
  if (!from) return ''
  return from.assignment_title || from.assignment_id || ''
})
const myGroupHeading = computed(() => {
  if (!myCurrentTeam.value) return ''
  if (isPreAssignedMode.value && !seededFromLabel.value) {
    return `Pre-Assigned Team: ${myCurrentTeam.value.team_name}`
  }
  return `Your group: ${myCurrentTeam.value.team_name}`
})

function isMyTeam(team) {
  return (
    !!team &&
    (team.members || []).some((m) => m.toLowerCase() === props.user.login.toLowerCase())
  )
}
const maxTeamSize = computed(() => teamMaxSize(props.assignment?.group_config))
const allowTeamCreation = computed(() => props.assignment.group_config?.allow_team_creation !== false)

const computedSlug = computed(() => {
  if (!newTeamName.value) return ''
  return newTeamName.value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
})

const slugListed = computed(() => {
  if (!computedSlug.value) return false
  return teams.value.some((t) => t.team_slug.toLowerCase() === computedSlug.value.toLowerCase())
})

// A NAME THAT IS TAKEN BY A TEAM NOBODY IS IN. The published file lists a team
// everybody left that keeps its repository and its code (pages/generate.mjs):
// the hub opens it only to that code, so it is a former member's way back and
// nobody else's name to take. A browser that kept its code is that member's.
const takenTeams = ref([])
const takenRejoinCode = computed(() => {
  void codeMemory.value
  const slug = computedSlug.value.toLowerCase()
  if (!slug || !takenTeams.value.some((t) => t.team_slug === slug)) return ''
  return rememberedJoinCode(codeKey(slug))
})
const slugTaken = computed(() => {
  const slug = computedSlug.value.toLowerCase()
  return !!slug && takenTeams.value.some((t) => t.team_slug === slug) && !takenRejoinCode.value
})
const slugConflict = computed(() => slugListed.value || slugTaken.value)

const filteredTeams = computed(() => {
  const q = teamSearchQuery.value.toLowerCase().trim()
  if (!q) return teams.value
  return teams.value.filter(
    (t) =>
      t.team_name.toLowerCase().includes(q) ||
      t.team_slug.toLowerCase().includes(q) ||
      (t.members || []).some((m) => m.toLowerCase().includes(q))
  )
})

const openTeamsCount = computed(() => teams.value.filter((t) => !t.is_full).length)

// JOIN CODES (lib/team-join-code.mjs). A team a student made while the
// assignment asks for codes is joined with its code; the page catches a typo
// itself, because a refusal reaches it only as "refused".
const codesOn = computed(() => requiresJoinCode(props.assignment?.group_config))
const codesBlocked = computed(() => codesOn.value && !claimKeyReady.value)
// The team whose code field is open, and what has been typed into it.
const codeFor = ref('')
const codeInput = ref('')
const codeWellFormed = computed(() => isWellFormedJoinCode(codeInput.value))
// Said only once there is a whole code's worth of characters to judge.
const codeLooksWrong = computed(
  () => codeInput.value.replace(/[\s-]/g, '').length >= 6 && !codeWellFormed.value,
)
// Bumped whenever this browser's remembered codes change, so what reads them
// recomputes.
const codeMemory = ref(0)
// Whose code, for which team: per GitHub account, so a shared lab computer
// does not show one student's codes to the next (team-code-memory.js).
const codeKey = (slug) => ({ org: props.org, assignmentId: props.assignment?.id, slug, login: props.user?.login })

/**
 * The code of the team this page is about, where this browser has it: made
 * here, or typed here to join. Not for a team that has none, and not once the
 * assignment stops asking for codes - then it opens nothing.
 */
const myTeamCode = computed(() => {
  void codeMemory.value
  const slug = activeTeamSlug.value
  if (!slug || !codesOn.value) return ''
  const team = teams.value.find((t) => t.team_slug === slug) || myCurrentTeam.value
  if (team && team.needs_code === false) return ''
  return rememberedJoinCode(codeKey(slug))
})
// A team with a code this browser does not have: said where to get it.
const myTeamCodeElsewhere = computed(() => {
  if (myTeamCode.value || !codesOn.value) return false
  const slug = activeTeamSlug.value
  const team = teams.value.find((t) => t.team_slug === slug) || myCurrentTeam.value
  return team?.needs_code === true
})

async function openCodeField(team) {
  codeFor.value = team.team_slug
  codeInput.value = ''
  await nextTick()
  document.getElementById(`join-code-${team.team_slug}`)?.focus()
}

function closeCodeField() {
  codeFor.value = ''
  codeInput.value = ''
}

async function joinWithCode(team) {
  if (!codeWellFormed.value || accepting.value) return
  selectedTeam.value = team
  targetTeamName.value = team.team_name
  const code = normalizeJoinCode(codeInput.value)
  await executeTeamAcceptance(team.team_slug, team.team_name, isSwitching.value ? 'switch' : 'join', code)
}

// The slug of the team this student last asked to join from THIS page. Set only
// once the broker accepted the request, so a failed submit changes nothing.
const targetTeamSlug = ref('')

/**
 * The team every repository lookup on this page is about: the one just joined,
 * else the one the teams list shows them in. One judge, so the invitation link,
 * "Check again" and the poll cannot point at different repositories.
 */
const activeTeamSlug = computed(() => targetTeamSlug.value || myCurrentTeam.value?.team_slug || '')

/** The repository name a team slug produces for this assignment. */
function teamRepoName(slug) {
  const pattern = props.assignment.repository_name_pattern || `${props.assignment.id}-{team_slug}`
  return pattern.replace('{team_slug}', slug).replace('{github_login}', props.user.login)
}

// A GUESS at the invitation page, and it 404s until the repository exists.
// Offered whenever no invitation has been PROVEN, because this page cannot see
// the student's pending invitations - see lib/invitation-evidence.js for the
// measurement, and AssignmentView for the same reasoning at length.
//
// THE TEAM JUST JOINED WINS. This read `myCurrentTeam` first, which after a
// switch is still the OLD team (the teams list lags the hub), so the link sent
// the student to the repository they had just been removed from, and it 404'd.
const invitationUrl = computed(() => {
  const slug = activeTeamSlug.value
  if (!slug) return null
  return `https://github.com/${props.org}/${teamRepoName(slug)}/invitations`
})

const invitationProven = ref(false)
const showInvitationGuess = computed(() =>
  mayOfferInvitationLink(invitationProven.value, invitationUrl.value),
)

// The broker issue this team registration was filed on. The hub answers there -
// it is the only surface a student can read - and this page cannot see its own
// pending invitation any other way.
const acceptanceIssue = ref(null)
// When that issue was opened. Only a RECENT refusal is shown on arrival, as on
// the individual page: an old one would greet a student who has since been
// sorted out with a refusal they no longer have.
const acceptanceIssueCreatedAt = ref(null)
// One spelling, shared with AssignmentView's in-flight check, which had the
// same 15 minutes written out as a bare expression.
const RECENT_ATTEMPT_MS = SHARED_RECENT_ATTEMPT_MS

function showRejected() {
  rejectedAt.value = new Date()
  acceptState.value = 'rejected'
  // A refused attempt's code is not this team's - or, for a team being made,
  // the team was never made with it. Not shown again as if it were.
  const sent = lastJoin.value
  if (sent?.code) {
    forgetJoinCode(codeKey(sent.slug), sent.code)
    codeMemory.value++
  } else if (ownAttempt.value?.team_action === 'create' && ownAttempt.value.team_slug) {
    // Refused while this page was closed: only the issue says what it was. A
    // CREATE stored the code it made, and that team was never made with it.
    // (A join stores nothing until it is admitted, so there is nothing to undo.)
    forgetAnyJoinCode(codeKey(ownAttempt.value.team_slug))
    codeMemory.value++
  }
}

/**
 * A typed code becomes the one this browser keeps only once the hub let the
 * student in with it; before that it is what they typed, possibly a typo of
 * another team's real code (review, 2026-10-06).
 */
function rememberAdmittedCode() {
  const sent = lastJoin.value
  if (!sent?.code || sent.made || sent.slug !== activeTeamSlug.value) return
  rememberJoinCode(codeKey(sent.slug), sent.code)
  codeMemory.value++
}
watch(acceptState, (state) => {
  if (state === 'provisioned' || state === 'invited') rememberAdmittedCode()
})

/**
 * Once a join lands, the page's team IS the one joined, whatever the lagging
 * teams list says - otherwise the "ready" banner names the team they left.
 */
function adoptTargetTeam() {
  const slug = targetTeamSlug.value
  if (!slug) return
  const listed = teams.value.find((t) => t.team_slug === slug)
  myCurrentTeam.value = listed || {
    team_slug: slug,
    team_name: targetTeamName.value || slug,
    members: [props.user.login],
  }
}

/**
 * Back to the team list after a refusal, re-read so it reflects what the hub
 * wrote - and still saying that it was refused (`refusedEarlier`).
 */
async function backToTeams() {
  refusedEarlier.value = acceptState.value === 'rejected' || refusedEarlier.value
  acceptState.value = 'ready'
  await loadTeams()
}

// Set by Back from a refusal, cleared when the next attempt is sent.
const refusedEarlier = ref(false)
// What the refused attempt was doing (`lastJoin`, below), so the heading names
// it: a team that was never created is not one the student "was not able to
// join".
const refusedHeading = computed(() => lastJoin.value?.action === 'create'
  ? 'Your team was not created'
  : `You were not able to join ${targetTeamName.value || 'this team'}`)

/** What the hub said, if anything. Null when it has not answered or we cannot read. */
async function readTeamAcceptanceOutcome() {
  if (!acceptanceIssue.value) return null
  const brokerRepo = brokerRepoName({ assignment: props.assignment, assignmentId: props.assignment?.id })
  try {
    // The issue's LABELS - see AssignmentView for why not comments.
    const res = await ghApi(
      getToken(), 'GET',
      `/repos/${props.org}/${brokerRepo}/issues/${acceptanceIssue.value}`,
    )
    // The TITLE too, from the same read: how far the broker got.
    attemptTitle.value = res.ok && typeof res.data?.title === 'string' ? res.data.title : null
    if (!res.ok) return null
    return outcomeFromLabels(res.data?.labels)
  } catch {
    attemptTitle.value = null
    return null
  }
}

// WHICH STEP THE JOIN IS AT - the same reading as the individual page, through
// the same module (frontend/src/lib/acceptance-progress.js). On 2026-10-02 two
// students watched this card spin four times each while their joins sat
// cancelled behind a stuck run, and could not tell it from a slow one.
const attemptTitle = ref(null)
const progress = ref({ step: 'unknown', final: false, canRetry: false })
const progressStepList = computed(() => progressSteps(progress.value.step))
const progressText = computed(() => progressMessage(progress.value.step))
// What the last join asked for, so "send it again" sends the same thing.
const lastJoin = ref(null)
// The student's own newest attempt as the broker holds it (loadTeams).
const ownAttempt = ref(null)
// The published team list could not be read, so the list is partial.
const teamsListPartial = ref(false)

async function readAttemptProgress() {
  const sentAt = Date.parse(acceptanceIssueCreatedAt.value || '')
  if (!acceptanceIssue.value || !Number.isFinite(sentAt)) return progress.value
  const broker = brokerRepoName({ assignment: props.assignment, assignmentId: props.assignment?.id })
  let run = null
  let runsRead = false
  try {
    const res = await ghApi(getToken(), 'GET', hubRunsPath({ owner: config.hubOwner, repo: config.hubRepo, sentAt }))
    if (res.ok) ({ run, runsRead } = attemptRunFromPage(res.data, { org: props.org, broker, issue: acceptanceIssue.value }))
  } catch {
    // Unread: says nothing.
  }
  progress.value = attemptProgress({ title: attemptTitle.value, run, runsRead, sentAt })
  return progress.value
}

/** Send the same join again: a new attempt. An older one that runs later does nothing. */
async function sendAgain() {
  if (pollTimer) clearTimeout(pollTimer)
  progress.value = { step: 'unknown', final: false, canRetry: false }
  const join = lastJoin.value || {
    slug: targetTeamSlug.value,
    name: targetTeamName.value || targetTeamSlug.value,
    action: 'join',
  }
  if (!join.slug) {
    acceptState.value = 'ready'
    return
  }
  await executeTeamAcceptance(join.slug, join.name, join.action, join.code || '', { made: join.made === true })
}

onMounted(async () => {
  claimToken.value = getToken() || ""
  await loadTeams()
  await checkExistingState()
})

onUnmounted(() => {
  pollGeneration++
  if (pollTimer) clearTimeout(pollTimer)
})

async function loadTeams() {
  loadingTeams.value = true
  const token = getToken()
  const brokerRepo = brokerRepoName({ assignment: props.assignment })
  // The assignment's maximum as it is NOW, for every team, whatever a teams
  // file says. A team's stored `max_members` is a snapshot from when it was
  // created, so taking it from the file kept every existing team "Full" after
  // the lecturer raised the size - the same number accept.mjs now admits on.
  const maxTeamCap = maxTeamSize.value
  const teamsMap = new Map() // slug -> teamObject
  // Who the published file places, and when it was made (attemptYields).
  const publishedPlaced = new Set()
  let publishedAt = NaN

  // Helper to upsert team
  // `needsCode` is what the published file says; a team known only from the
  // broker's issues is one a student is making right now, and has a code
  // exactly when the assignment gives new teams one.
  function upsertTeam(slug, name, members = [], seededFrom = null, needsCode = codesOn.value) {
    if (!slug) return
    const cleanSlug = slug.toLowerCase().trim()
    const existing = teamsMap.get(cleanSlug) || {
      team_slug: cleanSlug,
      team_name: name || cleanSlug,
      members: [],
      max_members: maxTeamCap,
      needs_code: needsCode,
    }
    if (name && name !== cleanSlug) existing.team_name = name
    if (seededFrom && !existing.seeded_from) existing.seeded_from = seededFrom
    for (const m of members) {
      if (m && !existing.members.some(em => em.toLowerCase() === m.toLowerCase())) {
        existing.members.push(m)
      }
    }
    existing.member_count = existing.members.length
    existing.is_full = existing.members.length >= existing.max_members
    teamsMap.set(cleanSlug, existing)
  }

  // 1. Try fetching from Pages CDN static data
  let fileRead = false
  try {
    const url = `${await inviteTeamsUrl(props.org, props.inviteToken)}?_t=${Date.now()}`
    const res = await fetch(url)
    if (res.ok) {
      fileRead = true
      const data = await res.json()
      for (const t of (data.teams || [])) {
        upsertTeam(t.team_slug, t.team_name, t.members || [], t.seeded_from, t.needs_code === true)
        for (const m of t.members || []) publishedPlaced.add(String(m).toLowerCase())
      }
      publishedAt = Date.parse(data.generated_at || '')
      takenTeams.value = (data.taken || [])
        .map((t) => ({ team_slug: String(t?.team_slug || '').toLowerCase(), team_name: t?.team_name || t?.team_slug }))
        .filter((t) => t.team_slug)
    }
  } catch (e) {
    fileRead = false
    console.warn('Could not load static teams file:', e.message)
  }
  // Said, not left to a guess (DESIGN.md §1.5): without the published file the
  // list is only the last minutes' requests, and whether a team there needs a
  // code is assumed from the setting.
  teamsListPartial.value = !fileRead

  // There used to be a second source here: `public/teams/<id>.json` in the
  // control repo. It was removed on 2026-09-22 because it could not answer.
  // pages/generate.mjs DELETES that directory on every run - "Removed legacy
  // public/teams - teams now live behind the invitation digest" - so the read
  // 404'd on every page load for every student, and the catch swallowed it. A
  // source that can never return anything is not a fallback; it is a request.

  // 2. Reconcile with live issues on public broker repository (Real-time live fallback)
  try {
    // ONE PAGE IS NOT THE LIST. This read `per_page=100` and stopped, so on a
    // cohort past a hundred acceptances - and one acceptance is one issue, so
    // a 200-student group assignment is 200 issues - every team formed after
    // the hundredth was invisible here. A student would then see a team as
    // having room, or not existing at all, and create a duplicate.
    //
    // Bounded rather than unbounded: this is a fallback behind the Pages teams
    // file and the control repo, and a student's own rate limit pays for it.
    // Five pages covers any cohort this system is designed for, and a short
    // page ends the walk early in the ordinary case - most brokers never reach
    // the second request.
    const MAX_PAGES = 5
    const issues = []
    let complete = true
    for (let page = 1; page <= MAX_PAGES; page++) {
      const path = `/repos/${props.org}/${brokerRepo}/issues?state=all&per_page=100&page=${page}`
      const res = token
        ? await ghApi(token, 'GET', path)
        : await fetch(`https://api.github.com${path}`).then(r => r.json().then(data => ({ ok: r.ok, data })))
      if (!res.ok || !Array.isArray(res.data)) { complete = false; break }
      issues.push(...res.data)
      if (res.data.length < 100) break
      if (page === MAX_PAGES) complete = false
    }
    if (!complete) {
      // Said out loud rather than swallowed: the team list below is built from
      // what was read, and a truncated read is not evidence a team is absent.
      console.warn('[teams] broker issue list was truncated; the live team reconciliation may be incomplete')
    }

    // The student's OWN acceptance issue, taken from a list we already have in
    // hand. It is skipped by the loop below - its title is `pxl-accept:`, not
    // `team:` - but it is the address the hub answers on, and without it a
    // student who closed the tab and came back can read neither the rejection
    // reason nor the invitation notice. Newest first, so the first match is the
    // current attempt.
    // Matched on the AUTHOR, among titles that are an acceptance attempt in
    // any form the broker leaves (never the `pxl-accept:` prefix alone, which
    // is rewritten in seconds) - frontend/src/lib/broker-teams.js carries why,
    // and is where a test can reach it.
    const mine = ownAcceptanceIssue(issues, props.user?.login)
    if (mine) {
      acceptanceIssue.value = mine.number
      acceptanceIssueCreatedAt.value = mine.created_at || null
      // What it asked for, read the way the hub reads it - for a refusal seen
      // after a reload, when this page no longer remembers what it sent.
      ownAttempt.value = parseTeamPayload({ body: mine.body, title: mine.title })
    }

    {
      // Read from the issue BODY, which the broker never redacts, not the
      // title, which it rewrites seconds after dispatching. That title match is
      // why this fallback reconciled zero teams for months and why four people
      // each created their own team inside 90 seconds on 2026-09-22 -
      // frontend/src/lib/broker-teams.js carries the whole story, and holds the
      // logic somewhere a test can call it.
      for (const row of teamsFromBrokerIssues(issues)) {
        // A published placement made after this attempt wins - a lecturer's
        // Move among them (attemptYields).
        const placed = row.members.some((m) => publishedPlaced.has(String(m).toLowerCase()))
        if (attemptYields(row, { generatedAt: publishedAt, placed })) continue
        // Their newest attempt is where they are going: out of every other
        // team, the published one included, which trails it.
        for (const [slug, team] of teamsMap) {
          if (slug === row.team_slug.toLowerCase().trim()) continue
          const left = team.members.filter((m) => !row.members.some((x) => x.toLowerCase() === m.toLowerCase()))
          if (left.length === team.members.length) continue
          team.members = left
          team.member_count = left.length
          team.is_full = left.length >= team.max_members
        }
        upsertTeam(row.team_slug, row.team_name, row.members)
      }
    }
  } catch (e) {
    console.warn('Could not query broker issues for live teams:', e.message)
  }

  // Final teams array
  teams.value = Array.from(teamsMap.values())

  // Check if user is already in a team
  const found = teams.value.find((t) =>
    (t.members || []).some((m) => m.toLowerCase() === props.user.login.toLowerCase())
  )
  if (found) {
    myCurrentTeam.value = found
  }

  loadingTeams.value = false
}

const teamLatestCommit = ref(null)
const teamOverride = ref(null)

const effectiveDeadline = computed(() => {
  if (teamOverride.value?.value) {
    return new Date(teamOverride.value.value)
  }
  return props.assignment?.deadline_at ? new Date(props.assignment.deadline_at) : null
})

const isPastDeadline = computed(() => {
  if (!effectiveDeadline.value) return false
  return new Date() > effectiveDeadline.value
})

const deadlineCountdown = computed(() => formatDeadlineCountdown(effectiveDeadline.value))

// Whether a switch would be allowed: the hub's own rule (acceptance/accept.mjs
// step 5) - self-service, which is what `canChooseAnother` says, and before the
// deadline on an assignment that is accepting.
const canSwitchTeam = computed(() =>
  canChooseAnother.value && !isPastDeadline.value && props.assignment?.state === 'published',
)
const switchUntil = computed(() =>
  effectiveDeadline.value ? formatDate(effectiveDeadline.value.toISOString(), props.assignment?.timezone) : 'the deadline',
)

const teamSubmissionStatus = computed(() => {
  if (!teamLatestCommit.value) return 'no-submission'
  if (!effectiveDeadline.value) return 'on-time'
  const commitTime = new Date(teamLatestCommit.value.date)
  return commitTime <= effectiveDeadline.value ? 'on-time' : 'late'
})

async function refreshTeamSubmissionMeta(org, repoName) {
  const token = getToken()
  if (!token) return
  try {
    const res = await ghApi(token, 'GET', `/repos/${org}/${repoName}/commits?per_page=1`)
    if (res.ok && Array.isArray(res.data) && res.data.length > 0) {
      const c = res.data[0]
      teamLatestCommit.value = {
        sha: c.sha,
        date: c.commit?.author?.date || c.commit?.committer?.date,
        message: c.commit?.message,
      }
    }
  } catch (e) {
    console.error('Failed to fetch team latest commit:', e)
  }

  // Load student or team override if exists. Same rule as the backend
  // (lib/effective-deadline.mjs): the last grant in the append-only history
  // wins, and an extension only ever extends.
  try {
    const overrideFile = await getRepoContent(token, props.org, config.controlRepo, overridePath(props.assignment.id, props.user.login))
    if (overrideFile) {
      const eff = effectiveDeadlineFor(props.assignment, props.user.login, {
        overrides: [JSON.parse(overrideFile)],
      })
      if (eff.extended) {
        teamOverride.value = { value: eff.deadline.toISOString(), reason: eff.reason }
      }
    }
  } catch {
    // optional override
  }
}

async function checkExistingState() {
  const token = getToken()
  if (!token) return

  // The team this page is ABOUT. After a switch that is the team just joined,
  // not the one the teams list still shows them in: that list is regenerated
  // after the hub writes, so it lags, and reading the old team here pointed
  // "Check again" and the invitation link at a repository the student had just
  // been removed from.
  const slug = activeTeamSlug.value
  if (slug) {
    const expectedName = teamRepoName(slug)

    const repo = await getRepo(token, props.org, expectedName)
    if (repo.ok) {
      repoUrl.value = repo.data.html_url
      repoFullName.value = repo.data.full_name
      acceptState.value = 'provisioned'
      adoptTargetTeam()
      await refreshTeamSubmissionMeta(props.org, expectedName)
      return
    }

    // A match is the only outcome that settles anything - see
    // lib/invitation-evidence.js.
    const invites = await getInvitations(token)
    const evidence = invitationEvidence(invites, { org: props.org, repo: expectedName })
    invitationProven.value = evidence.proven
    if (evidence.invitation) {
      const match = evidence.invitation
      pendingInvitation.value = match
      repoUrl.value = match.repository.html_url
      repoFullName.value = match.repository.full_name
      acceptState.value = 'invited'
      return
    }

    // The hub is the only party that can see the invitation - see
    // lib/invitation-evidence.js. No poll-count gate here: this runs once, on
    // mount, and the answer may already have been posted while the tab was
    // closed. That student is exactly the one with nothing else to go on.
    if (announcesInvitation(await readTeamAcceptanceOutcome())) {
      acceptState.value = 'invited'
      return
    }
  }

  // Refused in a tab they closed, or while this one was not looking. Only a
  // recent attempt: see RECENT_ATTEMPT_MS.
  const opened = Date.parse(acceptanceIssueCreatedAt.value || '')
  if (Number.isFinite(opened) && Date.now() - opened < RECENT_ATTEMPT_MS) {
    if (isRejection(await readTeamAcceptanceOutcome())) {
      showRejected()
      return
    }
  }
}

async function confirmJoinTeam(team) {
  // A team with a code asks for it first; one this student is already in
  // does not (the hub admits a member without one).
  if (team.needs_code && !isMyTeam(team)) {
    await openCodeField(team)
    return
  }
  selectedTeam.value = team
  targetTeamName.value = team.team_name
  await executeTeamAcceptance(team.team_slug, team.team_name, isSwitching.value ? 'switch' : 'join')
}

async function submitCreateTeam() {
  if (!computedSlug.value || slugConflict.value) return
  targetTeamName.value = newTeamName.value
  // Made here, so the creator can be shown it at once: nothing a student can
  // read holds it anywhere else (lib/team-join-code.mjs). A former member
  // going back to a team nobody is in sends the code it kept instead.
  const rejoin = takenRejoinCode.value
  const code = rejoin || (codesOn.value ? newJoinCode() : '')
  await executeTeamAcceptance(computedSlug.value, newTeamName.value, isSwitching.value ? 'switch' : 'create', code, { made: !rejoin })
}

/** `made`: the code was made here for a new team, not typed to join one. */
async function executeTeamAcceptance(teamSlug, teamName, teamAction, joinCode = '', { made = false } = {}) {
  accepting.value = true
  try {
    const token = getToken()
    const brokerRepo = brokerRepoName({ assignment: props.assignment })

    // The TITLE carries the signed invitation and the team slug, because that
    // is all the broker reads - it holds App credentials and must never parse
    // the body (ARCHITECTURE §4.3.1). The body carries the rest, and the HUB
    // fetches and validates it (scripts/read-team-payload.mjs).
    const title = await signedAcceptanceIssueTitle({
      inviteSecret: props.inviteToken,
      assignmentId: props.assignment.id,
      githubId: props.user?.id,
      teamSlug,
    })

    // One builder for both acceptance flows: the hub reads a single body with
    // two readers (team fields and claim fields), and two callers assembling
    // that JSON by hand is the shape that forked diffRosters.
    let claimField = null
    if (needsClaim.value) {
      const hubKey = hubClaimKey()
      if (!hubKey) {
        throw new Error(
          'Claiming is not set up for this course yet. Ask your lecturer to finish setting up the assignment.',
        )
      }
      if (!claim.value) {
        throw new Error(`Confirm your ${INSTITUTION} email address before joining a team.`)
      }
      claimField = {
        payload: await encryptClaim({
          publicKey: hubKey.publicKey,
          email: claim.value.email,
          githubId: props.user?.id,
          assignmentId: props.assignment.id,
        }),
        verified: claim.value.verified,
      }
    }

    let sealedCode = ''
    if (joinCode) {
      const hubKey = hubClaimKey()
      if (!hubKey) {
        throw new Error('Join codes are not set up for this course yet. Ask your lecturer to finish setting up the assignment.')
      }
      sealedCode = await encryptTeamCode({
        publicKey: hubKey.publicKey,
        code: joinCode,
        githubId: props.user?.id,
        assignmentId: props.assignment.id,
        teamSlug,
      })
    }

    const issueRes = await ghApi(token, 'POST', `/repos/${props.org}/${brokerRepo}/issues`, {
      title,
      body: buildAcceptanceBody({
        team: { team_slug: teamSlug, team_name: teamName, team_action: teamAction },
        claim: claimField,
        teamCode: sealedCode,
      }),
    })

    if (!issueRes.ok) {
      const msg = issueRes.data?.message || `HTTP ${issueRes.status}`
      if (issueRes.status === 404) {
        throw new Error(`Broker repository "${brokerRepo}" not found. Ask your lecturer to publish the assignment.`)
      }
      throw new Error(`Failed to submit team registration (${msg}). Ensure the broker repository exists and issues are enabled.`)
    }

    // Which issue the hub will answer on. Without it the announcement below is
    // unreadable and a group student gets nothing an individual student gets.
    acceptanceIssue.value = issueRes.data?.number ?? null
    acceptanceIssueCreatedAt.value = issueRes.data?.created_at ?? new Date().toISOString()
    targetTeamSlug.value = teamSlug
    lastJoin.value = { slug: teamSlug, name: teamName, action: teamAction, code: joinCode, made }
    // A code made here is the team's from the moment it is sent - the creator
    // needs it on screen while they wait. A TYPED one is only a guess at the
    // team's until the hub admits it (rememberAdmittedCode).
    if (joinCode && made) {
      rememberJoinCode(codeKey(teamSlug), joinCode)
      codeMemory.value++
    }
    closeCodeField()
    // A new attempt is on its way; the old refusal is no longer the news.
    refusedEarlier.value = false

    acceptState.value = 'pending'
    startPolling(teamSlug)
  } catch (e) {
    toast.error(`Could not join team: ${e.message}`)
  } finally {
    accepting.value = false
  }
}

function startPolling(teamSlug) {
  pollCount.value = 0
  waitedMs.value = 0
  pollStartedAt = Date.now()
  const expectedName = teamRepoName(teamSlug)
  const generation = ++pollGeneration
  const stale = () => generation !== pollGeneration

  const tick = async () => {
    if (stale()) return
    pollCount.value++
    waitedMs.value = Date.now() - pollStartedAt
    const token = getToken()
    if (!token) return

    const repo = await getRepo(token, props.org, expectedName)
    if (stale()) return
    if (repo.ok) {
      repoUrl.value = repo.data.html_url
      repoFullName.value = repo.data.full_name
      acceptState.value = 'provisioned'
      await loadTeams()
      adoptTargetTeam()
      return
    }

    const invites = await getInvitations(token)
    if (stale()) return
    const evidence = invitationEvidence(invites, { org: props.org, repo: expectedName })
    invitationProven.value = evidence.proven
    if (evidence.invitation) {
      const match = evidence.invitation
      pendingInvitation.value = match
      repoUrl.value = match.repository.html_url
      repoFullName.value = match.repository.full_name
      acceptState.value = 'invited'
      return
    }

    // Ask the hub, which is the only party that can answer: the call above is
    // expected to come back empty even when an invitation is waiting. Not from
    // tick one - the marker cannot exist before the repository does.
    if (pollCount.value >= 2) {
      const said = await readTeamAcceptanceOutcome()
      if (stale()) return
      if (isRejection(said)) {
        showRejected()
        return
      }
      if (announcesInvitation(said)) {
        acceptState.value = 'invited'
        return
      }
      // No repository, no invitation, no answer: how far did it get? A final
      // step ends the wait with "send it again".
      const at = await readAttemptProgress()
      if (stale()) return
      if (at.final) {
        acceptState.value = 'not-processed'
        return
      }
    }

    if (pollCount.value > 20) {
      pollInterval.value = 10000
    }
    // Not a timeout while GitHub says the join is still coming - bounded, so a
    // run GitHub never starts still ends somewhere. See AssignmentView.
    const stillComing = ['starting', 'not-started', 'queued', 'running', 'finishing'].includes(progress.value.step)
    const sentAt = Date.parse(acceptanceIssueCreatedAt.value || '') || pollStartedAt
    if (pollCount.value > 30 && !(stillComing && Date.now() - sentAt < GIVE_UP_MS)) {
      acceptState.value = 'timeout'
      return
    }

    if (acceptState.value === 'pending' && !stale()) {
      pollTimer = setTimeout(tick, pollInterval.value)
    }
  }

  // Immediately, not at +3s - see AssignmentView.
  tick()
}

async function handleAcceptInvitation() {
  if (!pendingInvitation.value) return
  const token = getToken()
  const result = await acceptInvitation(token, pendingInvitation.value.id)
  if (result.ok) {
    acceptState.value = 'provisioned'
    await loadTeams()
    adoptTargetTeam()
  } else {
    toast.error(`Could not accept invitation (HTTP ${result.status}). Check github.com/notifications.`)
  }
}

function startSwitchTeam() {
  isSwitching.value = true
  showAlternatives.value = true
  acceptState.value = 'ready'
}

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
</script>

<style scoped>
.alt-group-action {
  margin-top: var(--space-sm);
}

.back-to-group {
  margin-bottom: var(--space-sm);
}

.group-acceptance-card {
  padding: var(--space-xl);
  display: flex;
  flex-direction: column;
  gap: var(--space-md);
}

.flow-header h2 {
  font-size: 1.35rem;
  margin-bottom: var(--space-xs);
}

.tab-pill-selector {
  display: flex;
  gap: var(--space-sm);
  margin-bottom: var(--space-md);
  border-bottom: 1px solid var(--border-default);
  padding-bottom: var(--space-sm);
}

.tab-pill {
  background: none;
  border: 1px solid transparent;
  padding: 6px 14px;
  border-radius: 20px;
  color: var(--text-secondary);
  font-size: 0.875rem;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s ease;
}

.tab-pill:hover {
  background: var(--bg-surface-hover);
  color: var(--text-primary);
}

.tab-pill.active {
  background: var(--bg-surface-hover);
  border-color: var(--border-muted);
  color: var(--accent-blue);
}

.search-box {
  margin-bottom: var(--space-md);
}

.input-search {
  width: 100%;
  padding: 8px 12px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  color: var(--text-primary);
}

.teams-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
  max-height: 380px;
  overflow-y: auto;
}

.team-item-card {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: var(--space-md);
  background: var(--bg-secondary);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  transition: border-color 0.15s ease;
}

.team-item-card:hover:not(.is-full) {
  border-color: var(--accent-blue);
}

.team-item-card.is-full {
  opacity: 0.65;
}

.team-header-line {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  margin-bottom: 4px;
  flex-wrap: wrap;
}

.team-slug-badge code {
  font-size: 0.75rem;
  background: var(--bg-tertiary);
  padding: 2px 6px;
  border-radius: 4px;
}

.team-members-list {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.teams-partial {
  margin: 0 0 var(--space-sm);
}

.team-needs-code {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 6px;
}

.team-info {
  flex: 1;
  min-width: 0;
}

.join-code-form {
  margin-top: var(--space-sm);
}

.join-code-row {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  margin-top: 4px;
}

.join-code-input {
  max-width: 12ch;
  font-family: var(--font-mono);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.member-tag {
  font-size: 0.75rem;
  color: var(--text-secondary);
  background: var(--bg-primary);
  padding: 1px 6px;
  border-radius: 4px;
  border: 1px solid var(--border-default);
}

.team-badge-banner {
  background: var(--bg-secondary);
  border: 1px solid var(--border-default);
  padding: 8px 12px;
  border-radius: 6px;
  margin-bottom: var(--space-md);
  text-align: center;
}

.member-chips {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 4px;
}

.member-chip {
  font-size: 0.8rem;
  background: var(--bg-secondary);
  border: 1px solid var(--border-default);
  padding: 2px 8px;
  border-radius: 12px;
}

.member-chip.is-me {
  border-color: var(--accent-blue);
  color: var(--accent-blue);
}

.create-team-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-md);
  padding: var(--space-md) 0;
}

.input-text {
  width: 100%;
  padding: 10px 12px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  color: var(--text-primary);
  font-size: 1rem;
}


.alert-warn {
  background: var(--tint-attention-muted);
  border: 1px solid var(--tint-attention-emphasis);
  color: var(--accent-yellow);
  padding: 8px 12px;
  border-radius: 6px;
  font-size: 0.85rem;
}

/* ------------------------------------------------------------------------
   Vocabulary that was carried INLINE.

   Each class below was written in the markup beside a `style="…"` that said
   what it meant, so the class itself was declared nowhere and the look lived on
   the element. Moving the declarations here changes nothing on screen - the
   values are unchanged - but it takes them off the undeclared-class register
   and puts the appearance where DESIGN.md says it belongs.
   ------------------------------------------------------------------------ */

.team-switch-line {
  margin: var(--space-xs) 0 var(--space-md);
}
</style>
