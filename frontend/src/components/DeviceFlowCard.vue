<template>
  <div class="device-flow-card">
    <p>Go to <a :href="flow.verification_uri" target="_blank" rel="noopener">{{ flow.verification_uri }}</a> and enter:</p>
    <div class="device-code">
      <code>{{ flow.user_code }}</code>
      <button class="btn btn-with-icon" type="button" @click="copyCode" :aria-label="copied ? 'Copied' : 'Copy code'">
        <Icon v-if="copied" name="check" :size="14" />
        <Icon v-else name="copy" :size="14" />
        <span>{{ copied ? 'Copied' : 'Copy' }}</span>
      </button>
    </div>
    <p class="security-notice">
      <strong>Security Notice:</strong> The authorization page should ask you to authorize
      <strong>PXL Classroom Provisioner</strong>. If any other App name appears, do NOT enter the code.
    </p>
    <div class="waiting">
      <div class="spinner"></div>
      <span>Waiting for authorization…</span>
    </div>
    <button class="btn" type="button" @click="emit('cancel')">Cancel</button>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import Icon from './Icon.vue'

const props = defineProps({
  // { verification_uri, user_code, … } from startDeviceFlow()
  flow: { type: Object, required: true },
})
const emit = defineEmits(['cancel'])

const copied = ref(false)
function copyCode() {
  if (!props.flow?.user_code) return
  navigator.clipboard.writeText(props.flow.user_code)
  copied.value = true
  setTimeout(() => { copied.value = false }, 2000)
}
</script>

<style scoped>
.device-flow-card {
  margin-top: var(--space-lg);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-sm);
}
.device-code {
  display: flex;
  align-items: center;
  gap: var(--space-md);
  justify-content: center;
}
.device-code code {
  font-family: var(--font-mono);
  font-size: 1.75rem;
  font-weight: 700;
  letter-spacing: 0.12em;
  color: var(--accent-blue);
  background: var(--bg-tertiary);
  padding: var(--space-sm) var(--space-lg);
  border-radius: var(--radius-md);
  border: 1px solid var(--border-default);
}
.btn-with-icon { display: inline-flex; align-items: center; gap: var(--space-xs); }
.security-notice {
  color: var(--accent-yellow);
  font-size: 0.875rem;
  text-align: left;
  padding: 0.5rem;
  border: 1px solid var(--accent-yellow);
  border-radius: 4px;
  max-width: 420px;
}
.waiting {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  color: var(--text-secondary);
}
.waiting .spinner { width: 18px; height: 18px; border-width: 2px; }
</style>
