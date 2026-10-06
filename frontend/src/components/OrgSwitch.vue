<template>
  <!-- An organization's three staff views: Assignments (the list, and every
       tab of one assignment, its settings included), Roster, and Organization
       (what is the organization's own: what needs the lecturer, course
       activity, health, usage, connection). BETA-UX.md, 2026-10-02: there is no
       Admin view any more; the editor is each assignment's Settings tab.

       Inside an assignment, Assignments stays lit and still leads back to the
       list, since that is where it goes from anywhere else too.

       Same chrome as before (style.css, `.app-header-switch`). -->
  <nav class="app-header-switch" aria-label="Course views">
    <span v-if="current === 'assignments' && !assignmentId" class="primer-tab active" aria-current="page">Assignments</span>
    <router-link
      v-else
      :to="{ name: 'dashboard', params: { org } }"
      :class="['primer-tab', { active: current === 'assignments' }]"
    >Assignments</router-link>
    <span v-if="current === 'roster'" class="primer-tab active" aria-current="page">Roster</span>
    <router-link v-else :to="{ name: 'roster', params: { org } }" class="primer-tab">Roster</router-link>
    <span v-if="current === 'organization'" class="primer-tab active" aria-current="page">Organization<span v-if="needsYou" class="tab-count" :aria-label="countLabel">{{ needsYou }}</span></span>
    <router-link v-else :to="{ name: 'organization', params: { org } }" class="primer-tab">Organization<span v-if="needsYou" class="tab-count" :aria-label="countLabel">{{ needsYou }}</span></router-link>
  </nav>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  org: { type: String, required: true },
  /** Which of the three is on screen. */
  current: { type: String, required: true, validator: (v) => ['assignments', 'roster', 'organization'].includes(v) },
  /** The assignment on screen, if any: Assignments then leads back to the list. */
  assignmentId: { type: String, default: '' },
  /**
   * How many things need the lecturer (lib/org-notices.mjs), shown on the
   * Organization tab from every page of the org. Null is unknown: nothing shown.
   */
  needsYou: { type: Number, default: null },
})

const countLabel = computed(() => (props.needsYou === 1 ? '1 thing needs you' : `${props.needsYou} things need you`))
</script>
