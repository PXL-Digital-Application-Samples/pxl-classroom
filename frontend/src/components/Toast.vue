<template>
  <div class="toast-container">
    <TransitionGroup name="toast">
      <div
        v-for="t in toasts"
        :key="t.id"
        :class="['toast', `toast-${t.type}`]"
        :role="t.type === 'error' ? 'alert' : 'status'"
        @mouseenter="pauseToast(t.id)"
        @mouseleave="resumeToast(t.id)"
      >
        <span class="toast-message">{{ t.message }}</span>
        <button class="toast-close" type="button" @click="dismissToast(t.id)" aria-label="Dismiss notification">×</button>
      </div>
    </TransitionGroup>
  </div>
</template>

<script setup>
import { toasts, dismissToast, pauseToast, resumeToast } from '../lib/toast.js'
</script>

<style scoped>
.toast-container {
  position: fixed;
  bottom: 24px;
  right: 24px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  z-index: 9999;
  max-width: min(420px, calc(100vw - 48px));
}
.toast {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 12px 12px 12px 24px;
  border-radius: 8px;
  color: white;
  font-weight: 500;
  box-shadow: 0 4px 12px rgba(0,0,0,0.15);
}
.toast-message { flex: 1; }
.toast-close {
  background: none;
  border: none;
  color: inherit;
  opacity: 0.75;
  cursor: pointer;
  font-size: 1.15rem;
  line-height: 1;
  padding: 0 4px;
  flex-shrink: 0;
}
.toast-close:hover { opacity: 1; }
.toast-success { background: var(--accent-green, #238636); }
.toast-error { background: var(--accent-red, #da3633); }
.toast-info { background: var(--accent-blue, #1f6feb); }

.toast-enter-active,
.toast-leave-active {
  transition: all 0.3s ease;
}
.toast-enter-from {
  opacity: 0;
  transform: translateX(30px);
}
.toast-leave-to {
  opacity: 0;
  transform: scale(0.9);
}
</style>
