<template>
  <!-- NO `fade-in` here, for the reason AdminView gives: it leaves a transform
       on the element, and the roster's dialogs are position: fixed. -->
  <!-- The top bar is the organization's (OrgShell.vue), drawn once for all its pages. -->
  <div>

    <div class="roster-page container">
      <AuthCard v-if="!user" title="Sign in to open the roster" @authenticated="onAuthenticated">
        Sign in with a GitHub account that owns <strong>{{ org }}</strong>.
        Sessions last 8 hours. If you were signed in earlier, it has expired.
      </AuthCard>

      <template v-else>
        <div v-if="loading" class="roster-loading"><div class="spinner"></div></div>
        <!-- A staff surface, gated on reading the private control repository
             (control-repo-access.js) - the roster is in it. -->
        <ControlRepoUnreadable
          v-else-if="access"
          :org="org"
          :access="access"
          :viewer-login="user?.login || ''"
          @retry="load"
        />
        <div v-else-if="loadError" class="roster-load-error">
          <p class="text-secondary">{{ loadError }}</p>
          <button class="btn btn-sm" type="button" @click="load">Retry</button>
        </div>
        <!-- The assignments are passed so the roster can offer "add the
             students who accepted" one of them, and so correcting an address
             can carry the cohorts that hold it (lib/cohort-reidentify.mjs). -->
        <RosterTab v-else ref="rosterTab" :org="org" :assignments="assignments" />
      </template>
    </div>
  </div>
</template>

<script setup>
// The organization's roster, on a page of its own (ARCHITECTURE §10.1).
//
// It was a tab inside the Admin Panel, beside the assignment editor, and that
// placement said something false: the roster is one file per organization
// (`students/roster.yml`), and an assignment admits all of it or a selection
// from it. The editor (RosterTab) is unchanged; what moved is where it lives.

import { ref, watch, onMounted, onUnmounted } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import AuthCard from '../components/AuthCard.vue'
import RosterTab from '../components/RosterTab.vue'
import ControlRepoUnreadable from '../components/ControlRepoUnreadable.vue'
import { getToken, getUser, isAuthenticated } from '../lib/auth.js'
import { markStaff } from '../lib/org-session.js'
import { getRepo, ghApi } from '../lib/api.js'
import { config } from '../lib/config.js'
import { classifyUnreadableControlRepo } from '../lib/control-repo-access.js'
import { loadAssignmentDocs } from '../lib/org-assignments.js'
import { askDiscard } from '../lib/confirm.js'

const props = defineProps({
  org: { type: String, required: true },
})

const user = ref(null)
const loading = ref(true)
const loadError = ref('')
// classifyUnreadableControlRepo()'s verdict when the control repository could
// not be read, null when it could.
const access = ref(null)
const assignments = ref([])
const rosterTab = ref(null)

// The newest load wins: switching organization while one is in flight must not
// let the older answer land on the newer page.
let generation = 0

async function load() {
  const mine = ++generation
  loading.value = true
  loadError.value = ''
  access.value = null
  const token = getToken()
  try {
    const repoRes = await getRepo(token, props.org, config.controlRepo)
    if (mine !== generation) return
    if (!repoRes.ok) {
      if (repoRes.status === 404) {
        const verdict = await classifyUnreadableControlRepo(
          (method, path) => ghApi(token, method, path),
          { org: props.org, hubOwner: config.hubOwner, hubRepo: config.hubRepo },
        )
        if (mine !== generation) return
        access.value = verdict
        markStaff(props.org, false)
      } else {
        loadError.value = `Couldn't read ${props.org}'s control repository (HTTP ${repoRes.status}).`
      }
      return
    }
    // Read the control repository: staff here, and the org's tabs can show.
    markStaff(props.org, true)
    const docs = await loadAssignmentDocs(token, props.org)
    if (mine !== generation) return
    assignments.value = docs
  } catch (e) {
    if (mine !== generation) return
    console.error('Failed to load the roster page', e)
    loadError.value = `Couldn't load ${props.org}'s assignments${e?.status ? ` (HTTP ${e.status})` : ''}.`
  } finally {
    if (mine === generation) loading.value = false
  }
}

function onAuthenticated(authedUser) {
  user.value = authedUser
  load()
}

// A parsed CSV import with an uncommitted diff is unsaved work.
function rosterDirty() {
  return rosterTab.value?.isDirty?.() === true
}
// A promise when it asks: vue-router waits for the answer (lib/confirm.js).
onBeforeRouteLeave(() => !rosterDirty() || askDiscard('The roster import you pasted has not been committed.'))
function onBeforeUnload(e) {
  if (rosterDirty()) {
    e.preventDefault()
    e.returnValue = ''
  }
}

watch(() => props.org, () => { if (user.value) load() })

onMounted(() => {
  // Read by auth-storage's cross-tab reload, which spares a tab with edits.
  window.pxlHasUnsavedState = () => rosterDirty()
  window.addEventListener('beforeunload', onBeforeUnload)
  if (!isAuthenticated()) { loading.value = false; return }
  user.value = getUser()
  load()
})

onUnmounted(() => {
  window.pxlHasUnsavedState = null
  window.removeEventListener('beforeunload', onBeforeUnload)
})
</script>

<style scoped>
.roster-page {
  padding-top: var(--space-xl);
  padding-bottom: var(--space-2xl);
  max-width: 1400px;
}
.roster-loading { display: flex; justify-content: center; padding: var(--space-xl); }
.roster-load-error { text-align: center; padding: var(--space-lg); }
</style>
