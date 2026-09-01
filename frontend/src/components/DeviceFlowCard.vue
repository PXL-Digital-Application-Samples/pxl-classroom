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

         SYNCHRONOUS IS THE FIX, not splitting the button and not awaiting. The
         handler copies and opens without yielding, so both run inside the
         click's user activation. An `await` in between is what broke it:
         engines stop attributing a clipboard call - and a window.open - to the
         handler once one has intervened, and Firefox is stricter about it than
         Chrome.

         While this card is up the sign-in button is v-if'd out, so this is the
         view's only call to action: btn-primary btn-lg is DESIGN.md §3's
         "single decisive action", not an exception to it. -->
    <button class="btn btn-primary btn-lg btn-with-icon copy-open" type="button" @click="copyAndOpen">
      <Icon :name="copied ? 'check' : 'external-link'" :size="16" />
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
import { copyWithExecCommand, copyTextAsync } from '../lib/clipboard.js'

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
 * Copy the code, then open GitHub - both inside the click's user activation.
 *
 * THIS HANDLER DOES NOT AWAIT ON THE PATH THAT MATTERS, and that is the fix.
 *
 * Two earlier versions failed in opposite directions. The first opened GitHub
 * while the clipboard write was still in flight: window.open removes focus, a
 * write on an unfocused document is rejected, and the rejection was swallowed -
 * the button said "Copied" over an empty clipboard and the student had nothing
 * to paste. The second awaited the write before opening. That fixed the lie,
 * but put an `await` between the click and everything after it, and browsers
 * stop attributing clipboard calls to the handler once one has intervened
 * (MDN; Firefox bug 1605928, "writeText() does not work in asynchronous
 * environments"). So the execCommand fallback inside copyText could never run
 * in the one case it existed for, and Firefox's popup blocker got involved in
 * the open. It worked in Chrome, which is more forgiving, and not in Firefox.
 *
 * So: the SYNCHRONOUS copy leads. It finishes before window.open can take
 * focus, its answer is known without yielding, and the open therefore happens
 * in the same synchronous turn as the click - no activation is ever spent.
 * Only when that path is unavailable do we spend the async API, and then the
 * window stays SHUT until the write settles, because opening it is precisely
 * what would make the write fail.
 */
function copyAndOpen() {
  const code = props.flow?.user_code
  if (!code) return

  if (copyWithExecCommand(code)) {
    reportCopy(true)
    openGitHub()
    return
  }

  copyTextAsync(code).then((ok) => {
    reportCopy(ok)
    openGitHub()
  })
}

/** Say truthfully what happened, and lay out the manual path when it failed. */
function reportCopy(ok) {
  copied.value = ok
  copyFailed.value = !ok

  if (ok) {
    setTimeout(() => { copied.value = false }, 6000)
    return
  }

  // Select it for them, so the manual path is Ctrl+C and nothing else.
  selectCode()
  toast.info('Could not copy automatically - the code above is selected, press Ctrl+C.')
}

function openGitHub() {
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
/* The card's decisive action, and the step everything else waits on - it gets
   room of its own rather than sitting flush against the code and the notice. */
.copy-open {
  margin: var(--space-xs) 0 var(--space-sm) 0;
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
