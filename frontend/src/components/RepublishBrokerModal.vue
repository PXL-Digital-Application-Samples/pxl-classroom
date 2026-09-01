<template>
  <div class="modal-overlay" @click.self="requestClose">
    <div class="modal card republish-modal" ref="el" role="dialog" aria-modal="true" aria-labelledby="republish-broker-title" @keydown="onKeydown">
      <header class="modal-head flex justify-between items-center">
        <h3 id="republish-broker-title" class="flex items-center gap-sm">
          <Icon name="refresh-cw" :size="18" />
          <span>Republish Broker Repository</span>
        </h3>
        <button class="modal-close" type="button" @click="requestClose" :disabled="publishing" aria-label="Close">×</button>
      </header>

      <div class="modal-body flex flex-col gap-md">
        <div class="alert alert-info">
          <strong>Target Broker:</strong>
          <code>{{ org }}/{{ brokerRepo }}</code>
        </div>

        <div class="republish-explanation flex flex-col gap-sm">
          <h4 class="font-semibold text-sm">What will happen:</h4>
          <ul class="text-sm space-y-xs list-disc pl-md text-secondary">
            <li>Re-runs the central <code>publish-assignment.yml</code> workflow on GitHub Actions.</li>
            <li>Ensures the broker repository exists, variables &amp; secrets are configured, and triggers (including issues for group assignments) are enabled.</li>
          </ul>

          <h4 class="font-semibold text-sm mt-xs">Effect on existing student repositories:</h4>
          <div class="alert alert-success text-sm">
            <strong>100% Safe:</strong> Existing student and team repositories will <strong>not</strong> be modified, deleted, or reset. Students who have already accepted will keep all their code, branches, and commit history untouched.
          </div>

          <p class="text-xs text-muted">
            Use this if students are having trouble accepting or if the broker repository was missing or misconfigured.
          </p>
        </div>

        <!-- The one case where a repair cannot preserve the links, and it is
             not a choice: this assignment predates signed acceptance, so its
             invitation is a bearer token that lands in a public event. The
             publish mints a keypair, the broker starts checking signatures,
             and the old titles are refused from that moment. Saying so here
             is the difference between a lecturer redistributing the link and
             a cohort quietly failing to accept. Students who follow an old
             link get a page that says it was replaced, not a 404. -->
        <div v-if="migratesInvitation" class="alert alert-warning text-sm">
          <strong>Links handed out so far will stop working.</strong>
          This assignment still uses the old invitation format, where the link itself was published
          in GitHub's public event feed every time a student accepted. Publishing upgrades it. Copy
          the new link afterwards and send it to anyone who has not accepted yet - their repositories,
          if they already have one, are untouched.
        </div>

        <!-- Republishing normally REUSES the invitation, so a repair does not
             break links already handed out. Rotating is the other thing a
             lecturer needs and had no way to ask for: the input existed on
             publish-assignment.yml and nothing in the app ever sent it. -->
        <div class="regen-choice">
          <div class="field checkbox">
            <label>
              <input type="checkbox" v-model="regenerate" :disabled="publishing" />
              Regenerate the invitation link
            </label>
            <small v-if="migratesInvitation">
              The upgrade above already replaces the link. Tick this as well only if you also want to
              retire the new one immediately - normally you do not.
            </small>
            <small v-else>
              Leave this off to repair the broker while every link already handed out keeps working.
            </small>
          </div>
          <div v-if="regenerate" class="alert alert-danger text-sm">
            <strong>Every link already handed out stops working.</strong>
            Students who have not accepted yet will need the new link; anyone who already accepted keeps their repository.
            Do this if the current link has leaked.
            <!-- True since the generator retires a rotated-away card instead
                 of deleting it. Worth saying, because it changes what the
                 lecturer has to do next: field a page that explains itself,
                 rather than a queue of "your link is broken" messages. -->
            Anyone following an old link lands on a page telling them it is out of date and to ask you for the current one.
          </div>
        </div>
      </div>

      <footer class="modal-foot flex justify-end gap-sm">
        <button class="btn" type="button" @click="requestClose" :disabled="publishing">Cancel</button>
        <!-- DESIGN.md §1.2: a modal is its own view, so the confirm is this
             view's single solid button. §3 has no "warning" variant - the
             destructive spelling is .btn-danger, and it only appears when the
             action actually is destructive. -->
        <button
          :class="['btn', 'btn-with-icon', regenerate ? 'btn-danger' : 'btn-primary']"
          type="button"
          @click="emit('confirm', regenerate)"
          :disabled="publishing"
        >
          <Icon name="refresh-cw" :size="14" />
          <span>{{ publishing ? 'Publishing…' : (regenerate ? 'Republish and retire the old link' : 'Republish broker now') }}</span>
        </button>
      </footer>
    </div>
  </div>
