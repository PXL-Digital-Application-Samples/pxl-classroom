<template>
  <div class="admin-view fade-in">
    <AppHeader :user="user" @logout="handleLogout">
      <template #left>
        <div class="app-header-crumbs flex items-center gap-sm">
          <router-link :to="{ name: 'dashboard', params: { org } }" class="back-link">
            <Icon name="arrow-left" :size="14" />
            <span>Dashboard</span>
          </router-link>
          <span class="app-header-sep">/</span>
          <span class="text-secondary">{{ org }}</span>
          <span class="app-header-sep">/</span>
          <h1 class="app-header-heading">Admin Console</h1>
        </div>
      </template>
    </AppHeader>

    <div class="admin-page container">

    <!-- Not authenticated - never render the editor with data-shaped empty
         states signed out ("No assignments yet" on a full course reads as
         data loss after the 8h token expiry). -->
    <AuthCard v-if="!user" title="Sign in to open the Admin Panel" @authenticated="onAuthenticated">
      Sign in with a GitHub account that owns <strong>{{ org }}</strong>.
      Sessions last 8 hours. If you were signed in earlier, it has expired.
    </AuthCard>

    <template v-else>
    <nav class="primer-tabs" role="tablist">
      <button
        type="button"
        role="tab"
        :aria-selected="activeTab === 'assignments'"
        :tabindex="activeTab === 'assignments' ? 0 : -1"
        :class="['primer-tab', { active: activeTab === 'assignments' }]"
        @click="setTab('assignments')"
        @keydown="onTabKeydown"
      >
        <Icon name="file-text" :size="14" />
        <span>Assignments</span>
      </button>
      <button
        type="button"
        role="tab"
        :aria-selected="activeTab === 'roster'"
        :tabindex="activeTab === 'roster' ? 0 : -1"
        :class="['primer-tab', { active: activeTab === 'roster' }]"
        @click="setTab('roster')"
        @keydown="onTabKeydown"
      >
        <Icon name="users" :size="14" />
        <span>Roster</span>
      </button>
    </nav>

    <!-- v-show (not v-if): unmounting would silently discard an un-committed
         CSV import preview when the lecturer flips tabs. -->
    <RosterTab v-show="activeTab === 'roster'" ref="rosterTab" :org="org" />

    <div v-show="activeTab === 'assignments'" class="admin-layout">
      <!-- LEFT: assignment list -->
      <aside class="list-pane">
        <!-- DESIGN.md §1.2 counts primaries across the whole view. With an
             assignment open, the view's job is that assignment and its Save is
             the solid button; with nothing open, this is the only thing to do
             here and gets it. Exactly one, in both states. -->
        <button :class="['btn', 'new-btn', 'btn-with-icon', editing ? '' : 'btn-primary']" @click="newAssignment">
          <Icon name="plus" :size="14" />
          <span>New assignment</span>
        </button>

        <div v-if="loadingList" class="list-loading"><div class="spinner"></div></div>
        <div v-else-if="assignmentsError === 'no-control-repo'" class="list-empty error-state-box" style="padding: var(--space-md); border: 1px dashed var(--accent-red); border-radius: var(--radius-md); text-align: center;">
          <h4 style="margin: 0 0 var(--space-xs) 0;">{{ org }} isn't onboarded yet</h4>
          <p class="text-secondary" style="font-size: 0.85rem; margin: 0 0 var(--space-sm) 0; line-height: 1.4;">
            There is no <code>{{ org }}/pxl-classroom-control</code> repository (or you can't see it).
            A hub admin onboards the org by running the <strong>Setup Organization</strong> workflow.
          </p>
          <a :href="`${runbookUrl}#2-onboarding-a-new-organization-per-org`" target="_blank" rel="noopener" class="btn btn-sm">Read RUNBOOK §2</a>
        </div>
        <div v-else-if="assignmentsError" class="list-empty error-state-box" style="padding: var(--space-md); border: 1px dashed var(--accent-red); border-radius: var(--radius-md); text-align: center;">
          <h4 style="margin: 0 0 var(--space-xs) 0;">Couldn't load assignments</h4>
          <p class="text-secondary" style="font-size: 0.85rem; margin: 0 0 var(--space-sm) 0;">{{ assignmentsError }}</p>
          <button class="btn btn-sm" @click="loadAssignments">Retry</button>
        </div>
        <div v-else-if="assignments.length === 0" class="list-empty">
          No assignments yet. Create one to begin.
        </div>
        <ul v-else class="assignment-list">
          <li
            v-for="a in assignments"
            :key="a.id"
            :class="{ active: editing && editing.id === a.id }"
            style="padding: 0; margin-bottom: 4px;"
          >
            <router-link
              :to="{ name: 'admin', params: { org: props.org }, query: { edit: a.id } }"
              @click.prevent="editAssignment(a)"
              style="text-decoration: none; color: inherit; display: block;"
            >
              <div class="title">{{ a.title || a.id }}</div>
              <div class="slug">{{ a.id }}</div>
              <div class="meta">
                <span class="badge" :class="`badge-${a.state}`">{{ a.state }}</span>
                <span v-if="a.deadline_at" class="deadline">{{ formatDate(a.deadline_at, a.timezone) }}</span>
                <!-- The link, without opening the editor first (UX_PLAN §4.2).
                     The list already parsed each YAML, so the token is in hand
                     and this costs no request. -->
                <InvitationShare
                  v-if="a.state === 'published'"
                  :org="org"
                  :assignment="a"
                  variant="compact"
                  :resolve="false"
                />
              </div>
            </router-link>
          </li>
        </ul>
      </aside>

      <!-- RIGHT: editor -->
      <main class="editor-pane">
        <div v-if="!editing" class="empty-state">
          <h3>Pick an assignment to edit</h3>
          <p>Or click <strong>+ New assignment</strong> to create one.</p>
        </div>

        <form v-else class="editor-form" @submit.prevent>
          <div class="editor-header-bar">
            <div class="editor-title">
              <h3 v-if="isNew">New assignment</h3>
              <h3 v-else>Edit: <code>{{ form.id }}</code> <span class="badge" :class="`badge-${form.state}`">{{ form.state }}</span></h3>
            </div>
            <div class="editor-header-actions">
              <button
                v-if="!isNew"
                class="btn btn-with-icon"
                type="button"
                @click="showDiagnosticModal = true"
                title="Run deep pre-flight diagnostic tests and 1-click auto-fixes on this assignment"
              >
                <Icon name="activity" :size="14" />
                <span>Troubleshoot</span>
              </button>
              <button class="btn" type="button" @click="cancelEdit" :disabled="saving">Cancel</button>
              <button
                v-if="isNew || form.state === 'draft'"
                class="btn"
                type="button"
                @click="saveAssignment('draft')"
                :disabled="saving || !canSave"
              >{{ saving ? 'Saving…' : 'Save as draft' }}</button>
              <button
                class="btn btn-primary"
                type="button"
                @click="saveAndPublish"
                :disabled="saving || !canSave"
              >{{ saving ? 'Saving…' : (form.state === 'published' ? 'Save' : 'Save & publish') }}</button>
            </div>
          </div>

          <!-- PUBLISHED ASSIGNMENT INFO BANNER -->
          <div v-if="!isNew && form.state === 'published'" class="fade-in">
            <!-- 1. LIVE & VERIFIED -->
            <div v-if="publishWatch === 'ready' || (brokerExists === true && pagesLive === true)" class="published-info-card is-success">
              <div class="published-header">
                <Icon name="check-circle" :size="16" class="text-green" />
                <h4>Assignment is Published &amp; Verified Live</h4>
                <span class="badge badge-success" style="margin-left: auto; font-size: 0.75rem;">Ready to Share</span>
              </div>
              <p class="published-desc">
                Verified on GitHub and Pages. You can safely share the student invitation link below on Canvas, Toledo, or email. Students who open it will be prompted to accept the assignment and will automatically receive their provisioned repository.
              </p>
              <!-- :resolve="false" - the form is the authority here. Rotating
                   clears form.invite_token on purpose, and re-reading the YAML
                   the workflow has not rewritten yet would hand the retired
                   link straight back. -->
              <InvitationShare :org="org" :assignment="shareAssignment" variant="banner" :resolve="false" @regenerate="openRegenerate" />
              <!-- No "Track roster & progress" here: the cohort card below
                   carries it, and it was the same link twice (UX_PLAN §7.1). -->
            </div>

            <!-- 2. PUBLISHING / DEPLOYING IN PROGRESS -->
            <div v-else-if="publishWatch === 'watching' || (brokerExists === true && pagesLive === false)" class="published-info-card is-warning">
              <div class="published-header">
                <div class="spinner sm"></div>
                <h4 style="color: var(--accent-yellow);">Publishing &amp; Deploying in Progress</h4>
                <span class="badge badge-warning" style="margin-left: auto; font-size: 0.75rem;">Propagating (~1-2 min)</span>
              </div>
              <p class="published-desc">
                GitHub Actions is setting up the student acceptance broker and publishing the web portal. You can safely stay on this page or navigate away — setup will finish automatically in the background.
              </p>
              <div class="deploy-steps-row" style="display: flex; gap: var(--space-md); margin: var(--space-xs) 0; font-size: 0.85rem; flex-wrap: wrap;">
                <div style="display: flex; align-items: center; gap: 4px; color: var(--accent-green);">
                  <Icon name="check-circle" :size="14" />
                  <span>1. Setup Workflow Launched</span>
                </div>
                <div style="display: flex; align-items: center; gap: 4px;" :style="{ color: brokerExists ? 'var(--accent-green)' : 'var(--accent-yellow)' }">
                  <Icon :name="brokerExists ? 'check-circle' : 'refresh-cw'" :size="14" :class="{ 'spin-animation': !brokerExists }" />
                  <span>2. Acceptance Broker (<code>broker-{{ form.id }}</code>) {{ brokerExists ? 'Created' : 'Creating…' }}</span>
                </div>
                <div style="display: flex; align-items: center; gap: 4px;" :style="{ color: pagesLive ? 'var(--accent-green)' : 'var(--accent-yellow)' }">
                  <Icon :name="pagesLive ? 'check-circle' : 'refresh-cw'" :size="14" :class="{ 'spin-animation': !pagesLive }" />
                  <span>3. Student Web Portal {{ pagesLive ? 'Live' : 'Deploying (~1 min)…' }}</span>
                </div>
              </div>
              <!-- :resolve="false" - the form is the authority here. Rotating
                   clears form.invite_token on purpose, and re-reading the YAML
                   the workflow has not rewritten yet would hand the retired
                   link straight back. -->
              <InvitationShare :org="org" :assignment="shareAssignment" variant="banner" :resolve="false" @regenerate="openRegenerate" />
              <div class="link-share-row">
                <button class="btn btn-sm btn-secondary btn-with-icon" type="button" @click="verifyLiveInfrastructure(form.id)" :disabled="liveCheckLoading">
                  <Icon name="refresh-cw" :size="12" :class="{ 'spin-animation': liveCheckLoading }" />
                  <span>Check status</span>
                </button>
              </div>
            </div>

            <!-- 3. TIMEOUT / TAKING LONGER THAN USUAL -->
            <div v-else-if="publishWatch === 'timeout'" class="published-info-card is-warning">
              <div class="published-header">
                <Icon name="clock" :size="16" class="text-yellow" />
                <h4 style="color: var(--accent-yellow);">Publishing Taking Longer than Usual</h4>
                <span class="badge badge-warning" style="margin-left: auto; font-size: 0.75rem;">Queue Delay</span>
              </div>
              <p class="published-desc">
                GitHub Actions is taking longer than usual to complete deployment. The student link will activate automatically as soon as the background workflow finishes.
              </p>
              <!-- :resolve="false" - the form is the authority here. Rotating
                   clears form.invite_token on purpose, and re-reading the YAML
                   the workflow has not rewritten yet would hand the retired
                   link straight back. -->
              <InvitationShare :org="org" :assignment="shareAssignment" variant="banner" :resolve="false" @regenerate="openRegenerate" />
              <div class="link-share-row">
                <div style="display: flex; gap: var(--space-xs);">
                  <button class="btn btn-sm btn-secondary btn-with-icon" type="button" @click="verifyLiveInfrastructure(form.id)" :disabled="liveCheckLoading">
                    <Icon name="refresh-cw" :size="12" :class="{ 'spin-animation': liveCheckLoading }" />
                    <span>Check Status Now</span>
                  </button>
                  <button class="btn btn-sm btn-with-icon" type="button" @click="showDiagnosticModal = true">
                    <Icon name="activity" :size="12" />
                    <span>Troubleshoot</span>
                  </button>
                </div>
              </div>
            </div>

            <!-- 4. BROKER MISSING / INCOMPLETE PUBLISH -->
            <div v-else-if="brokerExists === false" class="published-info-card is-error">
              <div class="published-header">
                <Icon name="alert-triangle" :size="16" class="text-danger" />
                <h4 style="color: var(--accent-red);">Publish Incomplete: Student Acceptance Broker Missing</h4>
                <span class="badge badge-danger" style="margin-left: auto; font-size: 0.75rem;">Action Required</span>
              </div>
              <p class="published-desc text-danger">
                This assignment is set to published, but its student acceptance broker (<code>broker-{{ form.id }}</code>) does not exist on GitHub. Students cannot accept until the broker is created.
              </p>
              <div style="display: flex; gap: var(--space-sm); align-items: center; margin-top: var(--space-xs); flex-wrap: wrap;">
                <button class="btn btn-secondary btn-with-icon" type="button" @click="handlePublishClick" :disabled="publishing">
                  <Icon name="refresh-cw" :size="14" :class="{ 'spin-animation': publishing }" />
                  <span>{{ publishing ? 'Setting up…' : 'Complete Setup / Create Broker Now' }}</span>
                </button>
                <button class="btn btn-with-icon" type="button" @click="showDiagnosticModal = true">
                  <Icon name="activity" :size="14" />
                  <span>Troubleshoot</span>
                </button>
              </div>
            </div>

            <!-- 5. CHECKING / LOADING STATE -->
            <div v-else class="published-info-card">
              <div class="published-header">
                <div class="spinner sm"></div>
                <h4>Checking Live Status…</h4>
              </div>
              <p class="published-desc">Checking student acceptance broker repository and Pages deployment status.</p>
            </div>
          </div>

          <!-- COHORT SUMMARY (UX_PLAN §7.1)
               Once an assignment is out, the job is running a cohort, not
               defining one - so a published or closed assignment leads with
               where it stands and how long is left, and the settings go behind
               the disclosure below. A draft opens on the form, because
               defining it IS the job. -->
          <section v-if="cohortFirst" class="cohort-card">
            <div class="cohort-figures">
              <div class="cohort-stat">
                <template v-if="cohort">
                  <span class="cohort-value">{{ cohort.accepted }}<span v-if="cohort.cap" class="cohort-of"> / {{ cohort.cap }}</span></span>
                  <span class="cohort-label">accepted</span>
                </template>
                <template v-else>
                  <!-- Never "0 accepted": a report that has not run and a
                       cohort where nobody has accepted are different facts,
                       and only one of them is a number. -->
                  <span class="cohort-value cohort-unknown">—</span>
                  <span class="cohort-label">{{ cohortUnknownReason }}</span>
                </template>
              </div>
              <div class="cohort-stat">
                <span class="cohort-value">{{ deadlineSummary.value }}</span>
                <span class="cohort-label" :title="formatDate(shareAssignment.deadline_at, form.timezone)">{{ deadlineSummary.label }}</span>
              </div>
            </div>
            <router-link
              :to="{ name: 'assignment-detail', params: { org, assignmentId: form.id } }"
              class="btn btn-secondary btn-with-icon"
            >
              <span>Track roster &amp; progress</span>
              <Icon name="arrow-right" :size="14" />
            </router-link>
          </section>

          <!-- The six fieldsets, collapsed once the assignment is out. The
               summary carries the field-error count so a validation problem is
               visible from outside the disclosure even when it is shut. -->
          <details
            class="settings-disclosure"
            :class="{ 'is-static': !cohortFirst }"
            :open="settingsExpanded"
            @toggle="settingsOpen = $event.target.open"
          >
            <summary>
              <!-- `display: flex` on a <summary> removes the native disclosure
                   triangle, so the control has to bring its own or it reads as
                   a heading nobody would click. -->
              <Icon name="chevron-down" :size="14" class="settings-caret" />
              <span>Edit settings</span>
              <span v-if="fieldErrorCount" class="settings-problems">
                {{ fieldErrorCount }} field{{ fieldErrorCount === 1 ? '' : 's' }} need{{ fieldErrorCount === 1 ? 's' : '' }} fixing
              </span>
            </summary>

          <!-- `touchedFields.X || !isNew` on every field error below.
               `touched` exists so a form you are still filling in does not
               nag you about the boxes you have not reached yet - which is
               about a NEW assignment. On one loaded from the control repo
               every error is a fact about a document that already exists, and
               gating those on touch is how "1 field needs fixing" ended up on
               the settings summary with nothing on screen saying which field.
               Reachable: nothing validates an assignment YAML on the way in,
               so `roster_mode: open` with no cap, or `deadline_at: soon`,
               arrives here and disables Save silently. -->
          <!-- BASICS -->
          <fieldset>
            <legend>Basics</legend>
            <div class="field">
              <label>Title <span class="req">*</span></label>
              <input v-model="form.title" @input="autoSyncSlug(); touchedFields.title = true" placeholder="e.g. Linux Processes 2026" />
              <div v-if="(touchedFields.title || !isNew) && fieldErrors.title" class="field-error-msg">{{ fieldErrors.title }}</div>
            </div>
            <div class="field">
              <label>Slug (URL identifier) <span class="req">*</span></label>
              <input
                v-model="form.id"
                :disabled="!isNew"
                @input="manualSlug = true; touchedFields.id = true"
                placeholder="linux-processes-2026"
              />
              <div v-if="(touchedFields.id || !isNew) && fieldErrors.id" class="field-error-msg">{{ fieldErrors.id }}</div>
              <small v-if="isNew">Auto-derived from title. Edit to override.</small>
              <small v-else>Locked. Changing the slug would orphan the YAML file.</small>
            </div>
            <div class="field">
              <label>Description</label>
              <textarea
                v-model="form.description"
                rows="2"
                placeholder="Optional"
              ></textarea>
              <!-- Not gated on `touched`, unlike the required-field errors: this
                   one only fires when there IS content, so it can never nag an
                   empty form - and an assignment loaded from the control repo
                   with a bad description must explain why Save is disabled. -->
              <div v-if="fieldErrors.description" class="field-error-msg">{{ fieldErrors.description }}</div>
              <small>Published on the public assignment page, so students can read it before they accept.</small>
            </div>
          </fieldset>

          <!-- TEMPLATE -->
          <fieldset>
            <legend>Template</legend>
            <div class="field">
              <label>Template repository <span class="req">*</span></label>
              <div v-if="loadingTemplates" class="loading-inline"><div class="spinner sm"></div> Loading templates from {{ org }}…</div>
              <div v-else class="combobox-wrapper" ref="comboboxContainerEl">
                <div class="combobox-input-wrapper">
                  <input
                    type="text"
                    v-model="templateSearchText"
                    placeholder="Type or select a template repository"
                    @focus="showTemplateDropdown = true"
                    @input="onTemplateInput"
                    @keydown.down.prevent="navigateDropdown(1)"
                    @keydown.up.prevent="navigateDropdown(-1)"
                    @keydown.enter.prevent="selectActiveDropdownItem"
                    @keydown.esc="showTemplateDropdown = false"
                    role="combobox"
                    :aria-expanded="showTemplateDropdown"
                    aria-autocomplete="list"
                    aria-controls="template-dropdown"
                    :aria-activedescendant="activeDropdownIdx >= 0 && activeDropdownIdx < filteredTemplates.length ? 'template-option-' + activeDropdownIdx : undefined"
                  />
                  <div v-if="showTemplateDropdown" id="template-dropdown" class="combobox-dropdown" role="listbox">
                    <div
                      v-for="(t, idx) in filteredTemplates"
                      :key="t.full_name"
                      :class="['combobox-item', { active: idx === activeDropdownIdx }]"
                      @click="selectTemplate(t)"
                      role="option"
                      :id="'template-option-' + idx"
                      :aria-selected="idx === activeDropdownIdx"
                    >
                      <span>
                        {{ t.full_name }}
                        <span v-if="!t.is_template" class="text-secondary"> (not a template repo)</span>
                        <span v-if="t._foreign" class="text-muted"> (cross-org)</span>
                      </span>
                    </div>
                    <div v-if="filteredTemplates.length === 0" class="combobox-item no-matches" role="option" aria-disabled="true">
                      No template repositories match "{{ templateSearchText }}"
                    </div>
                  </div>
                </div>
                <button
                  class="btn btn-refresh"
                  type="button"
                  @click="loadTemplates"
                  :disabled="loadingTemplates"
                  title="Refresh templates from GitHub"
                >
                  <Icon name="refresh-cw" :size="14" :class="{ 'spin-animation': loadingTemplates }" />
                </button>
              </div>
              <!-- Pre-flight Template Validation Badge (2.B) -->
              <div v-if="templateValidationStatus" class="template-preflight-badge" style="margin-top: var(--space-xs);" role="status">
                <span v-if="templateValidationStatus.checking" class="badge badge-neutral flex items-center gap-xs" style="font-size: 0.8rem; padding: 3px 8px;">
                  <span class="spinner sm" style="width: 12px; height: 12px;"></span> Checking template repository…
                </span>
                <span v-else-if="templateValidationStatus.valid && templateValidationStatus.isTemplate" class="badge badge-success flex items-center gap-xs" style="font-size: 0.8rem; padding: 3px 8px;">
                  <Icon name="check-circle" :size="13" /> Valid Template Repository ({{ templateValidationStatus.defaultBranch }} branch{{ templateValidationStatus.isPrivate ? ', private' : '' }})
                </span>
                <span v-else-if="templateValidationStatus.valid && !templateValidationStatus.isTemplate" class="badge badge-warning flex items-center gap-xs" style="font-size: 0.8rem; padding: 3px 8px;">
                  <Icon name="alert-triangle" :size="13" /> Repository exists but is not marked as a GitHub Template
                </span>
                <span v-else-if="!templateValidationStatus.valid" class="badge badge-error flex items-center gap-xs" style="font-size: 0.8rem; padding: 3px 8px;">
                  <Icon name="x-circle" :size="13" /> {{ templateValidationStatus.message || 'Repository not found on GitHub' }}
                </span>
              </div>
              <div v-if="(touchedFields.template || !isNew) && fieldErrors.template" class="field-error-msg">{{ fieldErrors.template }}</div>
              <small v-if="templatesError" class="text-danger" style="display: block; margin-top: var(--space-xs);">
                Failed to load templates: {{ templatesError }}.
              </small>
              <!-- The first-run wall (UX_PLAN §5.1). The old copy - "Create one
                   and mark it as a template in repo Settings" - assumed the
                   reader already knew what a template repository is, and buried
                   the one non-obvious step (the checkbox) that is the actual
                   reason this list is empty for almost everyone.
                   The combobox deliberately stays: typing `owner/repo` is the
                   only way to name a template the org search cannot see, and
                   `checkTemplateValidity` probes it live. -->
              <div v-else-if="!loadingTemplates && templates.length === 0" class="template-empty">
                <strong>This organization has no template repositories yet.</strong>
                <p>
                  A template is an ordinary repository - starter code, a README, whatever each
                  student should begin from. Every student gets their own copy of it.
                </p>
                <a
                  class="btn btn-secondary btn-sm btn-with-icon"
                  :href="`https://github.com/organizations/${org}/repositories/new`"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Icon name="plus" :size="13" />
                  <span>Create one on GitHub</span>
                </a>
                <p>
                  Then open its <strong>Settings</strong> and tick <strong>Template repository</strong>.
                  Come back and press refresh - it will appear in the list.
                </p>
                <p class="text-muted">
                  Already have one? Ticking <strong>Template repository</strong> in its settings is
                  what makes it show up here.
                </p>
              </div>
              <small v-else-if="!loadingTemplates">
                Found {{ templates.length }} template repositories.
              </small>
            </div>
            <div class="field">
              <label>Repository name pattern <span class="req">*</span></label>
              <input v-model="form.repository_name_pattern" @input="manualRepositoryNamePattern = true; touchedFields.repository_name_pattern = true" placeholder="linux-processes-{github_login}" />
              <div v-if="(touchedFields.repository_name_pattern || !isNew) && fieldErrors.repository_name_pattern" class="field-error-msg">{{ fieldErrors.repository_name_pattern }}</div>
              <small>Must contain <code>{{ form.assignment_type === 'group' ? '{team_slug}' : '{github_login}' }}</code>. The repository will be named per this pattern.</small>
            </div>
          </fieldset>

          <!-- ASSIGNMENT TYPE -->
          <fieldset>
            <legend>Assignment Type</legend>
            <div class="field">
              <label>Collaboration Model</label>
              <div class="radio-group" style="display: flex; gap: var(--space-lg); margin-top: 4px;">
                <label style="display: flex; align-items: center; gap: 6px; cursor: pointer;">
                  <input type="radio" v-model="form.assignment_type" value="individual" @change="onAssignmentTypeChange" />
                  <span><strong>Individual</strong> (1 student per repository)</span>
                </label>
                <label style="display: flex; align-items: center; gap: 6px; cursor: pointer;">
                  <input type="radio" v-model="form.assignment_type" value="group" @change="onAssignmentTypeChange" />
                  <span><strong>Group</strong> (team collaboration on 1 repository)</span>
                </label>
              </div>
            </div>

            <div v-if="form.assignment_type === 'group'" class="group-config-box" style="margin-top: var(--space-md); padding: var(--space-md); background: var(--bg-secondary); border-radius: 6px; border: 1px solid var(--border-default); display: flex; flex-direction: column; gap: var(--space-md);">
              <div class="field">
                <label>Formation Mode</label>
                <select v-model="form.group_config.formation_mode">
                  <option value="self-service">Self-Service: students create or join open teams</option>
                  <option value="pre-assigned">Pre-Assigned: teams pre-mapped in roster / instructor created</option>
                </select>
                <small>Under pre-assigned mode, students only see and accept their assigned team repository.</small>
              </div>

              <div class="field">
                <label>Maximum team size <span class="req">*</span></label>
                <input type="number" v-model.number="form.group_config.max_team_size" min="2" max="50" style="max-width: 140px;" />
                <small>Maximum number of students allowed per team.</small>
              </div>

              <div class="field">
                <label>Minimum team size</label>
                <input type="number" v-model.number="form.group_config.min_team_size" min="1" max="50" style="max-width: 140px;" />
                <small>Teams with fewer members will show an under-capacity warning in the lecturer dashboard.</small>
              </div>

              <div v-if="form.group_config.formation_mode === 'self-service'" class="field checkbox">
                <label>
                  <input type="checkbox" v-model="form.group_config.allow_team_creation" />
                  Allow students to create new teams
                </label>
                <small>When enabled, students can create custom new teams or join open teams. When unchecked, students can only join existing teams created by the lecturer.</small>
              </div>

              <div v-if="form.group_config.formation_mode === 'pre-assigned'" class="field checkbox">
                <label>
                  <input
                    type="checkbox"
                    v-model="form.group_config.unassigned_fallback"
                    true-value="self-service"
                    false-value="block"
                  />
                  Let students with no assigned team form their own
                </label>
                <small>
                  Without this, a student who is in no team sees “contact your instructor” and cannot
                  accept at all — which is where late enrollers, Erasmus arrivals and anyone whose
                  partners dropped out get stuck.
                </small>
              </div>

              <!-- Not on the create form (UX_PLAN §5.3). Teams are stored under
                   the assignment's ID, so this could never work here - it was a
                   permanently disabled control explaining its own impossibility.
                   It stays on the editor for a saved assignment, where it works. -->
              <div v-if="!isNew" class="field">
                <label>Starting teams</label>
                <div class="flex items-center gap-sm flex-wrap">
                  <button
                    type="button"
                    class="btn btn-secondary btn-sm btn-with-icon"
                    :disabled="hasUnsavedEdits()"
                    @click="showSeedModal = true"
                  >
                    <Icon name="users" :size="13" />
                    <span>Seed teams from…</span>
                  </button>
                  <span v-if="hasUnsavedEdits()" class="text-muted text-xs">
                    Save your changes first — seeding reads this assignment's team size and
                    repository pattern.
                  </span>
                </div>
                <small>
                  Carry the groups from an earlier group assignment (or the roster’s team columns)
                  into this one, so students confirm the group they already work in instead of
                  forming a new one. Review the result in the assignment’s Teams tab before publishing.
                </small>
              </div>
            </div>
          </fieldset>

          <!-- SCHEDULE -->
          <fieldset>
            <legend>Schedule</legend>
            <div class="field">
              <label>Opens at <span class="req">*</span></label>
              <input type="datetime-local" v-model="form.opens_at_local" @change="touchedFields.opens_at = true" />
              <div v-if="(touchedFields.opens_at || !isNew) && fieldErrors.opens_at" class="field-error-msg">{{ fieldErrors.opens_at }}</div>
              <small>{{ utcHint(form.opens_at_local) }}</small>
            </div>
            <div class="field">
              <label>Deadline <span class="req">*</span></label>
              <input type="datetime-local" v-model="form.deadline_at_local" @change="touchedFields.deadline_at = true" />
              <div v-if="(touchedFields.deadline_at || !isNew) && fieldErrors.deadline_at" class="field-error-msg">{{ fieldErrors.deadline_at }}</div>
              <small>{{ utcHint(form.deadline_at_local) }}</small>
              <small v-if="deadlineInPast" class="text-warning">
                This deadline is in the past; the next nightly run will finalize (lock down + report) immediately.
              </small>
            </div>
          </fieldset>

          <!-- GUARDRAILS -->
          <fieldset>
            <legend>Guardrails</legend>
            <div class="field">
              <label>Who may accept</label>
              <select v-model="form.roster_mode">
                <option value="enforced">enforced: only students on the roster</option>
                <option value="open">open: any GitHub account (exams, unknown cohort)</option>
              </select>
              <!-- `enforced` makes students/roster.yml load-bearing, so the
                   form says whether anyone can accept at all rather than
                   naming a tab it does not link to (UX_PLAN §5.2). The count
                   comes from RosterTab, which has already read the file. -->
              <small v-if="form.roster_mode !== 'open'" class="roster-status">
                <span v-if="rosterCount === 0" class="status-indicator">
                  <span class="status-dot dot-warning"></span>
                  <span>No students imported yet - nobody can accept.</span>
                  <button type="button" class="btn-link" @click="setTab('roster')">Import roster →</button>
                </span>
                <span v-else-if="rosterCount > 0 && rosterLinked === 0" class="status-indicator">
                  <!-- github_login is the optional column and the only thing
                       accept.mjs matches on, so a roster imported before anyone
                       handed in a username stops every acceptance. -->
                  <span class="status-dot dot-warning"></span>
                  <span>
                    {{ rosterCount }} student{{ rosterCount === 1 ? '' : 's' }} on the roster, but
                    none has a GitHub username yet - nobody can accept.
                  </span>
                  <button type="button" class="btn-link" @click="setTab('roster')">Manage →</button>
                </span>
                <span v-else-if="rosterCount > 0" class="status-indicator">
                  <span class="status-dot dot-success"></span>
                  <span>
                    {{ rosterCount }} student{{ rosterCount === 1 ? '' : 's' }} on the roster<template
                      v-if="rosterLinked < rosterCount"
                    >, {{ rosterCount - rosterLinked }} without a GitHub username yet</template>.
                  </span>
                  <button type="button" class="btn-link" @click="setTab('roster')">Manage →</button>
                </span>
                <span v-else>
                  Students must appear in <code>students/roster.yml</code>. Import them under the
                  <strong>Roster</strong> tab - an empty roster means nobody can accept.
                </span>
              </small>
              <small v-else class="text-warning">
                <strong>Anyone</strong> with the link can claim a repo while the assignment is open.
                The deadline window and the max-acceptances cap are the only limits - keep the cap tight,
                and reconcile logins to students afterward.
              </small>
            </div>
            <div class="field">
              <label>Max acceptances<span v-if="form.roster_mode === 'open'"> (required)</span></label>
              <input type="number" v-model.number="form.max_acceptances" min="1" @input="touchedFields.max_acceptances = true" />
              <div v-if="(touchedFields.max_acceptances || !isNew) && fieldErrors.max_acceptances" class="field-error-msg">{{ fieldErrors.max_acceptances }}</div>
              <small v-if="form.max_acceptances">Hard cap on accepted students. Acceptances beyond this are rejected.</small>
              <small v-else-if="form.roster_mode === 'open'" class="field-error-msg">
                Required with open enrollment - without the roster gate this is the only limit on who can claim a repo.
              </small>
              <small v-else class="text-warning">Empty = <strong>no cap</strong> (any number of students can accept). Set a number to keep the guardrail.</small>
            </div>
            <div class="field">
              <label>Late work</label>
              <div class="radio-group" style="display: flex; flex-direction: column; gap: 6px; margin-top: 4px;">
                <label style="display: flex; align-items: flex-start; gap: 6px; cursor: pointer;">
                  <input type="radio" v-model="form.late_policy" value="report" @change="onLatePolicyChange" />
                  <span>
                    <strong>Counts</strong> - late commits are part of the submission and flagged in the
                    report. The submission branch is not locked.
                  </span>
                </label>
                <label style="display: flex; align-items: flex-start; gap: 6px; cursor: pointer;">
                  <input type="radio" v-model="form.late_policy" value="block" @change="onLatePolicyChange" />
                  <span>
                    <strong>Does not count</strong> - the submission branch is locked at the deadline.
                    Students keep their repository, their Actions, their secrets and their runners;
                    they simply cannot push to it.
                  </span>
                </label>
              </div>
              <small v-if="form.late_policy === 'block'">
                Locking happens on the first nightly run after the deadline. Anything pushed in between is
                filtered out - the submission falls back to the last commit <em>committed</em> before the
                deadline. That date comes from the student's own machine, so treat it as the ordinary case
                rather than as proof.
              </small>
            </div>
            <div class="field checkbox">
              <label>
                <input type="checkbox" v-model="form.lock_down_enabled" />
                Also take admin away at the deadline (demote to read-only)
              </label>
              <small v-if="form.late_policy === 'block'">
                Not needed to stop late pushes - the branch lock above already does that, and leaves
                students their Actions, secrets and runners. Tick this only if they should lose those too.
              </small>
              <small v-else>
                Students are demoted to read-only on the first nightly run after the deadline.
                Untick to leave their repositories open.
              </small>
            </div>
            <div class="field checkbox">
              <label>
                <input type="checkbox" v-model="form.feedback_pr" />
                Open a draft Feedback PR for each student (pxl-baseline protected branch)
              </label>
              <small>
                Provisioning creates a frozen <code>{{ form.feedback_pr_baseline_branch || 'pxl-baseline' }}</code> branch and protects it.
                PRs are opened lazily via <code>pxl-classroom feedback open --assignment {{ form.id || 'ID' }}</code> once students push commits.
              </small>
            </div>
            <!-- One line, never the configuration (UX_PLAN §6.1). This was an
                 "Enable autograding" checkbox that opened a type dropdown, four
                 unlabelled textareas whose meaning changed with it, no headers,
                 no totals and no validation until the schema refused the save.
                 The configuration's existence is the flag; there is no separate
                 checkbox left to disagree with it. -->
            <div class="field autograde-summary">
              <label>Automated checks</label>
              <div class="autograde-summary-row">
                <span class="autograde-summary-text">{{ autogradeSummary }}</span>
                <button class="btn btn-secondary btn-sm" type="button" @click="showAutogradeModal = true">
                  {{ form.autograde_enabled && (form.autograde_tests || []).length ? 'Edit' : 'Set up' }}
                </button>
                <button
                  v-if="form.autograde_enabled && (form.autograde_tests || []).length"
                  class="btn btn-sm"
                  type="button"
                  @click="clearAutograde"
                >Remove</button>
              </div>
              <div v-if="fieldErrors.autograde_tests" class="field-error-msg">{{ fieldErrors.autograde_tests }}</div>
              <small v-if="form.autograde_enabled && form.autograde_execution_environment === 'lecturer_local'">
                Run <code>pxl-classroom grade --org {{ org }} --assignment {{ form.id || 'ID' }}</code> after the deadline.
                Results land in <code>grading/{{ form.id || 'ID' }}/</code>.
              </small>
            </div>
          </fieldset>

          <!-- ADVANCED -->
          <details class="advanced">
            <summary>Advanced</summary>
            <div class="field">
              <label>Student permission</label>
              <select v-model="form.student_permission">
                <option value="admin">admin (recommended: required for Actions/runners exercises)</option>
                <option value="maintain">maintain</option>
                <option value="push">push</option>
                <option value="triage">triage</option>
                <option value="pull">pull</option>
              </select>
            </div>
            <div class="field">
              <label>Submission ref</label>
              <input v-model="form.submission_ref" placeholder="refs/heads/main" />
            </div>
            <div class="field">
              <label>Timezone (display)</label>
              <input v-model="form.timezone" placeholder="Europe/Brussels" />
            </div>
            <!-- No `acceptance_mode` control: the enum has one value, so the
                 select was a decision the lecturer could not make. The field is
                 still written by buildDoc() and published on the card. -->
          </details>
          </details>

          <!-- VALIDATION ERRORS - outside the disclosure on purpose. Save is
               disabled by them, so hiding them behind a collapsed section is
               how a lecturer ends up with a dead button and no explanation. -->
          <div v-if="validationErrors.length" class="validation-errors">
            <strong>Fix these before saving:</strong>
            <ul>
              <li v-for="(e, i) in validationErrors" :key="i">{{ e }}</li>
            </ul>
          </div>

          <!-- No second Cancel / Save row here. The editor header bar carries
               exactly these three buttons, and repeating them put two solid
               `Save & publish` on screen at once - DESIGN.md §1.2, and the
               reason it was scoped out of the conformity test until now. -->

          <!-- LIFECYCLE ACTIONS for existing -->
          <div v-if="!isNew" class="lifecycle">
            <h4>Lifecycle</h4>

            <!-- Repair above the rule, state transitions below it (UX_PLAN
                 §7.1 / UX24). "Republish the broker" and "stop the whole
                 cohort accepting" were adjacent buttons in one flat row; only
                 one of them changes what the assignment IS.

                 PUBLISHED ONLY, and that is load-bearing: publish-assignment.yml
                 writes `state: published` unconditionally, so dispatching it
                 from a closed or archived assignment REOPENS acceptance. That
                 is a transition, not a repair, and grouping it here under copy
                 promising nothing changes would be C4 exactly. A draft has no
                 broker to repair yet; its Publish is a transition too. -->
            <div v-if="form.state === 'published'" class="lifecycle-group lifecycle-repair">
              <span class="lifecycle-group-label">Repair</span>
              <button
                class="btn btn-secondary btn-with-icon"
                type="button"
                @click="handlePublishClick"
                :disabled="publishing"
              >
                <template v-if="publishing">Publishing…</template>
                <template v-else>
                  <Icon name="refresh-cw" :size="14" />
                  <span>Republish broker</span>
                </template>
              </button>
              <small class="text-secondary">Recreates the broker and its variables. Existing student repositories are untouched, and links already handed out keep working.</small>
            </div>

            <div class="lifecycle-group lifecycle-transitions">
              <span v-if="form.state === 'published' || form.state === 'closed'" class="lifecycle-group-label">State</span>
              <button
                v-if="form.state !== 'published'"
                class="btn btn-with-icon"
                type="button"
                @click="handlePublishClick"
                :disabled="publishing"
              >
                <template v-if="publishing">Publishing…</template>
                <!-- Named after what it does from here. From `closed` or
                     `archived` this is not a publish, it is an un-close. -->
                <template v-else-if="form.state === 'closed' || form.state === 'archived'">Reopen for acceptance</template>
                <template v-else>Publish (create broker, enable nightly)</template>
              </button>
              <button class="btn" type="button" @click="setState('closed')" :disabled="form.state === 'closed' || saving">
                Stop accepting
              </button>
              <button v-if="form.state === 'published' || form.state === 'closed'" class="btn" type="button" @click="setState('draft')" :disabled="saving">
                Revert to draft
              </button>
              <button class="btn" type="button" @click="setState('archived')" :disabled="form.state === 'archived' || saving">
                Archive
              </button>
              <!-- No "Copy invitation link" here: copying is not a lifecycle
                   transition (UX_PLAN §4.2 / UX24). It lives in the share block
                   above and on every assignment row. -->
              <button v-if="form.state === 'draft'" class="btn btn-danger" type="button" @click="deleteDraft" :disabled="deleting">
                {{ deleting ? 'Deleting…' : 'Delete draft' }}
              </button>
            </div>

            <!-- Both used to live here as accordions that made you type a
                 login from memory. They are per-student operations and their
                 home is the student's own row (UX_PLAN §7.2 / C2). -->
            <p v-if="form.state === 'published' || form.state === 'closed'" class="lifecycle-moved text-secondary">
              Per-student extensions and retries are on the
              <router-link :to="{ name: 'assignment-detail', params: { org, assignmentId: form.id } }">roster &amp; progress</router-link>
              page, on the student's own row.
            </p>

            <div v-if="publishWatch === 'watching'" class="publish-watch">
              <div class="spinner sm"></div>
              <span class="text-secondary">Publish triggered. Waiting for the assignment to go live on the Pages site… (checked {{ publishPollCount }}×)</span>
            </div>
            <div v-else-if="publishWatch === 'ready'" class="publish-watch publish-ready">
              <Icon name="check-circle" :size="15" />
              <span>Assignment is live. The invitation link above works now.</span>
            </div>
            <div v-else-if="publishWatch === 'timeout'" class="publish-watch">
              <span class="text-warning">
                Assignment not live on Pages site after 8 minutes. Check the
                <a :href="`https://github.com/${config.hubOwner}/${config.hubRepo}/actions/workflows/publish-assignment.yml`" target="_blank" rel="noopener">publish workflow run</a>.
              </span>
            </div>

          </div>
        </form>
      </main>
    </div>
    </template>

    <!-- Modal: Republish Broker Confirmation -->
    <div v-if="showRepublishModal" class="modal-overlay" @click.self="showRepublishModal = false">
      <div class="modal card republish-modal" role="dialog" aria-modal="true" aria-labelledby="republish-broker-title">
        <header class="modal-head flex justify-between items-center">
          <h3 id="republish-broker-title" class="flex items-center gap-sm">
            <Icon name="refresh-cw" :size="18" />
            <span>Republish Broker Repository</span>
          </h3>
          <button class="modal-close" type="button" @click="showRepublishModal = false" :disabled="publishing" aria-label="Close">×</button>
        </header>

        <div class="modal-body flex flex-col gap-md">
          <div class="alert alert-info">
            <strong>Target Broker:</strong>
            <code>{{ props.org }}/broker-{{ form.id }}</code>
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

          <!-- Republishing normally REUSES the invitation, so a repair does not
               break links already handed out. Rotating is the other thing a
               lecturer needs and had no way to ask for: the input existed on
               publish-assignment.yml and nothing in the app ever sent it. -->
          <div class="regen-choice">
            <div class="field checkbox">
              <label>
                <input type="checkbox" v-model="regenerateInvite" :disabled="publishing" />
                Regenerate the invitation link
              </label>
              <small>
                Leave this off to repair the broker while every link already handed out keeps working.
              </small>
            </div>
            <div v-if="regenerateInvite" class="alert alert-danger text-sm">
              <strong>Every link already handed out stops working.</strong>
              Students who have not accepted yet will need the new link; anyone who already accepted keeps their repository.
              Do this if the current link has leaked.
            </div>
          </div>
        </div>

        <footer class="modal-foot flex justify-end gap-sm">
          <button class="btn" type="button" @click="showRepublishModal = false" :disabled="publishing">Cancel</button>
          <!-- DESIGN.md §1.2: a modal is its own view, so the confirm is this
               view's single solid button. §3 has no "warning" variant - the
               destructive spelling is .btn-danger, and it only appears when the
               action actually is destructive. -->
          <button
            :class="['btn', 'btn-with-icon', regenerateInvite ? 'btn-danger' : 'btn-primary']"
            type="button"
            @click="confirmRepublish"
            :disabled="publishing"
          >
            <Icon name="refresh-cw" :size="14" />
            <span>{{ publishing ? 'Publishing…' : (regenerateInvite ? 'Republish and retire the old link' : 'Republish broker now') }}</span>
          </button>
        </footer>
      </div>
    </div>

    <!-- AUTOMATED CHECKS -->
    <AutogradeModal
      v-if="showAutogradeModal"
      :config="{
        execution_environment: form.autograde_execution_environment,
        visibility: form.autograde_visibility,
        tests: form.autograde_tests,
      }"
      @save="applyAutograde"
      @close="showAutogradeModal = false"
    />

    <!-- SEED TEAMS FROM AN EXISTING GROUPING -->
    <SeedTeamsModal
      v-if="showSeedModal && !isNew"
      :org="org"
      :assignment="buildDoc()"
      :assignments="assignments"
      @close="showSeedModal = false"
      @seeded="onTeamsSeeded"
    />

    <!-- UNIFIED SYSTEM HEALTH & DIAGNOSTIC MODAL -->
    <SystemHealthModal
      :is-open="showDiagnosticModal"
      :org="org"
      :assignment-id="form.id"
      :form-doc="buildDoc()"
      @close="showDiagnosticModal = false"
      @fixed="onDiagnosticFixed"
      @navigate-tab="onDiagnosticNavigate"
    />
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { onBeforeRouteLeave, useRoute } from 'vue-router'
import { config } from '../lib/config.js'
import { clearAuth, getToken, getUser, isAuthenticated } from '../lib/auth.js'
import { commitFile, deleteFile, getRepo, triggerWorkflow, listRepoDir, getRepoContent, explainDispatchFailure, listOrgTemplates, validateTemplateRepository } from '../lib/api.js'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { validateAgainst } from '../lib/validate.js'
import { formatAssignmentValidationError } from '../lib/validation-messages.js'
import { cleanChecks, summariseAutograde } from '../lib/autograde.js'
import { toast } from '../lib/toast.js'
import { parseInviteFields, inviteDataUrl } from '../lib/invite.js'
import { findPublicTextViolation, publicTextMessage } from '../../../lib/public-text.mjs'
import { formatDate } from '../lib/format.js'
import { countdownParts } from '../lib/countdown.js'
import RosterTab from '../components/RosterTab.vue'
import AuthCard from '../components/AuthCard.vue'
import AppHeader from '../components/AppHeader.vue'
import SystemHealthModal from '../components/SystemHealthModal.vue'
import SeedTeamsModal from '../components/SeedTeamsModal.vue'
import InvitationShare from '../components/InvitationShare.vue'
import AutogradeModal from '../components/AutogradeModal.vue'
import Icon from '../components/Icon.vue'

