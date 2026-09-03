<template>
  <div v-if="show" class="modal-overlay" @click.self="$emit('close')">
    <div class="modal card student-diagnostics-modal" role="dialog" aria-modal="true" aria-label="Student Access Diagnostics">
      <header class="modal-head flex justify-between items-center">
        <div class="flex items-center gap-sm">
          <Icon name="help-circle" :size="20" class="text-primary" />
          <h3 style="margin: 0;">Access &amp; Account Diagnostics</h3>
        </div>
        <button class="modal-close" type="button" @click="$emit('close')" aria-label="Close">×</button>
      </header>

      <div class="modal-body flex flex-col gap-md" style="padding: var(--space-md);">
        <!-- Summary Alert -->
        <div
          v-if="diagnosticsSummary.hasIssue"
          class="diag-banner flex items-center gap-sm p-sm"
          style="background: var(--tint-danger-subtle); border-left: 4px solid var(--accent-red); border-radius: 4px;"
        >
          <Icon name="alert-circle" :size="20" class="stat-red" />
          <div class="text-sm">
            <strong>{{ diagnosticsSummary.mainTitle }}</strong>
            <div class="text-xs text-secondary">{{ diagnosticsSummary.mainAction }}</div>
          </div>
        </div>
        <div
          v-else
          class="diag-banner flex items-center gap-sm p-sm"
          style="background: var(--tint-success-subtle); border-left: 4px solid var(--accent-green); border-radius: 4px;"
        >
          <Icon name="check-circle" :size="20" class="stat-green" />
          <div class="text-sm">
            <!-- NOT "all checks look healthy". One of them cannot be run at
                 all, and saying otherwise told a student everything was fine
                 while a pending invitation was the exact thing blocking them
                 - see lib/invitation-evidence.js. -->
            <strong>No blocking problem found in what this page can check</strong>
            <div class="text-xs text-secondary">
              One check below cannot be run from the browser, so a pending repository invitation
              cannot be ruled out.
            </div>
          </div>
        </div>

        <!-- Checks List -->
        <div class="checks-list flex flex-col gap-sm">
          <h4 class="text-xs text-secondary uppercase font-semibold" style="margin: 0;">Diagnostic Health Checks</h4>

          <!-- Check 1: Auth & Account Domain -->
          <div class="check-item flex items-start gap-sm">
            <Icon
              :name="isPersonalEmail ? 'alert-triangle' : 'check-circle'"
              :size="16"
              :class="isPersonalEmail ? 'stat-yellow' : 'stat-green'"
              style="margin-top: 2px;"
            />
            <div>
              <div class="text-sm font-semibold">
                GitHub Identity: <code>@{{ activeUser?.login }}</code>
              </div>
              <div v-if="isPersonalEmail" class="text-xs text-warning">
                <!-- The example domain came from this deployment's own
                     `claim_domains`, not from a literal: a fork showing a
                     student "@student.pxl.be" is telling them to use somebody
                     else's institution. -->
                ⚠️ Account email appears to be personal (<code>{{ userEmail || 'personal domain' }}</code>). If your course requires an official {{ INSTITUTION }} GitHub account (e.g. <code>@{{ exampleDomain }}</code>), switch accounts below.
              </div>
              <div v-else class="text-xs text-muted">
                Authenticated session active.
              </div>
            </div>
          </div>

          <!-- Check 2: Roster Status. Only `enforced` looks the student's LOGIN
               up in the roster. Under `claim` the key is the ADDRESS, so a
               student listed by email would be told they are missing; under
               `open` nobody is blocked by the roster at all. -->
          <div v-if="rosterMatchesLogin(assignment?.roster_mode)" class="check-item flex items-start gap-sm">
            <Icon
              :name="rosterStatus === 'enrolled' ? 'check-circle' : rosterStatus === 'missing' ? 'x-circle' : 'clock'"
              :size="16"
              :class="rosterStatus === 'enrolled' ? 'stat-green' : rosterStatus === 'missing' ? 'stat-red' : 'stat-blue'"
              style="margin-top: 2px;"
            />
            <div>
              <div class="text-sm font-semibold">
                Roster Enrollment:
                <span :class="rosterStatus === 'enrolled' ? 'text-success' : 'text-danger'">
                  {{ rosterStatus === 'enrolled' ? 'Verified Enrolled' : rosterStatus === 'missing' ? 'Not Found on Roster' : 'Checking…' }}
                </span>
              </div>
              <div v-if="rosterStatus === 'missing'" class="text-xs text-danger">
                Your GitHub handle (<code>@{{ activeUser?.login }}</code>) is not on the course roster. Contact your lecturer to be added to the cohort list.
              </div>
              <div v-else-if="rosterStatus === 'enrolled'" class="text-xs text-muted">
                Your account is confirmed on the class roster.
              </div>
            </div>
          </div>

          <!-- Check 3: Assignment Lifecycle -->
          <div class="check-item flex items-start gap-sm">
            <Icon
              :name="lifecycleHealthy ? 'check-circle' : 'x-circle'"
              :size="16"
              :class="lifecycleHealthy ? 'stat-green' : 'stat-red'"
              style="margin-top: 2px;"
            />
            <div>
              <div class="text-sm font-semibold">
                Assignment Lifecycle:
                <span>{{ assignment?.state || 'unknown' }}</span>
              </div>
              <div v-if="assignment?.state === 'draft'" class="text-xs text-warning">
                This assignment is currently in draft mode. Your lecturer hasn't published it yet.
              </div>
              <div v-else-if="assignment?.state === 'closed'" class="text-xs text-danger">
                New acceptances are closed for this assignment.
              </div>
              <div v-else-if="isPastDeadline" class="text-xs text-danger">
                The deadline for this assignment has passed ({{ assignment?.deadline_at }}).
              </div>
              <div v-else class="text-xs text-muted">
                Assignment is open and accepting student repositories.
              </div>
            </div>
          </div>

          <!-- Check 4: Registration Cap -->
          <div class="check-item flex items-start gap-sm">
            <Icon
              :name="isCapReached ? 'x-circle' : 'check-circle'"
              :size="16"
              :class="isCapReached ? 'stat-red' : 'stat-green'"
              style="margin-top: 2px;"
            />
            <div>
              <div class="text-sm font-semibold">
                Cohort Registration Limit:
                <span :class="isCapReached ? 'text-danger' : 'text-success'">
                  {{ isCapReached ? 'Cap Reached' : 'Slots Available' }}
                </span>
              </div>
              <div v-if="isCapReached" class="text-xs text-danger">
                All {{ assignment?.max_acceptances }} student seats are filled. Ask your lecturer to increase capacity.
              </div>
              <div v-else class="text-xs text-muted">
                {{ assignment?.accepted_count || 0 }} / {{ assignment?.max_acceptances || 'unlimited' }} seats taken.
              </div>
            </div>
          </div>

          <!-- Check 5: Pending Invitation Status.
               This check has TWO outcomes, not three: an invitation we are
               holding, or no answer. It used to report "Clear - No blocked
               invitations detected" for the second, which is a green tick on a
               question nobody asked GitHub successfully. Live, 3 Sep 2026, it
               showed exactly that beside a pending invitation the student
               needed to accept. -->
          <div class="check-item flex items-start gap-sm">
            <Icon
              :name="invitationPending ? 'alert-triangle' : 'help-circle'"
              :size="16"
              :class="invitationPending ? 'stat-yellow' : 'stat-blue'"
              style="margin-top: 2px;"
            />
            <div>
              <div class="text-sm font-semibold">
                Repository Collaboration Invitation:
                <span>{{ invitationPending ? 'Invitation Pending' : 'Cannot be checked from here' }}</span>
              </div>
              <div v-if="invitationPending" class="text-xs text-warning">
                GitHub has sent an invitation to your account. You must click "Accept Invitation" to access the repository.
              </div>
              <div v-else class="text-xs text-muted">
                This page cannot list your pending GitHub invitations, so it cannot rule one out.
                Check GitHub Notifications below, or the invitation link on the assignment page.
              </div>
            </div>
          </div>
        </div>

        <!-- Action Buttons -->
        <div class="modal-actions-box flex justify-between items-center flex-wrap gap-sm pt-sm">
          <div class="flex gap-xs">
            <button class="btn btn-sm btn-secondary" type="button" @click="copyReport">
              Copy Report
            </button>
            <a
              href="https://github.com/notifications"
              target="_blank"
              rel="noopener"
              class="btn btn-sm btn-secondary"
            >
              GitHub Notifications
            </a>
          </div>
          <button class="btn btn-sm btn-secondary" type="button" @click="handleSwitchAccount">
            Sign in with different account
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import Icon from './Icon.vue'
import { clearAuth, getUser } from '../lib/auth.js'
import { toast } from '../lib/toast.js'
import { copyText } from '../lib/clipboard.js'
import { rosterMatchesLogin } from '../../../lib/roster-mode.mjs'
import { CLAIM_DOMAINS, INSTITUTION } from '../lib/deployment.js'

