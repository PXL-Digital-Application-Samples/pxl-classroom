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
.cave-page {
  min-height: 100vh;
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
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-md);
}

.cave-frame {
  width: 100%;
  max-width: 640px;
  height: 520px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  background-color: transparent;
  box-shadow: var(--shadow-md);
}
</style>
