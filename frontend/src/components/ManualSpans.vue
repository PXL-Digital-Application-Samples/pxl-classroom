<template>
  <span>
    <template v-for="(span, i) in spans" :key="i">
      <template v-if="typeof span === 'string'">{{ span }}</template>
      <strong v-else-if="span.t === 'strong'">{{ span.v }}</strong>
      <em v-else-if="span.t === 'em'">{{ span.v }}</em>
      <code v-else-if="span.t === 'code'" class="manual-code">{{ span.v }}</code>

      <!-- An internal link moves the drawer to another topic rather than
           navigating away; the reader keeps their place in the app. -->
      <button
        v-else-if="span.t === 'link' && span.href.startsWith('#')"
        type="button"
        class="manual-link"
        @click="$emit('navigate', span.href.slice(1))"
      >{{ span.v }}</button>

      <a
        v-else-if="span.t === 'link'"
        :href="span.href"
        class="manual-link"
        target="_blank"
        rel="noopener noreferrer"
      >{{ span.v }}</a>

      <template v-else>{{ span.v }}</template>
    </template>
  </span>
</template>

<script setup>
defineProps({
  spans: { type: Array, required: true },
})

defineEmits(['navigate'])
</script>

<style scoped>
.manual-code {
  font-family: var(--font-mono);
  font-size: 0.86em;
  background: var(--bg-inset);
  border-radius: var(--radius-xs);
  padding: 0.1em 0.35em;
}

.manual-link {
  background: none;
  border: 0;
  padding: 0;
  font: inherit;
  color: var(--text-bright);
  text-decoration: underline;
  cursor: pointer;
}

.manual-link:hover {
  color: var(--text-primary);
}
</style>
