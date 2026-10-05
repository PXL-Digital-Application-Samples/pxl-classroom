<template>
  <!-- WHAT CHANGED, ONCE (decided 2026-10-03). The screens a lecturer had
       learnt moved: the organization's tabs, the assignment as one page, the
       state button, Settings as a tab. Five lines of where things are now,
       read once and put away - no link to documentation (DESIGN.md §1.6), and
       not a dialog, so someone who came to do one quick thing is not stopped.
       The page shows it to staff only (DashboardView's `staffVerdict`). -->
  <section v-if="open" class="whats-new card" aria-labelledby="whats-new-title">
    <!-- Three plain sentences (decided 2026-10-05), replacing five bullets.
         The fifth bullet said "Changes are saved only when you press Save",
         which is true of the Settings tab alone: a team, a move, a copy, the
         state button and the roster save as soon as the lecturer acts. Saying
         which is which is the one thing here a lecturer can get wrong. -->
    <h3 id="whats-new-title" class="whats-new-title">This page changed.</h3>
    <p class="whats-new-text">
      Admin is gone: each assignment now has its own tabs, and its settings are
      on the Settings tab, which saves when you press Save. Everything else -
      teams, the state button at the top left, the roster - saves as soon as you act.
    </p>
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
.whats-new-text {
  margin: 0;
  font-size: 0.88rem;
  line-height: 1.5;
  max-width: var(--form-measure);
}
.whats-new-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: var(--space-sm);
}
</style>
