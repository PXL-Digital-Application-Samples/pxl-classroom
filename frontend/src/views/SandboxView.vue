<template>
  <div class="sandbox-view container fade-in">
    <!-- Header -->
    <header class="sandbox-header flex justify-between items-center flex-wrap gap-md">
      <div>
        <div class="breadcrumb flex items-center gap-xs text-sm text-secondary">
          <router-link to="/" class="breadcrumb-link">Home</router-link>
          <span>/</span>
          <span class="breadcrumb-current text-primary font-medium">Design System Sandbox</span>
        </div>
        <h1 class="page-title" style="margin-top: 4px;">Component Gallery &amp; Design System</h1>
      </div>
      <div class="flex items-center gap-sm">
        <button class="btn btn-secondary btn-sm btn-with-icon" @click="dispatchSampleToasts">
          <Icon name="bell" :size="14" />
          <span>Fire Sample Toasts</span>
        </button>
        <router-link to="/dashboard" class="btn btn-primary btn-sm btn-with-icon">
          <Icon name="arrow-right" :size="14" />
          <span>Go to Dashboard</span>
        </router-link>
      </div>
    </header>

    <!-- Navigation Tabs -->
    <nav class="primer-tabs" role="tablist" aria-label="Sandbox Sections">
      <button
        type="button"
        class="primer-tab"
        :class="{ active: currentTab === 'tokens' }"
        @click="currentTab = 'tokens'"
      >
        <Icon name="sparkles" :size="14" />
        <span>Design Tokens &amp; Surfaces</span>
      </button>
      <button
        type="button"
        class="primer-tab"
        :class="{ active: currentTab === 'buttons' }"
        @click="currentTab = 'buttons'"
      >
        <Icon name="command" :size="14" />
        <span>Buttons &amp; Actions</span>
      </button>
      <button
        type="button"
        class="primer-tab"
        :class="{ active: currentTab === 'status' }"
        @click="currentTab = 'status'"
      >
        <Icon name="activity" :size="14" />
        <span>Status Dots &amp; Indicators</span>
      </button>
      <button
        type="button"
        class="primer-tab"
        :class="{ active: currentTab === 'modals' }"
        @click="currentTab = 'modals'"
      >
        <Icon name="layers" :size="14" />
        <span>Modals &amp; Overlays</span>
      </button>
      <button
        type="button"
        class="primer-tab"
        :class="{ active: currentTab === 'components' }"
        @click="currentTab = 'components'"
      >
        <Icon name="users" :size="14" />
        <span>Complex Components</span>
      </button>
    </nav>

    <!-- TAB 1: DESIGN TOKENS & SURFACES -->
    <section v-if="currentTab === 'tokens'" class="sandbox-section flex flex-col gap-lg">
      <div class="card">
        <h3 class="section-title">1. Tonal Surface Hierarchy (Dark Theme)</h3>
        <p class="text-secondary text-sm mb-md">
          Sections are separated by luminance layers rather than heavy border outlines.
        </p>

        <div class="surface-grid">
          <div class="surface-tile canvas-tile">
            <span class="surface-label">Canvas Background</span>
            <code class="mono">--bg-canvas: #0d1117</code>
            <span class="surface-desc">Root viewport &amp; code blocks</span>
          </div>

          <div class="surface-tile surface-base-tile">
            <span class="surface-label">Surface Level</span>
            <code class="mono">--bg-surface: #161b22</code>
            <span class="surface-desc">Cards, content panels, tables</span>
          </div>

          <div class="surface-tile surface-elevated-tile">
            <span class="surface-label">Elevated Surface</span>
            <code class="mono">--bg-surface-elevated: #1c2128</code>
            <span class="surface-desc">Modals, dropdown menus, flyouts</span>
          </div>

          <div class="surface-tile surface-hover-tile">
            <span class="surface-label">Hover &amp; Interactive</span>
            <code class="mono">--bg-surface-hover: #21262d</code>
            <span class="surface-desc">Button hovers, table row highlights</span>
          </div>
        </div>
      </div>

      <div class="card">
        <h3 class="section-title">2. Color Accents &amp; Semantics</h3>
        <div class="color-palette-grid">
          <div class="color-chip">
            <div class="chip-swatch" style="background: var(--accent-blue);"></div>
            <div class="chip-info">
              <strong class="text-sm">Accent Blue</strong>
              <code class="mono text-xs">#58a6ff</code>
            </div>
          </div>
          <div class="color-chip">
            <div class="chip-swatch" style="background: var(--accent-green);"></div>
            <div class="chip-info">
              <strong class="text-sm">Success Green</strong>
              <code class="mono text-xs">#3fb950</code>
            </div>
          </div>
          <div class="color-chip">
            <div class="chip-swatch" style="background: var(--accent-yellow);"></div>
            <div class="chip-info">
              <strong class="text-sm">Warning Yellow</strong>
              <code class="mono text-xs">#d29922</code>
            </div>
          </div>
          <div class="color-chip">
            <div class="chip-swatch" style="background: var(--accent-red);"></div>
            <div class="chip-info">
              <strong class="text-sm">Danger Red</strong>
              <code class="mono text-xs">#f85149</code>
            </div>
          </div>
          <div class="color-chip">
            <div class="chip-swatch" style="background: var(--border-default);"></div>
            <div class="chip-info">
              <strong class="text-sm">Border Default</strong>
              <code class="mono text-xs">#30363d</code>
            </div>
          </div>
          <div class="color-chip">
            <div class="chip-swatch" style="background: var(--border-muted);"></div>
            <div class="chip-info">
              <strong class="text-sm">Border Muted</strong>
              <code class="mono text-xs">#21262d</code>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- TAB 2: BUTTONS & ACTIONS -->
    <section v-if="currentTab === 'buttons'" class="sandbox-section flex flex-col gap-lg">
      <div class="card">
        <h3 class="section-title">Strict 1-Primary-Button Hierarchy</h3>
        <p class="text-secondary text-sm mb-md">
          Each viewport or view header must have strictly <strong>one solid primary CTA</strong>. Secondary options stay neutral.
        </p>

        <div class="demo-toolbar card flex items-center justify-between gap-md flex-wrap mb-lg">
          <div class="flex items-center gap-sm">
            <span class="text-xs font-semibold text-secondary uppercase">View Header Example:</span>
          </div>
          <div class="flex items-center gap-sm flex-wrap">
            <button class="btn btn-secondary btn-sm btn-with-icon" type="button">
              <Icon name="download" :size="14" />
              <span>Export ▾</span>
            </button>
            <button class="btn btn-secondary btn-sm btn-with-icon" type="button">
              <Icon name="more-horizontal" :size="14" />
              <span>··· More ▾</span>
            </button>
            <button class="btn btn-primary btn-sm btn-with-icon" type="button">
              <Icon name="link" :size="14" />
              <span>Copy Invitation Link</span>
            </button>
          </div>
        </div>

        <h4 class="text-sm font-semibold mb-sm">Button Variants &amp; Sizes</h4>
        <div class="button-matrix-grid">
          <div class="matrix-row flex items-center gap-md flex-wrap">
            <span class="matrix-label mono text-xs">.btn-primary:</span>
            <button class="btn btn-primary">Primary Solid</button>
            <button class="btn btn-primary btn-sm">Primary Small</button>
            <button class="btn btn-primary btn-xs">Primary Extra-Small</button>
            <button class="btn btn-primary btn-sm" disabled>Primary Disabled</button>
          </div>

          <div class="matrix-row flex items-center gap-md flex-wrap">
            <span class="matrix-label mono text-xs">.btn-secondary:</span>
            <button class="btn btn-secondary">Secondary Neutral</button>
            <button class="btn btn-secondary btn-sm">Secondary Small</button>
            <button class="btn btn-secondary btn-xs">Secondary Extra-Small</button>
            <button class="btn btn-secondary btn-sm" disabled>Secondary Disabled</button>
          </div>

          <div class="matrix-row flex items-center gap-md flex-wrap">
            <span class="matrix-label mono text-xs">.btn-ghost:</span>
            <button class="btn btn-ghost">Ghost Action</button>
            <button class="btn btn-ghost btn-sm">Ghost Small</button>
            <button class="btn btn-ghost btn-xs">Ghost Extra-Small</button>
          </div>

          <div class="matrix-row flex items-center gap-md flex-wrap">
            <span class="matrix-label mono text-xs">.btn-danger-outline:</span>
            <button class="btn btn-danger-outline">Danger Outline</button>
            <button class="btn btn-danger-outline btn-sm">Danger Outline Small</button>
          </div>
        </div>
      </div>
    </section>

    <!-- TAB 3: STATUS DOTS & INDICATORS -->
    <section v-if="currentTab === 'status'" class="sandbox-section flex flex-col gap-lg">
      <div class="card">
        <h3 class="section-title">Status Indicator Dot System</h3>
        <p class="text-secondary text-sm mb-md">
          Replaces heavy uppercase pill badges with high-density status dots and clean mixed-case labels.
        </p>

        <div class="status-grid">
          <div class="status-example-card card">
            <span class="status-indicator">
              <span class="status-dot dot-success"></span>
              <span class="status-text font-medium">On-time Submission</span>
            </span>
            <code class="mono text-xs text-muted">.dot-success</code>
          </div>

          <div class="status-example-card card">
            <span class="status-indicator">
              <span class="status-dot dot-warning"></span>
              <span class="status-text font-medium">Late Activity Observed</span>
            </span>
            <code class="mono text-xs text-muted">.dot-warning</code>
          </div>

          <div class="status-example-card card">
            <span class="status-indicator">
              <span class="status-dot dot-danger"></span>
              <span class="status-text font-medium">Merge Conflict / Error</span>
            </span>
            <code class="mono text-xs text-muted">.dot-danger</code>
          </div>

          <div class="status-example-card card">
            <span class="status-indicator">
              <span class="status-dot dot-neutral"></span>
              <span class="status-text font-medium">No Submission / Idle</span>
            </span>
            <code class="mono text-xs text-muted">.dot-neutral</code>
          </div>
        </div>
      </div>

      <div class="card">
        <h3 class="section-title">Table Row Simulation</h3>
        <div class="table-responsive">
          <table class="data-table">
            <thead>
              <tr>
                <th>Student</th>
                <th>Preserved Branch</th>
                <th>Commits</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><strong>@student-alice</strong></td>
                <td><code class="mono text-xs">preserved/hw1/alice</code></td>
                <td><span class="mono text-xs">4</span></td>
                <td>
                  <span class="status-indicator">
                    <span class="status-dot dot-success"></span>
                    <span class="text-sm">on-time</span>
                  </span>
                </td>
                <td><button class="btn btn-xs btn-ghost">View</button></td>
              </tr>
              <tr>
                <td><strong>@student-bob</strong></td>
                <td><code class="mono text-xs">preserved/hw1/bob</code></td>
                <td><span class="mono text-xs">2</span></td>
                <td>
                  <span class="status-indicator">
                    <span class="status-dot dot-warning"></span>
                    <span class="text-sm">late</span>
                  </span>
                </td>
                <td><button class="btn btn-xs btn-ghost">View</button></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </section>

    <!-- TAB 4: MODALS & OVERLAYS -->
    <section v-if="currentTab === 'modals'" class="sandbox-section flex flex-col gap-lg">
      <div class="card">
        <h3 class="section-title">Interactive Modal Triggers (Deterministic Mock Data)</h3>
        <p class="text-secondary text-sm mb-md">
          Click any button to open full modal dialogs with realistic, offline mock fixtures.
        </p>

        <div class="flex items-center gap-md flex-wrap">
          <button class="btn btn-primary btn-with-icon" @click="showStarterSyncModal = true">
            <Icon name="git-pull-request" :size="14" />
            <span>Launch Starter Sync Modal</span>
          </button>

          <button class="btn btn-secondary btn-with-icon" @click="showHealthModal = true">
            <Icon name="activity" :size="14" />
            <span>Launch System Health Modal</span>
          </button>
        </div>
      </div>
    </section>

    <!-- TAB 5: COMPLEX COMPONENTS (TeamsTable & Usage) -->
    <section v-if="currentTab === 'components'" class="sandbox-section flex flex-col gap-lg">
      <div class="card">
        <h3 class="section-title mb-md">Embedded TeamsTable (Mock Cohort)</h3>
        <TeamsTable
          :teams="mockTeams"
          :assignment="mockGroupAssignment"
          :org="'PXL-Digital'"
          :autogradeEnabled="true"
          :isGitHubActionsAutograde="true"
        />
      </div>
    </section>

    <!-- LAUNCHED MODALS -->
    <StarterSyncModal
      v-if="showStarterSyncModal"
      :assignment="mockAssignment"
      :org="'PXL-Digital'"
      :students="mockStudents"
      @close="showStarterSyncModal = false"
    />

    <SystemHealthModal
      v-if="showHealthModal"
      :org="'PXL-Digital'"
      :assignmentId="'lab-processes'"
      @close="showHealthModal = false"
    />
  </div>
