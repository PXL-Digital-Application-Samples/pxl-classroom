<template>
  <div class="claim-card">
    <div class="claim-head">
      <Icon name="mail" :size="16" />
      <span class="font-semibold">Confirm your {{ INSTITUTION }} email address</span>
    </div>

    <p class="text-sm text-secondary claim-intro">
      Your lecturer registered this course by email address. Confirm yours once and
      it is remembered for every assignment in
      <code>{{ org }}</code>.
    </p>

    <!-- Loading their addresses -->
    <p v-if="loading" class="text-sm text-secondary claim-line">
      <span class="spinner-sm"></span>
      Checking which addresses GitHub has verified for you…
    </p>

    <template v-else>
      <!-- Their own GitHub-verified addresses that match the allowed domains -->
      <div v-if="matching.length" class="claim-options">
        <label v-for="addr in matching" :key="addr" class="claim-option">
          <input v-model="chosen" type="radio" :value="addr" name="claim-address" />
          <span class="claim-address">{{ addr }}</span>
          <span class="status-indicator claim-badge">
            <span class="status-dot dot-success"></span>
            <span>Verified by GitHub</span>
          </span>
        </label>
      </div>

      <!-- Nothing matched, or we could not look. These are DIFFERENT states. -->
      <p v-else-if="unreadable" class="text-sm claim-line claim-note">
        We could not check which addresses GitHub has verified for you, so type
        the address your lecturer registered.
      </p>
      <!-- "VERIFIED", not "on your account". This branch only knows what
           `/user/emails` returned filtered to `verified === true`, so an
           address sitting on the account unverified is not in it - and the
           card's own loading line says "verified" one paragraph above. The
           stronger claim would have been wrong for exactly the students it is
           hardest on. -->
      <template v-else>
        <!-- The institution, not the domain list. A student does not think of
             themselves as having "a student.pxl.be address"; the domains stay
             the authority for MATCHING one (and still name themselves in the
             typed-address error, where the reader has typed something that
             failed and needs to know exactly what is accepted). -->
        <p class="text-sm claim-line claim-note">
          GitHub has not verified {{ article(INSTITUTION) }} {{ INSTITUTION }} email address on this
          account. Add and verify your official {{ INSTITUTION }} address on
          GitHub - or sign in with an account that already has it - and your
          lecturer will recognise you automatically.
        </p>
        <!-- Its own paragraph, immediately above the field it is about. Run
             together with the paragraph above it this was four sentences in one
             block, and the one sentence that says what to do next was the
             fourth. -->
        <p class="text-sm claim-line claim-note">
          You can continue with this account instead. Type your
          {{ INSTITUTION_SHORT }} address below; your lecturer will see it as
          unconfirmed.
        </p>
      </template>

      <!-- The typed fallback. Always reachable: a student whose institutional
           address is not on their GitHub account must never be locked out. -->
      <div v-if="typing || !matching.length" class="claim-typed">
        <label class="field">
          <span class="claim-field-label">Your {{ INSTITUTION_SHORT }} email address</span>
          <input
            v-model="typed"
            type="email"
            class="form-control"
            :placeholder="placeholder"
            autocomplete="email"
            spellcheck="false"
            @input="chosen = ''"
          />
        </label>
        <p v-if="typedProblem" class="form-hint claim-problem">{{ typedProblem }}</p>
      </div>
      <button
        v-else
        type="button"
        class="btn-link claim-switch"
        @click="typing = true"
      >
        Use a different address
      </button>
    </template>
  </div>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import Icon from './Icon.vue'
import { getUserEmails } from '../lib/api.js'
import { domainAllowed, normalizeEmail, resolveClaimDomains } from '../lib/claim.js'
import { CLAIM_DOMAINS, INSTITUTION, INSTITUTION_SHORT } from '../lib/deployment.js'

const props = defineProps({
  assignment: { type: Object, required: true },
  org: { type: String, required: true },
  token: { type: String, default: '' },
})

const emit = defineEmits(['update:claim'])

const loading = ref(true)
// `unreadable` and "no matching address" are different facts and must stay
// apart. A 403 - which is exactly what a missing `email_addresses: read`
// approval looks like - is NOT evidence that the student has no PXL address,
// and telling them so would send them to type one while implying their account
// is wrong. Same rule the org-owner check and Tier 1 apply: unreadable yields
// no claim about the world.
const unreadable = ref(false)
const addresses = ref([])
const chosen = ref('')
const typed = ref('')
const typing = ref(false)

