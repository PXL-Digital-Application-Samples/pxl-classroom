<template>
  <div class="center-card fade-in">
    <h2>{{ title }}</h2>
    <p class="text-secondary">
      <slot />
    </p>

    <!-- Sign-in failures render inside the card, never as a page-level error
         state - a signed-out view must never show a data-shaped empty state. -->
    <p v-if="authError" class="auth-error" role="alert">{{ authError }}. Try signing in again.</p>

    <button class="btn btn-primary btn-lg btn-with-icon" :disabled="authLoading" @click="startLogin">
      <template v-if="authLoading">
        <span class="spinner spinner-sm"></span>
        <span>Waiting…</span>
      </template>
      <template v-else>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
        </svg>
        <span>Sign in with GitHub</span>
      </template>
    </button>

    <DeviceFlowCard v-if="deviceFlow" :flow="deviceFlow" @cancel="cancelLogin" />
  </div>
</template>

<script setup>
import { onUnmounted, ref } from 'vue'
import DeviceFlowCard from './DeviceFlowCard.vue'
import { config } from '../lib/config.js'
import { pollDeviceFlow, startDeviceFlow } from '../lib/auth.js'

// The one sign-in surface. Seven views previously carried a verbatim copy of
// this markup AND of startLogin/cancelLogin, differing only in what they ran
// after a successful login - which is what @authenticated is for.
defineProps({
  title: { type: String, default: 'Sign in with GitHub' },
})

const emit = defineEmits(['authenticated'])

const deviceFlow = ref(null)
const authLoading = ref(false)
const authError = ref(null)
let pollAbort = null

async function startLogin() {
  authError.value = null
  if (!config.clientId) {
    authError.value = 'GitHub App Client ID is not configured. Set VITE_GITHUB_CLIENT_ID'
    return
  }
  authLoading.value = true
  try {
    const flow = await startDeviceFlow(config.clientId)
    deviceFlow.value = flow
    pollAbort = new AbortController()
    const result = await pollDeviceFlow(config.clientId, flow.device_code, flow.interval, pollAbort.signal)
    deviceFlow.value = null
    emit('authenticated', result.user)
  } catch (e) {
    if (e.message !== 'Cancelled') authError.value = e.message
    deviceFlow.value = null
  }
  authLoading.value = false
}

function cancelLogin() {
  if (pollAbort) pollAbort.abort()
  deviceFlow.value = null
  authLoading.value = false
}

// Only AssignmentView used to do this, so navigating away mid-device-flow left
// a poll running on the other six views. Owning the flow here fixes all of them.
onUnmounted(() => {
  if (pollAbort) pollAbort.abort()
})
</script>
