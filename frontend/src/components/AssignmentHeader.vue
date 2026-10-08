<template>
  <!-- ONE ASSIGNMENT, ONE HEADER, ON EVERY TAB (BETA-UX.md, 2026-10-02):
       its state - a button carrying the lifecycle - its deadline, the link
       students accept with, and the tabs. Shared by the assignment page
       (Progress / Teams / Grading) and the editor (Settings), which are two
       routes: the header is what makes them read as one place. -->
  <div>
    <div class="assignment-head flex items-center justify-between flex-wrap gap-sm">
      <div class="flex items-center gap-sm flex-wrap">
        <!-- The way back to the cards, first in the row (style.css,
             `.back-to-list`), and set apart from the assignment's own
             controls by a rule: it leaves this page, they act on it. -->
        <router-link :to="{ name: 'dashboard', params: { org } }" class="btn btn-ghost btn-sm btn-with-icon back-to-list">
          <Icon name="arrow-left" :size="13" />
          <span>Assignments</span>
        </router-link>
        <span class="assignment-head-rule" aria-hidden="true"></span>
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
           the popover is secondary. On Settings it steps down only while Save
           is the solid one: once a field is edited, or wherever saving is the
           next step anyway (a draft). Offered for a draft too: it has no link yet,
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
          <InvitationShare
            :org="org"
            :assignment="shareAssignment"
            variant="popover"
            :resolve="!linkRetired"
            :regenerable="state === 'published'"
            @regenerate="choose('regenerate')"
          />
        </div>
      </div>
    </div>

    <!-- WHILE STUDENTS DO NOT SEE WHAT IS SAVED, said on every tab - worked
         out from facts (composables/useStudentPageStatus.js), so it is there
         after a refresh too (2026-10-08: the only status was a toast). Not on
         Settings, which shows the same with its steps. Nothing when they do. -->
    <p v-if="studentLine && current !== 'settings'" class="status-indicator student-page-line" role="status" :data-student-page="studentPage.state">
      <span v-if="studentPage.state === 'updating'" class="spinner-sm" aria-hidden="true"></span>
      <span v-else :class="['status-dot', studentPage.state === 'failed' ? 'dot-danger' : 'dot-warning']" aria-hidden="true"></span>
      <span>{{ studentLine }}</span>
      <button
        v-if="studentPage.state === 'stuck' || studentPage.state === 'failed'"
        class="btn btn-secondary btn-sm"
        type="button"
        @click="emit('update-student-page')"
      >{{ studentPage.state === 'failed' ? 'Try again' : 'Update the student page now' }}</button>
    </p>

    <!-- The tab is in the address: Progress has none, Teams and Grading are
         `?tab=`, Settings is its own page (the editor). -->
    <nav class="primer-tabs assignment-tabs" aria-label="Assignment sections">
      <!-- `custom`: the tabs are one route told apart by `?tab=`, and the
           router ignores the query when it decides a link is the current page,
           so every tab was marked `aria-current="page"` at once. Which tab is
           current is this component's to say, from `current`. -->
      <!-- Settings carries a dot while it holds unsaved edits: the editor is
           kept on a look at another tab, and without this nothing there says
           the edits are still waiting. -->
      <template v-for="t in tabs" :key="t.key">
        <!-- The label is written flush against its tags: a line break there is
             a space in the text, and the tab's name is matched on that text. -->
        <span v-if="t.key === current" class="primer-tab active" aria-current="page">{{ t.label }}<template v-if="t.key === 'settings' && settingsUnsaved"><span class="status-dot dot-warning" title="Unsaved changes" aria-hidden="true"></span><span class="sr-only"> (unsaved changes)</span></template></span>
        <router-link v-else :to="t.to" custom v-slot="{ href, navigate }">
          <a :href="href" class="primer-tab" @click="navigate($event)">{{ t.label }}<template v-if="t.key === 'settings' && settingsUnsaved"><span class="status-dot dot-warning" title="Unsaved changes" aria-hidden="true"></span><span class="sr-only"> (unsaved changes)</span></template></a>
        </router-link>
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
import { stateActions, everPublished } from '../lib/state-actions.js'
import { keepMenuInView } from '../lib/menu-position.js'
import { studentPageLine } from '../lib/student-page-status.js'

