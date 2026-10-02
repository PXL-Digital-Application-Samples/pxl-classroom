<template>
  <!-- An organization's three staff views: Assignments (the dashboard and each
       assignment's overview), Roster, and Admin (the assignment editor). One
       control on every page of the org, where there used to be two that took
       turns: an assignment's Overview / Admin switch and the org's
       Assignments / Roster one.

       THE ASSIGNMENT TRAVELS, both ways. The most-used move is between one
       assignment's results and its settings, so from lab-3's overview Admin
       opens lab-3 in the editor (`?edit=`), and from the editor with lab-3
       open Assignments goes back to lab-3's overview rather than the list.
       The list is always one click away in the breadcrumb.

       Same chrome as before (style.css, `.app-header-switch`). -->
  <nav class="app-header-switch" aria-label="Course views">
    <span v-if="current === 'assignments'" class="primer-tab active" aria-current="page">Assignments</span>
    <router-link v-else :to="assignmentsTarget" class="primer-tab">Assignments</router-link>
    <span v-if="current === 'roster'" class="primer-tab active" aria-current="page">Roster</span>
    <router-link v-else :to="{ name: 'roster', params: { org } }" class="primer-tab">Roster</router-link>
    <span v-if="current === 'admin'" class="primer-tab active" aria-current="page">Admin</span>
    <router-link v-else :to="adminTarget" class="primer-tab">Admin</router-link>
  </nav>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  org: { type: String, required: true },
  /** Which of the three is on screen. */
  current: { type: String, required: true, validator: (v) => ['assignments', 'roster', 'admin'].includes(v) },
  /** The assignment on screen, if any: carried to the other view of it. */
  assignmentId: { type: String, default: '' },
})

const assignmentsTarget = computed(() => (props.assignmentId
  ? { name: 'assignment-detail', params: { org: props.org, assignmentId: props.assignmentId } }
  : { name: 'dashboard', params: { org: props.org } }))

const adminTarget = computed(() => (props.assignmentId
  ? { name: 'admin', params: { org: props.org }, query: { edit: props.assignmentId } }
  : { name: 'admin', params: { org: props.org } }))
</script>