const props = defineProps({ org: { type: String, required: true } })
const route = useRoute()

// ---------------------------------------------------------------- auth

// Device-flow sign-in for deep links opened without a session. Failures
// render inside the auth card (authError), never a misleading empty state.
const user = ref(getUser())

function handleLogout() {
  clearAuth()
  user.value = null
  assignments.value = []
  templates.value = []
}

async function onAuthenticated(authedUser) {
  user.value = authedUser
  await Promise.all([loadAssignments(), loadTemplates(), loadCohortSummary()])
}


// ---------------------------------------------------------------- tabs

const VALID_TABS = new Set(['assignments', 'roster'])
function tabFromHash() {
  const h = (typeof window !== 'undefined' && window.location.hash || '').replace(/^#/, '')
  return VALID_TABS.has(h) ? h : 'assignments'
}
const activeTab = ref(tabFromHash())
function setTab(name) {
  if (!VALID_TABS.has(name)) return
  activeTab.value = name
  if (typeof window !== 'undefined') {
    history.replaceState(null, '', `#${name}`)
  }
}
// Registered in onMounted / removed in onUnmounted - a setup-scope listener
// would leak (and mutate unmounted state) across route visits.
function onHashChange() { activeTab.value = tabFromHash() }

// Roving-tabindex arrow navigation for the two tabs (WAI-ARIA tabs pattern).
function onTabKeydown(e) {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
  e.preventDefault()
  setTab(activeTab.value === 'assignments' ? 'roster' : 'assignments')
  nextTick(() => document.querySelector('.admin-tabs .tab.active')?.focus())
}

// ---------------------------------------------------------------- state

const assignments = ref([])
const loadingList = ref(true)
const assignmentsError = ref(null)
const runbookUrl = `https://github.com/${config.hubOwner}/${config.hubRepo}/blob/main/RUNBOOK.md`
const templates = ref([])
const loadingTemplates = ref(false)
const templatesError = ref(null)
const editing = ref(null) // current assignment being edited (null = none)
const manualSlug = ref(false)
const saving = ref(false)
const publishing = ref(false)
const showRepublishModal = ref(false)
// Republish reuses the invitation by default; this is the opt-in that retires it.
const regenerateInvite = ref(false)
const showDiagnosticModal = ref(false)
const showSeedModal = ref(false)
const deleting = ref(false)

// '' | 'watching' | 'ready' | 'timeout' - post-publish broker watch
const publishWatch = ref('')
const publishPollCount = ref(0)
let publishPollTimer = null

// Drives the cohort card's countdown. A minute is the smallest unit it ever
// prints, so it ticks at a minute.
const now = ref(new Date())
let clockTimer = null

// Live infrastructure check state for published assignments
const liveCheckLoading = ref(false)
const brokerExists = ref(null) // null = unchecked, true = exists, false = missing
const pagesLive = ref(null)    // null = unchecked, true = live, false = not live

function onTeamsSeeded() {
  // The modal already reported the result; a second toast here just stacked on
  // top of it. Refresh the list so the assignment's team count is current.
  loadAssignments()
}

function onDiagnosticFixed({ type }) {
  if (type === 'publish_broker' || type === 'deploy_pages') {
    startPublishWatch()
  } else if (type === 'mark_template' || type === 'make_broker_public') {
    verifyLiveInfrastructure(form.value.id)
  }
}

function onDiagnosticNavigate(tabName) {
  if (tabName === 'roster') {
    setTab('roster')
  }
}

const form = ref(emptyForm())

// Snapshot of the form as of the last load/save. Anything different means
// unsaved edits - guard list navigation and Cancel against silent loss.
const savedSnapshot = ref('')
function snapshotForm() {
  savedSnapshot.value = JSON.stringify(form.value)
}
function confirmDiscard() {
  if (!editing.value) return true
  if (JSON.stringify(form.value) === savedSnapshot.value) return true
  return window.confirm('Discard unsaved changes to this assignment?')
}
function hasUnsavedEdits() {
  return !!editing.value && JSON.stringify(form.value) !== savedSnapshot.value
}

// The roster editor keeps its own pending-import state; include it in the
// exit guards so flipping away doesn't silently discard a parsed CSV.
const rosterTab = ref(null)
function rosterDirty() {
  return rosterTab.value?.isDirty?.() === true
}
// null until the roster has been read (or when there is no roster file at all),
// so the form can say "not known yet" rather than "nobody can accept".
const rosterCount = computed(() => rosterTab.value?.studentCount ?? null)
// How many of them can actually be matched by accept.mjs, which reads
// github_login and nothing else.
const rosterLinked = computed(() => rosterTab.value?.linkedCount ?? 0)
function confirmRosterDiscard() {
  if (!rosterDirty()) return true
  return window.confirm('Discard the un-committed roster import?')
}

// In-page navigation is guarded via confirmDiscard(); guard the two exits
// that used to lose edits silently - leaving the route (e.g. the Dashboard
// back button) and closing/refreshing the tab.
onBeforeRouteLeave(() => confirmDiscard() && confirmRosterDiscard())
function onBeforeUnload(e) {
  if (hasUnsavedEdits() || rosterDirty()) {
    e.preventDefault()
    e.returnValue = ''
  }
}

const isNew = computed(() => editing.value && editing.value.__new === true)

// A published or closed assignment leads with the cohort; a draft leads with
// the form, because defining it is still the job (UX_PLAN §7.1). An archived
// one keeps the form too - it is out of day-to-day tracking, so what is left
// to look at there is what it was configured to be.
const cohortFirst = computed(() =>
  !isNew.value && (form.value.state === 'published' || form.value.state === 'closed')
)

// Whether the six fieldsets are expanded. Seeded per assignment on load - an
// assignment that arrives with a validation problem opens expanded - and
// owned by the lecturer after that.
const settingsOpen = ref(true)
// A draft has no disclosure at all - the summary is hidden and the fieldsets
// are the page. Binding `open` through this is what stops a published
// assignment reverted to draft from rendering a collapsed, uncloseable form.
const settingsExpanded = computed(() => settingsOpen.value || !cohortFirst.value)

// What InvitationShare needs from the form. Built here rather than passed as
// `form` so the component sees an assignment-shaped object on every surface -
// the list rows and the dashboard cards pass real assignment records.
const shareAssignment = computed(() => ({
  id: form.value.id,
  state: form.value.state,
  timezone: form.value.timezone,
  invite_token: form.value.invite_token || null,
  invite_expires_at: form.value.invite_expires_at || null,
  opens_at: form.value.opens_at_local ? localToUtc(form.value.opens_at_local) : null,
  deadline_at: form.value.deadline_at_local ? localToUtc(form.value.deadline_at_local) : null,
  max_acceptances: form.value.max_acceptances || null,
}))

// Rotation had no affordance outside the Actions tab, and the one place it
// belongs is beside the link it retires. handlePublishClick still resets the
// box to false: a repair republish must not break links, and only a control
// that says "Regenerate" may arrive with it ticked.
function openRegenerate() {
  regenerateInvite.value = true
  showRepublishModal.value = true
}

const manualRepositoryNamePattern = ref(false)
const templateSearchText = ref('')
const showTemplateDropdown = ref(false)
const comboboxContainerEl = ref(null)
const activeDropdownIdx = ref(-1)

const touchedFields = ref({
  id: false,
  title: false,
  description: false,
  template: false,
  repository_name_pattern: false,
  opens_at: false,
  deadline_at: false,
  max_acceptances: false,
})

const filteredTemplates = computed(() => {
  const q = templateSearchText.value.toLowerCase().trim()
  if (!q) return templates.value
  return templates.value.filter(t => t.full_name.toLowerCase().includes(q))
})

const fieldErrors = computed(() => {
  const errors = {}

  // 1. Slug/ID check
  if (!form.value.id) {
    errors.id = 'Slug is required.'
  } else {
    const slugRegex = /^[a-z0-9][a-z0-9-]{0,99}$/
    if (!slugRegex.test(form.value.id)) {
      errors.id = 'Slug must be lowercase, start with a letter/number, and contain only lowercase letters, numbers, and hyphens (max 100 characters).'
    } else if (['admin', 'usage'].includes(form.value.id)) {
      errors.id = 'Slug "admin" and "usage" are reserved and cannot be used.'
    } else if (isNew.value && assignments.value.some(a => a.id === form.value.id)) {
      errors.id = 'Slug already exists. Choose a unique slug.'
    }
  }

  // 2. Title check
  if (!form.value.title) {
    errors.title = 'Title is required.'
  }

  // 3. Template check
  if (!form.value.template) {
    errors.template = 'Template repository is required.'
  } else {
    const parts = form.value.template.split('/')
    if (parts.length !== 2 || !parts[0].trim() || !parts[1].trim()) {
      errors.template = `Use the full name, e.g. ${props.org}/linux-template`
    }
  }

  // 4. Title and description are published on a public page.
  //
  // pages/scan.mjs would catch this, but only after Save, after the publish
  // workflow, inside a step that fails the whole ORG's dashboard regeneration
  // and reports a digest-named file. "Questions? Mail me at ..." is an ordinary
  // thing to type, so it gets refused here, next to the field.
  for (const [key, field, value] of [
    ['title', 'title', form.value.title],
    ['description', 'description', form.value.description],
  ]) {
    const violation = findPublicTextViolation(value)
    if (violation) errors[key] = publicTextMessage(field, violation)
  }

  // 5. Repository Name Pattern check
  if (!form.value.repository_name_pattern) {
    errors.repository_name_pattern = 'Repository name pattern is required.'
  } else if (form.value.assignment_type === 'group') {
    if (!form.value.repository_name_pattern.includes('{team_slug}') && !form.value.repository_name_pattern.includes('{github_login}')) {
      errors.repository_name_pattern = 'Pattern must contain "{team_slug}" (or "{github_login}").'
    }
  } else if (!form.value.repository_name_pattern.includes('{github_login}')) {
    errors.repository_name_pattern = 'Pattern must contain "{github_login}".'
  }

  // 6. Schedule check
  //
  // The unreadable case is not hypothetical: nothing validates an assignment
  // YAML on the way IN, so `deadline_at: soon` reaches the form as a date the
  // browser cannot parse. Saying so is the only way the lecturer learns why
  // the cohort card has no countdown and Save is disabled.
  const unreadable = (v) => Boolean(v) && Number.isNaN(new Date(v).getTime())
  if (!form.value.opens_at_local) {
    errors.opens_at = 'Open date is required.'
  } else if (unreadable(form.value.opens_at_local)) {
    errors.opens_at = 'This open date is not a date the panel can read - pick it again.'
  }
  if (!form.value.deadline_at_local) {
    errors.deadline_at = 'Deadline is required.'
  } else if (unreadable(form.value.deadline_at_local)) {
    errors.deadline_at = 'This deadline is not a date the panel can read - pick it again.'
  } else if (form.value.opens_at_local && !unreadable(form.value.opens_at_local)
             && new Date(form.value.deadline_at_local) <= new Date(form.value.opens_at_local)) {
    errors.deadline_at = 'Deadline must be after the open date.'
  }

  // 7. Max acceptances check
  if (form.value.max_acceptances !== '' && form.value.max_acceptances !== null && form.value.max_acceptances !== undefined) {
    const val = Number(form.value.max_acceptances)
    if (Number.isNaN(val) || !Number.isInteger(val) || val < 1) {
      errors.max_acceptances = 'Max acceptances must be a positive integer (or empty for no cap).'
    }
  } else if (form.value.roster_mode === 'open') {
    // Open enrollment drops the roster gate, so the cap is the only limit left.
    // Blocks Save (canSave watches fieldErrors), not just the submit handler.
    errors.max_acceptances = 'Open enrollment requires a cap - set a maximum number of acceptances.'
  }

  // 8. A python test is its script. Both CLI runners and the generated Actions
  // workflow write `script` to a file and run it, so an empty one is a test
  // that passes without executing anything. The schema refuses it too; caught
  // here it reads as a sentence instead of "/autograde/tests/2 must have
  // required property 'script'".
  if (form.value.autograde_enabled) {
    const scriptless = (form.value.autograde_tests || [])
      .map((t, i) => ({ t, label: t.id || `#${i + 1}` }))
      .filter(({ t }) => t.type === 'python' && !String(t.script || '').trim())
      .map(({ label }) => label)
    if (scriptless.length) {
      errors.autograde_tests = `Python test${scriptless.length > 1 ? 's' : ''} ${scriptless.join(', ')} need${scriptless.length > 1 ? '' : 's'} a script - it is the only thing a python test runs.`
    }
  }

  return errors
})

// Rendered on the disclosure's summary, so a validation problem is stated
// whether the fieldsets are open or shut. That - not forcing the disclosure
// open - is what stops one hiding behind it: a <details> that refuses to
// close is a dead control, and every field that can carry an error is inside
// this one, so there is no way to introduce a problem while it is collapsed.
// The only entry point that can is loading an assignment, and
// `editAssignment` seeds `settingsOpen` from exactly this count.
const fieldErrorCount = computed(() => Object.keys(fieldErrors.value).length)

// Combobox functions
function selectTemplate(t) {
  form.value.template = t.full_name
  templateSearchText.value = t.full_name
  showTemplateDropdown.value = false
  touchedFields.value.template = true
  activeDropdownIdx.value = -1

  // Auto-fill Title and Slug from template name if they are empty
  const repoName = t.full_name.split('/')[1] || ''
  if (repoName) {
    if (!form.value.title) {
      form.value.title = repoName
        .split('-')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ')
      touchedFields.value.title = true
    }
    if (!form.value.id && isNew.value) {
      form.value.id = toSlug(repoName)
      touchedFields.value.id = true
    }
  }
}

function onTemplateInput() {
  showTemplateDropdown.value = true
  activeDropdownIdx.value = -1
  // Keep form.template in sync if they type exactly an item, or update form.template with text
  const match = templates.value.find(t => t.full_name.toLowerCase() === templateSearchText.value.toLowerCase().trim())
  form.value.template = match ? match.full_name : templateSearchText.value.trim()
  touchedFields.value.template = true

  // If there's a match, auto-fill Title and Slug from template name if they are empty
  if (match) {
    const repoName = match.full_name.split('/')[1] || ''
    if (repoName) {
      if (!form.value.title) {
        form.value.title = repoName
          .split('-')
          .map(word => word.charAt(0).toUpperCase() + word.slice(1))
          .join(' ')
        touchedFields.value.title = true
      }
      if (!form.value.id && isNew.value) {
        form.value.id = toSlug(repoName)
        touchedFields.value.id = true
      }
    }
  }
}

function navigateDropdown(direction) {
  if (!showTemplateDropdown.value) {
    showTemplateDropdown.value = true
    return
  }
  const len = filteredTemplates.value.length
  if (len === 0) return
  activeDropdownIdx.value = (activeDropdownIdx.value + direction + len) % len
}

function selectActiveDropdownItem() {
  if (!showTemplateDropdown.value) return
  if (activeDropdownIdx.value >= 0 && activeDropdownIdx.value < filteredTemplates.value.length) {
    selectTemplate(filteredTemplates.value[activeDropdownIdx.value])
  } else if (filteredTemplates.value.length > 0) {
    selectTemplate(filteredTemplates.value[0])
  }
}

function handleClickOutside(ev) {
  if (comboboxContainerEl.value && !comboboxContainerEl.value.contains(ev.target)) {
    showTemplateDropdown.value = false
  }
}

const templateValidationStatus = ref(null)
let templateValidationTimer = null

async function checkTemplateValidity(templateStr) {
  if (templateValidationTimer) clearTimeout(templateValidationTimer)
  if (!templateStr || !templateStr.includes('/')) {
    templateValidationStatus.value = null
    return
  }

  const parts = templateStr.trim().split('/')
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    templateValidationStatus.value = null
    return
  }

  const [owner, repo] = parts
  templateValidationStatus.value = { checking: true }

  templateValidationTimer = setTimeout(async () => {
    const token = getToken()
    if (!token) return
    try {
      const res = await validateTemplateRepository(token, owner, repo)
      if (res.ok) {
        templateValidationStatus.value = {
          valid: true,
          isTemplate: res.isTemplate,
          defaultBranch: res.defaultBranch,
          isPrivate: res.isPrivate,
          fullName: res.fullName,
        }
      } else {
        templateValidationStatus.value = {
          valid: false,
          message: res.reason === 'not_found' ? `Repository "${owner}/${repo}" not found or private` : res.message,
        }
      }
    } catch (e) {
      templateValidationStatus.value = {
        valid: false,
        message: e.message,
      }
    }
  }, 400)
}

