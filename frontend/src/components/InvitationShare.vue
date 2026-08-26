<template>
  <!-- compact: one icon button, for a list row or a card. It exists so a
       lecturer coming back a week later does not have to open the editor to
       find the link (UX_PLAN §4.2). -->
  <button
    v-if="variant === 'compact'"
    type="button"
    class="btn btn-ghost btn-icon invitation-compact"
    :disabled="busy"
    :title="compactTitle"
    :aria-label="compactTitle"
    @click.stop.prevent="copy"
  >
    <Icon :name="copied ? 'check-circle' : 'copy'" :size="14" />
  </button>

  <div v-else :class="['invitation-share', `invitation-share-${variant}`]">
    <h4 v-if="variant === 'banner'" class="invitation-share-title">Share with students</h4>

    <div class="invitation-share-row">
      <!-- Truncated, never the full 122 characters: enough to recognise, and
           the whole thing on hover and in the clipboard. -->
      <code class="invitation-link" :title="link || undefined">{{ display }}</code>
      <button
        type="button"
        :class="['btn', 'btn-sm', 'btn-with-icon', copyClass]"
        :disabled="busy"
        @click="copy"
      >
        <Icon :name="copied ? 'check-circle' : 'copy'" :size="13" />
        <span>{{ copied ? 'Copied' : 'Copy' }}</span>
      </button>
      <!-- The only way a lecturer can see what a student sees. -->
      <a
        v-if="link"
        class="btn btn-sm btn-secondary btn-with-icon"
        :href="link"
        target="_blank"
        rel="noopener noreferrer"
      >
        <Icon name="external-link" :size="13" />
        <span>Open</span>
      </a>
    </div>

    <div class="invitation-share-status">
      <span class="status-indicator">
        <span class="status-dot" :class="status.dot"></span>
        <span>{{ status.label }}</span>
      </span>
      <span class="invitation-share-note">{{ status.note }}</span>
      <button
        v-if="variant === 'banner'"
        type="button"
        class="btn-link invitation-regenerate"
        @click="$emit('regenerate')"
      >Regenerate link →</button>
    </div>
  </div>
</template>

<script setup>
// The one place the invitation link is presented (UX_PLAN §4.1).
//
// It used to exist as a bare <span> in the publish banner, a primary button on
// the detail header, and nowhere at all on either list of assignments - so a
// lecturer who closed the editor had no route back to the link short of
// re-opening it. Used by three views, so its classes live in style.css per
// DESIGN.md §7; a scoped block here would render unstyled everywhere it is
// slotted into a parent.
import { computed, ref, watch } from 'vue'
import Icon from './Icon.vue'
import { config } from '../lib/config.js'
import { getToken } from '../lib/auth.js'
import { getRepoContent } from '../lib/api.js'
import { invitationUrl, parseInviteFields, linkSecretFrom } from '../lib/invite.js'
import { formatDate } from '../lib/format.js'
import { toast } from '../lib/toast.js'

const props = defineProps({
  org: { type: String, required: true },
  // Needs at least `id`. Everything else sharpens the status line; `invite_token`
  // saves a request when the caller already parsed the assignment YAML.
  assignment: { type: Object, required: true },
  variant: {
    type: String,
    default: 'inline',
    validator: (v) => ['banner', 'inline', 'compact'].includes(v),
  },
  // Whether an absent `invite_token` may be read from the control repo.
  //
  // Off for a caller that is AUTHORITATIVE about the token, which means one
  // that can deliberately clear it: rotating an invitation sets
  // `form.invite_token = ''` precisely so the retired link stops being
  // copyable, and re-reading the not-yet-rewritten YAML would hand it straight
  // back. On for callers that simply never had it - a dashboard card is built
  // from dashboard.json, which must not carry the token at all.
  resolve: { type: Boolean, default: true },
})

defineEmits(['regenerate'])

const fetched = ref(null)
const fetchedExpiry = ref(null)
const busy = ref(false)
const copied = ref(false)
let copiedTimer = null

// linkSecretFrom, not invite_token: a migrated assignment's link carries the
// acceptance private key, an unmigrated one still carries the token, and which
// it is must be decided in one place.
const token = computed(() => linkSecretFrom(props.assignment) || fetched.value || null)
const expiresAt = computed(() => props.assignment?.invite_expires_at || fetchedExpiry.value || null)
const link = computed(() => (token.value ? invitationUrl(props.org, token.value) : null))

