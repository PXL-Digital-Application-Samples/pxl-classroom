<template>
  <div class="not-found-page">
    <AppHeader :sticky="false" />

    <div class="not-found">
      <div class="container">
        <h1>404</h1>
        <p>Page not found.</p>
        <router-link to="/" class="btn btn-primary">Go home</router-link>
      </div>
    </div>
  </div>
</template>

<script setup>
import AppHeader from '../components/AppHeader.vue'
</script>

<style scoped>
/* The header takes its own space, so the centred block fills what is left
   rather than a full viewport height. */
.not-found {
  min-height: calc(100vh - 60px);
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
}
h1 {
  font-size: 6rem;
  font-weight: 700;
  color: var(--text-muted);
  margin-bottom: var(--space-sm);
}
p {
  color: var(--text-secondary);
  margin-bottom: var(--space-lg);
}
</style>