watch(() => form.value.template, (newVal) => {
  if (newVal !== templateSearchText.value) {
    templateSearchText.value = newVal || ''
  }
  checkTemplateValidity(newVal)
})

watch(() => form.value.id, (newId) => {
  if (isNew.value && !manualRepositoryNamePattern.value) {
    const isGrp = form.value.assignment_type === 'group'
    form.value.repository_name_pattern = newId
      ? (isGrp ? `${newId}-{team_slug}` : `${newId}-{github_login}`)
      : (isGrp ? '{slug}-{team_slug}' : '{slug}-{github_login}')
  }
})

// ---------------------------------------------------------------- cohort summary

// reports/dashboard.json, read ONCE per page load and shared by every
// assignment in the list. UX_PLAN §7.1 assumed the list already had it - it
// does not (that is DashboardView), so this is one extra Contents API call for
// the whole pane rather than one per assignment opened.
const dashboardEntries = ref(null)   // null until read; {} when there is none
const dashboardError = ref(false)

async function loadCohortSummary() {
  dashboardEntries.value = null
  dashboardError.value = false
  const token = getToken()
  if (!token) return
  try {
    const text = await getRepoContent(token, props.org, config.controlRepo, 'reports/dashboard.json')
    // A missing file is an answer ("no report has run"); an unreadable one is
    // not an answer at all, and the card says which.
    dashboardEntries.value = text ? (JSON.parse(text)?.assignments || {}) : {}
  } catch {
    dashboardError.value = true
    dashboardEntries.value = {}
  }
}

