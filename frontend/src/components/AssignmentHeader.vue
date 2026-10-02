<template>
  <!-- ONE ASSIGNMENT, ONE HEADER, ON EVERY TAB (BETA-UX.md, 2026-10-02):
       its state - a button carrying the lifecycle - its deadline, the link
       students accept with, and the tabs. Shared by the assignment page
       (Progress / Teams / Grading) and the editor (Settings), which are two
       routes: the header is what makes them read as one place. -->
  <div>
    <div class="assignment-head flex items-center justify-between flex-wrap gap-sm">
      <div class="flex items-center gap-sm flex-wrap">
        <div class="dropdown-container" ref="stateMenuRef">
          <button
            class="btn btn-secondary btn-sm btn-with-icon"
            type="button"
            :disabled="!actions.length || busy"
            :aria-expanded="stateMenuOpen"
            aria-haspopup="true"
            data-state-menu
            :title="actions.length ? 'Change what this assignment does now' : null"
            @click.stop="toggleStateMenu"
          >
            <span class="status-dot" :class="state === 'published' ? 'dot-success' : 'dot-neutral'"></span>
            <span>{{ busy ? 'Updating…' : assignmentStateLabel(state) }}</span>
            <Icon v-if="actions.length" :name="stateMenuOpen ? 'chevron-up' : 'chevron-down'" :size="11" />
          </button>
          <div v-if="stateMenuOpen" class="export-dropdown-menu state-menu fade-in" role="menu">
            <template v-for="(a, i) in actions" :key="a.key">
              <div v-if="a.danger && i > 0 && !actions[i - 1].danger" class="dropdown-divider"></div>
              <button class="export-dropdown-item" type="button" role="menuitem" @click="choose(a.key)">
                <div class="dropdown-item-text">
                  <span class="dropdown-item-title" :class="{ 'text-danger': a.danger }">{{ a.label }}</span>
                  <span class="dropdown-item-sub">{{ a.sub }}</span>
                </div>
              </button>
            </template>
          </div>
        </div>
        <div class="assignment-head-deadline">
          <span class="text-secondary text-sm">Deadline</span>
          <strong :class="{ 'stat-red': deadlinePassed }">{{ deadlineRelative || '-' }}</strong>
          <span v-if="deadlineAbs" class="text-secondary text-sm">· {{ deadlineAbs }}</span>
        </div>
      </div>

      <!-- HANDING THE LINK TO STUDENTS IS WHAT THIS PAGE IS FOR before anyone
           has accepted, and ARCHITECTURE §10.6 requires it never to vanish.
           DESIGN.md §1.2 names it the view's one solid button; the Copy inside
           the popover is secondary. Under the editor, Save is the solid one
           and this steps down. Offered for a draft too: it has no link yet,
           and the popover says so and why, which an absent button cannot
           (DESIGN.md §1.5). -->
      <div class="dropdown-container" ref="inviteMenuRef">
        <button
          :class="['btn', primaryInvite ? 'btn-primary' : 'btn-secondary', 'btn-sm', 'btn-with-icon']"
          type="button"
          @click.stop="toggleInviteMenu"
          :aria-expanded="inviteMenuOpen"
          aria-haspopup="true"
        >
          <Icon name="link" :size="13" />
          <span>Invite link</span>
          <Icon :name="inviteMenuOpen ? 'chevron-up' : 'chevron-down'" :size="11" />
        </button>
        <!-- Not role="menu": besides its rows it holds the link box, a status
             line and a help button, none of which is a menu item. -->
        <div v-if="inviteMenuOpen" class="export-dropdown-menu invite-menu fade-in" aria-label="Invite link for students">
          <InvitationShare :org="org" :assignment="shareAssignment" variant="popover" />
        </div>
      </div>
    </div>

    <!-- The tab is in the address: Progress has none, Teams and Grading are
         `?tab=`, Settings is its own page (the editor). -->
    <nav class="primer-tabs assignment-tabs" aria-label="Assignment sections">
      <template v-for="t in tabs" :key="t.key">
        <span v-if="t.key === current" class="primer-tab active" aria-current="page">{{ t.label }}</span>
        <router-link v-else :to="t.to" class="primer-tab">{{ t.label }}</router-link>
      </template>
    </nav>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import Icon from './Icon.vue'
