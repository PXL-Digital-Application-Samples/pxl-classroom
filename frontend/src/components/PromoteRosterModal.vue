<template>
  <div class="modal-overlay" @click.self="close">
    <div class="modal promote-modal" role="dialog" aria-modal="true" aria-labelledby="promote-modal-title">
      <header class="modal-head">
        <h3 id="promote-modal-title">Add students who accepted — {{ assignment.id }}</h3>
        <button class="modal-close" type="button" @click="close" aria-label="Close">×</button>
      </header>

      <div class="modal-body flex flex-col gap-md">
        <p class="promote-lede">
          Open enrolment means nobody had to be on the roster to accept, so this assignment's
          students exist only as GitHub logins. Adding them to the roster lets your
          <em>next</em> assignment enforce it against the cohort that actually turned up.
        </p>

        <!-- SAYS WHAT WILL ARRIVE, before it is written.
             A row carries the address the student confirmed when there is one,
             and a bare GitHub username when there is not - and a lecturer who
             expected names had no way to know which they were about to get
             until they looked at the roster afterwards. -->
        <p v-if="plan?.ok && plan.added.length" class="promote-lede">
          <template v-if="withAddress > 0">
            <strong>{{ withAddress }}</strong> of {{ plan.added.length }} will arrive with the email
            address they confirmed<template v-if="withAddress < plan.added.length">; the rest as a GitHub
            username only, because this assignment did not ask for one</template>.
          </template>
          <template v-else>
            They will arrive as GitHub usernames only — no name, student number or email, because this
            assignment never collected one. Tick <em>{{ REQUIRE_CLAIM_LABEL }}</em> on an open
            assignment to change that.
          </template>
        </p>

        <div v-if="loading" class="promote-status">
          <span class="spinner-sm"></span>
          <span class="text-secondary">Reading acceptances and the roster…</span>
        </div>

        <div v-else-if="loadError" class="diag-banner promote-banner-danger">
          <div>
            <strong>Could not read the control repository.</strong>
            <p class="promote-banner-text">{{ loadError }}</p>
          </div>
        </div>

        <!-- A short read must never be rounded down into a confident number. -->
        <div v-else-if="failedReads > 0" class="diag-banner promote-banner-danger">
          <div>
            <strong>{{ failedReads }} acceptance record(s) could not be read.</strong>
            <p class="promote-banner-text">
              Promoting now would quietly leave those students off the roster and still report
              success. Try again in a moment, or use
              <code>pxl-classroom roster promote --assignment {{ assignment.id }}</code>.
            </p>
          </div>
        </div>

        <template v-else-if="plan">
          <div v-if="!plan.ok" class="diag-banner promote-banner-danger">
            <div>
              <strong>Nothing was added.</strong>
              <ul class="promote-list">
                <li v-for="(e, i) in plan.errors" :key="i">{{ e.message }}</li>
              </ul>
            </div>
          </div>

          <template v-else>
            <div class="promote-summary">
              <div class="promote-stat">
                <span class="promote-stat-value">{{ plan.stats.acceptances }}</span>
                <span class="promote-stat-label">accepted</span>
              </div>
              <div class="promote-stat">
                <span class="promote-stat-value">{{ plan.stats.added }}</span>
                <span class="promote-stat-label">to add</span>
              </div>
              <div class="promote-stat">
                <span class="promote-stat-value">{{ plan.stats.already_on_roster }}</span>
                <span class="promote-stat-label">already on the roster</span>
              </div>
              <span class="status-indicator promote-summary-note">
                <span class="status-dot" :class="summaryDot"></span>
                <span>{{ summaryLabel }}</span>
              </span>
            </div>

            <div v-if="plan.warnings.length" class="diag-banner promote-banner-warn">
              <div>
                <strong>Worth knowing</strong>
                <ul class="promote-list">
                  <li v-for="(w, i) in plan.warnings" :key="i">{{ w.message }}</li>
                </ul>
              </div>
            </div>

            <div v-if="plan.added.length" class="promote-preview">
              <div class="promote-preview-head">
                <span class="text-secondary text-sm">Students to add</span>
                <span class="text-muted text-xs">GitHub login only — see below</span>
              </div>
              <ul class="promote-preview-list">
                <li v-for="s in plan.added" :key="s.github_login" class="promote-preview-row">
                  <span class="mono">@{{ s.github_login }}</span>
                  <span class="text-muted text-xs">accepted {{ formatWhen(s.promoted_from.accepted_at) }}</span>
                </li>
              </ul>
            </div>

            <p v-if="plan.added.length" class="promote-footnote">
              These entries carry a GitHub login and nothing else — GitHub never tells us a name or
              a student number, and guessing one would put a fabricated value in a field you grade
              from. They are marked <code>source: accepted</code> so you can spot which rows still
              need identifying, and a later CSV import fills them in. Students already on the roster
              are left exactly as they are.
            </p>
          </template>
        </template>
      </div>

      <footer class="modal-foot">
        <button class="btn btn-secondary" type="button" :disabled="applying" @click="close">Cancel</button>
        <button class="btn btn-primary" type="button" :disabled="!canApply" @click="apply">
          {{ applyLabel }}
        </button>
      </footer>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { getToken, getUser } from '../lib/auth.js'
