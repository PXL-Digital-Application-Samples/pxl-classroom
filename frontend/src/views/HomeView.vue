<template>
  <div class="home-page">
    <div class="hero">
      <div class="hero-glow"></div>
      <div class="container">
        <svg class="hero-icon" width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/>
          <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>
        </svg>
        <h1>PXL Classroom</h1>
        <p class="subtitle">GitHub-native assignment distribution for PXL</p>

        <div class="actions">
          <router-link to="/dashboard" class="btn btn-primary btn-lg">
            Open Dashboard
          </router-link>
        </div>

        <p class="hint">
          Students: open the assignment link shared by your lecturer.
        </p>
      </div>
    </div>
  </div>
</template>

<script setup>
</script>

<style scoped>
.home-page {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
}

.hero {
  text-align: center;
  padding: var(--space-2xl);
  position: relative;
}

.hero-glow {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 400px;
  height: 400px;
  background: radial-gradient(circle, rgba(88, 166, 255, 0.08) 0%, transparent 70%);
  pointer-events: none;
}

.hero-icon {
  color: var(--accent-blue);
  margin-bottom: var(--space-lg);
  filter: drop-shadow(0 0 20px rgba(88, 166, 255, 0.3));
}

h1 {
  font-size: 3rem;
  font-weight: 700;
  letter-spacing: -0.02em;
  margin-bottom: var(--space-sm);
  background: linear-gradient(135deg, var(--text-primary) 0%, var(--accent-blue) 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

.subtitle {
  color: var(--text-secondary);
  font-size: 1.125rem;
  margin-bottom: var(--space-xl);
}

.actions {
  margin-bottom: var(--space-xl);
}

.hint {
  color: var(--text-muted);
  font-size: 0.875rem;
}
</style>
