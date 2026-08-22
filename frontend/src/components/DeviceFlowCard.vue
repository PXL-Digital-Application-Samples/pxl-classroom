<template>
  <div class="device-flow-card">
    <p class="device-step">
      <strong>1.</strong> Copy this code and open GitHub:
    </p>

    <div class="device-code">
      <code>{{ flow.user_code }}</code>
    </div>

    <!-- One gesture does both. Copying and opening were two separate clicks,
         which is easy to get half-right: open the page, then discover you never
         copied the code and have to come back for it. Neutral styling on
         purpose - the view's primary button is "Sign in with GitHub"
         (DESIGN.md §1.2). -->
    <button class="btn btn-with-icon" type="button" @click="copyAndOpen">
      <Icon :name="copied ? 'check' : 'external-link'" :size="14" />
      <span>{{ copied ? 'Copied - GitHub opened' : 'Copy code & open GitHub' }}</span>
    </button>

    <p class="device-step">
      <strong>2.</strong> Paste the code on GitHub, then approve the request.
    </p>

    <p class="security-notice">
      <strong>Security Notice:</strong> The authorization page should ask you to authorize
      <strong>PXL Classroom Provisioner</strong>. If any other App name appears, do NOT enter the code.
    </p>

    <div class="waiting">
      <div class="spinner spinner-sm"></div>
      <span>Waiting for you to approve…</span>
    </div>

    <button class="btn" type="button" @click="emit('cancel')">Cancel</button>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue'
import Icon from './Icon.vue'
import { toast } from '../lib/toast.js'

const props = defineProps({
  // { verification_uri, user_code, … } from startDeviceFlow()
  flow: { type: Object, required: true },
})
const emit = defineEmits(['cancel'])

// RFC 8628 defines verification_uri_complete (the code pre-filled). GitHub does
// not document returning it, so this is opportunistic: use it when it is there,
// fall back to the plain URI when it is not. Costs nothing either way.
const verificationUrl = computed(
  () => props.flow?.verification_uri_complete || props.flow?.verification_uri
)

const copied = ref(false)

function copyAndOpen() {
  const code = props.flow?.user_code
  // Open first, inside the click gesture - a popup blocker will reject
  // window.open if the clipboard promise resolves first and breaks the chain.
  const win = window.open(verificationUrl.value, '_blank', 'noopener,noreferrer')
  if (!win) toast.info('Allow pop-ups, or open the GitHub link manually.')

  if (!code) return
  if (!navigator.clipboard) {
    // Insecure context or an old browser. The code is on screen and
    // user-select:all, so say so rather than failing silently.
    toast.info('Copy the code above manually, then paste it on GitHub.')
    return
  }
  navigator.clipboard.writeText(code).then(
    () => {
      copied.value = true
      setTimeout(() => { copied.value = false }, 4000)
    },
    () => toast.error('Could not copy the code - type it manually.')
  )
}
</script>

<style scoped>
.device-flow-card {
  margin-top: var(--space-lg);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-sm);
}
.device-step {
  color: var(--text-secondary);
  font-size: 0.9rem;
  margin: 0;
}
.device-code code {
  font-family: var(--font-mono);
  font-size: 1.75rem;
  font-weight: 700;
  letter-spacing: 0.12em;
  color: var(--accent-blue);
  background: var(--bg-inset);
  padding: var(--space-sm) var(--space-lg);
  border-radius: var(--radius-md);
  border: 1px solid var(--border-default);
  user-select: all;
}
.security-notice {
  color: var(--accent-yellow);
  font-size: 0.875rem;
  text-align: left;
  padding: var(--space-sm);
  border: 1px solid var(--accent-yellow);
  border-radius: var(--radius-xs);
  max-width: 420px;
}
.waiting {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  color: var(--text-secondary);
}
</style>
