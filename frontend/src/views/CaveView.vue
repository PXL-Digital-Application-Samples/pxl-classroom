<template>
  <div class="cave-page">
    <div class="cave-bar">
      <router-link to="/" class="cave-back-link">
        <Icon name="arrow-left" :size="14" />
        <span>Back</span>
      </router-link>
    </div>
    <div class="cave-frame-container">
      <iframe
        :src="gameUrl"
        class="cave-frame"
        title="Terminal"
        tabindex="0"
      ></iframe>
    </div>
  </div>
</template>

<script setup>
import Icon from '../components/Icon.vue'

const gameUrl = `${import.meta.env.BASE_URL}coolcave/index.html`
</script>

<style scoped>
/* The easter egg (UserBadge, four clicks on the profile picture). The frame
   takes the window's height because the game scales only by whole numbers:
   a fixed 520px frame left room for 1x on a 100% display. */
.cave-page {
  height: 100dvh;
  display: flex;
  flex-direction: column;
  background-color: var(--bg-canvas);
  color: var(--text-primary);
}

.cave-bar {
  padding: var(--space-sm) var(--space-md);
  display: flex;
  align-items: center;
}

.cave-back-link {
  display: inline-flex;
  align-items: center;
  gap: var(--space-xs);
  color: var(--text-secondary);
  font-size: 0.85rem;
  text-decoration: none;
  transition: color 0.15s ease;
}

.cave-back-link:hover {
  color: var(--text-primary);
  text-decoration: none;
}

.cave-frame-container {
  flex: 1;
  min-height: 0;
  display: flex;
  justify-content: center;
  padding: var(--space-md);
}

.cave-frame {
  width: 100%;
  max-width: 1000px;
  height: 100%;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  background-color: transparent;
  box-shadow: var(--shadow-md);
}
</style>