// The first configured domain is the cohort's - deployment.yml says so - so it
// is the one to show a student as an example.
const exampleDomain = CLAIM_DOMAINS[0] || 'your-institution.example'

const props = defineProps({
  show: { type: Boolean, default: false },
  user: { type: Object, default: () => ({}) },
  assignment: { type: Object, default: () => ({}) },
  acceptState: { type: String, default: 'ready' },
  pendingInvitation: { type: Object, default: null },
  rosterStatus: { type: String, default: 'enrolled' }, // 'enrolled' | 'missing' | 'unknown'
})

const emit = defineEmits(['close', 'switch-account'])

const activeUser = computed(() => {
  if (props.user && Object.keys(props.user).length > 0) return props.user
  return getUser() || {}
})

const userEmail = computed(() => activeUser.value?.email || '')

const isPersonalEmail = computed(() => {
  if (!userEmail.value) return false
  const email = userEmail.value.toLowerCase()
  return (
    email.endsWith('@gmail.com') ||
    email.endsWith('@outlook.com') ||
    email.endsWith('@hotmail.com') ||
    email.endsWith('@yahoo.com') ||
    email.endsWith('@icloud.com')
  )
})

// The only invitation state this page can assert. Named once because the
// template and the summary both used to spell the condition out, and the
// template's negative branch then claimed the opposite - "Clear".
const invitationPending = computed(
  () => Boolean(props.pendingInvitation) || props.acceptState === 'invited',
)

