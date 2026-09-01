<template>
  <div class="device-flow-card">
    <p class="device-step">
      <strong>1.</strong> Copy this code and open GitHub:
    </p>

    <!-- Click-to-select, so a failed copy is still one gesture away from a
         manual one. It is the only place the code exists on screen. -->
    <div class="device-code">
      <code ref="codeEl" tabindex="0" @click="selectCode" @focus="selectCode">{{ flow.user_code }}</code>
    </div>

    <!-- TWO CONTROLS, NOT ONE, and that is the fix rather than a preference.
         This was a single "Copy code & open GitHub" button, and the two halves
         are mutually exclusive: window.open moves focus to the new tab, and a
         clipboard write on an unfocused document is REJECTED. The write lost
         that race every time, its rejection was swallowed, and the button said
         "Copied" over an empty clipboard - so students had no code to paste and
         could not sign in.

         Copy now awaits a real answer and nothing steals focus while it runs.
         GitHub is a plain <a>, which no popup blocker touches - the reason the
         open had to share the click in the first place. -->
    <div class="device-actions">
      <button class="btn btn-with-icon" type="button" @click="copyCode">
        <Icon :name="copied ? 'check' : 'copy'" :size="14" />
        <span>{{ copied ? 'Copied' : 'Copy code' }}</span>
      </button>

      <a class="btn btn-with-icon" :href="verificationUrl" target="_blank" rel="noopener noreferrer">
        <Icon name="external-link" :size="14" />
        <span>Open GitHub</span>
      </a>
    </div>

    <!-- Said in the page, not only in a toast: a toast is gone in seconds and
         this is the step the student is stuck on. -->
    <p v-if="copyFailed" class="copy-failed" role="alert">
      Your browser would not let the page copy for you. Select the code above and copy it
      with <kbd>Ctrl</kbd>+<kbd>C</kbd> (<kbd>⌘</kbd>+<kbd>C</kbd> on a Mac).
    </p>

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
import { copyText } from '../lib/clipboard.js'

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
const copyFailed = ref(false)
const codeEl = ref(null)

/** Select the whole code, so a manual copy is one keystroke. */
function selectCode() {
  const node = codeEl.value
  if (!node || typeof window === 'undefined') return
  const range = document.createRange()
  range.selectNodeContents(node)
  const sel = window.getSelection()
  sel?.removeAllRanges()
  sel?.addRange(range)
}

/**
 * Copy the code, and report what actually happened.
 *
 * `copyText` resolves to a real boolean and NOTHING moves focus while it runs -
 * the two properties the old combined button lacked. It set `ok = true` before
 * the write settled, swallowed the rejection, then called `window.open`, which
 * removed focus and made the write fail. The button said "Copied" over an empty
 * clipboard, and a student with no code to paste cannot sign in.
 */
async function copyCode() {
  const code = props.flow?.user_code
  if (!code) return

  const ok = await copyText(code)
  copied.value = ok
  copyFailed.value = !ok

  if (ok) {
    setTimeout(() => { copied.value = false }, 6000)
  } else {
    // Select it for them, so the manual path is Ctrl+C and nothing else.
    selectCode()
    toast.info('Could not copy automatically - the code above is selected, press Ctrl+C.')
  }
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
.device-actions {
  display: flex;
  gap: var(--space-sm);
  flex-wrap: wrap;
  justify-content: center;
}
/* Stated in the page rather than only in a toast: a toast is gone in seconds,
   and this is the step the student is stuck on. */
.copy-failed {
  color: var(--accent-yellow);
  font-size: 0.875rem;
  text-align: center;
  max-width: 420px;
  margin: 0;
}
.copy-failed kbd {
  font-family: var(--font-mono);
  background: var(--bg-inset);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-xs);
  padding: 1px 5px;
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
