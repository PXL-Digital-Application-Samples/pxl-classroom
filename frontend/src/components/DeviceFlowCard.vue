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

    <!-- ONE gesture does both, as it always has. Copying and opening as two
         clicks is easy to get half-right: open the page, then discover you
         never copied the code and have to come back for it.

         ORDER IS THE FIX, not splitting the button. The copy is AWAITED before
         window.open, so the write completes while the document still has focus
         - a clipboard write on an unfocused document is rejected, and opening
         first is what left the clipboard empty. Awaiting costs a millisecond or
         two, well inside the ~5s of transient user activation that keeps the
         open out of the popup blocker. -->
    <button class="btn btn-with-icon" type="button" @click="copyAndOpen">
      <Icon :name="copied ? 'check' : 'external-link'" :size="14" />
      <span>{{ copied ? 'Copied - GitHub opened' : 'Copy code & open GitHub' }}</span>
    </button>

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
 * Copy the code, then open GitHub. One gesture, and the order is the fix.
 *
 * The old version started the clipboard write, did NOT wait for it, set
 * `ok = true` regardless, swallowed the rejection into `() => {}`, and called
 * `window.open` - which removed focus, which is exactly what makes the write
 * reject ("Document is not focused"). The button reported "Copied" over an
 * empty clipboard, so a student had no code to paste and could not sign in.
 *
 * AWAITING it fixes both halves at once: the write finishes while the document
 * is still focused, and `ok` is then the truth rather than an assumption. The
 * open still happens on the same click - a resolved clipboard write takes a
 * millisecond or two, far inside the ~5 seconds of transient user activation a
 * browser allows, so the popup blocker is not involved.
 */
async function copyAndOpen() {
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

  // `noopener` in the FEATURES string makes window.open return null even when
  // it succeeded, so the old `if (!win)` warned about pop-ups on every single
  // click. Nulling `opener` on the returned window keeps the same security
  // property and leaves null meaning what it should: actually blocked.
  const win = window.open(verificationUrl.value, '_blank')
  if (win) win.opener = null
  else toast.info('Allow pop-ups, or open github.com/login/device yourself.')
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
