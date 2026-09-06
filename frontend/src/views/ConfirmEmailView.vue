<template>
  <div class="assignment-page">
    <AppHeader :user="user" :sticky="false" @logout="handleLogout" />

    <main class="container">
      <div v-if="loading" class="center-card fade-in">
        <div class="spinner-lg spinner"></div>
        <p class="text-secondary">Loading…</p>
      </div>

      <div v-else-if="error" class="center-card fade-in">
        <Icon name="alert-triangle" :size="48" class="status-icon status-icon-warn" />
        <h2>Something went wrong</h2>
        <p class="text-secondary">{{ error }}</p>
        <button class="btn btn-secondary" @click="retry">Try again</button>
      </div>

      <!-- The link resolves, and the assignment behind it has been replaced.
           Same state AssignmentView renders, for the same reason: the honest
           answer is "out of date", not "not found". -->
      <div v-else-if="superseded" class="center-card fade-in">
        <Icon name="alert-triangle" :size="48" class="status-icon status-icon-warn" />
        <h2>This link is out of date</h2>
        <p class="text-secondary">
          Ask whoever sent it for a current one. Nothing you have already done is affected.
        </p>
      </div>

      <div v-else-if="!assignment" class="center-card fade-in">
        <Icon name="search" :size="48" class="status-icon" />
        <h2>We can't find this link</h2>
        <p class="text-secondary">
          Check that you copied the whole thing, including the last character.
        </p>
      </div>

      <!-- THE LINK OUTLIVES THE ASSIGNMENT ON PAGES. `pages/generate.mjs`
           publishes a card for `closed` as well as `published`, so the card is
           still there after an assignment finishes - while the broker behind it
           has `INVITE_ENABLED=false` and runs nothing. Without this branch the
           page took the POST's 201 and said "that's all we needed" over a
           confirmation that never happened.
           The DEADLINE is deliberately not consulted: a confirmation hands out
           nothing, and the weeks after a deadline are exactly when this link is
           wanted. Only the assignment being open at all decides. -->
      <div v-else-if="assignment.state !== 'published'" class="center-card fade-in">
        <Icon name="lock" :size="48" class="status-icon status-icon-warn" />
        <h2>This link is no longer open</h2>
        <p class="text-secondary">
          The assignment it belongs to has finished, so it cannot record an address any more.
          Ask your lecturer for a current link.
        </p>
      </div>

      <template v-else>
        <div class="card confirm-intro">
          <!-- NOT "Confirm your PXL email" - ClaimAddressCard's own heading
               says that four lines below, and a page whose first two headings
               are the same sentence reads like a rendering fault. This one
               says why the page exists; the card owns the ask. -->
          <h1 class="confirm-title">Tell your lecturer who you are</h1>
          <!-- WHAT THIS IS NOT, said before anything else. A student who has
               already accepted an assignment and is handed a second link will
               reasonably assume it is another one; letting them find out by
               reading the button is how somebody clicks expecting a repository.
               DESIGN.md §1.5 - say what the control does, and here what it
               does not.
               NO ASSIGNMENT IS NAMED. The binding is ORG-SCOPED - one
               confirmation covers every assignment in the organization - so
               "knows who Cloud Lab 3 belongs to" described a per-assignment
               record that does not exist. The assignment is only the carrier
               for the link, and saying otherwise would be the UI describing
               behaviour the system does not have. -->
          <p class="text-secondary">
            This links your GitHub account to your {{ INSTITUTION_SHORT }} email address, so your
            lecturer can match you to their class list. It does not sign you up for anything and
            does not create a repository.
          </p>
        </div>

        <AuthCard v-if="!user" @authenticated="onAuthenticated">
          Sign in with the GitHub account you use for your coursework.
        </AuthCard>

        <div v-else-if="done" class="card">
          <div class="confirm-done-head">
            <Icon name="check-circle" :size="20" class="status-icon status-icon-success" />
            <span class="font-semibold">Thanks - that's all we needed</span>
          </div>
          <p class="text-sm text-secondary">
            <code>{{ doneEmail }}</code> is now linked to <strong>@{{ user.login }}</strong>.
            You can close this page.
          </p>
        </div>

        <!-- NO wrapping .card. ClaimAddressCard draws its own edge, and a card
             around it puts a bordered box inside a bordered box around the
             radio rows - DESIGN.md 1.1's "never nest three boxes". -->
        <div v-else>
          <ClaimAddressCard
            :assignment="assignment"
            :org="org"
            :token="authToken"
            @update:claim="claim = $event"
          />

          <p v-if="!claimKeyReady" class="text-sm claim-unavailable">
            Confirming isn't set up for this course yet. Tell your lecturer - they can finish
            setting it up.
          </p>

          <p v-if="submitError" class="auth-error">{{ submitError }}</p>

          <!-- `btn-lg` because DESIGN.md §3 reserves it for "a card's single
               decisive action", which this is - the accept page's own button
               is sized the same way. NOT `btn-success`: §3 gives that exactly
               one use, the student's accepted state, and this page accepts
               nothing. -->
          <button
            class="btn btn-primary btn-lg btn-with-icon confirm-submit"
            :disabled="submitting || !claim || !claimKeyReady"
            @click="submit"
          >
            <template v-if="submitting">
              <div class="spinner" style="width:18px;height:18px;border-width:2px"></div>
              <span>Confirming…</span>
            </template>
            <template v-else>
              <Icon name="mail" :size="18" />
              <span>Confirm this address</span>
            </template>
          </button>
        </div>
      </template>
    </main>
  </div>