const props = defineProps({
  org: { type: String, required: true },
  assignmentId: { type: String, required: true },
  /** The assignment document, or null while it loads. */
  assignment: { type: Object, default: null },
  /** Which tab is on screen: progress | teams | grading | settings. */
  current: { type: String, required: true },
  isGroup: { type: Boolean, default: false },
  /** Accepted so far, for the invitation's status line. */
  // null when the report could not be read: unknown, never zero (DESIGN.md §1.5).
  acceptedCount: { type: Number, default: null },
  /** A state change is in flight. */
  busy: { type: Boolean, default: false },
  /** Whether Invite link is the view's one solid button (not under the editor). */
  primaryInvite: { type: Boolean, default: true },
  /** An invitation secret just regenerated away, not to be offered again. */
  retiredInviteKey: { type: String, default: '' },
  /** The Settings tab holds edits nobody has saved yet. */
  settingsUnsaved: { type: Boolean, default: false },
  /** Do students see what is saved (lib/student-page-status.js), or null. */
  studentPage: { type: Object, default: null },
})
const emit = defineEmits(['state-action', 'update-student-page'])

const studentLine = computed(() => (props.studentPage ? studentPageLine(props.studentPage) : ''))

const state = computed(() => props.assignment?.state || null)
const deadline = computed(() => props.assignment?.deadline_at || null)
const deadlinePassed = computed(() => !!deadline.value && Date.parse(deadline.value) < Date.now())
const deadlineRelative = computed(() => (deadline.value ? formatRelative(deadline.value) : ''))
const deadlineAbs = computed(() => (deadline.value ? formatDate(deadline.value, props.assignment?.timezone) : ''))
const actions = computed(() => stateActions({
  state: state.value,
  deadlinePassed: deadlinePassed.value,
  everPublished: everPublished(props.assignment),
}))

// A link just regenerated is retired at once, while the stored assignment still
// holds it until the workflow writes the new one. Offering it would hand out a
// link the broker now refuses, so it is withheld - here and in the read the
// popover would otherwise make for itself (`resolve`).
const linkRetired = computed(() => {
  const held = props.assignment?.invite_key || props.assignment?.invite_token || ''
  return !!props.retiredInviteKey && held === props.retiredInviteKey
})
const shareAssignment = computed(() => ({
  ...(props.assignment || {}),
  ...(linkRetired.value ? { invite_key: null, invite_token: null } : {}),
  id: props.assignmentId,
  accepted_count: props.acceptedCount,
}))

const tabs = computed(() => {
  const at = { name: 'assignment-detail', params: { org: props.org, assignmentId: props.assignmentId } }
  return [
    { key: 'progress', label: 'Progress', to: at },
    ...(props.isGroup ? [{ key: 'teams', label: 'Teams', to: { ...at, query: { tab: 'teams' } } }] : []),
    { key: 'grading', label: 'Grading', to: { ...at, query: { tab: 'grading' } } },
    { key: 'settings', label: 'Settings', to: { ...at, query: { tab: 'settings' } } },
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
  inviteMenuOpen.value = false
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
.student-page-line {
  flex-wrap: wrap;
  margin: 0 0 var(--space-sm);
  font-size: 0.875rem;
  color: var(--text-secondary);
}
.assignment-head-deadline { display: flex; align-items: baseline; gap: var(--space-xs); flex-wrap: wrap; min-width: 0; }
/* A divider, not a box (DESIGN.md §1.1): between the way out and the
   assignment's own controls, the height of the buttons' text. */
.assignment-head-rule { width: 1px; height: 16px; background: var(--border-default); }
.assignment-tabs { margin-bottom: var(--space-md); }
.state-menu { left: 0; right: auto; }
</style>
