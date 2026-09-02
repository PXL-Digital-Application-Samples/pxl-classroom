<template>
  <div class="manual-blocks">
    <template v-for="(block, i) in blocks" :key="i">
      <h3 v-if="block.type === 'h3'" class="manual-h3">{{ block.text }}</h3>

      <ul v-else-if="block.type === 'ul'" class="manual-list">
        <li v-for="(item, j) in block.items" :key="j">
          <ManualSpans :spans="item" @navigate="$emit('navigate', $event)" />
        </li>
      </ul>

      <p v-else class="manual-p">
        <ManualSpans :spans="block.spans" @navigate="$emit('navigate', $event)" />
      </p>
    </template>
  </div>
</template>

<script setup>
// Renders the block tree scripts/build-manual.mjs produced.
//
// Deliberately components and not `v-html`: the manual is repo-authored so the
// injection risk is small, but this page also lives in an app that holds a
// GitHub token, and rendering through real elements costs nothing extra and
// inherits the app's own type and colour tokens for free.

import ManualSpans from './ManualSpans.vue'

defineProps({
  blocks: { type: Array, required: true },
})

defineEmits(['navigate'])
</script>

<style scoped>
.manual-blocks {
  display: flex;
  flex-direction: column;
  gap: var(--space-md);
}

.manual-h3 {
  font-size: 0.95rem;
  font-weight: 600;
  color: var(--text-primary);
  margin: var(--space-xs) 0 0;
}

.manual-p {
  margin: 0;
  color: var(--text-secondary);
  line-height: 1.6;
}

.manual-list {
  margin: 0;
  padding-left: var(--space-lg);
  display: flex;
  flex-direction: column;
  gap: var(--space-xs);
  color: var(--text-secondary);
  line-height: 1.55;
}
</style>
