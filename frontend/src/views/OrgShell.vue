<template>
  <!-- ONE TOP BAR FOR EVERY PAGE OF AN ORGANIZATION (BETA-UX.md, 2026-10-03).
       Every page drew its own, so a click rebuilt the bar, the tabs waited for
       the new page to load before they reappeared, and they sat wherever that
       page's breadcrumb ended. This is the route the org's pages are children
       of: the bar is drawn once and only the page below it is swapped. -->
  <div class="org-shell">
    <AppHeader :user="user" @logout="handleLogout">
      <template #left>
        <div class="app-header-crumbs flex items-center gap-sm">
          <router-link to="/" class="app-header-logo-link" aria-label="PXL Classroom home">
            <img :src="logoUrl" alt="" class="header-logo" />
          </router-link>
          <OrgPicker v-if="user" :org="org" />
          <template v-if="crumb">
            <span class="app-header-sep">/</span>
            <h1 class="app-header-heading" :title="crumb">{{ crumb }}</h1>
          </template>
        </div>
      </template>
      <!-- Always present, so the bar keeps its three columns and nothing moves
           when the tabs arrive. The tabs themselves only once this session has
           seen the account act as staff in this org (lib/org-session.js): a
           student whose installation reaches the org must never see them. -->
      <template #center>
        <OrgSwitch v-if="showTabs" :org="org" :current="current" :assignment-id="belowList" />
      </template>
    </AppHeader>

    <router-view />
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AppHeader from '../components/AppHeader.vue'
import OrgPicker from '../components/OrgPicker.vue'
import OrgSwitch from '../components/OrgSwitch.vue'
import logoUrl from '../assets/logo.png'
import { clearAuth, getToken, getUser, onAuthChange } from '../lib/auth.js'
import { forgetOrgSession, knownStaff, loadOrgs } from '../lib/org-session.js'

const route = useRoute()
const router = useRouter()
const user = ref(getUser())

const org = computed(() => String(route.params.org || ''))
const assignmentId = computed(() => String(route.params.assignmentId || ''))

// Which of the three views the page below belongs to. An assignment's own tabs
// (Progress, Teams, Grading, Settings) and a new assignment are Assignments.
const current = computed(() => {
  const name = String(route.name || '')
  if (name === 'roster') return 'roster'
  if (name === 'organization' || name === 'usage-org') return 'organization'
  return 'assignments'
})

// Where you are below the organization, when the tab does not say it already.
const crumb = computed(() => {
  const name = String(route.name || '')
  if (name === 'assignment-detail') return assignmentId.value
  if (name === 'assignment-new') return 'New assignment'
  if (name === 'usage-org') return 'Usage'
  return ''
})

const showTabs = computed(() => !!user.value && knownStaff(org.value))

// Something under Assignments other than the list itself - an assignment, or a
// new one - so its tab stays lit AND leads back to the list (OrgSwitch).
const belowList = computed(() => {
  const name = String(route.name || '')
  if (current.value !== 'assignments' || name === 'dashboard' || name === 'dashboard-home') return ''
  return assignmentId.value || 'new'
})

function refreshUser() {
  user.value = getUser()
  if (user.value) loadOrgs(getToken())
}

let stopListening = null
onMounted(() => {
  stopListening = onAuthChange(refreshUser)
  if (user.value) loadOrgs(getToken())
})
onUnmounted(() => stopListening?.())

// A page's own sign-in card can complete after this mounted.
watch(() => route.fullPath, () => {
  if (!user.value && getUser()) refreshUser()
})

function handleLogout() {
  clearAuth()
  forgetOrgSession()
  // In the app, not a page load: the sign-in page is a route, and a reload
  // would only re-read what was just cleared.
  router.push({ name: 'home' })
}
</script>

<style scoped>
.org-shell {
  min-height: 100vh;
}
</style>