</template>

<script setup>
import { ref } from 'vue'
import Icon from '../components/Icon.vue'
import TeamsTable from '../components/TeamsTable.vue'
import StarterSyncModal from '../components/StarterSyncModal.vue'
import SystemHealthModal from '../components/SystemHealthModal.vue'
import { toast } from '../lib/toast.js'

const currentTab = ref('tokens')
const showStarterSyncModal = ref(false)
const showHealthModal = ref(false)

// Sample Toasts Dispatcher
function dispatchSampleToasts() {
  toast.success('Successfully synchronized starter code to 24 repositories')
  setTimeout(() => toast.info('System health check complete: all 6 tiers green'), 300)
  setTimeout(() => toast.warn('Approaching weekly Actions minutes threshold (82%)'), 600)
}

// Mock Data Fixtures
const mockAssignment = {
  id: 'lab-processes',
  title: 'Lab 1: Linux Process Hierarchy',
  description: 'Implement fork, exec, and waitpid in C to manage process lifecycles.',
  state: 'published',
  template: { owner: 'PXL-Digital', repository: 'template-lab-processes' },
  opens_at: '2026-09-01T08:00:00Z',
  deadline_at: '2026-09-15T23:59:59Z',
  timezone: 'Europe/Brussels',
}

const mockGroupAssignment = {
  id: 'project-web-fullstack',
  title: 'Fullstack Group Project',
  assignment_type: 'group',
  group_config: {
    max_team_size: 4,
    min_team_size: 2,
    allow_team_creation: true,
  },
  opens_at: '2026-09-01T08:00:00Z',
  deadline_at: '2026-10-31T23:59:59Z',
}

