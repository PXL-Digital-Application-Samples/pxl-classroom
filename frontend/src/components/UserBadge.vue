<template>
  <div v-if="user" class="user-badge flex items-center gap-sm">
    <img :src="user.avatar_url" :alt="user.login" class="avatar" referrerpolicy="no-referrer" />
    <span>{{ user.login }}</span>
    <button class="btn" @click="emit('logout')" aria-label="Sign out">Sign out</button>
  </div>
</template>

<script setup>
defineProps({
  user: { type: Object, required: false }
})
const emit = defineEmits(['logout'])
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
</style>
