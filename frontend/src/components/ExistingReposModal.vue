<template>
  <div class="modal-overlay" @click.self="emit('close')">
    <div
      class="modal card modal-existing-repos"
      ref="el"
      role="dialog"
      aria-modal="true"
      aria-label="This name is already in use"
      @keydown="onKeydown"
    >
      <header class="modal-head flex justify-between items-center">
        <div class="flex items-center gap-xs">
          <Icon name="alert-triangle" :size="18" class="stat-yellow" />
          <h3 class="modal-existing-title">This name is already in use</h3>
        </div>
        <button class="modal-close" type="button" @click="emit('close')" aria-label="Close">×</button>
      </header>

      <div class="modal-body flex flex-col gap-md">
        <!-- THE COUNT IS THE ORGANIZATION'S, and it says so. It is not how many
             students in this cohort would be affected - nobody has accepted
             yet, so that number does not exist here. A lecturer looking at 300
             has to be able to tell it is 300 of everybody's. -->
        <p class="text-sm existing-repos-lede">
          <strong>{{ count }}</strong>
          {{ count === 1 ? 'repository' : 'repositories' }} in <strong>{{ org }}</strong>
          already {{ count === 1 ? 'matches' : 'match' }} <code>{{ pattern }}</code>.
        </p>

        <div class="field">
          <label id="existing-repos-q">When a student already owns one</label>
          <div class="policy-options" role="radiogroup" aria-labelledby="existing-repos-q">
            <label class="policy-option" :class="{ selected: policy === 'reuse' }">
              <input type="radio" v-model="policy" value="reuse" />
              <span class="policy-option-text">
                <strong>Give them the existing repository</strong>
                <small>
                  They keep what is in it, and this assignment's starter code is not copied
                  over the top. What you want for work that carries across years, such as a
                  portfolio.
                </small>
              </span>
            </label>
            <label class="policy-option" :class="{ selected: policy === 'refuse' }">
              <input type="radio" v-model="policy" value="refuse" />
              <span class="policy-option-text">
                <strong>Turn that student away, and tell me</strong>
                <small>
                  They are refused by name rather than quietly starting the assignment without
                  its starter code. What you want for a lab or an exam.
                </small>
              </span>
            </label>
          </div>
          <!-- The reassurance, and it is why neither answer is dangerous. Said
               here rather than left out: without it the first option reads as
               "a student may be handed a repository they cannot push to",
               which is the one thing that never happens. -->
          <small>
            A repository locked by an earlier deadline is refused whichever you pick — the
            student could not have pushed to it.
          </small>
        </div>
      </div>

      <footer class="modal-foot flex justify-end gap-sm">
        <button class="btn btn-secondary" type="button" @click="emit('close')">Cancel</button>
        <button class="btn btn-primary" type="button" @click="emit('confirm', policy)">
          {{ confirmLabel }}
        </button>
      </footer>
    </div>
  </div>
</template>

<script setup>
// "This name is already in use" - the one moment this is worth saying, and the
// only place it is said.
//
// It was a permanent control under the repository name pattern first. That
// asked every lecturer in the deployment to have an opinion about a case
// exactly one of them meets, and read as clutter to the rest; it was then a
// `window.confirm`, which cannot carry two options with their explanations and
// is not the app's own surface. It is a dialog now, opened by Save and only
// when the organization actually holds repositories the pattern would produce.
//
// ASKED ONCE. The parent opens this while the assignment carries no answer, so
// a later edit to the title or the deadline saves in silence. `existing_repo_policy`
// absent means "never came up"; set means "asked, and this is what they said",
// which is what makes not asking again honest rather than forgetful.
//
// THE COUNT AND THE PATTERN ARE PROPS. This dialog does not probe, does not
// know how to match a pattern against a repository listing, and must not learn:
// `lib/assignment-collision.mjs` is the one judge of what collides, and a
// second implementation inside a dialog is exactly what that rule forbids.
import Icon from './Icon.vue'
import { ref } from 'vue'
import { useFocusTrap } from '../composables/useFocusTrap.js'

defineProps({
  /** How many repositories in the organization the pattern would produce. */
  count: { type: Number, required: true },
  org: { type: String, required: true },
  pattern: { type: String, required: true },
  /**
   * The label of the button that opened this - "Save as draft", "Save &
   * publish" or "Save". Echoed rather than replaced with a generic
   * confirmation: the lecturer asked for that action and this dialog
   * interrupts it, so offering them a different-sounding one asks whether it
   * still does what they clicked.
   */
  confirmLabel: { type: String, required: true },
})

const emit = defineEmits(['close', 'confirm'])

// `reuse` PRE-SELECTED because it is what already happens - provisioning has
// been idempotent on repository existence since it was written. A pair with
// neither filled would be the dialog asking a question the system has already
// answered, and would let somebody dismiss it into a state nothing defines.
const policy = ref('reuse')

const { el, onKeydown } = useFocusTrap()
</script>

<style scoped>
/* `.policy-option*` is deliberately NOT here - it is shared with AdminView's
   late-work pair and lives in style.css (DESIGN.md §7). What is here is only
   what this dialog owns. */
.modal-existing-repos {
  max-width: 520px;
}

.modal-head {
  border-bottom: 1px solid var(--border-default);
  padding: 14px 18px;
}

.modal-existing-title {
  margin: 0;
  font-size: 1.05rem;
}

.modal-body {
  padding: 16px 18px;
}

.existing-repos-lede {
  margin: 0;
}

.modal-foot {
  padding: 14px 18px;
  border-top: 1px solid var(--border-default);
}
</style>
