<template>
  <!-- A team's join code, for the student to give their teammates
       (lib/team-join-code.mjs). Shown where this browser has it; otherwise,
       for a team that has one, where to get it. -->
  <div v-if="code" class="join-code-panel" data-join-code-panel>
    <p class="text-sm text-secondary">
      Give your teammates this join code. They need it to join {{ teamName || 'your team' }}.
    </p>
    <div class="join-code-value">
      <code data-join-code>{{ formatJoinCode(code) }}</code>
      <button
        type="button"
        class="btn btn-secondary btn-sm btn-with-icon"
        :aria-label="copied ? 'Copied' : 'Copy join code'"
        @click="copy"
      >
        <Icon :name="copied ? 'check' : 'copy'" :size="14" />
        <span>{{ copied ? 'Copied' : 'Copy' }}</span>
      </button>
    </div>
  </div>
  <p v-else-if="elsewhere" class="join-code-elsewhere text-sm text-muted" data-join-code-elsewhere>
    New teammates need this team's join code. Your lecturer can see it.
  </p>
</template>

<script setup>
import { ref } from 'vue'
import Icon from './Icon.vue'
import { copyText } from '../lib/clipboard.js'
import { toast } from '../lib/toast.js'
import { formatJoinCode } from '../../../lib/team-join-code.mjs'

const props = defineProps({
  code: { type: String, default: '' },
  teamName: { type: String, default: '' },
  elsewhere: { type: Boolean, default: false },
})

const copied = ref(false)

// Synchronous inside the click: an await before the write loses the gesture
// in Firefox (CLAUDE.md).
function copy() {
  copyText(formatJoinCode(props.code)).then((ok) => {
    if (ok) {
      copied.value = true
      setTimeout(() => { copied.value = false }, 2000)
    } else {
      toast.error('Could not copy the join code')
    }
  })
}
</script>

<style scoped>
/* A tonal step, not a box (DESIGN.md §1.1): it sits on the card. */
.join-code-panel {
  margin: var(--space-md) auto 0;
  padding: var(--space-sm) var(--space-md);
  background: var(--bg-inset);
  border-radius: var(--radius-md);
  max-width: 420px;
  text-align: center;
}

.join-code-value {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-sm);
  margin-top: var(--space-xs);
}

.join-code-value code {
  font-size: 1.4rem;
  letter-spacing: 0.08em;
  color: var(--text-primary);
}

.join-code-elsewhere {
  margin-top: var(--space-sm);
}
</style>