// A published assignment always has one; a draft never does. Anything else is a
// publish that half-happened, which the status line has to say rather than
// showing an empty box.
const display = computed(() => {
  if (!link.value) return 'No invitation link yet'
  const [head, tail] = link.value.split('/i/')
  if (!tail) return link.value
  return `${head}/i/${tail.slice(0, 8)}…${tail.slice(-4)}`
})

const copyClass = computed(() => (props.variant === 'inline' ? 'btn-primary' : 'btn-secondary'))

const compactTitle = computed(() =>
  link.value || props.assignment?.state === 'published'
    ? 'Copy the student invitation link'
    : 'No invitation link yet - publish this assignment to mint one',
)

// The student-facing truth, gated on the same conditions AssignmentView uses to
// decide whether to show a student an Accept button. A lecturer reading "Live"
// here and a student seeing "Registration cap reached" there would be the exact
// UI-lies-about-the-system problem this workstream exists to remove.
const status = computed(() => {
  const a = props.assignment || {}
  const zone = a.timezone
  const when = (iso) => formatDate(iso, zone)
  const expiryNote = expiresAt.value ? ` Link expires ${when(expiresAt.value)}.` : ''
  const now = new Date()

  if (a.state !== 'published') {
    return {
      dot: 'dot-neutral',
      label: a.state === 'draft' ? 'Not shared yet' : `Closed (${a.state})`,
      note:
        a.state === 'draft'
          ? 'Publish the assignment to mint a link students can accept with.'
          : 'Students can no longer accept. Existing repositories are untouched.',
    }
  }
  if (!token.value) {
    return {
      dot: 'dot-danger',
      label: 'Published, but no link',
      note: 'The invitation was never minted or has been lost. Republish to mint one.',
    }
  }
  if (a.opens_at && now < new Date(a.opens_at)) {
    return { dot: 'dot-warning', label: `Opens ${when(a.opens_at)}`, note: `The link works, but nobody can accept before then.${expiryNote}` }
  }
  if (a.deadline_at && now > new Date(a.deadline_at)) {
    return { dot: 'dot-neutral', label: 'Closed', note: `The deadline passed ${when(a.deadline_at)}.${expiryNote}` }
  }
  const cap = Number(a.max_acceptances) || 0
  const accepted = Number(a.accepted_count) || 0
  if (cap && accepted >= cap) {
    return { dot: 'dot-warning', label: 'Cap reached', note: `${accepted} of ${cap} places taken - raise the cap to let more students in.${expiryNote}` }
  }
  return {
    dot: 'dot-success',
    label: 'Live - students can accept now',
    note: a.deadline_at
      ? `Anyone with this link can accept until ${when(a.deadline_at)}.${expiryNote}`
      : `Anyone with this link can accept.${expiryNote}`,
  }
})

// The token lives in the private control repo and never in Pages output or the
// dashboard report, so a caller that only has an id has to read it. Same call
// AssignmentDetailView already made; doing it lazily keeps a list of twenty
// assignments to zero extra requests until someone actually clicks.
async function ensureToken() {
  if (token.value) return token.value
  if (!props.resolve) return null
  const auth = getToken()
  if (!auth || !props.assignment?.id) return null
  try {
    const yaml = await getRepoContent(
      auth, props.org, config.controlRepo, `assignments/${props.assignment.id}.yml`,
    )
    const fields = parseInviteFields(yaml)
    fetched.value = linkSecretFrom(fields) || null
    fetchedExpiry.value = fields.invite_expires_at || null
    return fetched.value
  } catch {
    return null
  }
}

async function copy() {
  busy.value = true
  try {
    const value = await ensureToken()
    if (!value) {
      // Writing "null" to the clipboard and reporting success is worse than
      // saying nothing happened.
      toast.error('No invitation link yet - publish this assignment to mint one.')
      return
    }
    await navigator.clipboard.writeText(invitationUrl(props.org, value))
    copied.value = true
    clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => { copied.value = false }, 2000)
    if (props.assignment?.state !== 'published') {
      toast.info(`Invitation link copied. The assignment is ${props.assignment?.state || 'not published'}, so students cannot accept yet.`)
    } else {
      toast.success('Invitation link copied')
    }
  } catch {
    toast.error('Could not copy the link')
  } finally {
    busy.value = false
  }
}

// A different assignment in the same slot is a different link.
watch(() => props.assignment?.id, () => {
  fetched.value = null
  fetchedExpiry.value = null
  copied.value = false
})
</script>
