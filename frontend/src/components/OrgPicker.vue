<template>
  <!-- The organization this page is about, and the way to another one. In the
       shared top bar of every page of an org (OrgShell.vue); it was the
       dashboard's own until 2026-10-03, which is why the other pages had a
       plain breadcrumb instead. Choosing an org opens its assignments. -->
  <div class="org-dropdown-container" ref="rootRef">
    <button
      type="button"
      class="org-dropdown-btn"
      @click.stop="toggle"
      :aria-expanded="open"
      aria-haspopup="listbox"
      aria-label="Select organization"
      :title="org || 'Select organization…'"
    >
      <span class="flex items-center gap-sm">
        <span class="status-lamp" :class="`lamp-${orgStatus(org)}`" :title="orgStatusTitle(org)"></span>
        <span class="org-label" :title="org">{{ org || 'Select organization…' }}</span>
      </span>
      <Icon :name="open ? 'chevron-up' : 'chevron-down'" :size="12" class="dropdown-chevron" />
    </button>

    <div v-if="open" class="org-dropdown-menu" role="listbox" aria-label="Organizations" tabindex="-1">
      <!-- `orgOption`, not `org`: this component has a String prop called
           `org`, and a loop variable of the same name holding an OBJECT
           shadowed it. Correct only for as long as every `.login` stays inside
           the loop - move one line out and it renders empty, with no error. -->
      <div
        v-for="orgOption in ordered"
        :key="orgOption.login"
        class="org-dropdown-item org-choice-item"
        :class="{ 'is-selected': orgOption.login === org }"
        role="option"
        :aria-selected="orgOption.login === org"
        :title="orgOption.login"
        @click="choose(orgOption.login)"
        @keydown.enter.prevent="choose(orgOption.login)"
        @keydown.space.prevent="choose(orgOption.login)"
        tabindex="0"
      >
        <span class="status-lamp" :class="`lamp-${orgStatus(orgOption.login)}`" :title="orgStatusTitle(orgOption.login)"></span>
        <span class="org-item-text">{{ orgOption.login }}</span>
        <Icon v-if="orgOption.login === org" name="check" :size="13" class="check-icon" />
      </div>

      <div class="org-dropdown-divider" role="separator"></div>
      <a
        :href="APP_INSTALL_URL"
        target="_blank"
        rel="noopener"
        class="org-dropdown-item org-connect-item"
        role="option"
        aria-selected="false"
        @click="onConnect"
      >
        <Icon name="plus" :size="13" />
        <span class="org-item-text">Connect an organization</span>
        <Icon name="external-link" :size="12" class="check-icon" />
      </a>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import Icon from './Icon.vue'
import { APP_INSTALL_URL } from '../../../lib/audit.mjs'
import { lampRank, orderOrgsForSwitcher } from '../lib/org-order.js'
import { normalizeLogin } from '../../../lib/github-login.mjs'
import { orgs, orgStatus, orgStatusTitle, connectPending, rememberOrg } from '../lib/org-session.js'

const props = defineProps({
  /** The organization on screen; empty on /dashboard before one is chosen. */
  org: { type: String, default: '' },
})

const router = useRouter()
const open = ref(false)
const rootRef = ref(null)

// FROZEN WHILE THE MENU IS OPEN. The lamps arrive one fetch per org after the
// list does, and re-sorting under the pointer moves the row a lecturer is about
// to click. The order is taken when the menu opens; an org that appears while
// it is open sorts by its live lamp.
let menuRanks = null
const liveRank = (login) => lampRank(orgStatus(login))
const ordered = computed(() => {
  const isOpen = open.value
  return orderOrgsForSwitcher(orgs.value, (login) => {
    const key = normalizeLogin(login)
    return isOpen && menuRanks?.has(key) ? menuRanks.get(key) : liveRank(login)
  })
})

function toggle() {
  if (!open.value) menuRanks = new Map(orgs.value.map((o) => [normalizeLogin(o.login), liveRank(o.login)]))
  open.value = !open.value
}

function choose(login) {
  open.value = false
  rememberOrg(login)
  if (login !== props.org) router.push({ name: 'dashboard', params: { org: login } })
}

function onConnect() {
  connectPending.value = true
  open.value = false
}