const domains = computed(() => resolveClaimDomains(props.assignment, CLAIM_DOMAINS))

// "an student.pxl.be", in a sentence a student reads while already stuck. The
// article follows the sound of the domain, not a constant - every domain this
// deployment uses starts with a consonant, so the bug was every rendering of
// this phrase in both places that show it.
const article = (word) => (/^[aeiou]/i.test(word) ? 'an' : 'a')

const domainPhrase = computed(() => {
  const d = domains.value
  if (!d.length) return 'an accepted address'
  if (d.length === 1) return `${article(d[0])} ${d[0]} address`
  const head = d.slice(0, -1).map((x) => `${article(x)} ${x}`).join(', ')
  const last = d[d.length - 1]
  return `${head} or ${article(last)} ${last} address`
})

const placeholder = computed(() =>
  domains.value.length ? `you@${domains.value[0]}` : 'you@example.com',
)

const matching = computed(() =>
  addresses.value.filter((a) => domainAllowed(a, domains.value)),
)

// Only ever shown for something the student has actually typed, so an empty
// box is never an error - the same reason a field error is gated on `touched`
// for a new assignment.
const typedProblem = computed(() => {
  const raw = typed.value.trim()
  if (!raw) return ''
  const email = normalizeEmail(raw)
  if (!email) return 'That does not look like an email address.'
  if (!domainAllowed(email, domains.value)) {
    return `This assignment only accepts ${domainPhrase.value}.`
  }
  return ''
})

// What the parent will seal. `verified` is true ONLY when the address came out
// of the student's own GitHub-verified list - never for a typed one, even if
// they type the same address that is sitting in the list above.
const claim = computed(() => {
  if (chosen.value) return { email: chosen.value, verified: true }
  const email = normalizeEmail(typed.value)
  if (!email || typedProblem.value) return null
  return { email, verified: false }
})

watch(claim, (value) => emit('update:claim', value), { immediate: true })

onMounted(async () => {
  if (!props.token) {
    unreadable.value = true
    loading.value = false
    return
  }
  try {
    const res = await getUserEmails(props.token)
    if (!res.ok || !Array.isArray(res.data)) {
      unreadable.value = true
    } else {
      // GitHub's own verification is the whole value here: it is a check
      // somebody else already performed, for free, and it is the difference
      // between claim_verified true and false.
      addresses.value = res.data
        .filter((e) => e?.verified === true && typeof e?.email === 'string')
        .map((e) => normalizeEmail(e.email))
        .filter(Boolean)
    }
  } catch {
    unreadable.value = true
  }
  const first = matching.value[0]
  if (first) chosen.value = first
  loading.value = false
})
</script>

<style scoped>
/* Single-component vocabulary, so it stays scoped (DESIGN.md §7). Every colour
   is a token - no literals outside :root (§5). A tonal step rather than a
   border, because the acceptance card already draws one and a second would be
   §1.1's box prison. */
.claim-card {
  background: var(--bg-inset);
  border-radius: var(--radius-md);
  padding: var(--space-md);
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
  text-align: left;
}

.claim-head {
  display: flex;
  align-items: center;
  gap: var(--space-xs);
}

.claim-intro,
.claim-line,
.claim-note {
  margin: 0;
}

.claim-options {
  display: flex;
  flex-direction: column;
  gap: var(--space-xs);
}

.claim-option {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  padding: var(--space-sm);
  background: var(--bg-surface);
  border-radius: var(--radius-sm);
  cursor: pointer;
  /* min-width: 0 on the flex child is not enough for a long address; the
     address itself is what ellipsises. */
  min-width: 0;
}

.claim-address {
  font-family: var(--font-mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
  flex: 1;
}

.claim-badge {
  flex-shrink: 0;
}

/* In this state the field IS the action, so it gets air above it and carries
   more weight than the explanation it follows - not `.text-sm`, which is the
   size of the paragraph it has to stand out from. Sizes are literal rems the
   way style.css's own type scale is; §5 rule 1 is about COLOUR literals, and
   there is no colour here. */
.claim-typed {
  margin-top: var(--space-sm);
}

.claim-typed .field {
  margin: 0;
}

.claim-field-label {
  font-size: 0.95rem;
  font-weight: 600;
  color: var(--text-primary);
}

.claim-typed .form-control {
  font-size: 0.95rem;
  padding: var(--space-sm);
}

.claim-problem {
  color: var(--accent-red);
}

.claim-switch {
  align-self: flex-start;
}
</style>
