<template>
  <!-- The tooltip answers the question the button asks, in one sentence, so
       hovering is often enough and the drawer is for when it is not. It is NOT
       the accessible name: a screen reader already gets `aria-label`, and
       repeating a summary there would read the whole sentence before the user
       knows there is a button. -->
  <button
    type="button"
    class="help-button"
    :aria-label="`What does ${label} mean?`"
    :title="summary || null"
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

import { computed } from 'vue'
import { openHelp, MANUAL_TOPICS, topicSummary } from '../lib/help.js'

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

const summary = computed(() => topicSummary(props.topic))

function open() {
  openHelp(props.topic)
}
</script>

<style scoped>
/* Sized and coloured to read as interactive at a glance. The first version was
   1.1rem in --text-muted with a hairline border, and it was reported as not
   findable at all - it looked like punctuation. What made it findable was the
   accent colour and the solid ring, not the diameter, which is why this can be
   small again: 1.35rem read as heavy beside a label. */
.help-button {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.1rem;
  height: 1.1rem;
  padding: 0;
  margin-left: var(--space-2xs);
  border: 1px solid var(--accent-blue);
  border-radius: var(--radius-full);
  background: var(--bg-surface);
  color: var(--accent-blue);
  font-size: 0.7rem;
  font-weight: 700;
  line-height: 1;
  cursor: pointer;
  vertical-align: middle;
}

/* THE TARGET DOES NOT SHRINK WITH THE GLYPH. The ring renders at 16.5px here
   (the root font size is 15px, so 1.1rem is not 17.6), under the 24px WCAG 2.2
   SC 2.5.8 asks of a pointer target - and it sits inside a <label>, where a
   miss does not do nothing, it focuses the field. 4px each way brings the hit
   area to 24.5px without changing anything you can see. */
.help-button::before {
  content: '';
  position: absolute;
  inset: -4px;
}

.help-button:hover,
.help-button:focus-visible {
  color: var(--text-on-emphasis);
  background: var(--accent-blue);
}
</style>