const isPastDeadline = computed(() => {
  if (!props.assignment?.deadline_at) return false
  return new Date() > new Date(props.assignment.deadline_at)
})

const lifecycleHealthy = computed(() => {
  if (!props.assignment) return true
  if (props.assignment.state === 'draft' || props.assignment.state === 'closed') return false
  if (props.assignment.opens_at && new Date() < new Date(props.assignment.opens_at)) return false
  return !isPastDeadline.value
})

const isCapReached = computed(() => {
  if (!props.assignment?.max_acceptances) return false
  return (props.assignment.accepted_count || 0) >= props.assignment.max_acceptances
})

const diagnosticsSummary = computed(() => {
  if (isPersonalEmail.value) {
    return {
      hasIssue: true,
      mainTitle: 'Personal GitHub Account Detected',
      mainAction: `Your active GitHub account is registered with a personal email. Sign into your ${INSTITUTION} GitHub account.`,
    }
  }
  if (props.rosterStatus === 'missing') {
    return {
      hasIssue: true,
      mainTitle: 'Not Found on Course Roster',
      // Deliberately does NOT name the control-repo file. This is the STUDENT's
      // screen and they cannot see that repository, let alone edit it - naming
      // it is the shape DESIGN.md §1.6 rules out, telling a reader to act on
      // something that is not theirs to act on. What they can do is the second
      // sentence, which is now the whole message.
      mainAction: 'Your GitHub account is not on this course\'s roster yet. Contact your lecturer with your student number.',
    }
  }
  if (props.assignment?.state === 'draft') {
    return {
      hasIssue: true,
      mainTitle: 'Assignment in Draft Mode',
      mainAction: 'The assignment is drafted but not yet published by the instructor.',
    }
  }
  if (isCapReached.value) {
    return {
      hasIssue: true,
      mainTitle: 'Registration Cap Exhausted',
      mainAction: 'The maximum student capacity has been reached.',
    }
  }
  if (invitationPending.value) {
    return {
      hasIssue: true,
      mainTitle: 'Collaboration Invitation Awaiting Acceptance',
      mainAction: 'Check your GitHub notifications to accept the repository invitation.',
    }
  }
  // Not "System Healthy". Nothing this page can check is failing, which is a
  // narrower claim and the only one it is entitled to.
  return {
    hasIssue: false,
    mainTitle: 'No blocking problem found',
    mainAction: '',
  }
})

function handleSwitchAccount() {
  clearAuth()
  emit('switch-account')
  toast.info(`Signed out. Please sign in with your ${INSTITUTION} GitHub account.`)
  window.location.reload()
}

async function copyReport() {
  const report = [
    `### Student Diagnostics Report`,
    `- **User**: @${activeUser.value?.login || 'unknown'} (${userEmail.value || 'no email provided'})`,
    `- **Assignment**: ${props.assignment?.id} (State: ${props.assignment?.state})`,
    `- **Roster Status**: ${props.rosterStatus}`,
    `- **Accept State**: ${props.acceptState}`,
    `- **Cap**: ${props.assignment?.accepted_count || 0}/${props.assignment?.max_acceptances || 'unlimited'}`,
    // The lecturer reads this paste. Without the line they would take the
    // report's silence for "no invitation", which is the misreading that cost
    // a student two and a half minutes and a wrong answer.
    `- **Pending invitation**: ${
      invitationPending.value
        ? 'yes - not yet accepted'
        : 'unknown (the browser cannot list this student\'s invitations)'
    }`,
    `- **Timestamp**: ${new Date().toISOString()}`,
  ].join('\n')

  // This said "copied to clipboard" in its .catch(), in its else branch, AND in
  // its outer catch - success on every path including the ones that copied
  // nothing. A student following that toast pastes an empty clipboard into a
  // message to their lecturer. DESIGN.md §1.5.
  if (await copyText(report)) {
    toast.success('Diagnostic report copied to clipboard')
  } else {
    toast.error('Could not copy - your browser blocked it. Select the details above instead.')
  }
}
</script>

<style scoped>
.student-diagnostics-modal {
  max-width: 540px;
}
.check-item {
  padding: 8px 12px;
  background: var(--bg-primary);
  border: 1px solid var(--border-default);
  border-radius: 6px;
}

/* ------------------------------------------------------------------------
   Vocabulary that was carried INLINE.

   Each class below was written in the markup beside a `style="…"` that said
   what it meant, so the class itself was declared nowhere and the look lived on
   the element. Moving the declarations here changes nothing on screen - the
   values are unchanged - but it takes them off the undeclared-class register
   and puts the appearance where DESIGN.md says it belongs.
   ------------------------------------------------------------------------ */

.modal-actions-box {
  border-top: 1px solid var(--border-default);
}
</style>
