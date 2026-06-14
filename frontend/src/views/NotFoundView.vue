<template>
  <div class="not-found">
    <div class="container">
      <h1>404</h1>
      <p>Page not found.</p>
      <router-link to="/" class="btn btn-primary">Go home</router-link>
    </div>
  </div>
</template>

<script setup>
</script>

<style scoped>
.not-found {
  min-height: 100vh;
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