function onOutside(e) {
  if (rootRef.value && !rootRef.value.contains(e.target)) open.value = false
}
function onKey(e) {
  if (e.key === 'Escape') open.value = false
}
onMounted(() => {
  window.addEventListener('click', onOutside)
  window.addEventListener('keydown', onKey)
})
onUnmounted(() => {
  window.removeEventListener('click', onOutside)
  window.removeEventListener('keydown', onKey)
})
</script>

<style scoped>
.org-dropdown-divider {
  height: 1px;
  background: var(--border-muted);
  margin: var(--space-xs) 0;
}
/* Distinguished from the org rows: this one leaves the app. */
.org-connect-item {
  color: var(--accent-blue);
  text-decoration: none;
  font-weight: 500;
}
.org-connect-item:hover {
  text-decoration: none;
}

.org-dropdown-container {
  position: relative;
  /* No hard floor: this sits in the header, so a fixed min-width forces the
     whole bar wider than a narrow viewport. The org name truncates instead.
     Accommodates up to GitHub's 39-character max org name on desktop. */
  min-width: 0;
  max-width: min(390px, calc(100vw - 320px));
}

.org-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.org-dropdown-btn {
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-sm);
  background: var(--bg-canvas);
  border: 1px solid var(--border-default);
  color: var(--text-primary);
  padding: 3px 10px;
  border-radius: var(--radius-sm);
  font-size: 0.85rem;
  font-weight: 500;
  cursor: pointer;
  width: 100%;
  min-height: 28px;
  transition: border-color 0.12s, background-color 0.12s;
}
.org-dropdown-btn > span:first-child {
  min-width: 0;
  overflow: hidden;
}
.org-dropdown-btn:hover {
  border-color: var(--text-muted);
  background: var(--bg-surface-hover);
}
.org-dropdown-btn:focus-visible {
  outline: 2px solid var(--accent-blue);
  outline-offset: 1px;
}

.org-dropdown-menu {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  min-width: 100%;
  width: max-content;
  max-width: min(420px, calc(100vw - 32px));
  background: var(--bg-surface-elevated);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-md);
  z-index: 100;
  max-height: 280px;
  overflow-y: auto;
  padding: 4px;
}

.org-dropdown-item {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  padding: 6px 10px;
  border-radius: var(--radius-xs);
  font-size: 0.85rem;
  color: var(--text-primary);
  cursor: pointer;
  white-space: nowrap;
  transition: background-color 0.1s;
}
.org-dropdown-item:hover,
.org-dropdown-item:focus-visible {
  background: var(--bg-surface-hover);
  outline: none;
}

/* An actual organization to switch to, as opposed to the action rows below
   the divider. Named rather than left as ":not(.org-connect-item)", which
   silently counted the second action row as a 101st organization. */
.org-choice-item { cursor: pointer; }
.org-dropdown-item.is-selected {
  font-weight: 600;
  color: var(--accent-blue);
}

.check-icon {
  margin-left: auto;
  color: var(--accent-blue);
}

.dropdown-chevron {
  color: var(--text-muted);
  flex-shrink: 0;
}

/* Status Lamp Indicators */
.status-lamp {
  display: inline-block;
  width: 7px;
  height: 7px;
  min-width: 7px;
  min-height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
  box-sizing: border-box;
}
.lamp-active {
  background-color: var(--accent-green);
  box-shadow: 0 0 5px var(--tint-success-emphasis);
}
.lamp-inactive {
  background-color: var(--accent-yellow);
  opacity: 0.85;
}
.lamp-empty {
  background-color: transparent;
  border: 1.5px solid var(--border-strong);
  opacity: 0.7;
}
/* Declared, because `lamp-${status}` composes the class name from data and an
   undeclared class renders unstyled with no error (DESIGN.md §7). Hollow like
   `empty` rather than red: not being staff on an organization is not a fault
   condition, it is simply not yours. */
.lamp-no-access {
  background-color: transparent;
  border: 1.5px dashed var(--border-strong);
  opacity: 0.55;
}
.lamp-unknown {
  background-color: var(--border-default);
  opacity: 0.5;
}

@media (max-width: 640px) {
  .org-dropdown-container { max-width: 240px; }
}
@media (max-width: 420px) {
  .org-dropdown-container { max-width: 170px; }
}
</style>