// null whenever there is no reported figure, so the card can say so instead of
// rendering a zero nobody counted.
const cohort = computed(() => {
  const entry = dashboardEntries.value?.[form.value.id]
  if (!entry || typeof entry.accepted !== 'number') return null
  // An assignment with no cap has no cap - never substitute a number here.
  const cap = Number(form.value.max_acceptances) || null
  return { accepted: entry.accepted, cap, total: entry.total_students ?? null }
})

const cohortUnknownReason = computed(() => {
  if (dashboardEntries.value === null) return 'reading the report…'
  if (dashboardError.value) return "couldn't read the cohort report"
  return 'no cohort report yet'
})

const deadlineSummary = computed(() => {
  const parts = countdownParts(shareAssignment.value.deadline_at, now.value)
  if (!parts) return { value: '—', label: 'no deadline set' }
  return parts.passed
    ? { value: parts.duration, label: 'past the deadline' }
    : { value: parts.duration, label: 'until the deadline' }
})

// ---------------------------------------------------------------- defaults / helpers

function emptyForm() {
  const now = new Date()
  const in14d = new Date(Date.now() + 14 * 86400000)
  return {
    schema_version: 1,
    id: '',
    title: '',
    description: '',
    organization: props.org,
    template: '',
    repository_name_pattern: '{slug}-{github_login}',
    opens_at_local: toLocalInputValue(now),
    deadline_at_local: toLocalInputValue(in14d),
    _opens_at_original: '',
    _deadline_at_original: '',
    timezone: 'Europe/Brussels',
    submission_ref: 'refs/heads/main',
    student_permission: 'admin',
    // One enum value, so there is nothing to choose and no control for it.
    // The field stays because the schema and the public card still carry it.
    acceptance_mode: 'self-service',
    // The hint under this control already says "Anyone with the link can claim
    // a repo", and `accept.mjs` fails closed to `enforced` for anything it does
    // not recognise - the form was the only thing choosing the permissive
    // setting. Existing assignments keep whatever they were saved with.
    roster_mode: 'enforced',
    // `block` discards work. Now that it actually does something, defaulting to
    // it would silently start throwing away students' late commits on every new
    // assignment - so a lecturer opts in.
    late_policy: 'report',
    state: 'draft',
    max_acceptances: 50,
    lock_down_enabled: true,
    feedback_pr: false,
    feedback_pr_baseline_branch: 'pxl-baseline',
    autograde_enabled: false,
    autograde_execution_environment: 'lecturer_local',
    autograde_visibility: 'private',
    autograde_tests: [],
    assignment_type: 'individual',
    group_config: {
      max_team_size: 3,
      min_team_size: 2,
      formation_mode: 'self-service',
      allow_team_creation: true,
      // New assignments default to letting an unassigned student self-enrol;
      // hand-written YAML without the key keeps the stricter historical 'block'.
      unassigned_fallback: 'self-service',
    },
  }
}

