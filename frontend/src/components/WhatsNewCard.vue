<template>
  <!-- WHAT CHANGED, ONCE (decided 2026-10-03). The screens a lecturer had
       learnt moved: the organization's tabs, the assignment as one page, the
       state button, Settings as a tab. Five lines of where things are now,
       read once and put away - no link to documentation (DESIGN.md §1.6), and
       not a dialog, so someone who came to do one quick thing is not stopped.
       The page shows it to staff only (DashboardView's `staffVerdict`). -->
  <section v-if="open" class="whats-new card" aria-labelledby="whats-new-title">
    <h3 id="whats-new-title" class="whats-new-title">New look</h3>
    <ul class="whats-new-list">
      <li>Each course has three tabs at the top: Assignments, Roster and Organization.</li>
      <li>An assignment is one page. Progress, Grading and Settings are tabs on it (and Teams for group work).</li>
      <li>To stop accepting, reopen or archive, use the button at the top left that shows the assignment's state.</li>
      <li>The link for students is under Invite link, top right.</li>
      <li>Changes are saved only when you press Save. A dot on Settings means something is not saved yet.</li>
    </ul>
    <div class="whats-new-actions">
      <button class="btn btn-secondary btn-sm" type="button" @click="dismiss">Got it</button>
    </div>
  </section>
</template>

<script setup>
import { ref } from 'vue'
import { buildChannel } from '../lib/channel.js'
import { whatsNewStorage, whatsNewSeen, markWhatsNewSeen } from '../lib/whats-new.js'

const storage = whatsNewStorage(buildChannel())
const open = ref(!whatsNewSeen(storage))

function dismiss() {
  markWhatsNewSeen(storage)
  open.value = false
}
</script>

<style scoped>
.whats-new {
  margin-bottom: var(--space-md);
  padding: var(--space-md) var(--space-lg);
  border-color: var(--tint-accent-emphasis);
  background: var(--tint-accent-subtle);
}
.whats-new-title {
  margin: 0 0 var(--space-xs) 0;
  font-size: 1rem;
}
.whats-new-list {
  margin: 0;
  padding-left: 1.2em;
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 0.88rem;
  max-width: var(--form-measure);
}
.whats-new-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: var(--space-sm);
}
</style>
