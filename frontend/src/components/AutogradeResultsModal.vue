<template>
  <div class="modal-overlay" @click.self="emit('close')">
    <div
      class="modal card autograde-modal"
      role="dialog"
      aria-modal="true"
      :aria-label="`Autograding Results for ${subject}`"
      style="max-width: 650px;"
    >
      <header class="modal-head flex justify-between items-center">
        <div class="flex items-center gap-sm">
          <Icon name="check-circle" :size="20" :class="item.ci_status === 'success' ? 'text-success' : 'text-danger'" />
          <h3 style="margin: 0;">
            <slot name="title">Autograding: <code>{{ subject }}</code></slot>
          </h3>
        </div>
        <button class="modal-close" type="button" @click="emit('close')" aria-label="Close">×</button>
      </header>

      <div class="modal-body flex flex-col gap-md">
        <!-- Summary Banner -->
        <div
          class="score-banner flex justify-between items-center p-md"
          :class="item.ci_status === 'success' ? 'banner-success' : 'banner-warning'"
        >
          <div>
            <div class="text-xs text-secondary uppercase font-semibold">{{ scoreLabel }}</div>
            <div class="score-banner-value text-xl font-bold">
              <!-- No invented denominator. `points_possible` is not a schema
                   field and never existed; the 100 was the same class of guess
                   as the `?? 150` acceptance cap. -->
              {{ item.earned_points != null ? `${item.earned_points} / ${item.total_points} pts` : (item.ci_status || 'No score read yet') }}
            </div>
          </div>
          <div>
            <span
              class="score-banner-status badge"
              :class="item.ci_status === 'success' ? 'badge-success' : item.ci_status === 'failure' ? 'badge-error' : 'badge-warning'"
            >
              {{ item.ci_status || 'completed' }}
            </span>
          </div>
        </div>

        <!-- Test Breakdown List -->
        <div v-if="item.tests && item.tests.length" class="tests-breakdown-list flex flex-col gap-sm">
          <h4 style="margin: 0 0 4px 0;">Test Suites</h4>
          <div v-for="t in item.tests" :key="t.id" class="test-item-card p-sm">
            <div class="flex justify-between items-center">
              <div class="flex items-center gap-xs">
                <span class="test-item-verdict badge" :class="t.passed ? 'badge-success' : 'badge-error'">
                  {{ t.passed ? 'PASSED' : 'FAILED' }}
                </span>
                <strong>{{ t.name || t.id }}</strong>
              </div>
              <span class="mono font-semibold text-sm">{{ t.earned != null ? t.earned : (t.passed ? t.points : 0) }}/{{ t.points }} pts</span>
            </div>
            <div v-if="t.stdout || t.stderr" class="test-logs mt-xs">
              <pre class="mono text-xs p-xs">{{ t.stderr || t.stdout }}</pre>
            </div>
          </div>
        </div>
        <!-- A check run's annotations carry the grand total and nothing else -
             there is no per-test data to show here, and inventing a breakdown
             out of one number would be worse than pointing at the run that has
             the real one. -->
        <div v-else class="text-secondary text-sm">
          <p style="margin: 0;">
            The per-check breakdown is in the grading run itself.
            <a v-if="item.ci_run_url" :href="item.ci_run_url" target="_blank" rel="noopener" class="btn-link">
              Open the run →
            </a>
            <a v-else-if="item.repo_url" :href="`${item.repo_url}/actions`" target="_blank" rel="noopener" class="btn-link">
              Open GitHub Actions →
            </a>
          </p>
        </div>
      </div>

      <footer class="modal-foot">
        <button class="btn btn-secondary" type="button" @click="emit('close')">Close</button>
      </footer>
    </div>
  </div>
</template>

<script setup>
// PXL Classroom - the autograding RESULTS modal.
//
// One component, two callers. This markup existed twice - inline in
// AssignmentDetailView.vue (per student) and again in TeamsTable.vue (per team)
// - about seventy lines each, forty-five of them byte-identical once the item
// variable was renamed. The copies had already started drifting in the only way
// a duplicated template can drift silently: their explanatory comments had been
// reworded independently, so the next reader could not tell which was current.
//
// It is also why five class names appeared TWICE in
// tests/fixtures/undeclared-classes.backlog.json - `autograde-modal`,
// `score-banner`, `test-item-card`, `test-logs`, `tests-breakdown-list`. A class
// used by more than one component belongs in style.css (CLAUDE.md), and the
// duplication is what made them multi-component in the first place.
//
// AutogradeModal.vue is the EDITOR - where a lecturer defines the checks. This
// is the reader. Different jobs, adjacent names, and the reason this one says
// "Results".
import { computed } from 'vue'
import Icon from './Icon.vue'

const props = defineProps({
  /** A report student row or a team row: both carry ci_status, earned_points,
   *  total_points, tests[], ci_run_url and repo_url. */
  item: { type: Object, required: true },
  /** What the dialog is about, for the accessible label and the default title. */
  subjectLabel: { type: String, default: '' },
  /** "Total Score" for a student, "Team Score" for a team. */
  scoreLabel: { type: String, default: 'Total Score' },
})

const emit = defineEmits(['close'])

// Kept as a computed rather than read straight off props in the template, so a
// caller passing nothing still gets a label instead of an empty aria-label -
// which reads as an unnamed dialog to a screen reader.
const subject = computed(
  () => props.subjectLabel || props.item?.github_login || props.item?.team_slug || 'this submission',
)
</script>

<style scoped>
/* The inline `style="..."` attributes both copies carried, declared once.
   Scoped rather than global because exactly one component uses them now - which
   is the whole point of the extraction: they were in
   tests/fixtures/undeclared-classes.backlog.json precisely because two
   components used them and neither declared them. */
.score-banner {
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-default);
  padding: 12px 16px;
}

/* THE WHOLE POINT OF THE BANNER, and it did nothing.
   `:class="… ? 'banner-success' : 'banner-warning'"` has been in this markup
   since it was written - in both copies of it - and neither class was declared
   anywhere, so a passing autograding run and a failing one rendered identically.
   An undeclared class fails silently (DESIGN.md §7), which is why a template
   test asserting the class is present could confirm it and prove nothing.
   Tints, not hand-rolled rgba (DESIGN.md §2). */
.score-banner.banner-success {
  background: var(--tint-success-subtle);
  border-color: var(--tint-success-emphasis);
}

.score-banner.banner-warning {
  background: var(--tint-attention-subtle);
  border-color: var(--tint-attention-emphasis);
}

.score-banner-value {
  font-size: 1.4rem;
}

.score-banner-status {
  font-size: 0.85rem;
  padding: 4px 10px;
}

.test-item-card {
  border: 1px solid var(--border-default);
  border-radius: var(--radius-sm);
  padding: 10px;
  background: var(--bg-surface);
}

.test-item-verdict {
  font-size: 0.7rem;
  padding: 2px 6px;
}

.test-logs {
  margin-top: 6px;
}

.test-logs pre {
  background: var(--bg-canvas);
  border-radius: 4px;
  max-height: 120px;
  overflow-y: auto;
  white-space: pre-wrap;
  margin: 0;
  padding: 8px;
}

/* No `.modal-body` / `.modal-foot` rules here. Both copies carried inline
   padding and a border that re-stated - slightly differently - what style.css
   already declares for every modal in the app. A local override of a global
   token is how two dialogs end up looking almost the same. */
</style>