</template>

<script setup>
// "Republish the broker", and the one question it has to ask.
//
// Republishing normally REUSES the invitation so a repair does not break links
// already in students' hands. Whether to rotate it instead is a choice that
// only exists while this dialog is open, so `regenerate` is the dialog's own
// state and travels out on `confirm` - it used to be a ref on AdminView that
// outlived every cancel.
//
// `migratesInvitation` stays a PROP: it is a statement about the assignment
// document (does it hold a keypair yet), which the editor owns.
import { ref } from 'vue'
import Icon from './Icon.vue'
import { useFocusTrap } from '../composables/useFocusTrap.js'

const props = defineProps({
  org: { type: String, required: true },
  /** The broker this publish targets, e.g. `broker-<assignment-id>`. */
  brokerRepo: { type: String, required: true },
  /** True when this publish upgrades an assignment off the old bearer token. */
  migratesInvitation: { type: Boolean, default: false },
  /**
   * Open with the rotate box already ticked.
   *
   * Only a control that SAYS "Regenerate link" may pass true. A repair
   * republish must never arrive pre-ticked, because rotating breaks every link
   * already in a student's hands - which is why the parent has two entry points
   * rather than one with a default.
   */
  preselectRegenerate: { type: Boolean, default: false },
  publishing: { type: Boolean, default: false },
})

const emit = defineEmits(['close', 'confirm'])

const { el, onKeydown } = useFocusTrap()
// Seeded once, on open. `v-if` on the parent means the component is created
// fresh each time, so there is no stale tick to reset - which the parent used
// to have to do by hand in two places.
const regenerate = ref(props.preselectRegenerate)

function requestClose() {
  if (props.publishing) return
  emit('close')
}
</script>

<style scoped>
/* Moved with the markup out of AdminView, for the same reason: scoped styles do
   not cross a component boundary. The .alert-* family comes too - this dialog
   was that view's only user of it. */
.republish-modal {
  background: var(--bg-secondary);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-lg);
  box-shadow: 0 20px 45px var(--shadow-color-modal), 0 0 0 1px var(--border-subtle);
  width: 100%;
  max-width: 560px;
  max-height: calc(100vh - 10vh);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  margin: 0 auto;
}
.republish-modal .modal-head {
  padding: var(--space-md) var(--space-lg);
  border-bottom: 1px solid var(--border-default);
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: var(--bg-tertiary);
}
.republish-modal .modal-head h3 {
  margin: 0;
  font-size: 1rem;
  font-weight: 600;
}
.republish-modal .modal-body {
  padding: var(--space-lg);
  overflow-y: auto;
}
.republish-modal .modal-foot {
  padding: var(--space-md) var(--space-lg);
  border-top: 1px solid var(--border-default);
  background: var(--bg-tertiary);
}
.republish-explanation ul {
  margin: 0;
}
.alert-info {
  background: var(--tint-accent-subtle);
  border: 1px solid var(--tint-accent-emphasis);
  color: var(--accent-blue);
  padding: var(--space-sm) var(--space-md);
  border-radius: var(--radius-md);
}
.alert-success {
  background: var(--tint-success-subtle);
  border: 1px solid var(--tint-success-emphasis);
  color: var(--accent-green);
  padding: var(--space-sm) var(--space-md);
  border-radius: var(--radius-md);
}
.alert-warning {
  background: var(--tint-attention-subtle);
  border: 1px solid var(--tint-attention-emphasis);
  color: var(--accent-yellow);
  padding: var(--space-sm) var(--space-md);
  border-radius: var(--radius-md);
}
.alert-danger {
  background: var(--tint-danger-subtle);
  border: 1px solid var(--tint-danger-emphasis);
  color: var(--accent-red);
  padding: var(--space-sm) var(--space-md);
  border-radius: var(--radius-md);
}
.regen-choice {
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
  background: var(--bg-inset);
  padding: var(--space-sm) var(--space-md);
  border-radius: var(--radius-md);
}
.regen-choice .field.checkbox { margin: 0; }
.regen-choice small { color: var(--text-secondary); }
</style>