</template>

<script setup>
// PXL Classroom - "tell us who you are", with no assignment attached.
//
// WHY THIS PAGE EXISTS. A roster row promoted from an acceptance carries a
// github_login and nothing else, and nothing fills it in afterwards: promotion
// skips a login it has seen, and a claim joins to a row by email, which such a
// row has none of. The claim itself was only ever collected AT ACCEPTANCE -
// `ClaimAddressCard` renders inside AssignmentView's "Accept assignment"
// branch - so a student who had already accepted could never be asked again,
// and an assignment not in `claim` mode never asked at all.
//
// WHY IT RIDES AN ASSIGNMENT'S LINK. The alternative was a standing per-org
// receiver, which means the broker App's private key on a public repository
// with no expiry - the exact thing scripts/close-acceptance.mjs was written to
// end. Reusing the assignment's secret, nonce and broker means this inherits
// the kill switch (INVITE_ENABLED, flipped when the nightly finalizes) and the
// revocation (rotate the nonce and every link dies at once), rather than having
// a lifetime of its own that nobody would remember to end. The cost is that
// there must be a live assignment to carry it, which RUNBOOK says out loud.
//
// The purpose is inside the SIGNATURE, not just the `pxl-confirm:` prefix
// (lib/acceptance-signature.mjs). Otherwise a student sent this link could
// rewrite the prefix and accept an `open` assignment they were never invited
// to - the signature covers `<kid>.<payload>`, and the prefix sits outside it.
import { ref, computed, onMounted } from 'vue'

import AppHeader from '../components/AppHeader.vue'
import AuthCard from '../components/AuthCard.vue'
import ClaimAddressCard from '../components/ClaimAddressCard.vue'
import Icon from '../components/Icon.vue'
import { getUser, getToken, clearAuth } from '../lib/auth.js'
import { ghApi } from '../lib/api.js'
import { brokerRepoName } from '../../../lib/broker-repo.mjs'
import { buildAcceptanceBody, encryptClaim, hubClaimKey } from '../lib/claim.js'
import { inviteDataUrl, signedConfirmIssueTitle } from '../lib/invite.js'
import { INSTITUTION_SHORT } from '../lib/deployment.js'

const props = defineProps({
  org: { type: String, required: true },
  // The same secret the invitation link carries. One keypair per assignment,
  // so this page and the acceptance page resolve the same card.
  inviteToken: { type: String, default: '' },
})

const user = ref(getUser())
const authToken = ref(getToken())
const loading = ref(true)
const error = ref(null)
const assignment = ref(null)
const superseded = ref(false)
const claim = ref(null)
const submitting = ref(false)
const submitError = ref(null)
const done = ref(false)
const doneEmail = ref('')