import { listAcceptances, listClaims, getRepoContent, commitFile } from '../lib/api.js'
import { validateAgainst } from '../lib/validate.js'
import { config } from '../lib/config.js'
import { toast } from '../lib/toast.js'
import { formatDate } from '../lib/format.js'
// The same planner pxl-classroom roster promote runs. Imported, never
// re-implemented: the merge rule is what stops a lecturer's student_number
// being overwritten by the little an acceptance record knows.
import { planPromotion, promoteCommitMessage, ROSTER_PATH } from '../../../lib/promote-roster.mjs'
// The label is quoted, so it is read from where the checkbox reads it.
import { REQUIRE_CLAIM_LABEL } from '../lib/claim.js'

const props = defineProps({
  org: { type: String, required: true },
  assignment: { type: Object, required: true },
})
const emit = defineEmits(['close', 'promoted'])

const controlRepo = config.controlRepo

const loading = ref(true)
const loadError = ref('')
const applying = ref(false)
const failedReads = ref(0)
const acceptances = ref([])
const claims = ref([])
const roster = ref(null)

const plan = computed(() => {
  if (loading.value || loadError.value || failedReads.value > 0) return null
  return planPromotion({
    acceptances: acceptances.value,
    roster: roster.value,
    assignment: props.assignment,
    claims: claims.value,
    actor: getUser()?.login || 'lecturer',
  })
})

// How many of the rows about to be written carry the address the student
// confirmed. Counted off the PLAN rather than off the claims, so it says what
// will actually be written rather than what exists somewhere.
const withAddress = computed(() => (plan.value?.added || []).filter((s) => !!s.email).length)

const canApply = computed(() => !applying.value && !!plan.value?.ok && plan.value.added.length > 0)

const applyLabel = computed(() => {
  if (applying.value) return 'Adding…'
  const n = plan.value?.added.length ?? 0
  if (!n) return 'Nothing to add'
  return `Add ${n} student${n === 1 ? '' : 's'}`
})

const summaryDot = computed(() => {
  if (!plan.value?.added.length) return 'dot-neutral'
  return plan.value.warnings.length ? 'dot-warning' : 'dot-success'
})

const summaryLabel = computed(() => {
  if (!plan.value?.added.length) return 'Nothing to add'
  return plan.value.warnings.length ? 'Ready, with notes' : 'Ready to add'
})

function formatWhen(iso) {
  return iso ? formatDate(iso, props.assignment.timezone) : 'date unknown'
}

function close() {
  if (applying.value) return
  emit('close')
}

function onKey(e) {
  if (e.key === 'Escape') close()
}

onMounted(async () => {
  window.addEventListener('keydown', onKey)
  try {
    const token = getToken()
    // Claims are read alongside, so a student who confirmed an address is added
    // WITH it rather than as a bare username. Org-scoped: a student claims once
    // and every later assignment sees it.
    const [acc, rosterText, claimResult] = await Promise.all([
      listAcceptances(token, props.org, controlRepo, props.assignment.id),
      getRepoContent(token, props.org, controlRepo, ROSTER_PATH),
      // Unreadable is not evidence of none. Failing the whole promotion because
      // the claims could not be listed would refuse a lecturer an action that
      // works perfectly well without them, so this degrades to login-only rows.
      listClaims(token, props.org, controlRepo).catch(() => ({ records: [] })),
    ])
    acceptances.value = acc.records
    failedReads.value = acc.failed
    claims.value = claimResult?.records || []
    // getRepoContent resolves to decoded FILE TEXT and returns null on a 404,
    // so a falsy body here is a genuine absence - which the planner treats as
    // "create the roster", not as an error.
    roster.value = rosterText ? parseYaml(rosterText) : null
  } catch (e) {
    loadError.value = e?.message || String(e)
  } finally {
    loading.value = false
  }
})

