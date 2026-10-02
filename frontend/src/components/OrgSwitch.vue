<template>
  <!-- An organization's two staff views: its assignments (the dashboard) and its
       roster. The roster was a tab inside the Admin Panel, beside the
       assignment editor, which read as though it belonged to the assignments;
       it is one file per org, and every assignment admits all of it or a
       selection from it. Same chrome as an assignment's Overview / Admin
       switch (style.css, `.app-header-switch`). -->
  <nav class="app-header-switch" aria-label="Course views">
    <span v-if="current === 'assignments'" class="primer-tab active" aria-current="page">Assignments</span>
    <router-link v-else :to="{ name: 'dashboard', params: { org } }" class="primer-tab">Assignments</router-link>
    <span v-if="current === 'roster'" class="primer-tab active" aria-current="page">Roster</span>
    <router-link v-else :to="{ name: 'roster', params: { org } }" class="primer-tab">Roster</router-link>
  </nav>
</template>

<script setup>
defineProps({
  org: { type: String, required: true },
  /** Which of the two is on screen: 'assignments' or 'roster'. */
  current: { type: String, required: true, validator: (v) => ['assignments', 'roster'].includes(v) },
})
</script>
