<template>
  <!-- Which step a student's request is at, and - once waiting stops being
       the likely explanation - a way to send it again. Shared by the
       individual page and the team card so they cannot say different things
       about the same request (frontend/src/lib/acceptance-progress.js). -->
  <div v-if="steps.length" class="attempt-progress" role="status">
    <ol class="attempt-steps">
      <li v-for="s in steps" :key="s.label" :class="['attempt-step', `attempt-step-${s.state}`]">
        <Icon :name="ICON[s.state]" :size="16" />
        <span>{{ s.label }}</span>
      </li>
    </ol>
    <p v-if="message" class="text-secondary">{{ message }}</p>
    <div v-if="canRetry" class="attempt-retry">
      <p class="text-muted">Sending it again is safe: whatever the first one does later changes nothing.</p>
      <button class="btn btn-primary" type="button" :disabled="busy" @click="$emit('retry')">
        {{ busy ? 'Sending…' : 'Send it again' }}
      </button>
    </div>
  </div>
</template>

<script setup>
import Icon from './Icon.vue'

defineProps({
  /** progressSteps(step) */
  steps: { type: Array, required: true },
  /** progressMessage(step), or null */
  message: { type: String, default: null },
  canRetry: { type: Boolean, default: false },
  busy: { type: Boolean, default: false },
})
defineEmits(['retry'])

const ICON = { done: 'check', current: 'clock', todo: 'more-horizontal', failed: 'x' }
</script>

<style scoped>
.attempt-progress {
  margin: var(--space-md) auto 0;
  max-width: 420px;
  text-align: left;
}

.attempt-steps {
  list-style: none;
  margin: 0 0 var(--space-sm);
  padding: 0;
  display: grid;
  gap: var(--space-xs);
}

.attempt-step {
  display: flex;
  align-items: center;
  gap: var(--space-xs);
  color: var(--text-muted);
}

.attempt-step-done {
  color: var(--accent-green);
}

.attempt-step-current {
  color: var(--text-primary);
  font-weight: 600;
}

.attempt-step-failed {
  color: var(--accent-red);
  font-weight: 600;
}

.attempt-retry {
  margin-top: var(--space-sm);
  text-align: center;
}
</style>
