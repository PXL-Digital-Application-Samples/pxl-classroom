<template>
  <div>
    <AppHeader />

    <main class="container manual-main">
      <h1 class="manual-title">{{ MANUAL.title }}</h1>

      <div class="manual-intro">
        <ManualBlocks :blocks="MANUAL.intro" @navigate="scrollTo" />
      </div>

      <nav class="manual-toc" aria-label="Topics">
        <a
          v-for="t in MANUAL.topics"
          :key="t.id"
          class="manual-toc-item"
          :href="`#${t.id}`"
          @click.prevent="scrollTo(t.id)"
        >{{ t.title }}</a>
      </nav>

      <section
        v-for="t in MANUAL.topics"
        :id="t.id"
        :key="t.id"
        class="manual-topic"
      >
        <h2 class="manual-topic-title">{{ t.title }}</h2>
        <ManualBlocks :blocks="t.blocks" @navigate="scrollTo" />
      </section>
    </main>
  </div>
</template>

<script setup>
// The whole manual on one page, so a topic has a URL you can send to a
// colleague and so the manual is readable without hunting for a help button.
//
// The drawer and this page render the same block tree through the same
// components - there is one manual, shown two ways, rather than two copies that
// drift.

import { onMounted } from 'vue'
import { useRoute } from 'vue-router'
import AppHeader from '../components/AppHeader.vue'
import ManualBlocks from '../components/ManualBlocks.vue'
import { MANUAL } from '../lib/help.js'

const route = useRoute()

function scrollTo(id) {
  const el = document.getElementById(id)
  if (!el) return
  el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  history.replaceState(null, '', `#${id}`)
}

// Arriving with /manual#archiving should land on the topic, not the top.
onMounted(() => {
  const id = (route.hash || '').replace(/^#/, '')
  if (id) requestAnimationFrame(() => scrollTo(id))
})
</script>

<style scoped>
.manual-main {
  padding-block: var(--space-xl) var(--space-2xl);
  display: flex;
  flex-direction: column;
  gap: var(--space-lg);
  max-width: 46rem;
}

.manual-title {
  margin: 0;
  font-size: 1.5rem;
  font-weight: 600;
  color: var(--text-primary);
}

.manual-intro {
  color: var(--text-secondary);
}

.manual-toc {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-xs) var(--space-sm);
  padding: var(--space-md);
  background: var(--bg-inset);
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-md);
}

.manual-toc-item {
  font-size: 0.85rem;
  color: var(--text-secondary);
}

.manual-toc-item:hover {
  color: var(--text-primary);
}

.manual-topic {
  padding-top: var(--space-sm);
  scroll-margin-top: var(--space-2xl);
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
}

.manual-topic-title {
  margin: 0;
  font-size: 1.1rem;
  font-weight: 600;
  color: var(--text-primary);
  border-bottom: 1px solid var(--border-muted);
  padding-bottom: var(--space-2xs);
}
</style>