onUnmounted(() => window.removeEventListener('keydown', onKey))

async function apply() {
  const p = plan.value
  if (!p?.ok || !p.added.length) return
  applying.value = true
  try {
    // A JSON round trip, not structuredClone: the existing entries came out of
    // a ref, so they are reactive Proxies and structuredClone throws on them
    // ("#<Object> could not be cloned") - which surfaced as a failed promotion
    // only when the roster was non-empty. Validating and serialising the SAME
    // plain object also guarantees the bytes checked are the bytes written.
    const plain = JSON.parse(JSON.stringify(p.nextRoster))

    // Validate before writing, not after: this file is what the acceptance gate
    // reads to decide who gets a repository.
    const { valid, errors } = await validateAgainst('roster', plain)
    if (!valid) {
      toast.error(`Refusing to write an invalid roster: ${errors.map((e) => e.message).join(', ')}`)
      return
    }
    const res = await commitFile(
      getToken(),
      props.org,
      controlRepo,
      ROSTER_PATH,
      stringifyYaml(plain),
      promoteCommitMessage(p, { assignmentId: props.assignment.id }),
    )
    if (!res.ok) {
      toast.error(`Commit failed: ${res.data?.message || 'unknown error'}`)
      return
    }
    toast.success(
      `${p.added.length} student${p.added.length === 1 ? '' : 's'} added to the roster. ` +
      `They carry a GitHub login only until you import their details.`,
    )
    emit('promoted', p.stats)
    emit('close')
  } catch (e) {
    toast.error(`Could not update the roster: ${e?.message || e}`)
  } finally {
    applying.value = false
  }
}
</script>

<style scoped>
/* Tonal steps, not nested boxes (DESIGN.md §1). --bg-inset is the recessed
   step that differs in BOTH themes; --bg-surface-elevated is #ffffff in light,
   the same as the modal behind it. */
.promote-modal {
  max-width: 640px;
  width: 100%;
}

.promote-lede {
  margin: 0;
  color: var(--text-secondary);
}

.promote-status {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
}

/* Tonal wells rather than another ring of boxes (DESIGN.md §1.1): the modal
   already outlines itself, so the banners and the preview separate by tone. */
.promote-banner-danger {
  background: var(--tint-danger-subtle);
  border: 1px solid var(--tint-danger-emphasis);
  color: var(--accent-red);
}

.promote-banner-warn {
  background: var(--tint-attention-subtle);
  border: 1px solid var(--tint-attention-emphasis);
  color: var(--accent-yellow);
}

.promote-banner-text,
.promote-list {
  margin: var(--space-xs) 0 0;
}

.promote-banner-text {
  font-size: 0.85rem;
  color: var(--text-secondary);
}

.promote-list {
  padding-left: var(--space-md);
}

.promote-summary {
  display: flex;
  align-items: center;
  gap: var(--space-lg);
  flex-wrap: wrap;
  padding: var(--space-md);
  border-radius: var(--radius-md);
  background: var(--bg-inset);
}

.promote-stat {
  display: flex;
  flex-direction: column;
  line-height: 1.2;
}

.promote-stat-value {
  font-size: 1.25rem;
  font-weight: 600;
}

.promote-stat-label {
  font-size: 0.8rem;
  color: var(--text-muted);
}

.promote-summary-note {
  margin-left: auto;
}

.promote-preview {
  border-radius: var(--radius-md);
  background: var(--bg-inset);
  overflow: hidden;
}

.promote-preview-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: var(--space-sm);
  padding: var(--space-sm) var(--space-md);
  border-bottom: 1px solid var(--border-muted);
}

.promote-preview-list {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 260px;
  overflow-y: auto;
}

.promote-preview-row {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: var(--space-sm);
  padding: var(--space-xs) var(--space-md);
}

.promote-preview-row + .promote-preview-row {
  border-top: 1px solid var(--border-muted);
}

.promote-footnote {
  margin: 0;
  font-size: 0.85rem;
  color: var(--text-muted);
}
</style>
