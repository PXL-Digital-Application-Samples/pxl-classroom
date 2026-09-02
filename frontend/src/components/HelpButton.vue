<template>
  <button
    type="button"
    class="help-button"
    :aria-label="`What does ${label} mean?`"
    @click="open"
  >
    <span aria-hidden="true">?</span>
  </button>
</template>

<script setup>
// The affordance beside a control. It carries a topic id and nothing else.
//
// `topic` is validated against the registry rather than trusted, so a typo is a
// console warning in development instead of a button that does nothing when a
// lecturer presses it. tests/manual-topics.test.mjs catches the same mistake
// before it ships.

import { openHelp, MANUAL_TOPICS } from '../lib/help.js'

const props = defineProps({
  /** A topic id declared in MANUAL.md and listed in lib/manual-topics.mjs. */
  topic: {
    type: String,
    required: true,
    validator: (v) => MANUAL_TOPICS.includes(v),
  },
  /** What the button is explaining, for the accessible name. */
  label: { type: String, required: true },
})

function open() {
  openHelp(props.topic)
}
</script>

<style scoped>
/* Sized and coloured to read as interactive at a glance. The first version was
   1.1rem in --text-muted with a hairline border, and it was reported as not
   findable at all - it looked like punctuation. */
.help-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.35rem;
  height: 1.35rem;
  padding: 0;
  margin-left: var(--space-2xs);
  border: 1px solid var(--accent-blue);
  border-radius: var(--radius-full);
  background: var(--bg-surface);
  color: var(--accent-blue);
  font-size: 0.82rem;
  font-weight: 700;
  line-height: 1;
  cursor: pointer;
  vertical-align: middle;
}

.help-button:hover,
.help-button:focus-visible {
  color: var(--text-on-emphasis);
  background: var(--accent-blue);
}
</style>
