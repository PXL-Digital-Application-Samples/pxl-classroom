<template>
  <div class="modal-overlay" @click.self="requestClose">
    <div class="modal feedback-pr-modal" ref="el" role="dialog" aria-modal="true" aria-label="Open Feedback Pull Requests" @keydown="onKeydown">
      <header class="modal-head">
        <h3>Open Feedback Pull Requests</h3>
        <button class="modal-close" type="button" @click="requestClose" :disabled="busy" aria-label="Close">×</button>
      </header>

      <section class="modal-section">
        <p>
          This creates a dedicated <strong>Draft Pull Request</strong> (comparing <code>main</code> against the frozen <code>{{ baselineBranch }}</code> branch) in student repositories that have pushed commits.
        </p>

        <div class="safety-box">
          <h4 class="safety-box-title">Student Code Safety &amp; Scope</h4>
          <ul class="safety-list">
            <li><strong>No student code is altered or merged:</strong> The student's <code>main</code> branch, files, and git commit history remain completely untouched.</li>
            <li><strong>Safe Draft mode:</strong> The pull request is opened in Draft status for inline review comments and annotations only.</li>
            <li><strong>Continuous tracking:</strong> As students make and push further commits to <code>main</code>, the pull request automatically updates to include their new work.</li>
            <li><strong>Control repository records:</strong> PR numbers and links are saved to your control repository (<code>{{ controlRepo }}/repositories/</code>), not written to student repos.</li>
          </ul>
        </div>

        <div class="cohort-summary-grid">
          <div class="cohort-summary-item">
            <span class="cohort-summary-val">{{ eligibleCount }}</span>
            <span class="cohort-summary-lbl">Eligible (commits pushed)</span>
          </div>
          <div class="cohort-summary-item">
            <span class="cohort-summary-val">{{ alreadyOpenedCount }}</span>
            <span class="cohort-summary-lbl">Already opened</span>
          </div>
          <div class="cohort-summary-item">
            <span class="cohort-summary-val">{{ skippedNoCommitsCount }}</span>
            <span class="cohort-summary-lbl">Skipped (0 commits yet)</span>
          </div>
        </div>

        <div v-if="eligibleCount === 0" class="empty-eligible-notice">
          All student repositories with pushed commits already have Feedback PRs opened, or no students have pushed code yet.
        </div>
      </section>

      <footer class="modal-actions">
        <button class="btn" type="button" @click="requestClose" :disabled="busy">
          Cancel
        </button>
        <button class="btn btn-primary" type="button" @click="emit('confirm')" :disabled="busy || eligibleCount === 0">
          {{ busy ? 'Opening Pull Requests…' : `Open Feedback PRs on ${eligibleCount} Repo(s)` }}
        </button>
      </footer>
    </div>
  </div>
</template>

<script setup>
// Confirmation for "open a draft Feedback PR in every eligible student repo".
//
// The counts are computed by the parent, which holds the report. This dialog
// only states the consequences and asks - which is the whole reason it exists:
// DESIGN.md §1.2 puts a destructive or bulk action behind a modal, and §1.5
// requires the copy to describe what the system ACTUALLY does. Every claim in
// the safety box is a property of scripts/open-feedback-prs.mjs, not a
// reassurance written to make the button feel safer.
import { computed } from 'vue'
import { config } from '../lib/config.js'
import { useFocusTrap } from '../composables/useFocusTrap.js'

const props = defineProps({
  /** The assignment, for its baseline branch name. */
  assignment: { type: Object, default: null },
  eligibleCount: { type: Number, required: true },
  alreadyOpenedCount: { type: Number, default: 0 },
  skippedNoCommitsCount: { type: Number, default: 0 },
  busy: { type: Boolean, default: false },
})

const emit = defineEmits(['close', 'confirm'])

const { el, onKeydown } = useFocusTrap()

const controlRepo = config.controlRepo
const baselineBranch = computed(() => props.assignment?.feedback_pr_baseline_branch || 'pxl-baseline')

function requestClose() {
  if (props.busy) return
  emit('close')
}
</script>

<style scoped>
/* Moved with the markup out of AssignmentDetailView. A scoped rule left in the
   parent cannot reach a child's DOM, so every one of these rendered nothing. */
.feedback-pr-modal {
  max-width: 580px;
}
.safety-box {
  background: var(--bg-tertiary);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm, 4px);
  padding: var(--space-sm, 12px) var(--space-md, 16px);
  margin: var(--space-md, 16px) 0;
}
.safety-box-title {
  font-size: 0.88rem;
  font-weight: 600;
  margin: 0 0 var(--space-xs, 6px) 0;
  color: var(--text-primary);
}
.safety-list {
  margin: 0;
  padding-left: var(--space-md, 18px);
  font-size: 0.84rem;
  line-height: 1.5;
  color: var(--text-secondary);
}
.safety-list li + li {
  margin-top: 4px;
}
.cohort-summary-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: var(--space-sm, 8px);
  margin: var(--space-md, 16px) 0;
}
.cohort-summary-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: var(--space-sm, 8px);
  background: var(--bg-secondary);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm, 4px);
}
.cohort-summary-val {
  font-size: 1.25rem;
  font-weight: 700;
  color: var(--text-primary);
}
.cohort-summary-lbl {
  font-size: 0.72rem;
  color: var(--text-secondary);
  margin-top: 2px;
}
.empty-eligible-notice {
  padding: var(--space-sm, 8px) var(--space-md, 12px);
  background: var(--bg-secondary);
  border: 1px dashed var(--border-default);
  border-radius: var(--radius-sm, 4px);
  font-size: 0.84rem;
  color: var(--text-secondary);
  text-align: center;
  margin-top: var(--space-sm, 8px);
}
.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-sm, 8px);
  padding: var(--space-md, 16px);
  border-top: 1px solid var(--border-default);
  background: var(--bg-secondary);
}
</style>
