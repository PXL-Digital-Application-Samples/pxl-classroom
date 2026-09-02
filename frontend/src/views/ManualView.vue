<template>
  <div>
    <AppHeader />

    <main class="container manual-main">
      <nav class="manual-side" aria-label="Topics">
        <a
          v-for="t in MANUAL.topics"
          :key="t.id"
          class="manual-side-item"
          :class="{ 'is-current': current === t.id }"
          :href="`#${t.id}`"
          @click.prevent="scrollTo(t.id)"
        >{{ t.title }}</a>
      </nav>

      <div class="manual-body">
        <h1 class="manual-title">{{ MANUAL.title }}</h1>
        <div class="manual-intro">
          <ManualBlocks :blocks="MANUAL.intro" @navigate="scrollTo" />
        </div>

        <section
          v-for="t in MANUAL.topics"
          :id="t.id"
          :key="t.id"
          class="manual-topic"
        >
          <h2 class="manual-topic-title">{{ t.title }}</h2>
          <ManualBlocks :blocks="t.blocks" @navigate="scrollTo" />
        </section>
      </div>
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

import { onMounted, onUnmounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import AppHeader from '../components/AppHeader.vue'
import ManualBlocks from '../components/ManualBlocks.vue'
import { MANUAL } from '../lib/help.js'

const route = useRoute()
const current = ref(MANUAL.topics[0]?.id ?? null)

function scrollTo(id) {
  const el = document.getElementById(id)
  if (!el) return
  el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  history.replaceState(null, '', `#${id}`)
  current.value = id
}

// Highlights the topic you are reading. IntersectionObserver rather than a
// scroll handler so it costs nothing while the page is still.
let observer = null

onMounted(() => {
  observer = new IntersectionObserver(
    (entries) => {
      const visible = entries.filter((e) => e.isIntersecting)
      if (visible.length) current.value = visible[0].target.id
    },
    // A band near the top, so the highlight tracks what is being read rather
    // than whatever happens to be tallest on screen.
    { rootMargin: '-10% 0px -80% 0px', threshold: 0 },
  )
  for (const t of MANUAL.topics) {
    const el = document.getElementById(t.id)
    if (el) observer.observe(el)
  }

  // Arriving with /manual#archiving should land on the topic, not the top.
  const id = (route.hash || '').replace(/^#/, '')
  if (id) requestAnimationFrame(() => scrollTo(id))
})

onUnmounted(() => observer?.disconnect())
</script>

<style scoped>
.manual-main {
  padding-block: var(--space-xl) var(--space-2xl);
  display: grid;
  grid-template-columns: 14rem minmax(0, 42rem);
  gap: var(--space-2xl);
  align-items: start;
}

.manual-side {
  position: sticky;
  /* Clears the sticky app bar; without this the first item hides under it. */
  top: 4.5rem;
  display: flex;
  flex-direction: column;
  gap: var(--space-2xs);
  border-left: 1px solid var(--border-muted);
}

.manual-side-item {
  padding: var(--space-2xs) var(--space-sm);
  margin-left: -1px;
  border-left: 2px solid transparent;
  font-size: 0.85rem;
  color: var(--text-secondary);
  text-decoration: none;
  line-height: 1.35;
}

.manual-side-item:hover {
  color: var(--text-primary);
  text-decoration: none;
}

.manual-side-item.is-current {
  color: var(--text-bright);
  border-left-color: var(--accent-blue);
}

.manual-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-lg);
}

@media (max-width: 60rem) {
  .manual-main {
    grid-template-columns: minmax(0, 1fr);
    gap: var(--space-lg);
  }
  .manual-side {
    position: static;
    flex-direction: row;
    flex-wrap: wrap;
    border-left: 0;
    gap: var(--space-2xs) var(--space-xs);
  }
  .manual-side-item {
    border-left: 0;
    margin-left: 0;
    background: var(--bg-inset);
    border-radius: var(--radius-sm);
  }
  .manual-side-item.is-current {
    color: var(--text-bright);
    background: var(--bg-surface-hover);
  }
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
