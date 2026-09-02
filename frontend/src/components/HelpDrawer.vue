<template>
  <Transition name="help-fade">
    <div
      v-if="topic"
      class="help-scrim"
      @click.self="close"
    >
      <aside
        ref="panel"
        class="help-drawer"
        role="dialog"
        aria-modal="true"
        :aria-label="`Help: ${topic.title}`"
        tabindex="-1"
        @keydown.esc.stop="close"
      >
        <header class="help-drawer-head">
          <h2 class="help-drawer-title">{{ topic.title }}</h2>
          <button
            type="button"
            class="help-close"
            aria-label="Close help"
            @click="close"
          >&times;</button>
        </header>

        <div class="help-drawer-body">
          <ManualBlocks :blocks="topic.blocks" @navigate="goto" />
        </div>

        <footer class="help-drawer-foot">
          <router-link class="help-manual-link" :to="{ name: 'manual' }" @click="close">
            Read the full manual
          </router-link>
        </footer>
      </aside>
    </div>
  </Transition>
</template>

<script setup>
// The one drawer, rendered once at the top of App.vue.
//
// It must NOT be moved inside a view. It is `position: fixed`, and any ancestor
// carrying `transform`, `filter`, `perspective`, `will-change` or `contain`
// becomes its containing block - which sizes the scrim to that ancestor and
// puts the panel wherever the page happens to be scrolled to. `fade-in` is the
// usual culprit, because it ends on `translateY(0)` with fill-mode forwards and
// an identity transform is still a transform. tests/e2e/47 covers that trap for
// the modals; the same rule is why this lives beside <router-view>.

import { computed, nextTick, ref, watch, onMounted, onUnmounted } from 'vue'
import { openTopic, closeHelp, openHelp, topicById } from '../lib/help.js'
import ManualBlocks from './ManualBlocks.vue'

const panel = ref(null)
const topic = computed(() => (openTopic.value ? topicById(openTopic.value) : null))

function close() {
  closeHelp()
}

function goto(id) {
  // A dangling internal link would silently close the drawer. The guard in
  // tests/manual-topics.test.mjs is what keeps that from reaching a build, but
  // ignoring it here is still better than blanking the panel the reader is in.
  openHelp(id)
}

// Escape works even when focus has drifted off the panel - a reader who has
// clicked a link inside the body should still be able to dismiss it.
function onKey(e) {
  if (e.key === 'Escape' && openTopic.value) close()
}

onMounted(() => document.addEventListener('keydown', onKey))
onUnmounted(() => document.removeEventListener('keydown', onKey))

// Move focus into the panel when it opens so the keyboard goes with it, and so
// a screen reader announces the topic rather than leaving the user in the page
// behind.
watch(topic, async (t) => {
  if (!t) return
  await nextTick()
  panel.value?.focus()
})
</script>

<style scoped>
.help-scrim {
  position: fixed;
  inset: 0;
  background: var(--bg-scrim);
  display: flex;
  justify-content: flex-end;
  z-index: 60;
}

.help-drawer {
  width: min(26rem, 100vw);
  height: 100%;
  background: var(--bg-surface-elevated);
  border-left: 1px solid var(--border-default);
  box-shadow: var(--shadow-modal);
  display: flex;
  flex-direction: column;
  outline: none;
}

.help-drawer-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-sm);
  padding: var(--space-md) var(--space-lg);
  border-bottom: 1px solid var(--border-muted);
}

.help-drawer-title {
  margin: 0;
  font-size: 1rem;
  font-weight: 600;
  color: var(--text-primary);
}

.help-close {
  background: none;
  border: 0;
  font-size: 1.5rem;
  line-height: 1;
  cursor: pointer;
  color: var(--text-muted);
  padding: 0 var(--space-2xs);
  border-radius: var(--radius-sm);
}

.help-close:hover {
  color: var(--text-primary);
  background: var(--bg-surface-hover);
}

.help-drawer-body {
  flex: 1;
  overflow-y: auto;
  padding: var(--space-lg);
}

.help-drawer-foot {
  padding: var(--space-md) var(--space-lg);
  border-top: 1px solid var(--border-muted);
}

.help-manual-link {
  font-size: 0.85rem;
  color: var(--text-secondary);
}

/* Opacity only. A transform here would make this element the containing block
   for anything fixed inside it, which is the bug described above. */
.help-fade-enter-active,
.help-fade-leave-active {
  transition: opacity 120ms ease;
}

.help-fade-enter-from,
.help-fade-leave-to {
  opacity: 0;
}

@media (prefers-reduced-motion: reduce) {
  .help-fade-enter-active,
  .help-fade-leave-active {
    transition: none;
  }
}

@media (max-width: 40rem) {
  .help-drawer {
    width: 100vw;
  }
}
</style>