const mockStudents = [
  { github_login: 'alice-pxl', repo_name: 'PXL-Digital/lab-processes-alice-pxl', status: 'accepted' },
  { github_login: 'bob-pxl', repo_name: 'PXL-Digital/lab-processes-bob-pxl', status: 'accepted' },
  { github_login: 'charlie-pxl', repo_name: 'PXL-Digital/lab-processes-charlie-pxl', status: 'accepted' },
]

const mockTeams = [
  {
    team_slug: 'team-alpha',
    team_name: 'Team Alpha',
    members: ['alice-pxl', 'bob-pxl', 'charlie-pxl'],
    under_capacity: false,
    repo_name: 'PXL-Digital/project-team-alpha',
    repo_url: 'https://github.com/PXL-Digital/project-team-alpha',
    commit_count: 14,
    submission_status: 'on-time',
    ci_status: 'success',
  },
  {
    team_slug: 'team-beta',
    team_name: 'Team Beta',
    members: ['dave-pxl'],
    under_capacity: true,
    repo_name: 'PXL-Digital/project-team-beta',
    repo_url: 'https://github.com/PXL-Digital/project-team-beta',
    commit_count: 5,
    submission_status: 'late',
    ci_status: 'failure',
  },
  {
    team_slug: 'team-gamma',
    team_name: 'Team Gamma',
    members: [],
    vacant: true,
    under_capacity: true,
    repo_name: null,
    repo_url: null,
    commit_count: null,
    submission_status: 'unknown',
    ci_status: null,
  },
]
</script>