// If the user-visible HH:MM still matches what we derived from the original
// UTC value, preserve the original (with seconds/ms) rather than zeroing them.
function preserveOrLocal(localStr, originalUtc) {
  if (!originalUtc) return localToUtc(localStr)
  if (utcToLocalInput(originalUtc) === localStr) return originalUtc
  return localToUtc(localStr)
}

function toSlug(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-')
    .slice(0, 100)
    .replace(/^[^a-z0-9]+/, '')
}

function toLocalInputValue(date) {
  // Returns YYYY-MM-DDTHH:MM in browser's local time, for datetime-local input
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function localToUtc(localStr) {
  // datetime-local string -> UTC ISO. Browser interprets as local.
  if (!localStr) return ''
  const d = new Date(localStr)
  // `toISOString()` throws RangeError on an unparseable date, and this runs
  // inside the `shareAssignment` computed - so a hand-edited YAML carrying
  // `deadline_at: soon` took the entire editor pane down during render, with
  // the field that would fix it on the far side of the crash. An empty string
  // instead: the cohort card says "no deadline set", fieldErrors names it, and
  // the schema refuses the save.
  return Number.isNaN(d.getTime()) ? '' : d.toISOString()
}

function utcToLocalInput(utcIso) {
  if (!utcIso) return ''
  return toLocalInputValue(new Date(utcIso))
}

function utcHint(localStr) {
  if (!localStr) return ''
  try {
    const utc = new Date(localStr).toISOString()
    return `Stored as: ${utc}`
  } catch {
    return ''
  }
}

function autoSyncSlug() {
  if (isNew.value && !manualSlug.value) {
    form.value.id = toSlug(form.value.title)
    // Also keep repository_name_pattern in sync with slug if it has not been manually edited
    if (!manualRepositoryNamePattern.value) {
      form.value.repository_name_pattern = form.value.assignment_type === 'group'
        ? `${form.value.id}-{team_slug}`
        : `${form.value.id}-{github_login}`
    }
  }
}

// Choosing "Does not count" locks the submission branch with a ruleset, which
// stops pushes and leaves Actions, secrets and runners alone. Demoting on top of
// that takes exactly what the branch lock exists to preserve, so the checkbox
// comes off - once, and visibly. Ticking it again is a deliberate choice and
// sticks.
function onLatePolicyChange() {
  if (form.value.late_policy === 'block') form.value.lock_down_enabled = false
}

function onAssignmentTypeChange() {
  if (form.value.assignment_type === 'group') {
    if (!manualRepositoryNamePattern.value || form.value.repository_name_pattern.endsWith('-{github_login}')) {
      form.value.repository_name_pattern = form.value.repository_name_pattern.replace('{github_login}', '{team_slug}')
    }
  } else {
    if (!manualRepositoryNamePattern.value || form.value.repository_name_pattern.endsWith('-{team_slug}')) {
      form.value.repository_name_pattern = form.value.repository_name_pattern.replace('{team_slug}', '{github_login}')
    }
  }
}

// ---------------------------------------------------------------- data loading

async function loadAssignments() {
  loadingList.value = true
  assignmentsError.value = null
  const token = getToken()
  try {
    const repoRes = await getRepo(token, props.org, config.controlRepo)
    if (!repoRes.ok) {
      if (repoRes.status === 404) {
        assignmentsError.value = 'no-control-repo'
      } else {
        assignmentsError.value = `Failed to load control repository (HTTP ${repoRes.status})`
      }
      loadingList.value = false
      return
    }

    let files = []
    try {
      files = await listRepoDir(token, props.org, config.controlRepo, 'assignments')
    } catch (e) {
      if (e.status === 404) {
        files = []
      } else {
        throw e
      }
    }

    const ymls = files.filter((f) => f.type === 'file' && f.name.endsWith('.yml'))
    const docs = await Promise.all(
      ymls.map(async (f) => {
        try {
          const text = await getRepoContent(token, props.org, config.controlRepo, f.path)
          if (!text) return null
          const doc = parseYaml(text)
          const id = doc.id || f.name.replace(/\.yml$/, '')
          
          // If we are currently editing this assignment, merge the local form state
          // to prevent eventual consistency lag from showing stale data in the UI.
          if (editing.value && editing.value.id === id) {
            return {
              ...doc,
              id,
              state: form.value.state,
              title: form.value.title || doc.title,
              deadline_at: form.value.deadline_at_local ? localToUtc(form.value.deadline_at_local) : doc.deadline_at,
              timezone: form.value.timezone || doc.timezone,
            }
          }
          
          return { ...doc, id }
        } catch {
          return null
        }
      })
    )
    assignments.value = docs.filter(Boolean).sort((a, b) => {
      // draft first, then published, then closed, then archived
      const order = { draft: 0, published: 1, closed: 2, archived: 3 }
      return (order[a.state] ?? 9) - (order[b.state] ?? 9) || a.id.localeCompare(b.id)
    })

    if (route.query.new === '1' || route.query.new === 'true' || route.query.action === 'new') {
      activeTab.value = 'assignments'
      newAssignment()
    } else {
      const editId = route.query.edit
      if (editId && (!editing.value || editing.value.id !== editId)) {
        const a = assignments.value.find((x) => x.id === editId)
        if (a) {
          editAssignment(a)
        }
      }
    }
  } catch (e) {
    console.error('Failed to load assignments', e)
    assignmentsError.value = e.message || 'Unknown error'
    toast.error('Failed to load assignments')
  }
  loadingList.value = false
}

async function loadTemplates() {
  loadingTemplates.value = true
  templatesError.value = null
  const token = getToken()
  try {
    const repos = await listOrgTemplates(token, props.org)
    templates.value = repos
    // Apply the "auto-select the only template" default
    if (isNew.value && repos.length === 1 && !form.value.template) {
      form.value.template = repos[0].full_name
      templateSearchText.value = repos[0].full_name
    }
  } catch (e) {
    console.error('Failed to load templates', e)
    templatesError.value = e.message || 'Failed to load templates'
  }
  loadingTemplates.value = false
}

// ---------------------------------------------------------------- edit flow

function newAssignment() {
  if (!confirmDiscard()) return
  stopPublishWatch()
  editing.value = { __new: true, id: '' }
  manualSlug.value = false
  manualRepositoryNamePattern.value = false
  templateSearchText.value = ''
  touchedFields.value = {
    id: false,
    title: false,
    description: false,
    template: false,
    repository_name_pattern: false,
    opens_at: false,
    deadline_at: false,
    max_acceptances: false,
  }
  form.value = emptyForm()
  // Auto-select sole template if we already have it loaded
  if (templates.value.length === 1) {
    form.value.template = templates.value[0].full_name
    templateSearchText.value = templates.value[0].full_name
  }
  publishWatch.value = ''
  brokerExists.value = null
  pagesLive.value = null
  liveCheckLoading.value = false
  // A new assignment is nothing but its settings.
  settingsOpen.value = true

  snapshotForm()
}

function editAssignment(a) {
  if (editing.value && editing.value.id !== a.id && !confirmDiscard()) return
  stopPublishWatch()
  editing.value = { id: a.id }
  manualSlug.value = true // existing assignments - never auto-rewrite the slug
  manualRepositoryNamePattern.value = true
  form.value = {
    schema_version: a.schema_version || 1,
    id: a.id,
    title: a.title || '',
    description: a.description || '',
    organization: a.organization || props.org,
    template: a.template ? `${a.template.owner}/${a.template.repository}` : '',
    repository_name_pattern: a.repository_name_pattern || '',
    opens_at_local: utcToLocalInput(a.opens_at),
    deadline_at_local: utcToLocalInput(a.deadline_at),
    _opens_at_original: a.opens_at || '',
    _deadline_at_original: a.deadline_at || '',
    timezone: a.timezone || 'Europe/Brussels',
    submission_ref: a.submission_ref || 'refs/heads/main',
    student_permission: a.student_permission || 'admin',
    acceptance_mode: a.acceptance_mode || 'self-service',
    roster_mode: a.roster_mode === 'open' ? 'open' : 'enforced',
    late_policy: a.late_policy || 'report',
    state: a.state || 'draft',
    // 50 is the default for a NEW assignment (emptyForm), not a value to
    // invent for an existing one. buildDoc rebuilds the whole document, so
    // `?? 50` here silently capped an uncapped assignment the first time
    // anyone opened it to change the title. Empty means no cap, and buildDoc
    // omits the field.
    max_acceptances: a.max_acceptances ?? '',
    lock_down_enabled: a.lock_down_enabled ?? true,
    invite_token: a.invite_token || '',
    invite_nonce: a.invite_nonce || '',
    invite_expires_at: a.invite_expires_at || '',
    feedback_pr: a.feedback_pr === true,
    feedback_pr_baseline_branch: a.feedback_pr_baseline_branch || 'pxl-baseline',
    // The configuration's existence is the flag (UX_PLAN §6.1), so
    // `enabled: true` with no checks loads as off rather than as a state the
    // summary calls "Off" while Save fails on `tests.minItems`. A hand-edited
    // YAML in that shape gets repaired by the next save instead of trapping
    // the lecturer behind an error they cannot reach a control for.
    autograde_enabled: a.autograde?.enabled === true && (a.autograde?.tests || []).length > 0,
    autograde_execution_environment: a.autograde?.execution_environment || 'lecturer_local',
    autograde_visibility: a.autograde?.visibility || 'private',
    autograde_tests: a.autograde?.tests || [],
    assignment_type: a.assignment_type || 'individual',
    group_config: {
      max_team_size: a.group_config?.max_team_size || 3,
      min_team_size: a.group_config?.min_team_size || 2,
      formation_mode: a.group_config?.formation_mode || 'self-service',
      allow_team_creation: a.group_config?.allow_team_creation !== false,
      unassigned_fallback: a.group_config?.unassigned_fallback === 'self-service' ? 'self-service' : 'block',
    },
  }
  templateSearchText.value = form.value.template || ''
  touchedFields.value = {
    id: false,
    title: false,
    description: false,
    template: false,
    repository_name_pattern: false,
    opens_at: false,
    deadline_at: false,
    max_acceptances: false,
  }
  // Collapsed once the assignment is out - unless it arrives with a problem,
  // which a hand-edited YAML can, and then hiding the fields would hide the
  // only thing there is to do.
  settingsOpen.value = !cohortFirst.value || fieldErrorCount.value > 0
  // Pin the editing template into the dropdown even if it lives in a different
  // org than the assignment org. Drop any synthetic entry from a previous edit.
  templates.value = templates.value.filter(t => !t._foreign)
  if (form.value.template && !templates.value.some(t => t.full_name === form.value.template)) {
    const [tplOwner] = form.value.template.split('/')
    templates.value = [
      { full_name: form.value.template, is_template: true, _foreign: tplOwner !== props.org },
      ...templates.value,
    ]
  }
  publishWatch.value = ''
  if (a.state === 'published') {
    verifyLiveInfrastructure(a.id)
  } else {
    brokerExists.value = null
    pagesLive.value = null
    liveCheckLoading.value = false
  }
  snapshotForm()
}

function cancelEdit() {
  if (!confirmDiscard()) return
  editing.value = null
}

// ---------------------------------------------------------------- automated checks

// The row editor lives in AutogradeModal.vue now; this view holds the one-line
// summary and the resulting configuration (UX_PLAN §6.1).
const showAutogradeModal = ref(false)

const autogradeSummary = computed(() =>
  summariseAutograde({
    enabled: form.value.autograde_enabled,
    execution_environment: form.value.autograde_execution_environment,
    visibility: form.value.autograde_visibility,
    tests: form.value.autograde_tests,
  }),
)

function applyAutograde(config) {
  form.value.autograde_enabled = config.enabled
  form.value.autograde_execution_environment = config.execution_environment
  form.value.autograde_visibility = config.visibility
  form.value.autograde_tests = config.tests
  showAutogradeModal.value = false
}

// Removing the checks removes the flag with them: an enabled-but-empty
// configuration fails `tests.minItems: 1` on save, and promises a score the
// system will never produce.
function clearAutograde() {
  form.value.autograde_enabled = false
  form.value.autograde_tests = []
}

// ---------------------------------------------------------------- YAML generation + validation

function buildDoc(state = null) {
  const [tplOwner, tplRepo] = (form.value.template || '').split('/')
  return {
    schema_version: 1,
    id: form.value.id,
    title: form.value.title,
    ...(form.value.description ? { description: form.value.description } : {}),
    organization: form.value.organization,
    template: { owner: tplOwner || '', repository: tplRepo || '' },
    repository_name_pattern: form.value.repository_name_pattern,
    opens_at: preserveOrLocal(form.value.opens_at_local, form.value._opens_at_original),
    deadline_at: preserveOrLocal(form.value.deadline_at_local, form.value._deadline_at_original),
    timezone: form.value.timezone || 'Europe/Brussels',
    submission_ref: form.value.submission_ref || 'refs/heads/main',
    student_permission: form.value.student_permission,
    acceptance_mode: form.value.acceptance_mode,
    roster_mode: form.value.roster_mode || 'enforced',
    late_policy: form.value.late_policy,
    state: state || form.value.state,
    ...(form.value.max_acceptances ? { max_acceptances: Number(form.value.max_acceptances) } : {}),
    lock_down_enabled: !!form.value.lock_down_enabled,
    // Minted by publish-assignment.yml and never edited here - but this rebuilds
    // the whole document, so anything not carried through is deleted. Dropping
    // these silently retires the invitation link already handed to students.
    ...(form.value.invite_token ? { invite_token: form.value.invite_token } : {}),
    ...(form.value.invite_nonce ? { invite_nonce: form.value.invite_nonce } : {}),
    ...(form.value.invite_expires_at ? { invite_expires_at: form.value.invite_expires_at } : {}),
    ...(form.value.assignment_type ? { assignment_type: form.value.assignment_type } : {}),
    ...(form.value.assignment_type === 'group'
      ? {
          group_config: {
            max_team_size: Number(form.value.group_config?.max_team_size) || 3,
            ...(form.value.group_config?.min_team_size ? { min_team_size: Number(form.value.group_config.min_team_size) } : {}),
            formation_mode: form.value.group_config?.formation_mode || 'self-service',
            allow_team_creation: form.value.group_config?.allow_team_creation !== false,
            ...(form.value.group_config?.formation_mode === 'pre-assigned'
              ? {
                  unassigned_fallback:
                    form.value.group_config?.unassigned_fallback === 'self-service' ? 'self-service' : 'block',
                }
              : {}),
          },
        }
      : {}),
    ...(form.value.feedback_pr
      ? {
          feedback_pr: true,
          feedback_pr_baseline_branch: form.value.feedback_pr_baseline_branch || 'pxl-baseline',
        }
      : {}),
    // Included whenever enabled - an empty tests list then fails schema
    // validation visibly instead of being silently dropped from the YAML.
    ...(form.value.autograde_enabled
      ? { autograde: { enabled: true, execution_environment: form.value.autograde_execution_environment, visibility: form.value.autograde_visibility, tests: cleanChecks(form.value.autograde_tests) } }
      : {}),
  }
}


const validationErrors = ref([])

async function validate(state = null) {
  const doc = buildDoc(state)
  const { valid, errors } = await validateAgainst('assignment', doc)
  // Raw AJV names a JSON Pointer, a keyword and a regex - none of which is on
  // the lecturer's screen. UX_PLAN §5.4; unmapped errors still come through
  // verbatim rather than being swallowed.
  const problems = valid ? [] : errors.map((e) => formatAssignmentValidationError(e, doc))

  // Cross-field rules JSON Schema can't express.
  if (doc.opens_at && doc.deadline_at && new Date(doc.deadline_at) <= new Date(doc.opens_at)) {
    problems.push('Deadline must be after the open date.')
  }
  if (form.value.max_acceptances === 0) {
    problems.push('Max acceptances must be at least 1 (leave the field empty for no cap).')
  }
  // Open enrollment removes the roster gate; an uncapped open assignment lets
  // any GitHub account create unlimited repos from the template. Require the
  // one guardrail that is left.
  if (doc.roster_mode === 'open' && !doc.max_acceptances) {
    problems.push(
      'Open enrollment requires a max-acceptances cap - without the roster gate it is the only limit on who can claim a repo.',
    )
  }

  validationErrors.value = problems
  return problems.length === 0
}

// Soft warning (non-blocking): a deadline in the past finalizes on the very
// next nightly run - usually a typo, occasionally intentional (migrations).
const deadlineInPast = computed(() => {
  if (!form.value.deadline_at_local) return false
  try { return new Date(form.value.deadline_at_local) < new Date() } catch { return false }
})

const canSave = computed(() => {
  return (
    !!form.value.id &&
    !!form.value.title &&
    !!form.value.template &&
    !!form.value.repository_name_pattern &&
    !!form.value.opens_at_local &&
    !!form.value.deadline_at_local &&
    Object.keys(fieldErrors.value).length === 0
  )
})

// ---------------------------------------------------------------- save / publish

async function saveAssignment(stateOverride = null) {
  // Touch all fields to show error styling
  for (const k of Object.keys(touchedFields.value)) {
    touchedFields.value[k] = true
  }
  if (Object.keys(fieldErrors.value).length > 0) {
    toast.error('Validation failed. Please fix the errors in the form.')
    return
  }
  if (!(await validate(stateOverride))) {
    toast.error('Validation failed. Please fix the issues listed below the form.')
    return
  }
  if (isNew.value) {
    const slug = form.value.id
    if (assignments.value.some((a) => a.id === slug)) {
      toast.error(`${slug} already exists; pick another slug or edit the existing assignment.`)
      return
    }
    try {
      const token = getToken()
      const path = `assignments/${slug}.yml`
      const exists = await getRepoContent(token, props.org, config.controlRepo, path)
      if (exists !== null) {
        toast.error(`${slug} already exists; pick another slug or edit the existing assignment.`)
        return
      }
    } catch { /* ignore and let commitFile handle any errors */ }
  }
  saving.value = true
  try {
    const token = getToken()
    const path = `assignments/${form.value.id}.yml`
    const yaml = stringifyYaml(buildDoc(stateOverride))
    const res = await commitFile(token, props.org, config.controlRepo, path, yaml, isNew.value ? `Create assignment ${form.value.id}` : `Update assignment ${form.value.id}`)
    if (res.ok) {
      toast.success(`Saved ${form.value.id}`)
      form.value.state = stateOverride || form.value.state
      snapshotForm()
      await loadAssignments()
      // Stay on the edited assignment
      const stillExists = assignments.value.find((a) => a.id === form.value.id)
      if (stillExists) editing.value = { id: stillExists.id }
      if (form.value.state === 'published') {
        verifyLiveInfrastructure(form.value.id)
      }
    } else {
      toast.error(`Save failed: ${res.data?.message || 'unknown error'}`)
    }
  } finally {
    saving.value = false
  }
}

// Read the invitation the publish workflow minted straight into the control
// repo. The form we are holding has never seen it, so without this the link box
// stays empty however many times a lecturer republishes.
//
// Unconditional, not "only when the form has none": regenerating rotates the
// token, and a form that keeps whichever one it saw first goes on handing out a
// link the broker now rejects as superseded.
//
// getRepoContent resolves to the decoded FILE TEXT, or null - not a {ok, data}
// envelope. `.ok` on a string is undefined, which is why the fix that added this
// block appeared to do nothing.
async function refreshInvitation(assignmentId) {
  const token = getToken()
  if (!token) return ''
  const yaml = await getRepoContent(token, props.org, config.controlRepo, `assignments/${assignmentId}.yml`)
  const fields = parseInviteFields(yaml)
  if (!fields.invite_token) return ''
  // These three are system-owned - a lecturer never edits them - so filling
  // them in must not make a clean form look unsaved and prompt "Discard
  // unsaved changes?" on the way out.
  const wasClean = !hasUnsavedEdits()
  Object.assign(form.value, fields)
  if (wasClean) snapshotForm()
  return fields.invite_token
}

// Is the page a student would open actually there?
//
// This used to ask whether the id appeared in assignments.json. It does not:
// the student loads data/<org>/i/<sha256(token)>.json, and pages/generate.mjs
// writes that file ONLY when the assignment carries an invite_token - otherwise
// it logs a warning, continues, and still adds the id to the index. So an
// assignment published without a token reported "Verified Live" over a page
// that 404s for every student. Diagnostics Tier 5 was corrected for exactly
// this in e594f4f; the publish flow beside it was not.
async function acceptanceCardIsLive(inviteToken) {
  if (!inviteToken) return false
  try {
    const url = `${await inviteDataUrl(props.org, inviteToken)}?t=${Date.now()}`
    const res = await fetch(url, { cache: 'no-store' })
    if (!res.ok) return false
    const data = await res.json().catch(() => null)
    return !!data?.assignment?.id
  } catch {
    return false
  }
}

async function verifyLiveInfrastructure(assignmentId) {
  if (!assignmentId || form.value.state !== 'published') {
    brokerExists.value = null
    pagesLive.value = null
    liveCheckLoading.value = false
    return
  }
  liveCheckLoading.value = true
  const token = getToken()
  const brokerRepo = form.value.broker_repo || `broker-${assignmentId}`
  try {
    if (token) {
      const brokerRes = await getRepo(token, props.org, brokerRepo)
      brokerExists.value = brokerRes.ok
    }
    const inviteToken = await refreshInvitation(assignmentId)
    pagesLive.value = await acceptanceCardIsLive(inviteToken)
  } catch (e) {
    console.warn('Failed to verify live infrastructure:', e)
  } finally {
    liveCheckLoading.value = false
  }
}

async function saveAndPublish() {
  // Save current edits first (with state=published) then trigger publish workflow.
  if (form.value.state === 'published') {
    await saveAssignment()
    if (brokerExists.value === false) {
      await publishExisting()
    }
    return
  }
  await saveAssignment('published')
  if (form.value.state === 'published') {
    const dispatched = await publishExisting()
    // The dispatch failed (typically 403: no hub access / missing
    // actions:write). Don't leave the YAML claiming "published" while no
    // broker exists - students would see a published assignment with a dead
    // accept flow. Revert to draft and say so.
    if (!dispatched) await revertToDraftAfterFailedPublish()
  }
}

async function revertToDraftAfterFailedPublish() {
  try {
    const token = getToken()
    const path = `assignments/${form.value.id}.yml`
    const yaml = stringifyYaml(buildDoc('draft'))
    const res = await commitFile(token, props.org, config.controlRepo, path, yaml, `Revert ${form.value.id} to draft (publish dispatch failed)`)
    if (res.ok) {
      form.value.state = 'draft'
      brokerExists.value = null
      pagesLive.value = null
      snapshotForm()
      await loadAssignments()
      toast.error(`Publish dispatch failed. ${form.value.id} was reverted to draft. Fix hub access and publish again.`)
    } else {
      toast.error(`Publish dispatch failed AND the revert to draft failed: ${res.data?.message || 'unknown error'}. The YAML still says "published" but no broker exists. Set the state back to draft manually.`)
    }
  } catch (e) {
    console.error('Failed to revert state after failed publish:', e)
  }
}

function handlePublishClick() {
  if (form.value.state === 'published' && brokerExists.value === true) {
    // Rotating is never the default - a repair republish must not break links.
    // Only openRegenerate(), behind a control that says "Regenerate link",
    // arrives with the box already ticked.
    regenerateInvite.value = false
    showRepublishModal.value = true
    return
  }
  // publish-assignment.yml runs `sed -i "s/^state:.*/state: published/"` with
  // no regard for what the state was, so dispatching it from a closed or
  // archived assignment puts the cohort back to accepting. Every other thing
  // in this row that changes state says so first; this one has to as well.
  const reopening = form.value.state === 'closed' || form.value.state === 'archived'
  if (reopening && !window.confirm(
    `Reopen "${form.value.id}" for acceptance? Publishing sets its state back to published, ` +
    `so students can accept it again until the deadline.`
  )) return
  publishExisting()
}

async function confirmRepublish() {
  const ok = await publishExisting({ regenerate: regenerateInvite.value })
  if (ok) {
    showRepublishModal.value = false
    if (regenerateInvite.value) {
      // The old token is still in the form until the workflow writes the new
      // one; clear it so nothing can copy a link the broker is about to reject.
      form.value.invite_token = ''
      toast.info('Regenerating - the new link appears here once the workflow finishes. The old one stops working now.')
    }
    regenerateInvite.value = false
  }
}

// Returns true when the workflow_dispatch was accepted by GitHub.
//
// `regenerate` mints a fresh nonce, which retires every link already handed
// out. It is an input on publish-assignment.yml that nothing in the app ever
// sent, so the only way to rotate a leaked link was the Actions tab.
async function publishExisting({ regenerate = false } = {}) {
  publishing.value = true
  try {
    const token = getToken()
    const res = await triggerWorkflow(token, config.hubOwner, config.hubRepo, 'publish-assignment.yml', {
      org: props.org,
      assignment_id: form.value.id,
      // workflow_dispatch boolean inputs arrive as strings over the REST API.
      regenerate_invite: regenerate ? 'true' : 'false',
    })
    if (res.ok || res.status === 204) {
      toast.success('Publish workflow triggered. Watching for the broker to appear…')
      startPublishWatch()
      return true
    }
    toast.error(explainDispatchFailure(res, 'Publish failed'))
    return false
  } finally {
    publishing.value = false
  }
}

// Poll for the broker repo the publish workflow creates, so "published"
// isn't fire-and-forget: the lecturer sees when the accept link goes live.
function startPublishWatch() {
  stopPublishWatch()
  publishWatch.value = 'watching'
  publishPollCount.value = 0
  brokerExists.value = null
  pagesLive.value = null
  const tick = async () => {
    publishPollCount.value++
    try {
      const token = getToken()
      const brokerRepo = form.value.broker_repo || `broker-${form.value.id}`
      if (token && !brokerExists.value) {
        const brokerRes = await getRepo(token, props.org, brokerRepo)
        if (brokerRes.ok) brokerExists.value = true
      }
      // Two things have to be true, and only one of them was being checked.
      // The workflow mints the invitation into the control repo while we poll,
      // so the form has never seen it - read it first, then ask whether the
      // page a student would open is actually there. Waiting on the index
      // instead declared success over a card that 404s.
      const inviteToken = await refreshInvitation(form.value.id)
      if (inviteToken && (await acceptanceCardIsLive(inviteToken))) {
        brokerExists.value = true
        pagesLive.value = true
        publishWatch.value = 'ready'
        toast.success('Published! The invitation link is live and ready to share.')
        return
      }
    } catch (e) {
      // ignore
    }
    if (publishPollCount.value >= 48) { // 48 * 10s = 8 minutes
      publishWatch.value = 'timeout'
      // The workflow may well have finished and only Pages be lagging, so the
      // link is often already there. Show it rather than making the lecturer
      // press "Check Status Now" to find out.
      await verifyLiveInfrastructure(form.value.id)
      return
    }
    publishPollTimer = setTimeout(tick, 10000)
  }
  publishPollTimer = setTimeout(tick, 5000)
}

function stopPublishWatch() {
  if (publishPollTimer) {
    clearTimeout(publishPollTimer)
    publishPollTimer = null
  }
}

// Copying the link lives in InvitationShare.vue, not here. There were three
// implementations of "put the link on the clipboard" across two views, each
// with its own guard against writing the string "null" - one of them silently
// broken for months (tests/invitation-link-surface.test.mjs). One component
// owns it now.

async function deleteDraft() {
  if (form.value.state !== 'draft') return
  if (!window.confirm(`Delete draft "${form.value.id}"? This removes assignments/${form.value.id}.yml from the control repo.`)) return
  deleting.value = true
  try {
    const token = getToken()
    const res = await deleteFile(token, props.org, config.controlRepo, `assignments/${form.value.id}.yml`, `Delete draft assignment ${form.value.id}`)
    if (res.ok) {
      toast.success(`Deleted draft ${form.value.id}`)
      editing.value = null
      await loadAssignments()
    } else {
      toast.error(`Delete failed: ${res.data?.message || 'unknown error'}`)
    }
  } finally {
    deleting.value = false
  }
}

async function setState(newState) {
  const warnings = {
    draft: `Unpublish "${form.value.id}" back to draft? Students can no longer open the accept link.`,
    closed: `Close "${form.value.id}"? Students can no longer accept it (existing repos are unaffected).`,
    archived: `Archive "${form.value.id}"? It leaves the student-facing list and day-to-day tracking.`,
  }
  if (warnings[newState] && !window.confirm(warnings[newState])) return
  saving.value = true
  try {
    const token = getToken()
    const path = `assignments/${form.value.id}.yml`
    const yaml = stringifyYaml(buildDoc(newState))
    const res = await commitFile(token, props.org, config.controlRepo, path, yaml, `Set ${form.value.id} state to ${newState}`)
    if (res.ok) {
      form.value.state = newState
      snapshotForm()
      toast.success(`${form.value.id} -> ${newState}`)
      await loadAssignments()
    } else {
      toast.error(`Update failed: ${res.data?.message || 'unknown error'}`)
    }
  } finally {
    saving.value = false
  }
}

// ---------------------------------------------------------------- lifecycle

onMounted(async () => {
  window.pxlHasUnsavedState = () => {
    return hasUnsavedEdits() || rosterDirty()
  }
  window.addEventListener('beforeunload', onBeforeUnload)
  window.addEventListener('hashchange', onHashChange)
  document.addEventListener('click', handleClickOutside)
  clockTimer = setInterval(() => { now.value = new Date() }, 60000)
  if (!isAuthenticated()) { loadingList.value = false; return }
  user.value = getUser()
  await Promise.all([loadAssignments(), loadTemplates(), loadCohortSummary()])
})

onUnmounted(() => {
  window.pxlHasUnsavedState = null
  window.removeEventListener('beforeunload', onBeforeUnload)
  window.removeEventListener('hashchange', onHashChange)
  document.removeEventListener('click', handleClickOutside)
  stopPublishWatch()
  if (clockTimer) {
    clearInterval(clockTimer)
    clockTimer = null
  }
})

watch(
  () => form.value.title,
  () => {
    if (isNew.value && !manualSlug.value) autoSyncSlug()
  }
)

watch(
  () => route.query,
  (q) => {
    if (q.new === '1' || q.new === 'true' || q.action === 'new') {
      activeTab.value = 'assignments'
      newAssignment()
    } else if (q.edit) {
      activeTab.value = 'assignments'
      const a = assignments.value.find((x) => x.id === q.edit)
      if (a) editAssignment(a)
    }
  }
)
</script>

<style scoped>
.admin-page {
  padding-top: var(--space-xl);
  padding-bottom: var(--space-2xl);
  max-width: 1400px;
}
.back-link {
  font-size: 0.85rem;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--text-secondary);
}
.back-link:hover {
  color: var(--accent-blue);
  text-decoration: none;
}