import InvitationShare from './InvitationShare.vue'
import { assignmentStateLabel } from '../lib/status-labels.js'
import { formatDate, formatRelative } from '../lib/format.js'
import { stateActions } from '../lib/state-actions.js'
import { keepMenuInView } from '../lib/menu-position.js'

const props = defineProps({
  org: { type: String, required: true },
  assignmentId: { type: String, required: true },
  /** The assignment document, or null while it loads. */
  assignment: { type: Object, default: null },
  /** Which tab is on screen: progress | teams | grading | settings. */
  current: { type: String, required: true },
  isGroup: { type: Boolean, default: false },
  /** Accepted so far, for the invitation's status line. */
  acceptedCount: { type: Number, default: 0 },
  /** A state change is in flight. */
  busy: { type: Boolean, default: false },
  /** Whether Invite link is the view's one solid button (not under the editor). */
  primaryInvite: { type: Boolean, default: true },
})
const emit = defineEmits(['state-action'])

const state = computed(() => props.assignment?.state || null)
const deadline = computed(() => props.assignment?.deadline_at || null)
const deadlinePassed = computed(() => !!deadline.value && Date.parse(deadline.value) < Date.now())
const deadlineRelative = computed(() => (deadline.value ? formatRelative(deadline.value) : ''))
const deadlineAbs = computed(() => (deadline.value ? formatDate(deadline.value, props.assignment?.timezone) : ''))
const actions = computed(() => stateActions({ state: state.value, deadlinePassed: deadlinePassed.value }))

const shareAssignment = computed(() => ({
  ...(props.assignment || {}),
  id: props.assignmentId,
  accepted_count: props.acceptedCount,
}))

const tabs = computed(() => {
  const at = { name: 'assignment-detail', params: { org: props.org, assignmentId: props.assignmentId } }
  return [
    { key: 'progress', label: 'Progress', to: at },
    ...(props.isGroup ? [{ key: 'teams', label: 'Teams', to: { ...at, query: { tab: 'teams' } } }] : []),
    { key: 'grading', label: 'Grading', to: { ...at, query: { tab: 'grading' } } },
    { key: 'settings', label: 'Settings', to: { name: 'assignment-settings', params: { org: props.org, assignmentId: props.assignmentId } } },
  ]
})

const stateMenuOpen = ref(false)
const stateMenuRef = ref(null)
const inviteMenuOpen = ref(false)
const inviteMenuRef = ref(null)

function toggleStateMenu() {
  stateMenuOpen.value = !stateMenuOpen.value
  inviteMenuOpen.value = false
  if (stateMenuOpen.value) keepMenuInView(stateMenuRef)
}
function toggleInviteMenu() {
  inviteMenuOpen.value = !inviteMenuOpen.value
  stateMenuOpen.value = false
  if (inviteMenuOpen.value) keepMenuInView(inviteMenuRef)
}
function choose(key) {
  stateMenuOpen.value = false
  emit('state-action', key)
}
function onDocumentClick(e) {
  if (stateMenuRef.value && !stateMenuRef.value.contains(e.target)) stateMenuOpen.value = false
  if (inviteMenuRef.value && !inviteMenuRef.value.contains(e.target)) inviteMenuOpen.value = false
}
function onKey(e) {
  if (e.key === 'Escape') {
    stateMenuOpen.value = false
    inviteMenuOpen.value = false
  }
}
onMounted(() => {
  document.addEventListener('click', onDocumentClick)
  document.addEventListener('keydown', onKey)
})
onUnmounted(() => {
  document.removeEventListener('click', onDocumentClick)
  document.removeEventListener('keydown', onKey)
})
</script>

<style scoped>
.assignment-head { margin-bottom: var(--space-sm); }
.assignment-head-deadline { display: flex; align-items: baseline; gap: var(--space-xs); flex-wrap: wrap; min-width: 0; }
.assignment-tabs { margin-bottom: var(--space-md); }
.state-menu { left: 0; right: auto; }
</style>
