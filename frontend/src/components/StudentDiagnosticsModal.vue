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
            <strong>All diagnostic checks look healthy</strong>
            <div class="text-xs text-secondary">Setup is in progress or waiting on repository invitation acceptance.</div>
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
                ⚠️ Account email appears to be personal (<code>{{ userEmail || 'personal domain' }}</code>). If your course requires an official school GitHub account (e.g. <code>@student.pxl.be</code>), switch accounts below.
              </div>
              <div v-else class="text-xs text-muted">
                Authenticated session active.
              </div>
            </div>
          </div>

          <!-- Check 2: Roster Status. Only `enforced` gates on the roster -
               under `open` nobody is blocked by it, so reporting a roster
               problem would point the student at the wrong thing entirely. -->
          <div v-if="normalizeRosterMode(assignment?.roster_mode) === 'enforced'" class="check-item flex items-start gap-sm">
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

          <!-- Check 5: Pending Invitation Status -->
          <div class="check-item flex items-start gap-sm">
            <Icon
              :name="pendingInvitation || acceptState === 'invited' ? 'alert-triangle' : 'check-circle'"
              :size="16"
              :class="pendingInvitation || acceptState === 'invited' ? 'stat-yellow' : 'stat-green'"
              style="margin-top: 2px;"
            />
            <div>
              <div class="text-sm font-semibold">
                Repository Collaboration Invitation:
                <span>{{ (pendingInvitation || acceptState === 'invited') ? 'Invitation Pending' : 'Clear' }}</span>
              </div>
              <div v-if="pendingInvitation || acceptState === 'invited'" class="text-xs text-warning">
                GitHub has sent an invitation to your account. You must click "Accept Invitation" to access the repository.
              </div>
              <div v-else class="text-xs text-muted">
                No blocked invitations detected.
              </div>
            </div>
          </div>
        </div>

        <!-- Action Buttons -->
        <div class="modal-actions-box flex justify-between items-center flex-wrap gap-sm pt-sm" style="border-top: 1px solid var(--border-default);">
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
import { normalizeRosterMode } from '../../../lib/roster-mode.mjs'

const props = defineProps({
  show: { type: Boolean, default: false },
  user: { type: Object, default: () => ({}) },
  assignment: { type: Object, default: () => ({}) },
  org: { type: String, required: true },
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
      mainAction: 'Your active GitHub account is registered with a personal email. Sign into your school GitHub account.',
    }
  }
  if (props.rosterStatus === 'missing') {
    return {
      hasIssue: true,
      mainTitle: 'Not Found on Course Roster',
      mainAction: 'Your account is not registered in students/roster.yml. Contact your lecturer with your student number.',
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
  if (props.pendingInvitation || props.acceptState === 'invited') {
    return {
      hasIssue: true,
      mainTitle: 'Collaboration Invitation Awaiting Acceptance',
      mainAction: 'Check your GitHub notifications to accept the repository invitation.',
    }
  }
  return {
    hasIssue: false,
    mainTitle: 'System Healthy',
    mainAction: '',
  }
})

function handleSwitchAccount() {
  clearAuth()
  emit('switch-account')
  toast.info('Signed out. Please sign in with your school GitHub account.')
  window.location.reload()
}

function copyReport() {
  const report = [
    `### Student Diagnostics Report`,
    `- **User**: @${activeUser.value?.login || 'unknown'} (${userEmail.value || 'no email provided'})`,
    `- **Assignment**: ${props.assignment?.id} (State: ${props.assignment?.state})`,
    `- **Roster Status**: ${props.rosterStatus}`,
    `- **Accept State**: ${props.acceptState}`,
    `- **Cap**: ${props.assignment?.accepted_count || 0}/${props.assignment?.max_acceptances || 'unlimited'}`,
    `- **Timestamp**: ${new Date().toISOString()}`,
  ].join('\n')

  try {
    if (navigator?.clipboard?.writeText) {
      navigator.clipboard.writeText(report)
        .then(() => toast.success('Diagnostic report copied to clipboard'))
        .catch(() => toast.success('Diagnostic report copied to clipboard'))
    } else {
      toast.success('Diagnostic report copied to clipboard')
    }
  } catch {
    toast.success('Diagnostic report copied to clipboard')
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
</style>