.btn-with-icon { display: inline-flex; align-items: center; gap: var(--space-xs); }

.admin-layout {
  display: grid;
  /* `minmax(0, 1fr)`, never a bare `1fr`. A `1fr` track's automatic minimum is
     its content's min-content size, and the invitation link is `white-space:
     nowrap`, so its min-content IS its max-content - a 122-character URL. The
     track grew to fit it and the editor pane pushed the page 208px wider than
     a 375px phone, sideways-scrolling the whole admin route. The floor makes
     the child ellipsise (which it is already styled to do) instead of the
     track widening. tests/e2e/25-responsive-layout.spec.mjs covers this route
     now; it never did before. */
  grid-template-columns: 320px minmax(0, 1fr);
  gap: var(--space-lg);
  align-items: start;
}
@media (max-width: 900px) {
  .admin-layout { grid-template-columns: minmax(0, 1fr); }
}

/* LIST */
.list-pane {
  position: sticky;
  top: var(--space-md);
  background: var(--bg-secondary);
  border: 1px solid var(--border-default);
  border-radius: 8px;
  padding: var(--space-md);
  max-height: calc(100vh - 100px);
  overflow-y: auto;
}
.new-btn { width: 100%; margin-bottom: var(--space-md); }
.list-loading, .list-empty {
  padding: var(--space-md);
  color: var(--text-secondary);
  text-align: center;
}
.assignment-list { list-style: none; padding: 0; margin: 0; }
.assignment-list li {
  margin-bottom: 4px;
}
.assignment-list li a {
  padding: var(--space-sm) var(--space-md);
  border-radius: 6px;
  cursor: pointer;
  border: 1px solid transparent;
  text-decoration: none;
  color: inherit;
  display: block;
}
.assignment-list li a:hover { background: var(--bg-surface-elevated); }
.assignment-list li.active a {
  background: var(--bg-surface-elevated);
  border-color: var(--accent-blue);
}
.assignment-list .title { font-weight: 600; }
.assignment-list .slug { font-size: 0.8rem; color: var(--text-secondary); font-family: var(--font-mono); }
.assignment-list .meta { display: flex; gap: var(--space-sm); margin-top: 4px; font-size: 0.8rem; color: var(--text-secondary); }