const claimKeyReady = computed(() => Boolean(hubClaimKey()))

async function load() {
  loading.value = true
  error.value = null
  superseded.value = false

  if (!globalThis.crypto?.subtle) {
    error.value =
      'This browser cannot confirm an address securely. ' +
      'Open the link over https://, or try a current version of Chrome, Firefox, Edge or Safari.'
    loading.value = false
    return
  }

  try {
    // Found by the digest of the secret, exactly as the acceptance page finds
    // it - holding the link is what makes the card findable at all.
    const url = `${await inviteDataUrl(props.org, props.inviteToken)}?t=${Date.now()}`
    const res = await fetch(url, { cache: 'no-store' })
    if (res.ok) {
      let data = null
      try { data = await res.json() } catch { /* not JSON means no such link */ }
      if (data?.superseded) superseded.value = true
      else if (data?.assignment?.id) assignment.value = { ...data.assignment }
    }
  } catch (e) {
    error.value = `Couldn't load this link (${e.message}). Check your connection and try again.`
  }
  loading.value = false
}

function retry() {
  load()
}

function onAuthenticated(authedUser) {
  user.value = authedUser
  authToken.value = getToken()
}

function handleLogout() {
  clearAuth()
  user.value = null
  // EVERYTHING ABOUT THE PREVIOUS ACCOUNT GOES, and this page is the one where
  // it matters most: it runs on shared lab machines and its whole output is a
  // record asserting who somebody is. A half-filled address left behind would
  // be sealed under the NEXT student's id, and a success card left on screen
  // would tell them an address they have never seen is now theirs.
  authToken.value = ''
  claim.value = null
  submitError.value = null
  done.value = false
  doneEmail.value = ''
}

async function submit() {
  submitting.value = true
  submitError.value = null
  try {
    const hubKey = hubClaimKey()
    if (!hubKey) throw new Error('Confirming is not set up for this course yet. Tell your lecturer.')
    if (!claim.value) throw new Error('Pick or type the address to confirm first.')

    const brokerRepo = brokerRepoName({ assignment: assignment.value, assignmentId: assignment.value?.id })
    if (!brokerRepo) throw new Error('This link is incomplete. Ask your lecturer for a current one.')

    const title = await signedConfirmIssueTitle({
      inviteSecret: props.inviteToken,
      assignmentId: assignment.value.id,
      githubId: user.value?.id,
    })

    // Only ciphertext travels. The title and body land in a public event that
    // GH Archive keeps forever, which is the whole reason the address is sealed
    // to the hub's key rather than sent in the clear.
    const payload = await encryptClaim({
      publicKey: hubKey.publicKey,
      email: claim.value.email,
      githubId: user.value?.id,
      assignmentId: assignment.value.id,
    })

    const res = await ghApi(getToken(), 'POST', `/repos/${props.org}/${brokerRepo}/issues`, {
      title,
      // The shared builder, never a hand-assembled object. The hub reads
      // `claim_verified === true`, so a body spelled here would record every
      // confirmation as unverified the first time either side moved.
      body: buildAcceptanceBody({ claim: { payload, verified: claim.value.verified } }),
    })
    if (!res.ok) {
      if (res.status === 404) {
        throw new Error('This link is no longer active. Ask your lecturer for a current one.')
      }
      throw new Error(`Could not confirm your address (HTTP ${res.status}).`)
    }

    // ONLY after the POST resolved. A success flag set beside an un-awaited
    // promise is a UI that lies, and this one would tell a student they were
    // identified when nothing had been recorded.
    doneEmail.value = claim.value.email
    done.value = true
  } catch (e) {
    submitError.value = e.message
  }
  submitting.value = false
}

onMounted(load)
</script>

<style scoped>
.confirm-intro {
  margin-bottom: var(--space-md);
}

.confirm-title {
  margin: 0 0 var(--space-sm);
  font-size: 1.4rem;
}

.confirm-submit {
  margin-top: var(--space-md);
}

.confirm-done-head {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  margin-bottom: var(--space-xs);
}
</style>
