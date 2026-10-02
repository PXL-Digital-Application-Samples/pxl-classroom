<template>
  <!-- One card per verdict, from the judge the dashboard uses
       (control-repo-access.js). It said "isn't onboarded yet ... (or you
       can't see it)" to everybody, including an owner of the hub org
       looking at a course that had been running for days.
       Shared by the Admin Panel and the Roster page: both are staff surfaces
       over the same private repository, and two copies of this copy is how
       one of them comes to say the old sentence again. -->
  <div class="control-repo-unreadable">
    <template v-if="access?.verdict === 'no-org-access'">
      <h4>{{ org }} is set up, but not for this account</h4>
      <p class="text-secondary">
        Its course data is in a private repository this account can't read.
        Ask an owner of <strong>{{ org }}</strong> to add you as an owner.
        <span v-if="access.budgetOwner && !sameLogin(access.budgetOwner, viewerLogin)">Its budget owner is <strong>@{{ access.budgetOwner }}</strong>.</span>
      </p>
    </template>
    <template v-else-if="access?.verdict === 'unknown'">
      <h4>Couldn't tell whether {{ org }} is set up</h4>
      <p class="text-secondary">
        This account can't read its control repository, and the hub's list of set-up
        organizations didn't load.
      </p>
      <button class="btn btn-sm" type="button" @click="emit('retry')">Retry</button>
    </template>
    <template v-else-if="access?.verdict === 'no-access'">
      <h4>This account can't read {{ org }}'s course data</h4>
      <p class="text-secondary">
        If you teach this course, ask a PXL Classroom administrator to set the organization
        up and to give you access to its control repository.
      </p>
    </template>
    <template v-else>
      <h4>{{ org }} isn't set up yet</h4>
      <p class="text-secondary">
        There is no <code>{{ org }}/{{ config.controlRepo }}</code> repository yet.
        <template v-if="access?.hubWritable">Set it up from this organization's overview.</template>
        <template v-else>A hub admin sets it up by running <strong>Setup Organization</strong>.</template>
      </p>
    </template>
  </div>
</template>

<script setup>
import { config } from '../lib/config.js'
import { sameLogin } from '../../../lib/github-login.mjs'

defineProps({
  org: { type: String, required: true },
  /** classifyUnreadableControlRepo()'s answer, or null while it is unknown. */
  access: { type: Object, default: null },
  /** The signed-in login, so the budget owner is not named back to themselves. */
  viewerLogin: { type: String, default: '' },
})
const emit = defineEmits(['retry'])
</script>

<style scoped>
.control-repo-unreadable {
  padding: var(--space-md);
  border: 1px dashed var(--accent-red);
  border-radius: var(--radius-md);
  text-align: center;
}
.control-repo-unreadable h4 { margin: 0 0 var(--space-xs) 0; }
.control-repo-unreadable p {
  font-size: 0.85rem;
  margin: 0 0 var(--space-sm) 0;
  line-height: 1.4;
}
</style>