<style scoped>
.sandbox-view {
  padding-top: var(--space-lg);
  padding-bottom: var(--space-2xl);
}

.page-title {
  font-size: 1.5rem;
  font-weight: 700;
  color: var(--text-primary);
}

.section-title {
  font-size: 1.1rem;
  font-weight: 600;
  margin-bottom: var(--space-xs);
  color: var(--text-primary);
}

/* Surface Grid */
.surface-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: var(--space-md);
}

.surface-tile {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: var(--space-md);
  border-radius: var(--radius-md);
  border: 1px solid var(--border-muted);
}

.canvas-tile {
  background: var(--bg-canvas);
}

.surface-base-tile {
  background: var(--bg-surface);
}

.surface-elevated-tile {
  background: var(--bg-surface-elevated);
}

.surface-hover-tile {
  background: var(--bg-surface-hover);
}

.surface-label {
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--text-primary);
}

.surface-desc {
  font-size: 0.72rem;
  color: var(--text-muted);
  margin-top: 4px;
}

/* Palette Grid */
.color-palette-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
  gap: var(--space-sm);
  margin-top: var(--space-sm);
}

.color-chip {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  padding: var(--space-xs) var(--space-sm);
  background: var(--bg-surface-hover);
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-sm);
}

.chip-swatch {
  width: 24px;
  height: 24px;
  border-radius: 4px;
  flex-shrink: 0;
  border: 1px solid rgba(255, 255, 255, 0.1);
}

.chip-info {
  display: flex;
  flex-direction: column;
}

/* Button Matrix */
.button-matrix-grid {
  display: flex;
  flex-direction: column;
  gap: var(--space-md);
}

.matrix-row {
  padding: var(--space-sm) var(--space-md);
  background: var(--bg-surface-hover);
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-sm);
}

.matrix-label {
  min-width: 140px;
  color: var(--text-muted);
}

/* Status Grid */
.status-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: var(--space-md);
}

.status-example-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-xs);
  padding: var(--space-md);
  background: var(--bg-surface-hover);
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-sm);
}
</style>