/* BADGES */
.badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 0.75rem;
  text-transform: lowercase;
}
.badge-draft { background: var(--tint-neutral-muted); color: var(--text-secondary); }
.badge-published { background: var(--tint-success-muted); color: var(--accent-green-bright); }
.badge-closed { background: var(--tint-attention-muted); color: var(--accent-yellow-bright); }
.badge-archived { background: var(--tint-neutral-subtle); color: var(--text-muted); }

/* EDITOR */
.editor-pane {
  background: var(--bg-secondary);
  border: 1px solid var(--border-default);
  border-radius: 8px;
  padding: var(--space-lg);
}
.empty-state {
  text-align: center;
  padding: var(--space-2xl);
  color: var(--text-secondary);
}
.editor-form { display: flex; flex-direction: column; gap: var(--space-md); }
.editor-header-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-md);
  flex-wrap: wrap;
  margin-bottom: var(--space-xs);
}
.editor-header-bar .editor-title h3 {
  margin: 0;
  display: flex;
  align-items: center;
  gap: var(--space-sm);
}
.editor-header-actions {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  flex-wrap: wrap;
}

fieldset {
  border: 1px solid var(--border-default);
  border-radius: 6px;
  padding: var(--space-md);
  margin: 0;
}
legend {
  font-weight: 600;
  padding: 0 var(--space-xs);
  color: var(--accent-blue);
}
.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: var(--space-md);
}
.field:last-child { margin-bottom: 0; }
.field.checkbox { flex-direction: row; align-items: center; gap: var(--space-xs); }
.field.checkbox label { display: flex; align-items: center; gap: var(--space-xs); cursor: pointer; }
.field input[type="text"],
.field input[type="number"],
.field input[type="datetime-local"],
.field input:not([type]),
.field textarea,
.field select {
  width: 100%;
  padding: 8px 10px;
  background: var(--bg-primary);
  border: 1px solid var(--border-default);
  border-radius: 4px;
  color: var(--text-primary);
  font-family: inherit;
  font-size: 0.95rem;
}
.field textarea { resize: vertical; min-height: 60px; }
.field label { font-weight: 500; font-size: 0.9rem; color: var(--text-secondary); }
.field label .req { color: var(--accent-red); margin-left: 2px; }
.field small { color: var(--text-muted); font-size: 0.8rem; }
.field code { background: var(--bg-tertiary); padding: 0 4px; border-radius: 3px; font-size: 0.85em; }

