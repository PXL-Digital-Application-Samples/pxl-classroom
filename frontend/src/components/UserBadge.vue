<template>
  <div v-if="user" class="user-badge flex items-center gap-sm">
    <img :src="user.avatar_url" :alt="user.login" class="avatar" referrerpolicy="no-referrer" />
    <span class="login-wrap">
      {{ user.login }}
      <small v-if="expiryLabel" class="expiry" :title="expiryTitle">{{ expiryLabel }}</small>
    </span>
    <button class="btn" @click="emit('logout')" aria-label="Sign out">Sign out</button>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { getTokenExpiry } from '../lib/auth.js'

defineProps({
  user: { type: Object, required: false }
})
const emit = defineEmits(['logout'])

// Device-flow tokens live ~8h and there is no refresh — show the remaining
// time so expiry isn't a surprise mid-session. Ticks once a minute.
const now = ref(Date.now())
let timer = null
onMounted(() => { timer = setInterval(() => { now.value = Date.now() }, 60_000) })
onBeforeUnmount(() => { if (timer) clearInterval(timer) })

const remainingMs = computed(() => {
  const exp = getTokenExpiry()
  return exp ? exp.getTime() - now.value : null
})

const expiryLabel = computed(() => {
  if (remainingMs.value == null) return ''
  const mins = Math.max(0, Math.round(remainingMs.value / 60_000))
  if (mins >= 90) return `session ${Math.round(mins / 60)}h`
  return `session ${mins}m`
})

const expiryTitle = computed(() => {
  const exp = getTokenExpiry()
  return exp ? `Signed-in session ends ${exp.toLocaleTimeString()}. You'll need to sign in again after that.` : ''
})
</script>

<style scoped>
.user-badge {
  font-size: 0.875rem;
}
.avatar {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  border: 2px solid var(--border-default);
}
.login-wrap { display: flex; flex-direction: column; line-height: 1.2; }
.expiry { color: var(--text-muted); font-size: 0.68rem; }
</style>