.loading-inline { display: flex; align-items: center; gap: var(--space-sm); color: var(--text-secondary); }
.spinner.sm { width: 14px; height: 14px; border-width: 2px; }

details { border: 1px solid var(--border-default); border-radius: 6px; padding: var(--space-sm); }
details > summary { cursor: pointer; font-weight: 600; padding: var(--space-xs); }
details[open] > summary { margin-bottom: var(--space-md); }
details .field { padding: 0 var(--space-sm); }

.yaml-code {
  background: var(--bg-tertiary);
  padding: var(--space-md);
  border-radius: 4px;
  font-family: var(--font-mono);
  font-size: 0.85rem;
  overflow-x: auto;
}

.validation-errors {
  background: var(--tint-danger-subtle);
  border: 1px solid var(--accent-red);
  border-radius: 6px;
  padding: var(--space-md);
  color: var(--accent-red);
}
.validation-errors ul { margin: var(--space-xs) 0 0 var(--space-md); padding: 0; }

.actions {
  display: flex;
  gap: var(--space-sm);
  justify-content: flex-end;
  padding-top: var(--space-md);
  border-top: 1px solid var(--border-default);
}

.lifecycle {
  margin-top: var(--space-md);
  padding-top: var(--space-md);
  border-top: 1px solid var(--border-default);
}
.lifecycle h4 { margin: 0 0 var(--space-md) 0; }
.lifecycle-group {
  display: flex;
  gap: var(--space-sm);
  flex-wrap: wrap;
  align-items: center;
  margin-bottom: var(--space-md);
}
.lifecycle-group-label {
  font-size: 0.75rem;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--text-secondary);
  min-width: 5.5ch;
}
/* A single-side rule is a divider, not a box (DESIGN.md §1.1): repair above
   it, the transitions that change what the assignment IS below. */
.lifecycle-repair {
  padding-bottom: var(--space-md);
  border-bottom: 1px solid var(--border-muted);
}
.lifecycle-repair small {
  flex: 1 1 24ch;
  min-width: 0;
  font-size: 0.8rem;
  line-height: 1.4;
}
.lifecycle-transitions { margin-bottom: var(--space-md); }
.lifecycle-moved {
  font-size: 0.85rem;
  margin: 0 0 var(--space-md) 0;
}
.autograde-summary small {
  display: block;
  background: var(--tint-accent-subtle);
  border-left: 3px solid var(--accent-blue);
  padding: var(--space-sm) var(--space-md);
  color: var(--text-secondary);
  margin-top: var(--space-xs);
}
.autograde-summary-row {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  flex-wrap: wrap;
}
.autograde-summary-text {
  flex: 1 1 18ch;
  min-width: 0;
  color: var(--text-secondary);
  font-size: 0.9rem;
}
.text-warning { color: var(--accent-yellow); }
.text-secondary { color: var(--text-secondary); }

.btn-danger { border-color: var(--accent-red); color: var(--accent-red); }
.btn-danger:hover { background: var(--tint-danger-subtle); }

.publish-watch {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  margin-bottom: var(--space-md);
  font-size: 0.9rem;
}
.publish-ready { color: var(--accent-green); }

/* COMBOBOX */
.combobox-wrapper {
  position: relative;
  display: flex;
  gap: var(--space-sm);
  align-items: stretch;
}
.combobox-input-wrapper {
  position: relative;
  flex: 1;
}
.combobox-dropdown {
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  background: var(--bg-secondary);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  max-height: 200px;
  overflow-y: auto;
  z-index: 100;
  box-shadow: 0 4px 12px var(--shadow-color-sm);
  margin-top: 4px;
}
.combobox-item {
  padding: var(--space-xs) var(--space-sm);
  cursor: pointer;
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 0.95rem;
}
.combobox-item:hover, .combobox-item.active {
  background: var(--bg-surface-elevated);
  color: var(--text-primary);
}
.combobox-item.no-matches {
  color: var(--text-secondary);
  font-style: italic;
  cursor: default;
  background: transparent;
}
.btn-refresh {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0 var(--space-md);
  border: 1px solid var(--border-default);
  background: var(--bg-secondary);
  border-radius: 6px;
  cursor: pointer;
  color: var(--text-secondary);
  transition: border-color var(--transition-normal), color var(--transition-normal);
}
.btn-refresh:hover:not(:disabled) {
  border-color: var(--text-secondary);
  color: var(--text-primary);
}
.btn-refresh:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* The zero-templates wall. A tonal well, not a fourth 1px box inside a
   fieldset inside a card (DESIGN.md §1.1) - `--bg-inset` is the step that
   differs in both themes. */
.template-empty {
  margin-top: var(--space-sm);
  padding: var(--space-md);
  border-radius: var(--radius-md);
  background: var(--bg-inset);
  font-size: 0.85rem;
  color: var(--text-secondary);
}
.template-empty strong { color: var(--text-primary); }
.template-empty p { margin: var(--space-xs) 0 var(--space-sm) 0; }
.template-empty p:last-child { margin-bottom: 0; }
.template-empty a { margin-bottom: var(--space-xs); }

/* Roster readiness under "Who may accept". `.status-indicator` owns the dot;
   this only keeps the sentence and its link on one line when there is room. */
.roster-status { display: block; }
.roster-status .status-indicator { flex-wrap: wrap; gap: var(--space-xs); }
.roster-status .btn-link { font-size: inherit; }

/* DYNAMIC VALIDATION ERROR ALERTS */
/* .field-error-msg moved to style.css - AutogradeModal renders one too, and a
   scoped rule here would leave it invisible there (DESIGN.md §7). */

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
.spin-animation {
  animation: spin 1s linear infinite;
}

/* PUBLISHED INFO CARD */
.published-info-card {
  background: var(--tint-success-subtle);
  border: 1px solid var(--tint-success-muted);
  border-radius: 8px;
  padding: var(--space-md);
  margin-bottom: var(--space-md);
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
}
.published-info-card.is-warning {
  background: var(--tint-attention-subtle);
  border-color: var(--tint-attention-emphasis);
}
.published-info-card.is-error {
  background: var(--tint-danger-subtle);
  border-color: var(--tint-danger-emphasis);
}
/* Tonal step, no border: the editor pane already draws one and the fieldsets
   below draw another (DESIGN.md §1.1 - never nest three boxes). --bg-inset is
   the recessed step that differs from --bg-surface in BOTH themes. */
.cohort-card {
  background: var(--bg-inset);
  border-radius: 8px;
  padding: var(--space-md);
  margin-bottom: var(--space-md);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-md);
  flex-wrap: wrap;
}
.cohort-figures {
  display: flex;
  gap: var(--space-lg);
  flex-wrap: wrap;
}
.cohort-stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.cohort-value {
  font-size: 1.35rem;
  font-weight: 600;
  line-height: 1.1;
  color: var(--text-primary);
}
.cohort-of {
  font-size: 1rem;
  font-weight: 400;
  color: var(--text-secondary);
}
.cohort-unknown { color: var(--text-secondary); }
.cohort-label {
  font-size: 0.8rem;
  color: var(--text-secondary);
}

/* Not a box: the editor pane already draws one and every fieldset inside
   draws another, so a third would be DESIGN.md §1.1's prison. A single-side
   rule is a divider, which is fine. */
.settings-disclosure {
  border: none;
  border-radius: 0;
  padding: 0;
  border-top: 1px solid var(--border-muted);
  margin-bottom: 0;
}
.settings-disclosure > summary {
  cursor: pointer;
  font-weight: 600;
  padding: var(--space-md) 0;
  display: flex;
  align-items: center;
  gap: var(--space-sm);
}
.settings-disclosure[open] > summary { margin-bottom: var(--space-sm); }
.settings-caret { transition: transform 0.15s ease; }
.settings-disclosure:not([open]) .settings-caret { transform: rotate(-90deg); }
/* A draft has nothing to disclose - the fieldsets ARE the page, and the
   details element is only here so there is one markup path. */
.settings-disclosure.is-static { border-top: none; margin-bottom: 0; }
.settings-disclosure.is-static > summary { display: none; }
.settings-problems {
  font-size: 0.8rem;
  font-weight: 500;
  color: var(--accent-red);
}

.published-header {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
}
.published-header h4 {
  margin: 0;
  color: var(--accent-green);
  font-size: 1.05rem;
  font-weight: 600;
}
.published-desc {
  font-size: 0.9rem;
  color: var(--text-secondary);
  line-height: 1.4;
  margin: 0;
}
.link-share-row {
  display: flex;
  gap: var(--space-md);
  align-items: center;
  flex-wrap: wrap;
  margin-top: var(--space-xs);
}
.link-box {
  flex: 1;
  min-width: 280px;
  display: flex;
  background: var(--bg-primary);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  padding: 2px 2px 2px var(--space-sm);
  align-items: center;
  justify-content: space-between;
  gap: var(--space-sm);
}
.link-text {
  font-family: var(--font-mono);
  font-size: 0.85rem;
  color: var(--text-primary);
  word-break: break-all;
  user-select: all;
}
.btn-copy {
  padding: var(--space-xs) var(--space-sm);
  font-size: 0.8rem;
  border-color: var(--border-default);
}
/* Modal styles for Republish confirmation */
.modal-overlay {
  position: fixed;
  inset: 0;
  background: var(--bg-scrim);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  z-index: 1000;
  padding: max(24px, 5vh) var(--space-md);
  overflow-y: auto;
  backdrop-filter: blur(4px);
}
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
.modal-close {
  background: none;
  border: none;
  font-size: 1.25rem;
  line-height: 1;
  color: var(--text-muted);
  cursor: pointer;
  padding: 0 4px;
}
.modal-close:hover {
  color: var(--text-primary);
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
.alert-danger {
  background: var(--tint-danger-subtle);
  border: 1px solid var(--tint-danger-emphasis);
  color: var(--accent-red);
  padding: var(--space-sm) var(--space-md);
  border-radius: var(--radius-md);
}

/* DESIGN.md §1.1: the modal already outlines itself and its alerts. A third
   bordered box here is the prison - this is a tonal step instead, and
   --bg-inset is the one that actually differs in both themes. */
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
