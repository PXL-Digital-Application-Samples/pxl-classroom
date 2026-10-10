<template>
  <!-- NO `fade-in` ON THIS ELEMENT, and it is not a style preference.
       `fadeIn` ends on `transform: translateY(0)` with `animation-fill-mode:
       forwards`, so the element keeps `transform: matrix(1,0,0,1,0,0)` for ever
       - and ANY transform other than `none` makes an element the containing
       block for its `position: fixed` descendants. Every modal on this page
       therefore resolved `inset: 0` against this 2000px-tall wrapper instead of
       the viewport and rendered `scrollY` pixels ABOVE the screen: measured at
       y=-1245 with the page scrolled to the Automated checks button, which is
       why "Set up" looked like it opened an empty screen (2026-09-02).
       tests/e2e/47-modal-in-viewport.spec.mjs holds this. -->
  <div class="admin-view">
    <!-- No top bar of its own: a new assignment sits under the organization's
         (OrgShell.vue), and an assignment's settings sit inside the
         assignment page as its Settings tab (`embedded`), under that page's
         header and tabs, at its width. -->
    <div :class="embedded ? 'admin-embedded' : 'admin-page container'">

    <!-- Not authenticated - never render the editor with data-shaped empty
         states signed out ("No assignments yet" on a full course reads as
         data loss after the 8h token expiry). -->
    <AuthCard v-if="!user" title="Sign in to edit this assignment" @authenticated="onAuthenticated">
      Sign in with a GitHub account that owns <strong>{{ org }}</strong>.
      Sessions last 8 hours. If you were signed in earlier, it has expired.
    </AuthCard>

    <template v-else>
    <!-- No "Course roster" line and no assignment header here (BETA-UX.md,
         2026-10-03). The roster's numbers are the organization's and are on
         the Roster tab, and the form's own "Who may accept" says how many can
         accept. The header - state button, deadline, Invite link, tabs - is
         the assignment page's, which this editor sits inside as its Settings
         tab (`embedded`); a new assignment has nothing for it to say yet. -->
    <!-- The way back to the cards. The Settings tab has its own in the
         assignment's header row; a new assignment has no header, so here. -->
    <router-link v-if="!embedded" :to="{ name: 'dashboard', params: { org } }" class="btn btn-ghost btn-sm btn-with-icon back-to-list new-assignment-back">
      <Icon name="arrow-left" :size="13" />
      <span>Assignments</span>
    </router-link>
    <div class="admin-layout" :class="{ 'has-section-nav': formShown }">
      <!-- THE FORM'S SECTIONS, beside it (2026-10-03). The form keeps its
           reading measure (DESIGN.md §1.8), and the page's width goes to a
           list that jumps to each section and says which one is on screen - the
           layout of GitHub's own settings pages. Hidden on a narrow window,
           where there is no width to give it. -->
      <nav v-if="formShown" class="settings-nav" aria-label="Settings sections">
        <a
          v-for="s in sectionNav"
          :key="s.id"
          :href="'#' + s.id"
          class="settings-nav-link"
          :class="{ active: currentSection === s.id }"
          :aria-current="currentSection === s.id ? 'true' : null"
          @click.prevent="scrollToSection(s.id)"
        >{{ s.label }}</a>
      </nav>
      <main class="editor-pane">

        <div v-if="loadingList" class="list-loading"><div class="spinner"></div></div>
        <ControlRepoUnreadable
          v-else-if="controlRepoUnreadable"
          :org="org"
          :access="controlRepoAccess"
          :viewer-login="user?.login || ''"
          @retry="loadAssignments"
        />
        <div v-else-if="assignmentsError" class="list-empty error-state-box">
          <h4 style="margin: 0 0 var(--space-xs) 0;">Couldn't load the assignment</h4>
          <p class="text-secondary" style="font-size: 0.85rem; margin: 0 0 var(--space-sm) 0;">{{ assignmentsError }}</p>
          <button class="btn btn-sm" @click="loadAssignments">Retry</button>
        </div>
        <!-- A name in the address that is not an assignment: say so, never an
             empty editor that would create one by that name. -->
        <div v-else-if="!editing && mode === 'single' && unreadableIds.has(assignmentId)" class="empty-state">
          <h3>Couldn't read <code>{{ assignmentId }}</code> just now.</h3>
          <p class="text-secondary">GitHub did not return its settings. Nothing was changed.</p>
          <button class="btn btn-sm" @click="loadAssignments().then(applyRouteIntent)">Retry</button>
        </div>
        <div v-else-if="!editing && mode === 'single'" class="empty-state">
          <h3>There is no assignment called <code>{{ assignmentId }}</code> in {{ org }}.</h3>
          <p><router-link :to="{ name: 'dashboard', params: { org } }">Back to the assignments</router-link></p>
        </div>

        <!-- `data-broker`: whether the broker check has answered. Saving a
             live assignment does different things by it (publishedSaveWorkflow),
             and since the "Published & Verified" panel went nothing on screen
             says when it has - tests wait on this rather than on a guess. -->
        <form
          v-else-if="editing"
          class="editor-form"
          :data-broker="brokerExists === null ? 'unknown' : (brokerExists ? 'present' : 'missing')"
          @submit.prevent
        >


          <!-- The template changed under students who already accepted: their
               repositories keep the old files until a starter sync, and
               publishing again does not do it. lib/template-change.js. -->
          <div
            v-if="!isNew && templateNotice && templateNotice.id === form.id"
            class="published-info-card is-warning"
            role="status"
          >
            <div class="published-header">
              <Icon name="refresh-cw" :size="16" class="text-yellow" />
              <h4>Existing repositories still have the old template</h4>
            </div>
            <p class="published-desc">
              <template v-if="templateNotice.count !== null">
                {{ templateNotice.count }} student{{ templateNotice.count === 1 ? ' has' : 's have' }} a repository
              </template>
              <template v-else>Students who already accepted have repositories</template>
              made from the previous template. The new one, <code>{{ templateNotice.template }}</code>, is used for
              students who accept from now on; publishing again does not change existing repositories.
              Sync Starter Code brings them up to the new template, and shows every change before it is sent.
            </p>
            <div class="cohort-actions">
              <router-link
                class="btn btn-secondary btn-sm"
                :to="{ name: 'assignment-detail', params: { org, assignmentId: templateNotice.id }, query: { sync: '1' } }"
              >Sync Starter Code</router-link>
              <button type="button" class="btn-link" @click="templateNotice = null">Dismiss</button>
            </div>
          </div>

          <!-- student_permission is read at acceptance, so a change reaches
               nobody who already has a repository unless it is applied.
               lib/permission-change.mjs decides who and does it. -->
          <div
            v-if="!isNew && permissionNotice && permissionNotice.id === form.id"
            class="published-info-card"
            :class="permissionApplied ? 'is-success' : 'is-warning'"
            role="status"
            aria-label="Student permission change"
          >
            <div class="published-header">
              <Icon :name="permissionApplied ? 'check-circle' : 'users'" :size="16" :class="permissionApplied ? 'text-green' : 'text-yellow'" />
              <!-- Not "still have {from}": `from` is the previous SAVED value,
                   and after two saves nobody applied students hold neither
                   (third review, 2026-09-26). What they hold is what they
                   were given when they accepted. -->
              <h4 v-if="!permissionNotice.done">Students who already accepted keep the permission they were given</h4>
              <h4 v-else>Student permission applied</h4>
            </div>
            <p v-if="permissionNotice.unreadable" class="published-desc">
              Could not read which students already have a repository, so nothing can be changed from here.
              {{ permissionNotice.to }} applies to students who accept from now on.
            </p>
            <template v-else>
              <p v-if="!permissionNotice.done" class="published-desc">
                <template v-if="permissionNotice.plan.apply.length">
                  {{ permissionNotice.plan.apply.length }} student{{ permissionNotice.plan.apply.length === 1 ? '' : 's' }}
                  accepted before this change.
                </template>
                The new permission, {{ permissionNotice.to }}, is given to students who accept from now on.
              </p>
              <p v-else class="published-desc">
                {{ permissionNotice.done.changed }} student{{ permissionNotice.done.changed === 1 ? ' now has' : 's now have' }}
                {{ permissionNotice.to }}.
                <template v-if="permissionNotice.done.failed.length">
                  Not changed: {{ permissionNotice.done.failed.join(', ') }}.
                </template>
                <template v-if="permissionNotice.done.gone?.length">
                  No longer in their repository, so not re-invited: {{ permissionNotice.done.gone.join(', ') }}.
                </template>
              </p>
              <p v-if="permissionPastDeadline" class="published-desc">
                {{ permissionPastDeadline === 1 ? '1 student is' : `${permissionPastDeadline} students are` }}
                past their deadline or locked, and {{ permissionPastDeadline === 1 ? 'keeps' : 'keep' }} what they have:
                after the deadline, changing a student's permission would give back the access the deadline took.
              </p>
              <div class="cohort-actions">
                <button
                  v-if="!permissionNotice.done && permissionNotice.plan.apply.length"
                  type="button"
                  class="btn btn-secondary btn-sm"
                  :disabled="permissionNotice.running"
                  @click="applyPermissionChange"
                >{{ permissionNotice.running
                  ? `Applying… ${permissionNotice.progress} of ${permissionNotice.plan.apply.length}`
                  : `Apply ${permissionNotice.to} to ${permissionNotice.plan.apply.length} student${permissionNotice.plan.apply.length === 1 ? '' : 's'}` }}</button>
                <button type="button" class="btn-link" :disabled="permissionNotice.running" @click="permissionNotice = null">Dismiss</button>
              </div>
            </template>
          </div>

          <!-- PUBLISHING, in one line, while it is going on (BETA-UX.md,
               2026-10-03). The "Published & Verified Live" panel that sat here
               repeated the Invite link button at the top of the page, and its
               Regenerate link is in that button's menu now. What it said while
               a publish was still going live is all that stays. -->
          <!-- The step GitHub is at, read from the hub's runs
               (lib/publish-progress.js), not a count of the page's own checks:
               on 2026-10-06 "a minute or two (checked 45×)" ran for half an
               hour while GitHub had not even started the publish. -->
          <div v-if="!isNew && publishWatch === 'watching'" class="publish-watch publish-progress" role="status" :data-publish-step="publishProgress.step">
            <!-- Which step of how many, each finished one with how long it
                 took (2026-10-08: "I don't know in which step I am"). -->
            <!-- Status dots (DESIGN.md §1.3, §4), the one in progress a spinner;
                 the state is said in words to a screen reader, not by colour
                 alone. -->
            <ol v-if="publishStepList" class="publish-steps" aria-label="Publishing steps">
              <li v-for="(st, i) in publishStepList" :key="st.key" :class="['status-indicator', 'publish-step', `is-${st.state}`]" :data-step-state="st.state">
                <span v-if="st.state === 'active'" class="spinner sm" aria-hidden="true"></span>
                <span v-else :class="['status-dot', STEP_DOT[st.state]]" aria-hidden="true"></span>
                <span>{{ i + 1 }}. {{ st.label }}<template v-if="st.detail"> ({{ st.detail }})</template></span>
                <span class="sr-only">{{ STEP_WORDS[st.state] }}</span>
              </li>
            </ol>
            <span class="text-secondary publish-progress-line">
              <span v-if="!publishStepList" class="spinner sm" aria-hidden="true"></span>
              {{ publishProgressMessage.text }}
              <template v-if="publishProgressMessage.slow">
                GitHub is slow right now: <a :href="GITHUB_STATUS_URL" target="_blank" rel="noopener">githubstatus.com</a>.
              </template>
              <a v-if="publishProgress.step === 'deployed-without-page' && publishProgress.url" :href="publishProgress.url" target="_blank" rel="noopener">See the run.</a>
              <span class="text-muted" data-publish-usual>
                Usually {{ USUAL_WAIT }} in total<template v-if="publishMinutes >= 1">; {{ publishMinutes }} min so far</template>.
              </span>
            </span>
          </div>
          <div v-else-if="!isNew && publishWatch === 'ready'" class="publish-watch publish-ready" role="status">
            <Icon name="check-circle" :size="15" />
            <span>Live. The Invite link at the top of the page works now.</span>
          </div>
          <!-- A publish that did not finish will not go live by waiting, so the
               page stops checking and stops spinning. -->
          <div v-else-if="!isNew && publishWatch === 'failed'" class="publish-watch" role="status" data-publish-step="failed">
            <span class="text-warning">
              The publish did not finish on GitHub.
              <a v-if="publishProgress.url" :href="publishProgress.url" target="_blank" rel="noopener">See the run.</a>
            </span>
          </div>
          <!-- DO STUDENTS SEE WHAT IS SAVED? For a published (or closed)
               assignment, from the facts (props.studentPage): the card the saved
               document makes against the one students are served. Said after a
               refresh as much as after a save - which used to be a toast that
               vanished (2026-10-08). Not while a publish is being followed above. -->
          <div
            v-if="!isNew && studentPageShown"
            :class="['publish-watch', 'publish-progress', { 'publish-ready': studentPage.state === 'current' }]"
            role="status"
            :data-student-page="studentPage.state"
          >
            <ol v-if="studentPageStepList" class="publish-steps" aria-label="Getting the saved version to students">
              <li v-for="(st, i) in studentPageStepList" :key="st.key" :class="['status-indicator', 'publish-step', `is-${st.state}`]" :data-step-state="st.state">
                <span v-if="st.state === 'active'" class="spinner sm" aria-hidden="true"></span>
                <span v-else :class="['status-dot', STEP_DOT[st.state]]" aria-hidden="true"></span>
                <span>{{ i + 1 }}. {{ st.label }}</span>
                <span class="sr-only">{{ STEP_WORDS[st.state] }}</span>
              </li>
            </ol>
            <span class="publish-progress-line">
              <template v-if="studentPage.state === 'current'">
                <Icon name="check-circle" :size="15" />
                <span>Students see what is saved.</span>
              </template>
              <span v-else class="text-secondary">{{ studentPageMessage }}</span>
              <button
                v-if="studentPage.state === 'stuck' || studentPage.state === 'failed'"
                class="btn btn-secondary btn-sm"
                type="button"
                @click="emit('update-student-page')"
              >{{ studentPage.state === 'failed' ? 'Try again' : 'Update the student page now' }}</button>
            </span>
            <!-- What differs, in the lecturer's words: the evidence behind
                 "students still see the previous version". -->
            <ul v-if="studentPage.differences?.length" class="student-page-differences text-sm text-secondary" data-student-page-differences>
              <li v-for="d in studentPage.differences.slice(0, 4)" :key="d.key">
                {{ d.label }}: students see {{ cardValue(d.key, d.served) }}, saved {{ cardValue(d.key, d.saved) }}
              </li>
            </ul>
          </div>

          <!-- What is true after half an hour: the page stopped looking. Not the
               last step, which read as if it were still going on. -->
          <div v-else-if="!isNew && publishWatch === 'timeout'" class="publish-watch" role="status">
            <span class="text-warning">
              Not live after 30 minutes, and this page has stopped checking.
              <a :href="publishProgress.url || `https://github.com/${config.hubOwner}/${config.hubRepo}/actions/workflows/publish-assignment.yml`" target="_blank" rel="noopener">See the run.</a>
            </span>
          </div>

          <!-- A published assignment with no broker: a fault with a fix, not a
               repeat of anything else on the page, so it stays. -->
          <div v-if="!isNew && form.state === 'published' && brokerExists === false && publishWatch !== 'watching'" class="published-info-card is-error">
            <div class="published-header">
              <Icon name="alert-triangle" :size="16" class="text-danger" />
              <h4 style="color: var(--accent-red);">Publish Incomplete: Student Acceptance Broker Missing</h4>
              <span class="badge badge-danger">Action Required</span>
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

          <!-- The accepted / time-left card and its "Track roster & progress"
               went with the move into the assignment page (BETA-UX.md,
               2026-10-03): the header and the Progress tab say both. ADD
               STUDENTS STAYS. The cohort is a snapshot, so a student imported
               next week is not in an assignment made today, and the picker that
               fixes that is the sixth section down - this is the way to it. -->
          <div v-if="cohortFirst && showAddStudents" class="settings-quick-actions">
            <button type="button" class="btn btn-secondary btn-sm btn-with-icon" @click="openAddStudents">
              <Icon name="users" :size="13" />
              <span>Add students</span>
            </button>
          </div>

          <!-- The six fieldsets, always open. They used to fold away once the
               assignment was out, under an "Edit settings" summary; on the
               Settings tab the form is the whole point of being there, so the
               fold was one more click in front of it (2026-10-03). -->
          <div class="settings-fields">

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
          <!-- BASICS
               ONE BLOCK, IN THE ORDER THE DATA ALREADY FLOWED. Basics and
               Template were two fieldsets, and the split put Title ABOVE the
               template picker while `selectTemplate` fills the title only when
               it is EMPTY - so a lecturer working down the form typed a title
               first and the prefill never fired. Nothing about the chain
               changed here: the template fills the title, `autoSyncSlug` fills
               the slug, and the `form.id` watcher fills the repository name
               pattern. The layout was what disagreed with it.

               The two became one because both answered "what is this assignment
               and what is it called", and a border around each half of one
               question is the box prison DESIGN.md 1.1 names. -->
          <fieldset id="settings-basics">
            <legend>Basics</legend>

            <!-- SLUG, KEPT OUT OF THE WAY. It is derived, it is locked after
                 creation, and it is not in the student's invitation link
                 (/:org/i/:token) - so it is shown as what it is, a consequence
                 of the title, rather than as a box asking a question. It is
                 still real: it names assignments/<id>.yml, the public
                 broker-<id> repository a student lands on to accept, and the
                 lecturer's own /dashboard/<org>/<id>. Rare reasons to override
                 it survive behind Edit: a collision, or a broker repository
                 name that would be absurdly long.

                 Rendered below the repository name pattern, which is where the
                 collision verdict now lives too - the pattern IS the collision
                 key (lib/assignment-collision.mjs), and with the slug demoted
                 the pattern is the field a lecturer is looking at when they
                 choose a name. -->
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
                <!-- A link, not a button with window.open: it opens in a new
                     tab in every browser, Firefox's pop-up rules included. -->
                <a
                  v-if="templateGithubUrl"
                  class="btn template-open"
                  :href="templateGithubUrl"
                  target="_blank"
                  rel="noopener"
                  title="Open the template on GitHub"
                  aria-label="Open the template on GitHub"
                  data-template-open
                >
                  <Icon name="external-link" :size="14" />
                </a>
                <button
                  v-else
                  class="btn template-open"
                  type="button"
                  disabled
                  title="Choose a template repository GitHub can find, and it opens here"
                  aria-label="Open the template on GitHub"
                  data-template-open
                >
                  <Icon name="external-link" :size="14" />
                </button>
              </div>
              <!-- Said WHILE the template is being changed, not only after the
                   save: a changed template reaches only students who accept
                   from now on, and publishing again does not change that. -->
              <small v-if="templateSwitchCount" class="form-hint" role="note">
                {{ templateSwitchCount === 1 ? '1 student already has' : `${templateSwitchCount} students already have` }}
                a repository from the current template. The new one is used only for students who accept from now on;
                after saving, Sync Starter Code sends it to the others.
              </small>
              <!-- Pre-flight Template Validation Badge (2.B) -->
              <div v-if="templateValidationStatus" class="template-preflight-badge" style="margin-top: var(--space-xs);" role="status">
                <span v-if="templateValidationStatus.checking" class="badge badge-neutral flex items-center gap-xs" style="font-size: 0.8rem; padding: 3px 8px;">
                  <span class="spinner sm" style="width: 12px; height: 12px;"></span> Checking template repository…
                </span>
                <!-- Refused BEFORE the success badge: this one reads as valid
                     on the lecturer's own token, which is how it used to reach
                     provisioning and fail there, after a student had accepted. -->
                <span v-else-if="templateValidationStatus.valid && templateValidationStatus.blocked" class="badge badge-error flex items-center gap-xs" style="font-size: 0.8rem; padding: 3px 8px;">
                  <Icon name="x-circle" :size="13" /> Private template in another organization
                </span>
                <!-- A WARNING, not a refusal: the new repository may be exactly
                     what the lecturer intended, and only they can say. Saving
                     adopts it; until then provisioning refuses, so nobody gets
                     starter code the assignment was not built from. -->
                <span v-else-if="templateValidationStatus.valid && templateValidationStatus.replaced" class="badge badge-warning flex items-center gap-xs" style="font-size: 0.8rem; padding: 3px 8px;">
                  <Icon name="alert-triangle" :size="13" /> {{ templateValidationStatus.replaced }}
                </span>
                <!-- Before the success badge: GET /repos reports a default
                     branch for an empty repository, so it used to read "Valid
                     Template Repository (main branch)" over a template GitHub
                     cannot generate from. -->
                <span v-else-if="templateValidationStatus.valid && templateValidationStatus.empty" class="badge badge-warning flex items-center gap-xs" style="font-size: 0.8rem; padding: 3px 8px;">
                  <Icon name="alert-triangle" :size="13" /> {{ templateValidationStatus.empty }}
                </span>
                <span v-else-if="templateValidationStatus.valid && templateValidationStatus.isTemplate" class="badge badge-success flex items-center gap-xs" style="font-size: 0.8rem; padding: 3px 8px;">
                  <Icon name="check-circle" :size="13" /> Valid Template Repository ({{ templateValidationStatus.defaultBranch ? `${templateValidationStatus.defaultBranch} branch` : 'default branch unknown' }}{{ templateValidationStatus.isPrivate ? ', private' : '' }})
                </span>
                <span v-else-if="templateValidationStatus.valid && !templateValidationStatus.isTemplate" class="badge badge-warning flex items-center gap-xs" style="font-size: 0.8rem; padding: 3px 8px;">
                  <Icon name="alert-triangle" :size="13" /> Repository exists but is not marked as a GitHub Template
                </span>
                <span v-else-if="!templateValidationStatus.valid" class="badge badge-error flex items-center gap-xs" style="font-size: 0.8rem; padding: 3px 8px;">
                  <Icon name="x-circle" :size="13" /> {{ templateValidationStatus.message || 'Repository not found on GitHub' }}
                </span>
              </div>
              <!-- `templateValidationStatus?.blocked` widens the touched gate
                   rather than adding a second message: the badge above it is
                   four words, and this sentence is the one that says what to
                   do. Untouched-and-new is reachable - the form fills in an
                   org's sole template by itself - and a refusal nobody can
                   read is the failure this whole check exists to end. -->
              <div v-if="(touchedFields.template || !isNew || templateValidationStatus?.blocked) && fieldErrors.template" class="field-error-msg">{{ fieldErrors.template }}</div>
              <!-- Here, not under the Submission ref field: that one lives inside
                   the collapsed Advanced section, where a warning is unread. A
                   warning, not a refusal, so a draft stays saveable; publishing
                   refuses it (scripts/check-publish-preflight.mjs). -->
              <small v-if="submissionBranchWarning" class="text-warning submission-branch-warning" role="status">
                {{ submissionBranchWarning }}
              </small>
              <!-- Same trap as the blank starter's failure below, and this one
                   had been in it: as a `<small class="text-danger">` under
                   `.field small { color: var(--text-muted) }`, a failed read of
                   the organization's templates rendered in help-text grey. -->
              <div v-if="templatesError" class="field-error-msg" role="alert">
                Failed to load templates: {{ templatesError }}.
              </div>
              <!-- The first-run wall (ARCHITECTURE §10.4). The old copy - "Create one
                   and mark it as a template in repo Settings" - assumed the
                   reader already knew what a template repository is, and buried
                   the one non-obvious step (the checkbox) that is the actual
                   reason this list is empty for almost everyone.
                   The combobox deliberately stays: typing `owner/repo` is the
                   only way to name a template the org search cannot see, and
                   `checkTemplateValidity` probes it live. -->
              <!-- ONE BUTTON IN THIS FIELD, and it is the blank starter below.
                   Going to GitHub is a link, so it looks like one: two grey
                   `+ Create …` buttons four lines apart read as two spellings
                   of one action, and the reaction to seeing them was exactly
                   that. Nothing is lost by demoting it - it opened a new tab
                   either way.
                   The copy is three lines now. It was five, because a one-line
                   version had already failed: a lecturer who does not know what
                   a template repository is cannot act on it, and the Settings
                   checkbox is the step everyone misses. Both of those survive
                   in the sentence; what went was the paragraph repeating the
                   checkbox and the list of what starter code might be. -->
              <div v-else-if="!loadingTemplates && templates.length === 0" class="template-empty">
                <strong>This organization has no template repositories yet.</strong>
                <p>
                  A template is an ordinary repository. Every student gets their own copy of it.
                  Have starter code?
                  <a
                    :href="`https://github.com/organizations/${org}/repositories/new`"
                    target="_blank"
                    rel="noopener noreferrer"
                  >Create one on GitHub</a>, or open one you already have, then tick
                  <strong>Template repository</strong> in its <strong>Settings</strong> and press refresh.
                </p>
              </div>
              <small v-else-if="!loadingTemplates">
                Found {{ templates.length }} template {{ templates.length === 1 ? 'repository' : 'repositories' }}.
              </small>
              <!-- "STUDENTS START FROM NOTHING" IS AN ORDINARY THING TO WANT,
                   and until now the form had no answer for it: GitHub Classroom
                   made the template optional, this cannot, and a lecturer acting
                   on the difference makes a repository with no commits. That
                   failed provisioning for a whole assignment on 2026-09-17, and
                   a second lecturer asked the same evening whether the template
                   could be skipped. The warning badge and the publish preflight
                   turn that into a refusal; this turns it into a repository.
                   One call sets both things a hand-made one gets wrong - the
                   commit and the Template checkbox - and the sentence beside it
                   is here because the belief, not the four steps on github.com,
                   is what actually went wrong. -->
              <!-- AND IT GOES AWAY ONCE THERE IS A TEMPLATE. Left standing, it
                   offered to create a repository that now exists - the same
                   button, the same sentence in the present tense, and a second
                   press would be refused as a name clash. An offer that has
                   been taken is not an offer (DESIGN.md §1.5). Clearing the
                   field brings it back. -->
              <div v-if="isNew && !form.template" class="blank-starter">
                <div class="blank-starter-row">
                  <span>Nothing to start from?</span>
                  <button
                    type="button"
                    class="btn btn-secondary btn-sm btn-with-icon"
                    :disabled="!blankStarterRepo || creatingBlankStarter"
                    @click="createBlankStarter"
                  >
                    <Icon name="plus" :size="13" />
                    <span>{{ creatingBlankStarter ? 'Creating…' : 'Create a blank starter' }}</span>
                  </button>
                </div>
                <small class="text-muted">
                  <template v-if="!blankStarterRepo">
                    Title the assignment first, and this creates the starter repository for you.
                  </template>
                  <template v-else>
                    Makes <code>{{ org }}/{{ blankStarterRepo }}</code> with a README and uses it here.
                    GitHub cannot copy an empty repository, so one file is the minimum.
                  </template>
                </small>
                <!-- `.field-error-msg`, not a `<small class="text-danger">`:
                     `.field small` sets `--text-muted` and its scoped selector
                     outranks the global `.text-danger`, so a failure written
                     that way renders as help text (DESIGN.md §7). The error
                     vocabulary under a field already exists; use it. -->
                <div v-if="blankStarterError" class="field-error-msg" role="alert">
                  {{ blankStarterError }}
                </div>
              </div>
            </div>

            <!-- SECOND, BECAUSE PICKING THE TEMPLATE FILLS IT IN. -->
            <div class="field">
              <label>Title <span class="req">*</span></label>
              <input
                v-model="form.title"
                @input="autoSyncSlug(); touchedFields.title = true"
                @blur="onSlugBlur"
                placeholder="e.g. Linux Processes 2026"
              />
              <div v-if="(touchedFields.title || !isNew) && fieldErrors.title" class="field-error-msg">{{ fieldErrors.title }}</div>
            </div>

            <div class="field">
              <!-- A CONSEQUENCE, SHOWN AS ONE (DESIGN.md §1.8). The pattern is
                   filled from the slug, and most lecturers never change it, so
                   it reads as a line with Edit, the way the slug below does.
                   The box comes back when somebody asks for it, or when there
                   is something wrong with it to fix. -->
              <div v-if="!patternEditing && !patternNeedsInput" class="derived-line" data-derived="pattern">
                <span class="text-muted">Repository name</span>
                <code>{{ form.repository_name_pattern || '—' }}</code>
                <button type="button" class="btn-link" @click="patternEditing = true">Edit</button>
              </div>
              <template v-else>
                <label for="assignment-pattern">Repository name pattern <span class="req">*</span></label>
                <!-- This field IS the collision key (lib/seed-teams.mjs), so
                     editing it invalidates the verdict exactly as editing the
                     slug does, and leaving it re-runs the check. -->
                <input
                  id="assignment-pattern"
                  v-model="form.repository_name_pattern"
                  @input="manualRepositoryNamePattern = true; touchedFields.repository_name_pattern = true; clearCollision()"
                  @blur="onSlugBlur"
                  placeholder="linux-processes-{github_login}"
                />
              </template>
              <div v-if="(touchedFields.repository_name_pattern || !isNew) && fieldErrors.repository_name_pattern" class="field-error-msg">{{ fieldErrors.repository_name_pattern }}</div>

              <!-- THE COLLISION VERDICT LIVES HERE NOW. It used to sit under
                   the slug, on the reasoning that the slug was the field a
                   lecturer was looking at while choosing a name. Demoting the
                   slug inverts that, and this field was always the actual
                   collision key (lib/assignment-collision.mjs): provisioning is
                   idempotent on repository existence, so a pattern producing a
                   name that already exists hands the student the OLD repository
                   with the old deadline's lockdown on it.

                   A list, not a paragraph: as prose the same four findings were
                   five wrapped lines of red, which is a wall, not a message. -->
              <div v-else-if="collisionBlockers.length" class="field-error-msg">
                {{ COLLISION_LEAD }}
                <ul class="collision-list">
                  <li v-for="(f, i) in collisionBlockers" :key="`${f.kind}-${i}`">{{ f.detail }}</li>
                </ul>
                <!-- A refusal that only says no gets routed around. These are
                     the real options, and the cheap one is marked. -->
                <div class="collision-ways">
                  {{ COLLISION_REMEDY_LEAD }}
                  <ol class="collision-list">
                    <li v-for="w in collisionWays" :key="w.key">
                      <!-- Spaced by CSS, not by a text node: Vue trims
                           whitespace between elements, so a literal space
                           here rendered as "readable.Recommended." -->
                      {{ w.label }}<strong v-if="w.recommended" class="collision-rec">Recommended.</strong>
                    </li>
                  </ol>
                </div>
              </div>
              <div v-else-if="collisionError" class="field-error-msg">{{ collisionError }}</div>
              <!-- Nothing blocks. Said in the muted voice, because it is
                   information, not a refusal - the assignment saves. -->
              <div v-else-if="collisionNotes.length" class="collision-note text-muted">
                {{ COLLISION_WARNING_LEAD }}
                <ul class="collision-list">
                  <li v-for="(f, i) in collisionNotes" :key="`${f.kind}-${i}`">{{ f.detail }}</li>
                </ul>
              </div>


              <small v-if="collisionChecking">Checking whether this name is free…</small>
              <small v-else>
                Students see this name. Must contain
                <code>{{ form.assignment_type === 'group' ? '{team_slug}' : '{github_login}' }}</code>.
              </small>

            </div>

            <!-- The slug, as a consequence rather than a question. `.btn-link`
                 and not a re-implementation of it (DESIGN.md 7).
                 ITS OWN `.field`, though it renders as one line: the pattern
                 above already shows an error or the collision verdict, and two
                 `.field-error-msg` inside one field is two refusals about
                 different things reading as one. -->
            <div class="field">
              <div class="derived-line" data-derived="slug">
                <template v-if="slugEditing && isNew">
                  <label for="assignment-slug">Slug</label>
                  <input
                    id="assignment-slug"
                    v-model="form.id"
                    @input="manualSlug = true; touchedFields.id = true; clearCollision()"
                    @blur="onSlugBlur"
                    placeholder="linux-processes-2026"
                  />
                </template>
                <template v-else>
                  <span class="text-muted">Slug</span>
                  <code>{{ form.id || '—' }}</code>
                  <button
                    v-if="isNew"
                    type="button"
                    class="btn-link"
                    @click="slugEditing = true"
                  >Edit</button>
                </template>
              </div>
              <div v-if="(touchedFields.id || !isNew) && fieldErrors.id" class="field-error-msg">{{ fieldErrors.id }}</div>
              <small class="text-muted">
                Names the acceptance repository students open and your own link to this
                assignment.<template v-if="!isNew"> Fixed once the assignment exists.</template>
              </small>
            </div>

            <!-- LAST, AND FOLDED AWAY UNTIL IT IS WANTED. It is the only field
                 here nothing else derives from, it is optional, and most
                 assignments never get one - so a permanently open textarea was
                 spending the most vertical space on the least-used control and
                 pushing Schedule, which changes every time, below the fold.
                 Opens on click, and opens by itself when there is something to
                 show: a description already written, or an error about one on
                 an assignment loaded from the control repo. -->
            <div v-if="!descriptionOpen && !form.description && !fieldErrors.description" class="field">
              <button type="button" class="btn-link" @click="openDescription">
                Add a description
              </button>
              <small>Optional. Published on the public assignment page.</small>
            </div>
            <div v-else class="field">
              <label for="assignment-description">Description <span class="text-muted">(optional)</span></label>
              <textarea
                id="assignment-description"
                ref="descriptionEl"
                v-model="form.description"
                rows="2"
                placeholder="What students should know before they accept"
              ></textarea>
              <!-- Not gated on `touched`, unlike the required-field errors: this
                   one only fires when there IS content, so it can never nag an
                   empty form - and an assignment loaded from the control repo
                   with a bad description must explain why Save is disabled. -->
              <div v-if="fieldErrors.description" class="field-error-msg">{{ fieldErrors.description }}</div>
              <small>Published on the public assignment page, so students can read it before they accept.</small>
            </div>
          </fieldset>

          <!-- SCHEDULE, BEFORE ASSIGNMENT TYPE.
               Ordered by what a lecturer actually touches. The collaboration
               model is set once and then almost never changed - individual is
               the default and most assignments are individual - while the
               opening date and the deadline are different on every single
               assignment. The rarely-changed control was sitting above the
               always-changed one. -->
          <fieldset id="settings-schedule">
            <legend>Schedule</legend>
            <!-- THE ONE PLACE TWO FIELDS GENUINELY PAIR. They are read
                 together - an assignment opens THEN closes - and a
                 `datetime-local` is fixed-length, so a full-width box for
                 "21/09/2026 03:15" tells the reader the wrong thing (Baymard's
                 first rule: a fixed-length input is sized to its content).
                 Side by side they end at the same right edge as every other
                 field, so the column keeps its single measure while each date
                 gets a box that fits what goes in it. -->
            <div class="field-row">
              <div class="field">
                <label>Opens at <span class="req">*</span></label>
                <input type="datetime-local" v-model="form.opens_at_local" @change="touchedFields.opens_at = true" />
                <!-- The box is the browser's, in the browser's language (AM/PM
                     in a US-English Chrome); this is the same moment in 24-hour
                     time (lib/date-readout.js). -->
                <small v-if="openReadout" data-date-readout>{{ openReadout }}</small>
                <div v-if="(touchedFields.opens_at || !isNew) && fieldErrors.opens_at" class="field-error-msg">{{ fieldErrors.opens_at }}</div>
              </div>
              <div class="field">
                <label>Deadline <span class="req">*</span> <HelpButton topic="deadlines-and-extensions" label="deadlines and extensions" /></label>
                <input type="datetime-local" v-model="form.deadline_at_local" @change="touchedFields.deadline_at = true" />
                <small v-if="deadlineReadout" data-date-readout>{{ deadlineReadout }}</small>
                <div v-if="(touchedFields.deadline_at || !isNew) && fieldErrors.deadline_at" class="field-error-msg">{{ fieldErrors.deadline_at }}</div>
              </div>
            </div>
            <!-- WHICH CLOCK, said once for the pair. Each date used to carry
                 "Stored as: 2026-10-02T10:28:00.000Z", a UTC timestamp nobody
                 filling in a form acts on. What a lecturer needs is the zone the
                 boxes are in - the computer's, because that is how the browser
                 reads a datetime-local - and, when it differs, the one students
                 are shown (the assignment's timezone, under Advanced). -->
            <!-- In a `.field` of their own so they start on the fields' left
                 edge, under BOTH dates, because they are about the pair. -->
            <div class="field">
              <small>
                In your computer's time<template v-if="browserTimeZone"> ({{ browserTimeZone }})</template><template
                  v-if="studentTimeZone && studentTimeZone !== browserTimeZone"
                >. Students see times in {{ studentTimeZone }}</template>.
              </small>
              <small v-if="deadlineInPast" class="text-warning">
                This deadline is in the past; the next nightly run will finalize (lock down + report) immediately.
              </small>
            </div>
            <!-- ONE QUESTION, AND ITS ANSWERS ARE WHAT HAPPENS (2026-10-02).
                 Two stored fields, `late_policy` and `lock_down_enabled`, were
                 asked as two questions (DESIGN.md §1.9), and a lecturer could
                 not tell which one decided grading and which access - because
                 both do some of each: `block` locks the submission branch AND
                 decides what counts. So the question is now the one a lecturer
                 asks - what happens at the deadline - and each answer names
                 both fields at once (`deadlineChoice`).

                 The fourth combination, read-only while late work still
                 counts, is what both 2026 exams ran on. It is not offered for a
                 new assignment, and it is never lost: an assignment that holds
                 it shows it as a fourth answer (`legacyDeadlineOffered`), so
                 loading one changes nothing. -->
            <div class="field">
              <label>After the deadline <HelpButton topic="late-work" label="late work" /></label>
              <!-- Alternatives as rows with a tonal step on the chosen one; no
                   bordered card, because this fieldset is already a box
                   (DESIGN.md §1.1). -->
              <div class="policy-options">
                <label class="policy-option" :class="{ selected: deadlineChoice === 'stop-pushes' }">
                  <input type="radio" v-model="deadlineChoice" value="stop-pushes" />
                  <span class="policy-option-text">
                    <strong>Pushing stops</strong>
                    <small>
                      The submission is the last commit before the deadline. Students keep their
                      Actions, secrets and runners.
                    </small>
                  </span>
                </label>
                <label class="policy-option" :class="{ selected: deadlineChoice === 'nothing' }">
                  <input type="radio" v-model="deadlineChoice" value="nothing" />
                  <span class="policy-option-text">
                    <strong>Nothing is locked</strong>
                    <small>Late commits count, and are marked late in the report.</small>
                  </span>
                </label>
                <label class="policy-option" :class="{ selected: deadlineChoice === 'read-only' }">
                  <input type="radio" v-model="deadlineChoice" value="read-only" />
                  <span class="policy-option-text">
                    <strong>The repository becomes read-only</strong>
                    <small>
                      Pushing stops, and students also lose Actions, secrets, environments, runners
                      and settings until you reopen it.
                    </small>
                  </span>
                </label>
                <label
                  v-if="legacyDeadlineOffered || deadlineChoice === 'legacy'"
                  class="policy-option"
                  :class="{ selected: deadlineChoice === 'legacy' }"
                >
                  <input type="radio" v-model="deadlineChoice" value="legacy" />
                  <span class="policy-option-text">
                    <strong>Read-only, but late work still counts</strong>
                    <small>
                      What this assignment is set to. Students lose Actions, secrets and settings at
                      the deadline, and anything they pushed before the lock landed still counts.
                      Not offered for new assignments.
                    </small>
                  </span>
                </label>
              </div>
              <!-- WHEN the lock lands and what the date behind it is worth -
                   two facts, said apart. The deadline sentinel locks at the
                   instant for every published assignment (lib/sentinel-window.mjs);
                   the nightly run is the fallback, not the plan. This line used
                   to say "the lock is applied by the nightly run", which stopped
                   being true when the sentinel shipped (DESIGN.md §1.5). -->
              <small v-if="deadlineChoice === 'stop-pushes' || deadlineChoice === 'read-only'">
                The lock lands at the deadline, or at the nightly run if that is missed. Work pushed
                in between does not count: the submission is the last commit <em>dated</em> before
                the deadline. A commit's date comes from the student's own computer - fine for
                ordinary marking, but not proof if you ever need to challenge it.
              </small>
            </div>
          </fieldset>

          <!-- STUDENTS: who works on it, who may accept and how many.
               Below Schedule because it is chosen once and rarely changed, while
               the dates differ on every assignment (DESIGN.md §1.8). It took in
               the old Assignment Type fieldset - one radio row was a whole box -
               and the who controls from Guardrails, a grab-bag of nine. -->
          <fieldset id="settings-students">
            <legend>Students</legend>
            <div class="field">
              <!-- "TEAM", NOT "GROUP". This was the one place in the whole flow
                   that said Group, and it collided with the class groups on the
                   roster - two unrelated concepts, one word. Everything
                   downstream of this radio already said team: Formation Mode,
                   maximum and minimum team size, the Teams tab, Copy teams,
                   team_slug and team_name. Canvas draws the same distinction and
                   names them the same way round: sections segment the class,
                   groups collaborate on one submission. -->
              <label>Students work <HelpButton topic="group-assignments" label="group assignments" /></label>
              <div class="radio-group">
                <label style="display: flex; align-items: center; gap: 6px; cursor: pointer;">
                  <input type="radio" v-model="form.assignment_type" value="individual" @change="onAssignmentTypeChange" />
                  <span><strong>Alone</strong> (1 student per repository)</span>
                </label>
                <label style="display: flex; align-items: center; gap: 6px; cursor: pointer;">
                  <input type="radio" v-model="form.assignment_type" value="group" @change="onAssignmentTypeChange" />
                  <span><strong>In teams</strong> (2 or more students share 1 repository)</span>
                </label>
              </div>
            </div>

            <div v-if="form.assignment_type === 'group'" class="group-config-box">
              <div class="field">
                <label>Formation Mode</label>
                <select v-model="form.group_config.formation_mode">
                  <option value="self-service">Self-Service: students create or join open teams</option>
                  <option value="pre-assigned">Pre-Assigned: teams pre-mapped in roster / instructor created</option>
                </select>
                <!-- IT DESCRIBED THE OPTION YOU DID NOT PICK. With Self-Service
                     selected it read "Under pre-assigned mode, students only
                     see and accept their assigned team repository" - true of
                     something, and not of what was on screen. -->
                <small v-if="form.group_config.formation_mode === 'pre-assigned'">
                  Each student sees only the team you put them in, and accepts into that repository.
                  Seed the teams before you publish, or nobody has one.
                </small>
                <small v-else>
                  Students form their own teams: the first to accept creates one, the rest join it.
                </small>
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

              <!-- THE CONDITION BEFORE WHAT DEPENDS ON IT (asked 2026-10-10). Under
                   pre-assigned teams the code question exists only while this box
                   is ticked - the teams those students form are the only ones a
                   code is for - and it sat ABOVE it, so unticking the lower box
                   made the upper one vanish. -->
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
                  accept at all. That is where late enrollers, Erasmus arrivals and anyone whose
                  partners dropped out get stuck.
                </small>
              </div>

              <div
                v-if="form.group_config.allow_team_creation !== false && (form.group_config.formation_mode === 'self-service' || form.group_config.unassigned_fallback === 'self-service')"
                class="field checkbox"
              >
                <label>
                  <input type="checkbox" v-model="form.group_config.require_join_code" data-field="require-join-code" />
                  Joining a team needs a code from someone in it
                </label>
                <small v-if="form.group_config.formation_mode === 'pre-assigned'">
                  Only for the teams formed by students with no assigned team: whoever creates one gets a
                  code to give their teammates. The teams you made or seeded have no code. You can see
                  every code on the Teams tab.
                </small>
                <small v-else>
                  The student who creates a team gets a code to give their teammates. You can see every
                  team's code on the Teams tab. Teams you make or seed have no code and stay open.
                </small>
              </div>

              <!-- Not on the create form (ARCHITECTURE §5.6.1). Teams are stored under
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
                    <span>Copy teams from…</span>
                  </button>
                  <span v-if="hasUnsavedEdits()" class="text-muted text-xs">
                    Save your changes first: seeding reads this assignment's team size and
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
            <!-- WHO MAY ACCEPT, AND WHAT THEY DO WHEN THEY DO - two plain questions
                 (2026-10-02). They were a dropdown of three modes plus a checkbox
                 that applied to one of them, and the claim mode hid under a third
                 name. All four combinations are valid and map onto what is stored:
                 anyone + email = open + require_claim, anyone + click = open,
                 roster + click = enforced, roster + email = claim (whoMayAccept /
                 acceptIdentity). No schema change: the same two fields are written.
                 Each answer says what the STUDENT experiences, because that is what
                 a lecturer can predict. -->
            <div class="field">
              <label>Who may accept <HelpButton topic="who-may-accept" label="who may accept" /></label>
              <div class="radio-group">
                <label><input type="radio" v-model="whoMayAccept" value="anyone" /> Anyone with the link</label>
                <label><input type="radio" v-model="whoMayAccept" value="roster" /> Only students on the roster</label>
              </div>
            </div>
            <div class="field">
              <label>{{ ACCEPT_IDENTITY_QUESTION }} <HelpButton topic="confirming-an-email-address" label="confirming an email address" /></label>
              <div class="radio-group">
                <label><input type="radio" v-model="acceptIdentity" value="email" /> {{ REQUIRE_CLAIM_LABEL }}</label>
                <label><input type="radio" v-model="acceptIdentity" value="click" /> just click Accept</label>
              </div>
              <!-- One line that changes with the combination: what the two
                   answers together mean for a student opening the link. -->
              <small>{{ acceptanceSentence }}</small>
              <!-- A roster is still worth importing under `open`: report.mjs
                   builds the population from the union of acceptances and the
                   roster, so roster students show up before they accept and
                   carry their number, name and class group into the report and
                   the CSV export. `open` drops the GATE, not the roster. -->
              <small v-if="form.roster_mode === 'open' && rosterCount > 0">
                <template v-if="rosterCount > 0">
                  Your roster still names {{ rosterCount }} student{{ rosterCount === 1 ? '' : 's' }} in
                  the report - it just does not decide who may accept.
                </template>
              </small>
              <!-- `enforced` and `claim` both make students/roster.yml
                   load-bearing, so the form says whether anyone can accept at
                   all rather than naming a tab it does not link to
                   (ARCHITECTURE §10.4). The count comes from this view's own
                   read of the org roster (lib/roster-read.js). -->
              <small v-if="rosterGatesAcceptance(form.roster_mode)" class="roster-status">
                <span v-if="rosterCount === 0" class="status-indicator">
                  <span class="status-dot dot-warning"></span>
                  <span>No students imported yet - nobody can accept.</span>
                  <router-link :to="{ name: 'roster', params: { org } }" class="btn-link">Import roster →</router-link>
                </span>
                <span
                  v-else-if="rosterMatchesLogin(form.roster_mode) && rosterCount > 0 && rosterLinked === 0"
                  class="status-indicator"
                >
                  <!-- github_login is the optional column and the only thing
                       accept.mjs matches on UNDER `enforced`, so a roster
                       imported before anyone handed in a username stops every
                       acceptance there. Under `claim` it is exactly the column
                       a lecturer is not expected to have - that is the whole
                       reason the mode exists - so warning about it would be
                       describing a problem the cohort does not have. -->
                  <span class="status-dot dot-warning"></span>
                  <span>
                    {{ rosterCount }} student{{ rosterCount === 1 ? '' : 's' }} on the roster, but
                    none has a GitHub username yet - nobody can accept.
                  </span>
                  <router-link :to="{ name: 'roster', params: { org } }" class="btn-link">Manage →</router-link>
                </span>
                <span v-else-if="rosterCount > 0" class="status-indicator">
                  <span class="status-dot dot-success"></span>
                  <span>
                    {{ rosterCount }} student{{ rosterCount === 1 ? '' : 's' }} on the roster<template
                      v-if="rosterMatchesLogin(form.roster_mode) && rosterLinked < rosterCount"
                    >, {{ rosterCount - rosterLinked }} without a GitHub username yet</template>.
                  </span>
                  <router-link :to="{ name: 'roster', params: { org } }" class="btn-link">Manage →</router-link>
                </span>
                <span v-else>
                  Students must appear in the course roster. Import them on the
                  <router-link :to="{ name: 'roster', params: { org } }">Roster page</router-link>
                  - an empty roster means nobody can accept.
                </span>
              </small>
            </div>

            <!-- WHICH SECTION THIS ASSIGNMENT IS FOR.
                 The roster is org-wide, so a course running two groups has one
                 gate for both unless an assignment narrows it. Nothing ticked
                 means every group, which is what every assignment written
                 before this existed means.
                 Only rendered when the roster is actually the gate - a filter
                 under `open` decides nothing.

                 IT SHOWS WHENEVER THERE IS A ROSTER TO PICK FROM. Its
                 predecessor was hidden until the org already had class groups,
                 which meant the only people who ever saw it were the ones who
                 did not need telling: measured 2026-09-05, not one student in
                 any live org carried a `class_group`, so the control had never
                 rendered anywhere and a lecturer asking how to split their
                 classes had nothing on screen to find. Groups are only the
                 filter now, so their absence costs the picker nothing - the
                 list is still the list. -->
            <div v-if="showCohortPicker" class="field">
              <label>Who is this assignment for <HelpButton topic="who-is-this-assignment-for" label="who this assignment is for" /></label>
              <!-- FILTER, THEN TICK. The chips narrow the list; they are not
                   the answer. A chip carries its count because a bare "3A"
                   never answered the question being asked at that moment -
                   how many people am I about to admit - and "No group" is a
                   filter of its own, so the students who used to be silently
                   refused are visible and tickable. -->
              <div class="cohort-filters">
                <button
                  type="button"
                  class="chip-btn"
                  :class="{ active: cohortFilter === null && !cohortShowSelected }"
                  @click="showGroup(null)"
                >All {{ rosterStudents.length }}</button>
                <button
                  v-for="c in cohortGroupCounts"
                  :key="c.group || '__none__'"
                  type="button"
                  class="chip-btn"
                  :class="{ active: cohortFilter === c.group && !cohortShowSelected }"
                  @click="showGroup(c.group)"
                >{{ c.group || 'No group' }} · {{ c.count }}</button>
                <!-- READ BACK WHAT YOU BUILT. "A whole class plus these two" is
                     what this picker is for, and assembling it means moving
                     between filters - so there has to be a way to see the
                     result without trusting a number in the corner. -->
                <button
                  v-if="cohortSelected.size"
                  type="button"
                  class="chip-btn"
                  :class="{ active: cohortShowSelected }"
                  @click="showSelectedOnly"
                >Selected · {{ cohortSelected.size }}</button>
                <input
                  v-model="cohortSearch"
                  type="search"
                  class="cohort-search"
                  placeholder="Search name, number or username"
                  aria-label="Search the roster"
                />
              </div>

              <div class="cohort-list">
                <!-- ONE CLICK FOR A WHOLE CLASS. Filtering to a class and then
                     ticking twenty boxes is not a flow anyone should have; the
                     footer link that did this was small, generic and easy to
                     miss beside a chip that fills blue and reads as though it
                     had already selected the class. A header checkbox is the
                     pattern every table uses, it names what it will take, and
                     its indeterminate state says "some of these" without a
                     sentence. -->
                <!-- NOT a `.cohort-row`: that class means "a student" to every
                     count on this screen and to the tests, and a header that
                     answers `.cohort-row` makes a list of five report six. -->
                <label v-if="cohortVisible.length" class="cohort-all">
                  <input
                    type="checkbox"
                    :checked="allShownSelected"
                    :disabled="cohortReadOnly"
                    :indeterminate.prop="someShownSelected && !allShownSelected"
                    :aria-label="selectAllLabel"
                    @change="toggleAllShown"
                  />
                  <span class="cohort-all-label">{{ selectAllLabel }}</span>
                </label>
                <label
                  v-for="s in cohortVisible"
                  :key="cohortKey(s)"
                  class="cohort-row"
                  :class="{ 'is-locked': isLocked(s) }"
                  :style="cohortRowStyle"
                >
                  <input
                    type="checkbox"
                    :checked="isPicked(s)"
                    :disabled="cohortReadOnly || isLocked(s)"
                    :title="isLocked(s) ? 'Already in this assignment. Removing a student does not delete their repository or their work, so this only adds.' : null"
                    @change="toggleCohortStudent(s)"
                  />
                  <code v-if="cohortShowsNumber" class="cohort-num">{{ s.student_number || '—' }}</code>
                  <span class="cohort-name">{{ cohortPrimary(s) }}</span>
                  <span v-if="cohortShowsGroup" class="cohort-group text-muted">{{ s.class_group || '—' }}</span>
                  <span v-if="cohortShowsAccount" class="cohort-acct text-muted">{{ cohortSecondary(s) }}</span>
                </label>
                <p v-if="!cohortVisible.length" class="text-muted text-center cohort-empty">
                  No students match this filter.
                </p>
              </div>

              <!-- A FILTER THAT LOOKS LIKE A SELECTION. Clicking a class fills
                   the chip blue and leaves exactly that class on screen with
                   every box unticked, which reads as "this assignment is for
                   1TIN-A" while it is still open to the whole roster. Said
                   where it is true, not left to a count in the corner. -->
              <p v-if="cohortFilteredButEmpty" class="cohort-hint text-warning">
                Showing <strong>{{ cohortFilterLabel }}</strong> — but nothing is selected yet, so
                every student on the roster may accept. Tick the box above to take this class.
              </p>

              <!-- No "Select all shown" here any more: the header checkbox
                   does that job, and two controls for one action is how a
                   lecturer ends up trusting neither. -->
              <div class="cohort-foot">
                <button v-if="cohortSelected.size" type="button" class="btn-link" @click="clearCohort">
                  Clear selection
                </button>
                <span class="cohort-count" :class="cohortSelected.size ? 'is-narrowed' : null">
                  {{ cohortSelected.size ? `${cohortSelected.size} of ${rosterStudents.length} selected` : 'Nobody selected' }}
                </span>
              </div>

              <!-- THE EMPTY STATE IS A TRAP UNLESS IT SAYS SO. Nothing ticked
                   stores nothing, and nothing stored means EVERYONE - so a
                   lecturer who unticks their way to zero must be told, not left
                   to discover it when the whole course accepts. -->
              <!-- A LIVE ASSIGNMENT THAT ADMITS EVERYONE KEEPS ADMITTING THEM.
                   Narrowing it would refuse students who can accept today, some
                   of whom already have - the same act the add-only lock exists
                   to prevent, in its worst form, and the one direction that was
                   left open. -->
              <small v-if="cohortReadOnly" class="text-muted">
                <strong>Every student on the roster may accept, and this cannot be narrowed now.</strong>
                Taking students out of a published assignment would refuse people who can accept
                today. Close the assignment first if you need to change who it is for.
              </small>
              <small v-else-if="!cohortSelected.size">
                <strong>Every student on the roster may accept.</strong> Tick students to limit this
                assignment to them; the chips above filter the list.
              </small>
              <!-- THREE FACTS, THREE LINES. Run together they were a paragraph
                   nobody finishes: who may accept, why some ticks will not come
                   off, and who is missing are separate answers and only the
                   first is always true. -->
              <template v-else>
                <small>
                  Only these <strong>{{ cohortSelected.size }}</strong> may accept.
                  <span v-if="cohortOverCap" class="text-warning">
                    That is more than the cap of {{ form.max_acceptances }} - students past it are
                    rejected. Raise <strong>Max acceptances</strong> or select fewer.
                  </span>
                </small>
                <!-- WHY A TICK WILL NOT COME OFF. Said where the disabled boxes
                     are, rather than left to a tooltip nobody hovers. -->
                <small v-if="cohortLocked.size" class="text-muted">
                  The {{ cohortLocked.size }} already in this assignment cannot be removed - taking a
                  student out would not delete their repository or their work. Ticking adds.
                </small>
                <!-- THE SILENT OMISSION, named. A late enroller is simply absent
                     from a snapshot, and nothing would say so until they could
                     not accept. Only once live: on a draft the lecturer is still
                     choosing and a running count would be nagging. -->
                <small v-if="cohortLocked.size && cohortMissing > 0" class="text-warning">
                  {{ cohortMissing }} student(s) on the roster are not in this assignment - imported
                  since, or never picked.
                </small>
                <!-- WHY THE COUNT DOES NOT MATCH THE ROWS. A student removed
                     from the roster stays named in every assignment that picked
                     them, deliberately - the cohort is a record. But then "22
                     selected" sits over twenty rows and the reader assumes they
                     miscounted. -->
                <small v-if="cohortDangling.length" class="text-warning">
                  {{ cohortDangling.length }} of them
                  {{ cohortDangling.length === 1 ? 'is' : 'are' }} no longer on the roster
                  (<code>{{ cohortDangling.join(', ') }}</code>) - kept, because this assignment was
                  for them.
                </small>
              </template>
            </div>

            <div class="field">
              <label>Max acceptances<span v-if="form.roster_mode === 'open'"> (required)</span></label>
              <input type="number" v-model.number="form.max_acceptances" min="1" @input="touchedFields.max_acceptances = true" />
              <div v-if="(touchedFields.max_acceptances || !isNew) && fieldErrors.max_acceptances" class="field-error-msg">{{ fieldErrors.max_acceptances }}</div>
              <!-- Not "Hard cap": the check is check-then-act across parallel
                   runs, so a simultaneous burst can land a couple over
                   (deliberate - ARCHITECTURE §5.4). C4 says the UI must not
                   describe behaviour the system does not have. -->
              <small v-if="form.max_acceptances">Cap on accepted students. Acceptances beyond it are rejected.</small>
              <small v-else-if="form.roster_mode === 'open'" class="field-error-msg">
                Required with open enrollment - without the roster gate this is the only limit on who can claim a repo.
              </small>
              <small v-else class="text-warning">Empty = <strong>no cap</strong> (any number of students can accept). Set a number to keep the guardrail.</small>
            </div>
          </fieldset>

          <!-- GRADING: what happens to the work, apart from the deadline. The
               Grading tab's "Set up grading" opens the settings here. -->
          <fieldset id="settings-grading">
            <legend>Grading</legend>
            <div class="field checkbox">
              <div class="checkbox-with-help">
                <label>
                  <input type="checkbox" v-model="form.feedback_pr" />
                  Open a draft Feedback PR for each student
                </label>
                <HelpButton topic="feedback-pull-requests" label="feedback pull requests" />
              </div>
              <small>
                Gives you a page per student where you comment on their code line by line.
                Switch it on now: it cannot be added later.
              </small>
            </div>
            <!-- One line, never the configuration (ARCHITECTURE §11.6). This was an
                 "Enable autograding" checkbox that opened a type dropdown, four
                 unlabelled textareas whose meaning changed with it, no headers,
                 no totals and no validation until the schema refused the save.
                 The configuration's existence is the flag; there is no separate
                 checkbox left to disagree with it. -->
            <div class="field autograde-summary">
              <!-- "Automated checks" named nothing a lecturer recognises - the
                   feature is grading, and a bare "Off" beside a button says
                   nothing about what is off (reported 2026-09-02). The state
                   itself stays in `.autograde-summary-text` so it remains one
                   readable value; the sentence sits beside it. -->
              <label>Autograding <HelpButton topic="autograding" label="autograding" /></label>
              <div class="autograde-summary-row">
                <span class="autograde-summary-text">{{ autogradeSummary }}</span>
                <span v-if="!gradingAnswered" class="autograde-summary-note">
                  · no checks are configured here
                </span>
                <button class="btn btn-secondary btn-sm" type="button" @click="showAutogradeModal = true">
                  {{ gradingAnswered ? 'Edit' : 'Set up' }}
                </button>
                <button
                  v-if="gradingAnswered"
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
          <details id="settings-advanced" class="advanced">
            <summary>Advanced</summary>
            <div class="field">
              <label>Student permission</label>
              <select v-model="form.student_permission">
                <option value="admin">admin</option>
                <option value="maintain">maintain</option>
                <option value="push">push</option>
                <option value="triage">triage</option>
                <option value="pull">pull</option>
              </select>
              <!-- Each sentence is a measurement, not a reading of GitHub's
                   docs: tests/live/permission-probe.mjs, 2026-09-26. -->
              <small v-if="form.student_permission === 'admin'">
                Students can also register self-hosted runners, create environments, change the repository's
                settings and rulesets, and add other people to their repository.
              </small>
              <small v-else-if="form.student_permission === 'maintain' || form.student_permission === 'push'">
                Students can push and create Actions secrets and variables. They cannot register self-hosted runners,
                create environments, change the repository's settings or add other people. Choose admin for an
                exercise that needs a runner or an environment.
              </small>
              <small v-else>Students cannot push to their repository.</small>
              <small v-if="!isNew && storedStudentPermission && form.student_permission !== storedStudentPermission">
                Students who already accepted keep the permission they were given until you apply the change to them after saving.
              </small>
            </div>
            <div class="field">
              <label>Submission ref</label>
              <input v-model="form.submission_ref" placeholder="refs/heads/main" @input="manualSubmissionRef = true" />
              <small v-if="templateValidationStatus?.valid && templateValidationStatus.defaultBranch">
                Student repositories start with the template's default branch only:
                <code>refs/heads/{{ templateValidationStatus.defaultBranch }}</code>.
              </small>
            </div>
            <div class="field">
              <label>Time zone students see</label>
              <input v-model="form.timezone" :placeholder="TIMEZONE" />
              <small>Dates on the student's page are shown in this zone. The dates above are entered in your computer's time.</small>
            </div>
            <!-- THE FORM OF THE ADDRESS, wherever one is asked for. Under
                 Advanced since 2026-10-02: it is the institution's rule, on by
                 default, and almost nobody should switch it off for one
                 assignment. The rule
                 itself is deployment.yml's (firstname.lastname at PXL); this
                 only switches it off for one assignment. Ticked is the
                 deployment's rule, so nothing is written for it. -->
            <div v-if="CLAIM_ADDRESS_FORMAT && (form.roster_mode === 'claim' || (form.roster_mode === 'open' && form.require_claim))" class="field checkbox">
              <label>
                <input type="checkbox" v-model="requireNamedAddress" />
                Only accept the {{ CLAIM_ADDRESS_FORMAT.example }}@ form of the address
              </label>
              <small v-if="requireNamedAddress">
                An address like 12345678@ does not say who the student is, so it is not accepted. A student who
                confirmed one earlier is asked again.
              </small>
              <small v-else>Any address in the allowed domains is accepted.</small>
            </div>
            <!-- No `acceptance_mode` control: the enum has one value, so the
                 select was a decision the lecturer could not make. The field is
                 still written by buildDoc() and published on the card. -->
          </details>
          </div>

          <!-- VALIDATION ERRORS. Save is disabled by them, so they are listed
               together here as well as beside each field: a lecturer at the
               bottom bar sees why the button is dead without scrolling up. -->
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

          <!-- THE BROKER, for an existing assignment. Changing the STATE is the
               state button in the header above (AssignmentHeader.vue,
               runStateAction), the one place it is offered on every tab; what
               is left here is repairing a published assignment's broker and
               watching a publish go live. -->
          <div v-if="!isNew && form.state === 'published'" id="settings-lifecycle" class="lifecycle">
            <h4>Broker</h4>

            <!-- Repair above the rule, state transitions below it
                 (ARCHITECTURE §10.1.1). "Republish the broker" and "stop the whole
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
              <!-- The reassurance is only true once this assignment has a
                   keypair. The publish that mints one is the publish that
                   retires every link issued in the old format, and promising
                   otherwise is DESIGN.md §1.5 - the UI describing behaviour the
                   system does not have. -->
              <small v-if="migratesInvitation" class="text-secondary">Recreates the broker and its variables. Existing student repositories are untouched. This assignment still uses the old invitation format, so publishing upgrades it and links handed out so far stop working.</small>
              <small v-else class="text-secondary">Recreates the broker and its variables. Existing student repositories are untouched, and links already handed out keep working.</small>
            </div>


          </div>

          <!-- THE FORM'S ACTIONS, ONCE, IN A BAR STUCK TO THE BOTTOM of the
               window (BETA-UX.md, 2026-10-03). They sat in a row at the top of
               the form, so a lecturer who changed the grading section scrolled
               back up to save, and the row competed with the assignment's own
               header above it. DESIGN.md §1.2: one action row, never two. -->
          <div class="editor-action-bar">
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
            <!-- WHY SAVE IS GREY. Both buttons were disabled on a fresh form with
                 nothing saying why, and the field errors that would explain it
                 wait until a field is touched, so as not to nag a form still
                 being filled in. This line names the fields, not the errors. -->
            <p v-if="saveBlockers.length && !saving" class="save-blockers">
              Still needed: {{ saveBlockers.join(', ') }}
            </p>
            <!-- WHETHER WHAT IS ON SCREEN IS SAVED. Not the assignment's state:
                 a draft is saved, it is just not open to students. These are
                 edits that exist in this tab only, until Save. Said only when
                 true; a saved form says nothing. -->
            <span v-if="(isNew || unsaved) && !actionStep" class="unsaved-note" data-unsaved>
              <span class="status-dot dot-warning" aria-hidden="true"></span>
              {{ isNew ? 'Not saved yet' : 'Unsaved changes' }}
            </span>
            <!-- WHERE IT WAS PRESSED. Pressed at the bottom of a long form,
                 Save & publish showed nothing for three seconds of checks, and
                 then only a line at the top of the page (2026-10-08). The press
                 says what it is doing at once, and a publish going live says
                 its step here as well as at the top. -->
            <span v-if="actionStep || publishBarStatus" class="publish-bar-status" role="status" data-publish-bar>
              <span v-if="actionStep || publishWatch === 'watching'" class="spinner sm" aria-hidden="true"></span>
              {{ actionStep || publishBarStatus }}
            </span>
            <div class="editor-action-buttons">
              <button class="btn" type="button" @click="cancelEdit" :disabled="saving || !!actionStep">Cancel</button>
              <button
                v-if="isNew || form.state === 'draft'"
                class="btn"
                type="button"
                @click="saveAssignment('draft')"
                :disabled="saving || !!actionStep || !canSave"
              >{{ saving ? 'Saving…' : 'Save as draft' }}</button>
              <button
                :class="['btn', saveIsPrimary ? 'btn-primary' : '']"
                type="button"
                @click="saveKeepsState ? saveKeepingState() : saveAndPublish()"
                :disabled="saving || !!actionStep || !canSave"
              >{{ actionStep || (saving ? 'Saving…' : saveLabel) }}</button>
            </div>
          </div>
        </form>
      </main>
    </div>
    </template>

    <!-- Republish the broker, and the one question that goes with it: keep the
         invitation or rotate it. The dialog owns that choice - it only exists
         while the dialog is open - and hands it back on confirm. -->
    <RepublishBrokerModal
      v-if="showRepublishModal"
      :org="props.org"
      :broker-repo="brokerRepoName({ assignment: form })"
      :migrates-invitation="migratesInvitation"
      :preselect-regenerate="regenerateInvite"
      :publishing="publishing"
      @close="showRepublishModal = false"
      @confirm="confirmRepublish"
    />

    <!-- DELETE. The dialog owns the typed-slug confirmation and its own state
         (DESIGN.md §6); the two repository names are passed in because
         lib/archive-repo.mjs and lib/broker-repo.mjs are the only things
         allowed to decide them. -->
    <DeleteAssignmentModal
      v-if="showDeleteModal"
      :assignment-id="form.id"
      :archive-repo-name="archiveRepoName(form.id)"
      :broker-repo-name="brokerRepoName({ assignment: form })"
      :busy="deleting"
      @close="showDeleteModal = false"
      @confirm="deleteAssignment"
    />

    <!-- THIS NAME IS ALREADY IN USE. Opened by Save, and only when the
         organization actually holds repositories the pattern would produce -
         which on a normal course is never. The count and the pattern are
         passed in; lib/assignment-collision.mjs decided them and the dialog
         does not re-derive either. -->
    <ExistingReposModal
      v-if="existingReposPrompt"
      :count="existingReposPrompt.count"
      :orphans="existingReposPrompt.orphans"
      :org="org"
      :pattern="existingReposPrompt.pattern"
      :teams="existingReposPrompt.teams"
      :confirm-label="existingReposPrompt.confirmLabel"
      @close="answerExistingRepos(false)"
      @confirm="answerExistingRepos"
    />

    <!-- AUTOMATED CHECKS -->
    <AutogradeModal
      v-if="showAutogradeModal"
      :config="{
        execution_environment: form.autograde_execution_environment,
        tests: form.autograde_tests,
      }"
      :submission-marker="form.submission_marker_value || ''"
      :submission-marker-multiple="form.submission_marker_multiple !== false"
      :submission-marker-max-hand-ins="readMaxHandIns(Number(form.submission_marker_max_hand_ins))"
      :template-grades="form.template_grades"
      :template="templateWorkflow"
      @check-template="checkTemplateWorkflow"
      @add-starter-workflow="addStarterWorkflow"
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
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRoute, useRouter } from 'vue-router'
import { config } from '../lib/config.js'
// deployment.yml's display timezone, so the form default, the placeholder and
// the value buildDoc() writes are one fact rather than three literals.
import { TIMEZONE, INSTITUTION_SHORT, CLAIM_ADDRESS_FORMAT } from '../lib/deployment.js'
import { REQUIRE_CLAIM_LABEL, ACCEPT_IDENTITY_QUESTION } from '../lib/claim.js'
import { getToken, getUser, isAuthenticated } from '../lib/auth.js'
import { markStaff } from '../lib/org-session.js'
import { commitFile, commitFiles, createBlankStarterRepository, deleteFile, dispatchWorkflowRun, getRepo, ghApi, triggerWorkflow, listRepoDir, listOrgRepos, getRepoContent, explainDispatchFailure, listOrgTemplates, validateTemplateRepository } from '../lib/api.js'
import { blankStarterName, blankStarterFailure } from '../lib/blank-starter.js'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { validateAgainst } from '../lib/validate.js'
import { publishedSaveWorkflow, writeReachesStudentPage } from '../lib/publish.js'
import { republishStudentPages } from '../lib/student-pages.js'
import { brokerRepoName } from '../../../lib/broker-repo.mjs'
import { readMaxHandIns, submissionBranch } from '../../../lib/submission-marker.mjs'
import { templateChanged, templateChangeNotice } from '../lib/template-change.js'
import { planPermissionApply, applyStudentPermission } from '../../../lib/permission-change.mjs'
import {
  assignmentPath,
  repositoriesDir,
  overridesDir,
  unlockedDir,
  lockdownRecordPath,
  reportPath,
  reportCsvPath,
  gradingSummaryPath,
  retiredDir,
  retiredManifestPath,
  DASHBOARD_PATH,
  ASSIGNMENT_OWNED_DIRS,
} from '../../../lib/control-layout.mjs'
import { archiveRepoName } from '../../../lib/archive-repo.mjs'
import { buildRetiredManifest } from '../../../lib/retired-manifest.mjs'
import {
  deleteWaitsForReport,
  readReportFreshness,
  STALE_REPORT_REFUSAL,
  UNKNOWN_REPORT_REFUSAL,
  UNREADABLE_REPORT_REFUSAL,
} from '../../../lib/report-freshness.mjs'
// Deleting an assignment has to take its organization ruleset with it: unlike a
// repository one, it does not live in a student repository and would be left
// behind, named after an assignment that no longer exists.
import { findOrgSubmissionLock } from '../../../lib/submission-lock.mjs'
import {
  collidingRepoNames,
  retiredPatternClash,
  patternProblem,
  clashingAssignments,
  assignmentCollisions,
  blockingFindings,
  noteFindings,
  collisionRemedies,
  COLLISION_LEAD,
  COLLISION_REMEDY_LEAD,
  COLLISION_WARNING_LEAD,
} from '../lib/assignment-collision.js'
import { formatAssignmentValidationError } from '../lib/validation-messages.js'
import { summariseGrading } from '../lib/autograde.js'
import { assignmentFacts } from '../../../lib/dashboard-aggregate.mjs'
import {
  STARTER_PATH,
  buildStarterWorkflow,
  isGradingWorkflow,
  readGateMessage,
} from '../lib/starter-workflow.js'
// One implementation of the document this panel writes, and of the
// datetime-local <-> UTC conversion around it. See assignment-doc.js for what a
// second, hand-maintained copy had already quietly dropped.
import { buildAssignmentDoc, localToUtc, utcToLocalInput } from '../lib/assignment-doc.js'
import { normalizeRepoRef } from '../lib/github-repo-ref.js'
import { toast } from '../lib/toast.js'
import { askConfirm, askDiscard } from '../lib/confirm.js'
import { usePublishWatch } from '../composables/usePublishWatch.js'
import { GITHUB_STATUS_URL, USUAL_WAIT, publishBarText, publishRunIdFrom, publishStageMessage, publishSteps } from '../lib/publish-progress.js'
import { dateReadout } from '../lib/date-readout.js'
import { formatDate } from '../lib/format.js'
import { studentPageBarText, studentPageLine, studentPageSteps } from '../lib/student-page-status.js'
import { findPublicTextViolation, publicTextMessage } from '../../../lib/public-text.mjs'
import { deadlineIsImminent } from '../../../lib/sentinel-window.mjs'
import { republishRefusal } from '../../../lib/finished-assignment.mjs'
import { everPublished } from '../lib/state-actions.js'
import {
  templateUsable,
  templateSourceMessage,
  resolveTemplatePin,
  templatePinMessage,
  submissionBranchProvisioned,
  templateHasCommits,
  FOREIGN_PRIVATE,
  EMPTY_TEMPLATE,
} from '../../../lib/template-source.mjs'
import ControlRepoUnreadable from '../components/ControlRepoUnreadable.vue'
import HelpButton from '../components/HelpButton.vue'
import AuthCard from '../components/AuthCard.vue'
import SystemHealthModal from '../components/SystemHealthModal.vue'
import SeedTeamsModal from '../components/SeedTeamsModal.vue'
import AutogradeModal from '../components/AutogradeModal.vue'
import DeleteAssignmentModal from '../components/DeleteAssignmentModal.vue'
import ExistingReposModal from '../components/ExistingReposModal.vue'
import RepublishBrokerModal from '../components/RepublishBrokerModal.vue'
import Icon from '../components/Icon.vue'
// Shared with acceptance/accept.mjs and pages/generate.mjs so the three cannot
// disagree about which mode an assignment is actually in.
import { normalizeRosterMode, rosterGatesAcceptance, rosterMatchesLogin } from '../../../lib/roster-mode.mjs'
import { classGroupChips, studentInClassGroup, normalizeClassGroup } from '../lib/class-groups.js'
import { cohortIdentity, rosterIdentities, normalizeCohortEntry, danglingCohortEntries } from '../lib/cohort.js'
import { DEFAULT_MAX_TEAM_SIZE, maxTeamSize as teamMaxSize } from '../../../lib/group-config.mjs'
import { requiresJoinCode } from '../../../lib/team-join-code.mjs'
import { readRoster } from '../lib/roster-read.js'
import { classifyUnreadableControlRepo } from '../lib/control-repo-access.js'

// THE EDITOR FOR ONE ASSIGNMENT (BETA-UX.md, 2026-10-02). It was the Admin
// page: a list of every assignment beside this editor. Now it is an
// assignment's Settings tab (`mode: 'single'`, under the same header as its
// Progress, Teams and Grading tabs) or a new assignment (`mode: 'new'`). The
// list is gone; the assignments are listed once, on the Assignments tab.
const props = defineProps({
  org: { type: String, required: true },
  assignmentId: { type: String, default: '' },
  mode: { type: String, default: 'single', validator: (v) => ['single', 'new'].includes(v) },
  /** Inside the assignment page as its Settings tab (BETA-UX.md, 2026-10-03). */
  embedded: { type: Boolean, default: false },
  /**
   * Do students see what is saved - worked out by the page around the editor
   * (composables/useStudentPageStatus.js), shown here as steps. Null outside it.
   */
  studentPage: { type: Object, default: null },
})
// `changed`: the stored document is different now (saved, state changed,
// published), so the page around the editor reads it again for its header.
// `regenerated`: the invitation secret passed with it was just retired; the
// page's Invite link must stop offering it until the new one is written.
// `student-page-failed`: starting the student page update after a save failed;
// `update-student-page`: the lecturer asked for it again.
const emit = defineEmits(['changed', 'regenerated', 'save-primary', 'unsaved', 'student-page-failed', 'update-student-page'])
const route = useRoute()
const router = useRouter()

// ---------------------------------------------------------------- auth

// Device-flow sign-in for deep links opened without a session. Failures
// render inside the auth card (authError), never a misleading empty state.
const user = ref(getUser())

async function onAuthenticated(authedUser) {
  user.value = authedUser
  await Promise.all([loadAssignments(), loadTemplates(), loadRoster()])
}


// ---------------------------------------------------------------- the org roster

// Read here for the form's numbers and the cohort picker, edited on the Roster
// page (RosterView). This view used to read them off a mounted roster tab; on
// separate pages each reads the file, through the same function.
const rosterDoc = ref(null)
// True until the first read settles, so the form says "not known yet" rather
// than "nobody can accept" for the moment before it.
const rosterLoading = ref(true)
const rosterReadFailed = ref(false)
async function loadRoster() {
  rosterLoading.value = true
  rosterReadFailed.value = false
  try {
    rosterDoc.value = (await readRoster(getToken(), props.org)).doc
  } catch (e) {
    rosterDoc.value = null
    rosterReadFailed.value = true
    console.error('Failed to load roster', e)
  } finally {
    rosterLoading.value = false
  }
}

// `#roster` is a bookmark from when the roster was a tab on this page.
const LEGACY_ROSTER_HASH = '#roster'

// ---------------------------------------------------------------- state

const assignments = ref([])
const loadingList = ref(true)
const assignmentsError = ref(null)
// Why the control repository answered 404, when it did - control-repo-access.js.
const controlRepoAccess = ref(null)
const controlRepoUnreadable = computed(() => assignmentsError.value === 'no-control-repo')
const templates = ref([])
const loadingTemplates = ref(false)
const templatesError = ref(null)
const editing = ref(null) // current assignment being edited (null = none)
const manualSlug = ref(false)
// The slug is shown as a derived value, not asked for. This opens the input for
// the two reasons a lecturer would ever override it: a collision, or a broker
// repository name that would be absurdly long. It stays open once opened -
// somebody who went looking for it is editing it.
const slugEditing = ref(false)
// The repository name pattern, the same way: a line until asked for, or until
// it carries an error a lecturer has to fix in the box.
const patternEditing = ref(false)
// The description is optional and rarely written, so it is folded away until
// asked for. Not a `<details>`: opening one leaves focus on the summary, and
// the point of clicking "Add a description" is to type.
const descriptionOpen = ref(false)
const descriptionEl = ref(null)
async function openDescription() {
  descriptionOpen.value = true
  await nextTick()
  descriptionEl.value?.focus()
}
const saving = ref(false)
const publishing = ref(false)
const showRepublishModal = ref(false)
// Republish reuses the invitation by default; this is the opt-in that retires it.
const regenerateInvite = ref(false)
const showDiagnosticModal = ref(false)
const showSeedModal = ref(false)
const deleting = ref(false)

// '' | 'watching' | 'ready' | 'timeout' - post-publish broker watch


// Live infrastructure check state for published assignments

function onTeamsSeeded() {
  // The modal already reported the result; a second toast here just stacked on
  // top of it. Refresh the list so the assignment's team count is current.
  loadAssignments()
}

function onDiagnosticFixed({ type, runId = null }) {
  // Only a publish has a publish to follow. A Pages-only redeploy started one
  // too, which read "checking with GitHub" for half an hour over no publish.
  if (type === 'publish_broker') {
    startPublishWatch({ runId })
  } else if (type === 'mark_template' || type === 'make_broker_public') {
    verifyLiveInfrastructure(form.value.id)
  }
}

function onDiagnosticNavigate(tabName) {
  if (tabName === 'roster') {
    router.push({ name: 'roster', params: { org: props.org } })
  }
}

const form = ref(emptyForm())

// Snapshot of the form as of the last load/save. Anything different means
// unsaved edits - guard list navigation and Cancel against silent loss.
const savedSnapshot = ref('')
// What a lecturer can edit, and nothing else. The `invite_*` fields are the
// publish workflow's: no control writes them, and Regenerate clears them in the
// form so the retired link cannot be copied - which made an untouched form
// read as edited, so leaving asked "discard?" about nothing and Save lit up.
function editableFingerprint(f) {
  const own = {}
  for (const [k, v] of Object.entries(f)) if (!k.startsWith('invite_')) own[k] = v
  return JSON.stringify(own)
}
function snapshotForm() {
  savedSnapshot.value = editableFingerprint(form.value)
}
function hasUnsavedEdits() {
  return !!editing.value && editableFingerprint(form.value) !== savedSnapshot.value
}
// A promise of the answer (lib/confirm.js): route guards return it and
// vue-router waits; every other caller awaits it.
function confirmDiscard() {
  if (!hasUnsavedEdits()) return Promise.resolve(true)
  return askDiscard('Your changes to this assignment are not saved.')
}
// Reactive, for what the screen says about it (the bar, the tab's dot).
const unsaved = computed(() => hasUnsavedEdits())

// Publishing dispatches a workflow and returns; whether the broker, the
// invitation and the acceptance card have actually appeared is a poll, and it
// lives in composables/usePublishWatch.js. It clears its own timer on unmount -
// which this view never did, so navigating away mid-publish left a 10-second
// poll running for the life of the tab.
const {
  publishWatch,
  publishProgress,
  publishMinutes,
  liveCheckLoading,
  brokerExists,
  pagesLive,
  verifyLiveInfrastructure,
  startPublishWatch,
  stopPublishWatch,
} = usePublishWatch({
  org: () => props.org,
  form,
  hasUnsavedEdits,
  snapshotForm,
  onReady: (msg) => toast.success(msg),
})
// What the publishing line says: the step GitHub is at, read from its runs.
const publishProgressMessage = computed(() => publishStageMessage(publishProgress.value))
// The steps, at the top; and the short version in the bar at the bottom of the
// window, where Save & publish was pressed (asked 2026-10-08: a lecturer at the
// bottom of the form saw nothing happen, and did not know which step it was in
// or how long to wait). lib/publish-progress.js.
// A finished, failed or later step's dot (DESIGN.md §4), and its state in words.
const STEP_DOT = { done: 'dot-success', failed: 'dot-danger', todo: 'dot-neutral' }
const STEP_WORDS = { done: 'done', active: 'in progress', failed: 'did not finish', todo: 'not yet' }
const publishStepList = computed(() =>
  publishSteps(publishProgress.value, { ready: publishWatch.value === 'ready' }))
const publishBarStatus = computed(() => {
  if (['watching', 'ready', 'failed'].includes(publishWatch.value)) {
    return publishBarText(publishProgress.value, { ready: publishWatch.value === 'ready', minutesSoFar: publishMinutes.value })
  }
  // A save of a live assignment: getting it to students, in the bar too.
  return studentPageShown.value ? studentPageBarText(props.studentPage) : ''
})

// Do students see what is saved (props.studentPage): shown at the top of the
// tab whenever it is known and no publish is being followed there instead.
const studentPageShown = computed(() =>
  ['updating', 'stuck', 'failed', 'current'].includes(props.studentPage?.state) &&
  !['watching', 'ready', 'failed'].includes(publishWatch.value))
const studentPageStepList = computed(() =>
  props.studentPage?.state === 'current' ? null : studentPageSteps(props.studentPage))
const studentPageMessage = computed(() => (props.studentPage ? studentPageLine(props.studentPage) : ''))
/** A card value in the lecturer's words: dates in 24-hour time, the rest plainly. */
function cardValue(key, value) {
  if (value == null || value === '') return 'nothing'
  if (key === 'opens_at' || key === 'deadline_at') return formatDate(value, form.value.timezone || null)
  if (typeof value === 'boolean') return value ? 'yes' : 'no'
  if (typeof value === 'object') return JSON.stringify(value)
  const s = String(value)
  return s.length > 60 ? `"${s.slice(0, 57)}..."` : `"${s}"`
}

// The page around the editor reads the assignment for its header (state,
// deadline, Invite link). A publish going live, and an invitation the watch
// picked up, change what that header should say - so it reads again.
watch(publishWatch, (state) => { if (state === 'ready') emit('changed') })
watch(() => form.value.invite_key, (key, before) => { if (key && key !== before) emit('changed') })

// The org's real class groups, and what restricting to some of them would cost.
//
// The picker appears ONLY when both halves are true: the roster is actually the
// gate (under `open` it decides nothing, so a cohort filter there would be a
// control that does nothing - DESIGN.md §1.5), and the roster genuinely has
// groups (offering a distinction this org has not made is worse than offering
// none).
const rosterStudents = computed(() =>
  (Array.isArray(rosterDoc.value?.students) ? rosterDoc.value.students : []))
// It needs a roster that gates and a roster with somebody in it. An empty roster
// under `enforced` already has a louder warning on the mode itself - nobody can
// accept at all - and an empty picker underneath it would bury it.
const showCohortPicker = computed(() =>
  rosterGatesAcceptance(form.value.roster_mode) && rosterStudents.value.length > 0)

/**
 * Offered only where it would do something.
 *
 * A published assignment that admits everyone has nothing to add TO - the
 * picker's own empty state already says so - and offering the action there
 * would send a lecturer to a control that cannot change anything.
 */
const showAddStudents = computed(() =>
  cohortFirst.value && showCohortPicker.value && (form.value.cohort || []).length > 0)

/** Put the picker on screen and land in the search box. */
async function openAddStudents() {
  await nextTick()
  const list = document.querySelector('.cohort-list')
  // Scroll the LIST, not the field: the field's label is what a browser lands
  // on and it leaves the rows below the fold on a short window.
  list?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  document.querySelector('.cohort-search')?.focus({ preventScroll: true })
}

// --- the cohort picker ---------------------------------------------------
//
// `form.cohort` is the stored answer, in the same identity strings lib/cohort.mjs
// reads. Everything below is the way to build it: filter chips, a search box,
// and a checkbox per roster row.

/** null = every group; "" = the ungrouped; otherwise the lecturer's spelling. */
const cohortFilter = ref(null)
const cohortSearch = ref('')

// The two display rules moved into lib/class-groups.mjs when the Roster tab
// grew the same filter row - they were about to be copied, which is how one
// surface comes to offer a chip the other hides.
const cohortGroupCounts = computed(() => classGroupChips(rosterStudents.value))

/** The identity a NEW pick is stored as. Never re-spelled here - lib/cohort.mjs owns it. */
const cohortKey = (student) => cohortIdentity(student)

/**
 * WHAT THIS ROW ACTUALLY KNOWS ABOUT THE PERSON, in the primary cell.
 *
 * It printed `full_name || 'Not yet identified'`, so a roster of rows promoted
 * from acceptances - which carry a login and nothing else - rendered six
 * identical placeholders in the widest, brightest column while the one thing
 * that DID identify each of them sat last and muted. The placeholder outranked
 * the data, and it was not even true: `@afx42` identifies somebody.
 *
 * Name, then address, then account. A name is what a lecturer recognises; an
 * address is what they were handed; a login is what GitHub gave us. Only a row
 * carrying none of the three is genuinely unidentified.
 *
 * THE ROSTER TAB ANSWERS THIS DIFFERENTLY ON PURPOSE - it is not a fork left
 * half-done. This is a picker: recognise the person, tick them, and a column
 * nobody fills is noise. The Roster tab is the complete view, where the job is
 * to SEE what is missing and fill it in, so it keeps its columns and says
 * "Name unknown" beside an address rather than hiding the gap. Same data,
 * different question. DESIGN.md 1.7.
 */
function cohortPrimary(s) {
  const name = String(s?.full_name ?? '').trim()
  if (name) return name
  const email = String(s?.email ?? '').trim()
  if (email) return email
  const login = String(s?.github_login ?? '').trim()
  if (login) return `@${login}`
  return 'Not yet identified'
}

/**
 * The account, and only when it is not already the primary.
 *
 * `@IlkayDuranPXL` beside `@IlkayDuranPXL` is the login twice - the same
 * duplication DESIGN.md 1.7 names for a column heading repeated in its cells.
 */
function cohortSecondary(s) {
  const login = String(s?.github_login ?? '').trim()
  if (!login) return ''
  return cohortPrimary(s) === `@${login}` ? '' : `@${login}`
}

// A COLUMN NOBODY FILLS IS A COLUMN OF DASHES. Measured against the whole
// roster rather than the filtered view, so the table does not change shape
// under a lecturer while they click between chips.
const cohortShowsNumber = computed(() =>
  rosterStudents.value.some((s) => String(s?.student_number ?? '').trim()))
const cohortShowsGroup = computed(() =>
  rosterStudents.value.some((s) => String(s?.class_group ?? '').trim()))
const cohortShowsAccount = computed(() => rosterStudents.value.some((s) => cohortSecondary(s)))

/**
 * The row's grid, built from the columns that are actually rendered.
 *
 * Derived rather than written out per combination: five columns give eight
 * templates, and the one nobody tested is the one a lecturer gets.
 */
const cohortRowStyle = computed(() => {
  const cols = ['auto']
  if (cohortShowsNumber.value) cols.push('6.5rem')
  cols.push('minmax(0, 1fr)')
  if (cohortShowsGroup.value) cols.push('5rem')
  if (cohortShowsAccount.value) cols.push('minmax(0, 9rem)')
  return { gridTemplateColumns: cols.join(' ') }
})

/**
 * Is this student in the cohort? ANY identity they carry, exactly as the gate asks.
 *
 * The checkbox used to ask `cohortSelected.has(cohortKey(s))` - one canonical
 * key - while `assignmentAdmitsStudent` matched on either. So a row promoted
 * from an acceptance and stored as `login:ella-dev`, who later gained a student
 * number through a CSV import, rendered UNTICKED on an assignment she was
 * admitted to: the screen said one thing and the gate did another, which is the
 * exact failure `rosterIdentities` was written to prevent. Applying it to the
 * gate and not to the picker got the halves out of step again.
 */
const isPicked = (student) =>
  rosterIdentities(student).some((k) => cohortSelected.value.has(k))

/** Already in the published cohort - same any-identity rule, same reason. */
const isLocked = (student) =>
  rosterIdentities(student).some((k) => cohortLocked.value.has(k))

// A Set of what is ticked, so a 200-row list does not run `includes` per row per
// keystroke. Derived from the form rather than held beside it: one source of
// truth, and an assignment loaded for edit populates it for free.
const cohortSelected = computed(() => new Set(
  (form.value.cohort || []).map((e) => normalizeCohortEntry(e)).filter(Boolean),
))

/**
 * Show only what is ticked.
 *
 * "A whole class plus these two" is the case this picker exists for, and
 * building it means moving between filters - so there has to be a way to read
 * back what you actually assembled without trusting a count. Separate from the
 * group filter rather than a value inside it: it answers a different question
 * and it survives switching between classes.
 */
const cohortShowSelected = ref(false)

const cohortVisible = computed(() => {
  const q = cohortSearch.value.trim().toLowerCase()
  const rows = rosterStudents.value.filter((s) => {
    if (cohortShowSelected.value && !isPicked(s)) return false
    if (!cohortShowSelected.value && cohortFilter.value !== null && !studentInClassGroup(s, cohortFilter.value)) return false
    if (!q) return true
    return [s.full_name, s.student_number, s.github_login, s.email]
      .some((v) => typeof v === 'string' && v.toLowerCase().includes(q))
  })
  // BY GROUP, THEN BY NAME. Roster order is import order, so on an unfiltered
  // list the sections interleave and there is no way to read down a class -
  // which is the thing a lecturer is most often trying to do here. The
  // ungrouped sort last, where a leftover reads as a leftover rather than as
  // the top of the list.
  return [...rows].sort((a, b) => {
    const ga = normalizeClassGroup(a.class_group)
    const gb = normalizeClassGroup(b.class_group)
    if (ga !== gb) {
      if (!ga) return 1
      if (!gb) return -1
      return ga.localeCompare(gb)
    }
    return String(a.full_name || a.student_number || a.github_login || '')
      .localeCompare(String(b.full_name || b.student_number || b.github_login || ''))
  })
})

/** The group being filtered by, in the lecturer's own spelling. */
const cohortFilterLabel = computed(() => {
  if (cohortFilter.value === null) return null
  return cohortFilter.value === '' ? 'No group' : cohortFilter.value
})

/**
 * A filter that has selected nothing, while looking like it has.
 *
 * Clicking a class chip fills it blue and leaves exactly that class on screen,
 * every box unticked - so it reads as "this assignment is for 1TIN-A" when the
 * assignment is still open to the whole roster. Said out loud at the moment it
 * is true, rather than left to a count in the corner.
 */
const cohortFilteredButEmpty = computed(() =>
  !cohortShowSelected.value && cohortFilter.value !== null && cohortSelected.value.size === 0)

function showSelectedOnly() {
  cohortShowSelected.value = true
  cohortSearch.value = ''
}

function showGroup(group) {
  cohortShowSelected.value = false
  cohortSearch.value = ''
  cohortFilter.value = group
}

/**
 * SEARCHING LOOKS ACROSS EVERYONE, so the chip stands down.
 *
 * The two used to compose, which made the flow this picker exists for a dead
 * end: take 1TIN-A, then search for the two students from another class you
 * also want - and find nothing, because the class filter was still on. Someone
 * typing a name knows who they are looking for. Clearing the chip rather than
 * silently ignoring it, so the screen says which list is being searched.
 */
watch(cohortSearch, (q) => {
  if (!q.trim()) return
  cohortFilter.value = null
  cohortShowSelected.value = false
})

/**
 * Roster students this assignment is not for.
 *
 * The snapshot's one real cost: a student imported next week is simply absent,
 * and without this nothing says so until they cannot accept. It counts against
 * what is TICKED rather than what is published, so ticking someone clears them
 * from the count as you go.
 */
/**
 * Cohort entries that match nobody on the roster any more.
 *
 * A student removed from the roster leaves their identity behind in every
 * assignment that named them - deliberately, because the cohort is a record of
 * who the assignment was for. But then "22 selected" sits over twenty rows, and
 * without this the difference is invisible: the reader assumes they miscounted.
 */
const cohortDangling = computed(() =>
  danglingCohortEntries({ cohort: form.value.cohort }, rosterStudents.value))

const cohortMissing = computed(() => {
  if (!cohortSelected.value.size) return 0
  return rosterStudents.value.filter((s) => {
    const key = cohortKey(s)
    return key && !cohortSelected.value.has(key)
  }).length
})

/** Picking more students than the cap means refusals - say so before publishing. */
const cohortOverCap = computed(() => {
  const cap = Number(form.value.max_acceptances) || 0
  return cap > 0 && cohortSelected.value.size > cap
})

function writeCohort(keys) {
  form.value.cohort = [...keys]
  // NO `cohort_groups`. It recorded the groups REPRESENTED in the selection,
  // which is not the question anyone asks: tick three students who happen to be
  // in 3A and the card read "3A" for an assignment that is for three people out
  // of twenty. A label that over-claims is the status line DESIGN.md §1.5
  // forbids, and the honest version - "only when the whole class is taken" -
  // goes stale the moment somebody joins that class. The count is the truth.

  // Viewing the selection and emptying it leaves a filter with no chip and a
  // list with nothing in it. Fall back rather than strand.
  if (cohortShowSelected.value && keys.size === 0) cohortShowSelected.value = false
}

/**
 * The cohort as it stands on a published assignment - locked, and add-only.
 *
 * ADD ONLY, and the reason is not caution. Removing a student who has already
 * accepted does not un-provision their repository, un-invite them or delete
 * their work, so a control that appeared to take them out of the assignment
 * would describe behaviour the system does not have (DESIGN.md §1.5). Empty on
 * a draft, where nobody can have accepted anything yet and the whole selection
 * is still the lecturer's to change.
 */
const cohortLocked = computed(() => new Set(
  (form.value._cohort_published || []).map((e) => normalizeCohortEntry(e)).filter(Boolean),
))

/**
 * A PUBLISHED ASSIGNMENT THAT ADMITS EVERYONE KEEPS ADMITTING EVERYONE.
 *
 * The add-only lock only engages once a cohort exists, which is the case that
 * was already narrow - so the picker happily narrowed a live assignment from
 * the whole roster down to whoever was ticked, and every other student, some of
 * whom had already accepted, met `rejected:not-in-cohort` on their next visit.
 * That is the same act the lock exists to prevent, in its most destructive
 * form, and it was the one direction left open.
 *
 * Closed and archived are editable: nobody can accept any more, so narrowing
 * changes a record rather than shutting a door. That is also the way back for a
 * lecturer who published too wide - close it, narrow it, reopen.
 */
const cohortReadOnly = computed(() =>
  form.value.state === 'published' && (form.value._cohort_published || []).length === 0 && !isNew.value)

function toggleCohortStudent(student) {
  const key = cohortKey(student)
  if (!key || cohortReadOnly.value) return
  const ids = rosterIdentities(student)
  if (ids.some((k) => cohortLocked.value.has(k))) return
  const next = new Set(cohortSelected.value)
  // Untick removes EVERY identity this row carries, not just the canonical one:
  // a cohort written before a CSV import gave the student a number holds their
  // login, and removing only `num:` would leave them silently admitted.
  if (isPicked(student)) for (const k of ids) next.delete(k)
  else next.add(key)
  writeCohort(next)
}

/** Rows on screen this lecturer can still change - locked ones are not theirs. */
const shownTogglable = computed(() => cohortVisible.value.filter((s) => {
  const ids = rosterIdentities(s)
  return ids.length > 0 && !ids.some((k) => cohortLocked.value.has(k))
}))

const allShownSelected = computed(() =>
  shownTogglable.value.length > 0 && shownTogglable.value.every((s) => isPicked(s)))

const someShownSelected = computed(() => shownTogglable.value.some((s) => isPicked(s)))

/** Names what the box will take, because "Select all" never says all of what. */
const selectAllLabel = computed(() => {
  const n = cohortVisible.value.length
  if (cohortShowSelected.value) return `All ${n} selected`
  if (cohortSearch.value.trim()) return `Select these ${n}`
  if (cohortFilter.value === null) return `Select all ${n} on the roster`
  return `Select all ${n} in ${cohortFilterLabel.value}`
})

function toggleAllShown() {
  if (cohortReadOnly.value) return
  const next = new Set(cohortSelected.value)
  // Ticking takes everything shown; unticking gives back only what is shown,
  // so narrowing to a class and unticking cannot empty a selection built
  // elsewhere.
  if (allShownSelected.value) {
    for (const s of shownTogglable.value) for (const k of rosterIdentities(s)) next.delete(k)
  } else {
    for (const s of shownTogglable.value) next.add(cohortKey(s))
  }
  writeCohort(next)
}


function clearCohort() {
  if (cohortReadOnly.value) return
  // A published cohort survives Clear: those students keep their place, and
  // clearing to nothing would mean "everyone", which is not a thing this button
  // is allowed to do to a live assignment.
  writeCohort(new Set(cohortLocked.value))
}

// null means "not known": still loading, or the read failed. A roster file that
// does not exist is 0 - that is a known fact, and it is the one that stops
// every acceptance under `roster_mode: enforced`.
const rosterCount = computed(() =>
  (rosterLoading.value || rosterReadFailed.value ? null : rosterStudents.value.length))
// How many of them can actually be matched by accept.mjs, which reads
// github_login and nothing else.
const rosterLinked = computed(() =>
  rosterStudents.value.filter((s) => typeof s?.github_login === 'string' && s.github_login.trim()).length)

// In-page navigation is guarded via confirmDiscard(); guard the two exits
// that used to lose edits silently - leaving the route (e.g. the Dashboard
// back button) and closing/refreshing the tab.
// Embedded, the assignment page asks on the way out (it owns the route, and
// switching its tabs keeps this editor and its edits); a new assignment asks
// for itself.
if (!props.embedded) {
  onBeforeRouteLeave(() => confirmDiscard())
  onBeforeRouteUpdate((to, from) => to.params.assignmentId === from.params.assignmentId || confirmDiscard())
}
defineExpose({ hasUnsavedEdits: () => hasUnsavedEdits(), reloadFromStored })

/**
 * The assignment page wrote the document behind this form - the cap's quick
 * bump in its banner. Kept mounted across tabs, the form still held the old
 * value, and the next Save or state change rebuilt the document from it: +10
 * on the banner, then Save on Settings, and the cap was back at 30 with
 * nothing on screen saying so (review 2026-10-06).
 *
 * With nothing edited here the form is read again from what is stored. With
 * edits waiting it is not - that would throw them away - and only the fields
 * the page changed are carried in, into the form AND its snapshot, so they
 * neither revert at Save nor look like the lecturer's own edit.
 *
 * @param {Record<string, unknown>} changed form fields the page wrote, as the form holds them
 */
async function reloadFromStored(changed = {}) {
  if (!editing.value || isNew.value) return
  if (!hasUnsavedEdits()) {
    await loadAssignments()
    const a = assignments.value.find((x) => x.id === editing.value?.id)
    if (a) await editAssignment(a, { confirmed: true })
    return
  }
  const snapshot = JSON.parse(savedSnapshot.value || '{}')
  for (const [k, v] of Object.entries(changed)) {
    // A field the lecturer has edited here keeps their value, and stays an
    // edit waiting (it now differs from what is stored); only an untouched
    // one takes the page's.
    const edited = JSON.stringify(form.value[k] ?? null) !== JSON.stringify(snapshot[k] ?? null)
    if (!edited) form.value[k] = v
    snapshot[k] = v
  }
  savedSnapshot.value = JSON.stringify(snapshot)
}
function onBeforeUnload(e) {
  if (hasUnsavedEdits()) {
    e.preventDefault()
    e.returnValue = ''
  }
}

const isNew = computed(() => editing.value && editing.value.__new === true)

// WHICH BUTTON IS THE SOLID ONE (DESIGN.md §1.2: one per view). On the
// Settings tab of a live assignment with nothing edited there is nothing to
// save, and handing out the link is still the thing to do - so the header's
// Invite link stays solid, as on every other tab, and Save takes over the
// moment a field changes. Anywhere else (a new assignment, a draft, a closed
// one) saving or publishing is the next step whether or not anything changed.
const saveIsPrimary = computed(() =>
  !props.embedded || isNew.value || form.value.state !== 'published' || unsaved.value)
// CLOSED AND ARCHIVED ARE SAVED AS THEY ARE. Their one save button was "Save &
// publish", so fixing a typo in a closed exam's grading published it again -
// and when it was finished, the refused publish turned it into a draft.
// Reopening is the state menu's Reopen, asked as such.
const saveKeepsState = computed(() =>
  !isNew.value && (form.value.state === 'closed' || form.value.state === 'archived'))
const saveLabel = computed(() =>
  (form.value.state === 'published' || saveKeepsState.value ? 'Save' : 'Save & publish'))
watch(saveIsPrimary, (primary) => emit('save-primary', primary), { immediate: true })
// The assignment page marks its Settings tab with it, so an edit left behind
// on a look at Progress is visible from there.
watch(unsaved, (u) => emit('unsaved', u), { immediate: true })

// The assignment page's state button (lib/state-actions.js), arriving as
// `?action=` (applyRouteIntent). Every one of these was a button in this
// editor's Lifecycle section and still runs the same function, with its own
// confirmation. "Lock everyone out now" is the Progress tab's own dialog and
// never comes here. `regenerate` is the Invite link menu's Regenerate link.
function runStateAction(key) {
  // A state change writes the document, and the document is built from the
  // form - so with edits pending it saved them too, behind a confirm that
  // asked only about the state. One thing at a time: the edits are saved or
  // cancelled first, by the bar right below (decided 2026-10-03). Publishing
  // is not refused: it is "Save & publish", saving is what it says.
  if (['close', 'draft', 'archive'].includes(key) && hasUnsavedEdits()) {
    toast.error('You have unsaved changes in Settings. Save or cancel them first, then change the state.')
    return
  }
  switch (key) {
    case 'regenerate':
      return openRegenerate()
    case 'publish':
    case 'reopen':
      return handlePublishClick()
    case 'close':
      return setState('closed')
    case 'draft':
      return setState('draft')
    case 'archive':
      return setState('archived')
    case 'delete-draft':
      return deleteDraft()
    case 'delete':
      showDeleteModal.value = true
      return
    case 'edit-deadline':
      return scrollToSection('settings-schedule')
  }
}

// A fieldset of the form, brought into view. Advanced is a disclosure, and
// jumping to it shut would land on one line with nothing under it.
async function scrollToSection(id) {
  await nextTick()
  const el = document.getElementById(id)
  if (!el) return
  if (el.tagName === 'DETAILS') el.open = true
  el.scrollIntoView({ block: 'start' })
  currentSection.value = id
  // The section asked for stays the lit one until the lecturer scrolls: one
  // near the end cannot reach the top of the window, and the page's own
  // reading of where it stands would light a neighbour instead.
  jumpedTo = id
}

// --- the section list beside the form ---------------------------------------

const formShown = computed(() =>
  !!editing.value && !loadingList.value && !assignmentsError.value)

// In the order the form renders them. Broker is there only where the form
// draws it (a published assignment), so the list never names a section that
// is not on the page.
const sectionNav = computed(() => [
  { id: 'settings-basics', label: 'Basics' },
  { id: 'settings-schedule', label: 'Schedule' },
  { id: 'settings-students', label: 'Students' },
  { id: 'settings-grading', label: 'Grading' },
  { id: 'settings-advanced', label: 'Advanced' },
  ...(!isNew.value && form.value.state === 'published' ? [{ id: 'settings-lifecycle', label: 'Broker' }] : []),
])

// The section on screen: the last one whose top has scrolled past the sticky
// header. Read from the page on scroll, never stored per section, so a section
// that appears or goes (Broker) cannot leave a stale answer behind.
const currentSection = ref('settings-basics')
let sectionFrame = 0
let jumpedTo = ''
// A scroll the lecturer makes (wheel, touch, keys) ends a jump's hold; the
// scroll a jump itself causes does not.
function releaseJump() { jumpedTo = '' }
const USER_SCROLL_EVENTS = ['wheel', 'touchmove', 'keydown']
function trackSection() {
  if (jumpedTo || sectionFrame) return
  sectionFrame = requestAnimationFrame(() => {
    sectionFrame = 0
    // The Settings tab is kept mounted and hidden on the other tabs, where
    // every section measures zero and would all count as scrolled past.
    if (!document.getElementById(sectionNav.value[0]?.id)?.offsetParent) return
    const line = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sticky-top')) || 0
    let current = sectionNav.value[0]?.id
    for (const s of sectionNav.value) {
      const el = document.getElementById(s.id)
      if (el && el.getBoundingClientRect().top <= line + 8) current = s.id
    }
    // At the bottom of the page the last section may never reach the line.
    if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2) {
      current = sectionNav.value.at(-1)?.id
    }
    if (current) currentSection.value = current
  })
}
onMounted(() => {
  window.addEventListener('scroll', trackSection, { passive: true })
  for (const ev of USER_SCROLL_EVENTS) window.addEventListener(ev, releaseJump, { passive: true })
})
onUnmounted(() => {
  window.removeEventListener('scroll', trackSection)
  for (const ev of USER_SCROLL_EVENTS) window.removeEventListener(ev, releaseJump)
  if (sectionFrame) cancelAnimationFrame(sectionFrame)
})

// Where a delete, and Cancel on a new assignment, leave: the list.
function leaveEditor() {
  return router.push({ name: 'dashboard', params: { org: props.org } })
}

// A saved new assignment has an address: its page, on the Settings tab. Not
// while a Save & publish is still running - the new-assignment page goes away
// when this navigates, and a publish cut off half way is the wreck
// revertAfterFailedPublish exists for. That flow navigates when it is done,
// and says so (`publishing=<run id>`, or `1` when GitHub named no run), so the
// Settings tab picks the watch up - of that run.
let inPublishFlow = false
// The publish run the last dispatch started, as GitHub named it.
let lastPublishRunId = null
function goToSavedAssignment({ publishing = false } = {}) {
  if (props.mode !== 'new' || !editing.value || isNew.value) return
  return router.replace({
    name: 'assignment-detail',
    params: { org: props.org, assignmentId: editing.value.id },
    query: { tab: 'settings', ...(publishing ? { publishing: String(lastPublishRunId || '1') } : {}) },
  })
}

// A published or closed assignment leads with the cohort; a draft leads with
// the form, because defining it is still the job (ARCHITECTURE §10.1.1). An archived
// one keeps the form too - it is out of day-to-day tracking, so what is left
// to look at there is what it was configured to be.
const cohortFirst = computed(() =>
  !isNew.value && (form.value.state === 'published' || form.value.state === 'closed')
)

// The one republish that CANNOT keep the links alive, and it is not optional.
//
// An assignment published before signed acceptance carries a token and no
// keypair. Its next publish mints one, the broker gets INVITE_PUBKEY, and from
// that moment it refuses the legacy title - so every link handed out in the old
// format is dead, whatever the "Regenerate" box says. Two pieces of copy
// promise the opposite, and leaving them to say it on this one publish is
// DESIGN.md §1.5 exactly: the UI describing behaviour the system does not have.
//
// It is true only once, per assignment. After the migration the keypair is
// reused on every republish, the same way the nonce is.
const migratesInvitation = computed(
  () => Boolean(form.value.invite_token) && !form.value.invite_key,
)

// Rotation had no affordance outside the Actions tab, and the one place it
// belongs is beside the link it retires. handlePublishClick still resets the
// box to false: a repair republish must not break links, and only a control
// that says "Regenerate" may arrive with it ticked.
function openRegenerate() {
  regenerateInvite.value = true
  showRepublishModal.value = true
}

const manualRepositoryNamePattern = ref(false)
// Set by typing in Submission ref. Until then a NEW assignment's ref follows
// the template's default branch, the only branch a student repository gets.
const manualSubmissionRef = ref(false)
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

// The static segments under /dashboard/<org>/ (router/index.js).
const RESERVED_SLUGS = Object.freeze(['admin', 'usage', 'roster', 'organization', 'new'])

const fieldErrors = computed(() => {
  const errors = {}

  // 1. Slug/ID check
  if (!form.value.id) {
    errors.id = 'Slug is required.'
  } else {
    const slugRegex = /^[a-z0-9][a-z0-9-]{0,99}$/
    if (!slugRegex.test(form.value.id)) {
      errors.id = 'Slug must be lowercase, start with a letter/number, and contain only lowercase letters, numbers, and hyphens (max 100 characters).'
    } else if (RESERVED_SLUGS.includes(form.value.id)) {
      // Each is a route beside /dashboard/<org>/<id>, which an assignment of
      // that name could never be reached past (router/index.js).
      errors.id = `Slugs ${RESERVED_SLUGS.map((s) => `"${s}"`).join(', ')} are reserved and cannot be used.`
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
    } else {
      // A private template in another organization cannot provision, measured
      // rather than assumed (lib/template-source.mjs). Refused at SAVE because
      // every later surface is worse: publishing is silent about it, and the
      // student who accepts is the one who finds out.
      //
      // Read off the live probe, and only when the probe is about THIS
      // template - `fullName` is GitHub's canonical spelling of what was
      // asked, so a stale answer for the previous value cannot block the
      // current one. No probe yet means no finding: this check refuses what
      // was established, never what was not.
      const probe = templateValidationStatus.value
      const asked = form.value.template.trim().toLowerCase()
      if (probe?.valid && probe.blocked && String(probe.fullName || '').toLowerCase() === asked) {
        errors.template = probe.blocked.message
      }
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

  // 5. Repository Name Pattern check. The rules live in
  // lib/assignment-collision.mjs beside the matcher that reads the same
  // placeholders, so "what is a placeholder" is answered once.
  const patternIssue = patternProblem(form.value.repository_name_pattern, {
    assignmentType: form.value.assignment_type,
  })
  if (patternIssue) errors.repository_name_pattern = patternIssue

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

// The pattern's box comes out when it carries an error a lecturer has to fix
// (`patternEditing` above). Defined after fieldErrors, which a watch reads at
// once. Once the box is out it stays out: fixing the error must not swap the
// input back to a line under the cursor of somebody still typing.
const patternNeedsInput = computed(() =>
  Boolean(fieldErrors.value.repository_name_pattern) && (touchedFields.value.repository_name_pattern || !isNew.value))
watch(patternNeedsInput, (needs) => { if (needs) patternEditing.value = true })

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

  // THE FAST PATH NEVER BLURS ANYTHING. Pick a template, watch the title, slug
  // and repository name pattern fill themselves, press Save - and the blur that
  // normally triggers the collision check never happens. The gate on save still
  // holds and still refuses, but finding out at Save is finding out after the
  // point where changing the title was free.
  //
  // After nextTick, because `repository_name_pattern` is written by the
  // `form.id` watcher rather than here, and the check needs both.
  nextTick(onSlugBlur)
}

function onTemplateInput() {
  showTemplateDropdown.value = true
  activeDropdownIdx.value = -1

  // A pasted GitHub URL becomes `owner/repo` in the box, as it lands. Nothing
  // announces it: the red "Use the full name" clearing and the pre-flight badge
  // turning green are the feedback, and a toast confirming something that
  // worked is noise. See lib/github-repo-ref.js for why this is a rewrite
  // rather than a better error message (DESIGN.md §1.5).
  //
  // On input rather than on paste or on blur. `@paste` misses drag-and-drop and
  // autofill, and blur-only leaves the error on screen while the lecturer is
  // still looking at it. Typing by hand converges too, because the rewrite
  // fires only once owner AND repo are both present and the caret is already
  // at the end.
  const normalized = normalizeRepoRef(templateSearchText.value)
  if (normalized && normalized !== templateSearchText.value) {
    templateSearchText.value = normalized
  }

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
// The `template` block of the assignment currently open, as STORED. The pin is
// compared against the document, not against the form - `form.template` is
// only the `owner/repo` string, and rebuilding a pin from it is impossible.
const storedTemplate = ref(null)
let templateValidationTimer = null

// ----------------------------------------------- "students start from nothing"
//
// A lecturer with no starter code still needs a template, because `generate`
// cannot copy a repository with no commits - and the two ways that has gone
// wrong are written up in frontend/src/lib/blank-starter.js beside the live
// readings. This makes the repository they would otherwise make by hand in four
// steps on github.com, with the commit and the Template checkbox both correct
// because one API call sets them.
const creatingBlankStarter = ref(false)
const blankStarterError = ref('')

// NEW ASSIGNMENTS ONLY. On one that exists this would repoint a live template,
// and although resolveTemplatePin catches that as a replacement and warns,
// there is no reason to walk up to it: students may already hold repositories
// generated from the template being replaced.
const blankStarterRepo = computed(() => (isNew.value ? blankStarterName(form.value.id) : ''))

async function createBlankStarter() {
  // Guarded rather than only disabled: a disabled button is a rendering, and
  // this one is reachable by keyboard the instant the slug appears.
  if (!blankStarterRepo.value || creatingBlankStarter.value) return
  const name = blankStarterRepo.value
  const token = getToken()
  if (!token) return

  creatingBlankStarter.value = true
  blankStarterError.value = ''
  try {
    const res = await createBlankStarterRepository(
      token,
      props.org,
      name,
      `Starter repository for ${form.value.title || form.value.id}. Students begin from what is in here.`,
    )
    // `.ok`, never a `.catch()` - ghApi resolves on failure and rejects only on
    // a network error, which the try/finally below owns (tests/button-honesty).
    const verdict = blankStarterFailure(res, { org: props.org, name })
    if (!verdict.ok) {
      blankStarterError.value = verdict.message
      return
    }
    const fullName = res.data?.full_name || `${props.org}/${name}`
    // It exists now, so it belongs in the list without a refresh - and at the
    // top, because it is the one the lecturer just made.
    templates.value = [
      { full_name: fullName, is_template: true, id: res.data?.id },
      ...templates.value.filter((t) => t.full_name !== fullName),
    ]
    // NOT OVER A TEMPLATE THE LECTURER NAMED WHILE THIS WAS IN FLIGHT. The
    // offer disappears the moment the field is non-empty, but the request it
    // started does not, and a create that lands two seconds later must not
    // replace the repository they picked in the meantime. The repository is
    // still theirs and is in the list above; nothing is lost by saying so.
    if (String(form.value.template || '').trim()) {
      toast.success(`Created ${fullName}. The template field already names ${form.value.template}, so it was left alone.`)
      return
    }
    // Written AFTER the create resolved 201, and through `form.template` alone:
    // its watcher syncs the combobox text and runs the same live probe a picked
    // template gets, which is what fills `submission_ref` from the real
    // `default_branch` and takes the pin. Writing `refs/heads/main` here would
    // be the master-template trap with a friendlier face.
    // Written AFTER the create resolved 201, and through `form.template` alone:
    // its watcher syncs the combobox text and runs the same live probe a picked
    // template gets, which is what fills `submission_ref` from the real
    // `default_branch` and takes the pin. Writing `refs/heads/main` here would
    // be the master-template trap with a friendlier face.
    form.value.template = fullName
    touchedFields.value.template = true
    toast.success(`Created ${fullName} with a README. Students start from that.`)
  } catch (e) {
    // NOT "nothing was changed" - this branch cannot know that. The request
    // failed on the way out or on the way back, and GitHub may well have
    // created the repository before the answer was lost. Say what is true and
    // what to do about it (DESIGN.md §1.5).
    blankStarterError.value =
      `Could not reach GitHub: ${e.message}. If the request got through, ${props.org}/${name} may ` +
      `exist already - press refresh and check the list before trying again.`
  } finally {
    creatingBlankStarter.value = false
  }
}

// Does Submission ref name a branch the student repositories will have? The
// same judge the publish preflight refuses with. Only on a probe that ANSWERED
// for the template now in the field, and never on an unknown default branch:
// this refuses what was established, not what was not - the preflight asks
// again with the credential that does the work.
const submissionBranchWarning = computed(() => {
  const probe = templateValidationStatus.value
  if (!probe?.valid || !probe.defaultBranch) return ''
  const asked = String(form.value.template || '').trim()
  if (String(probe.fullName || '').toLowerCase() !== asked.toLowerCase()) return ''
  const finding = submissionBranchProvisioned({
    submissionRef: form.value.submission_ref,
    templateDefaultBranch: probe.defaultBranch,
  })
  if (finding.ok) return ''
  const [templateOwner, templateRepo] = asked.split('/')
  return templateSourceMessage(finding, { templateOwner, templateRepo, org: props.org })
})

/**
 * The template on GitHub, for the button beside Refresh (asked 2026-10-08:
 * after creating an empty template from scratch there was no way to get to
 * it). Only once the check found the repository - an empty or not-yet-ticked
 * one included, since those are what a lecturer goes there to fix - and only
 * for the repository still in the field: the check waits 400ms and may be
 * answering for the previous one.
 */
const templateGithubUrl = computed(() => {
  const s = templateValidationStatus.value
  if (!s?.valid || !s.fullName || !s.probed) return null
  if (String(form.value.template || '').trim().toLowerCase() !== s.probed.toLowerCase()) return null
  return `https://github.com/${s.fullName}`
})

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
        // THIS PROBE RAN ON THE LECTURER'S TOKEN, and provisioning will not.
        // It creates each student repository as an app installed on THIS org,
        // with a token minted for this installation - so a private repository
        // in another organization is a 404 to it, measured 2026-09-07, even
        // where the app is installed on that other org too. The lecturer can
        // see their own private repository perfectly well, which is exactly
        // why the badge went green on the one configuration that cannot work
        // and the failure surfaced in provisioning instead, after a student
        // had accepted and spent a slot of max_acceptances.
        const finding = templateUsable({
          templateOwner: owner,
          org: props.org,
          isPrivate: res.isPrivate,
          isTemplate: res.isTemplate,
        })
        // Is this still the repository the assignment was created from? Only
        // meaningful while EDITING one - a new assignment has nothing to
        // compare against, and `editing.value` carries the stored document.
        const pin = resolveTemplatePin({
          storedTemplate: isNew.value ? null : storedTemplate.value,
          owner,
          repo,
          probedId: res.id,
        })
        // A NEW assignment collects from the branch its students will have.
        // Only while the lecturer has not typed a ref of their own, only for
        // the template still in the field (this probe is debounced and may be
        // answering for the previous one), and never on an EXISTING assignment:
        // writing into the form on probe would make opening it look edited.
        // An existing one gets submissionBranchWarning instead.
        if (
          isNew.value &&
          !manualSubmissionRef.value &&
          res.defaultBranch &&
          String(form.value.template || '').trim().toLowerCase() === `${owner}/${repo}`.toLowerCase()
        ) {
          form.value.submission_ref = `refs/heads/${res.defaultBranch}`
        }
        // No commits, so every acceptance would fail in provisioning. A
        // warning like not-a-template, not a refusal: a draft stays saveable
        // while the lecturer adds a README, and publishing refuses it. Only
        // an established "empty" - a read that did not answer says nothing.
        const content = templateHasCommits({ commitsStatus: res.commitsStatus })
        templateValidationStatus.value = {
          valid: true,
          // What was asked, as typed: GitHub answers a renamed repository
          // under its new `fullName`, so that is not what to compare the
          // field against (templateGithubUrl).
          probed: `${owner}/${repo}`,
          empty:
            content.code === EMPTY_TEMPLATE
              ? templateSourceMessage(content, { templateOwner: owner, templateRepo: repo, org: props.org })
              : null,
          isTemplate: res.isTemplate,
          defaultBranch: res.defaultBranch,
          isPrivate: res.isPrivate,
          fullName: res.fullName,
          // Carried onto the saved document, so the pin is taken on first use
          // and preserved afterwards rather than re-taken on every edit.
          // On a replacement this is the NEW id: the badge reports it, and
          // saving is how the lecturer accepts it. Storing null instead would
          // drop the pin altogether and silence the check for good.
          repositoryId: pin.ok ? pin.repositoryId : res.id,
          replaced: pin.ok
            ? null
            : templatePinMessage(pin, { templateOwner: owner, templateRepo: repo }),
          // Only the impossible one blocks the SAVE. A repository that is
          // merely not ticked as a template keeps its existing warning: it is
          // one checkbox away on a repository the lecturer owns, and a draft
          // must stay saveable while they go and tick it. Publishing refuses
          // both, which is the point at which students can accept.
          blocked:
            finding.ok || finding.code !== FOREIGN_PRIVATE
              ? null
              : {
                  code: finding.code,
                  message: templateSourceMessage(finding, {
                    templateOwner: owner,
                    templateRepo: repo,
                    org: props.org,
                  }),
                },
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
  // OR THE FIELD IS EMPTY, whatever the manual flag says. The flag means "the
  // lecturer is managing this themselves", and it is set by an `@input` - which
  // fires when somebody clicks in, types a character and deletes it again.
  // Leaving that person with a permanently empty pattern is the same trap the
  // `{slug}` seed was, one step over: an empty field cannot be a deliberate
  // choice, because it is not a savable value.
  if (isNew.value && (!manualRepositoryNamePattern.value || !form.value.repository_name_pattern)) {
    const isGrp = form.value.assignment_type === 'group'
    // No id yet means no pattern yet. It used to fall back to
    // "{slug}-{github_login}", which is not a placeholder deriveRepoName
    // knows - it would have been copied into the repository name verbatim.
    form.value.repository_name_pattern = newId
      ? (isGrp ? `${newId}-{team_slug}` : `${newId}-{github_login}`)
      : ''
  }
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
    // EMPTY, not a fake placeholder. This seeded "{slug}-{github_login}", and
    // "{slug}" is not one: deriveRepoName does two literal replacements and
    // copies anything else through, so a repository would be named
    // "{slug}-alice" - which is not even a legal GitHub name. The seed
    // survived to a real save whenever the lecturer touched this field before
    // naming the assignment: that sets manualRepositoryNamePattern, and both
    // auto-writers then stand down. Measured 2026-09-09, and patternProblem()
    // now refuses it as well.
    repository_name_pattern: '',
    opens_at_local: toLocalInputValue(now),
    deadline_at_local: toLocalInputValue(in14d),
    _opens_at_original: '',
    _deadline_at_original: '',
    timezone: TIMEZONE,
    submission_ref: 'refs/heads/main',
    // `maintain` for a NEW assignment since 2026-09-26: a student can still
    // push and create Actions secrets and variables, and can no longer add
    // other people to their repository or change its settings (measured,
    // tests/live/permission-probe.mjs). An existing assignment keeps what it
    // stores, and an absent field is still `admin` everywhere that reads it.
    student_permission: 'maintain',
    // One enum value, so there is nothing to choose and no control for it.
    // The field stays because the schema and the public card still carry it.
    acceptance_mode: 'self-service',
    // Open, deliberately, and reversed from WS1's default on 2026-08-24.
    //
    // WS1 set this to `enforced` because the broker repo is public, so the
    // roster was the only thing standing between any GitHub account and a
    // provisioned repository. That stopped being the case when signed
    // invitations landed (ARCHITECTURE §4.3.2): the broker verifies an
    // Ed25519 signature at the edge before a credential is minted, so someone
    // without the link gets nothing whatever this says. The roster is no
    // longer load-bearing for access control, and defaulting to it made every
    // new assignment depend on a CSV import before a single student could
    // accept.
    //
    // `enforced` remains one dropdown away, and existing assignments keep
    // whatever they were saved with. `accept.mjs` still fails CLOSED to
    // `enforced` for any unrecognised value - that is a parser rule about
    // garbage, not a default, and it must not be relaxed to match this.
    //
    // Open requires a cap (schema `allOf`/`if`/`then`), and `max_acceptances`
    // below is why a new assignment is valid the moment it is created.
    roster_mode: 'open',
    // ON (2026-10-02, the lecturer's call). An open assignment that collects no
    // address leaves only GitHub usernames to match against the roster, which
    // is the reconciliation nobody can do afterwards. A lecturer who wants an
    // anonymous one unticks it. It was off, on the argument that `open` is for
    // a cohort nobody listed up front and should not identify itself.
    require_claim: true,
    // Empty means EVERY class group, which is what a new assignment should
    // mean - restricting a cohort is a decision a lecturer makes, never a
    // default they inherit.
    cohort: [],
    // Nothing is published yet, so nothing in the picker is locked.
    _cohort_published: [],
    // `block` (2026-10-02, the lecturer's call): the deadline is final unless
    // somebody says otherwise. It locks the submission branch and leaves the
    // student their Actions, secrets and runners; late commits do not count.
    // It was `report`, on the argument that a default which discards late work
    // should be opted into. The repository question below stays "as it is":
    // `block` already stops late pushes, and demotion on top of it takes the
    // toolchain this lock exists to leave alone.
    late_policy: 'block',
    // EMPTY, and no field on the form sets it - the dialog Save opens does,
    // once, and only on an individual assignment where repositories were
    // actually found. Absent is "nobody said", which lib/existing-repo.mjs
    // resolves by assignment type: individual reuses, team refuses. Carried
    // here and through buildDoc because this editor rebuilds the whole
    // document, so an answer that was not carried would be deleted by the next
    // unrelated edit.
    existing_repo_policy: '',
    state: 'draft',
    max_acceptances: 50,
    // Demoting to `pull` does not just stop pushes - it takes Actions, secrets,
    // environments, runners and settings, which on these courses is the subject
    // being taught. It is the heaviest thing the system does to a student, so a
    // lecturer opts in rather than discovering it at the deadline. Preservation
    // is unaffected: the snapshot is pushed to the assignment's archive repo
    // whatever this says, so the record a grade dispute rests on still exists.
    //
    // This is the FORM default and nothing else. `lockdown.mjs` still reads an
    // ABSENT `lock_down_enabled` as `true` (ARCHITECTURE §11.2.1) - every
    // assignment written before the field existed relies on that, and flipping
    // it there would silently stop freezing live cohorts. `buildDoc` writes the
    // field explicitly, so a new assignment carries `false` rather than nothing.
    lock_down_enabled: false,
    feedback_pr: false,
    feedback_pr_baseline_branch: 'pxl-baseline',
    autograde_enabled: false,
    template_grades: null,
    autograde_execution_environment: 'lecturer_local',
    autograde_tests: [],
    submission_marker_value: '',
    // Handing in again is allowed unless somebody says otherwise, which is the
    // same direction `readSubmissionMarker` takes for an absent field.
    submission_marker_multiple: true,
    // '' is no limit, which is what an assignment without the field means.
    submission_marker_max_hand_ins: '',
    assignment_type: 'individual',
    group_config: {
      max_team_size: DEFAULT_MAX_TEAM_SIZE,
      min_team_size: 2,
      formation_mode: 'self-service',
      allow_team_creation: true,
      // On for a new assignment; an existing one keeps what it stored, and
      // absent there is off (lib/team-join-code.mjs).
      require_join_code: true,
      // New assignments default to letting an unassigned student self-enrol;
      // hand-written YAML without the key keeps the stricter historical 'block'.
      unassigned_fallback: 'self-service',
    },
  }
}

// If the user-visible HH:MM still matches what we derived from the original
// UTC value, preserve the original (with seconds/ms) rather than zeroing them.
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

// The zone a datetime-local box is read in, which is the computer's, not the
// assignment's - localToUtc goes through `new Date(local)`. '' if the engine
// will not say, and the line under the dates then names no zone.
const browserTimeZone = (() => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || '' } catch { return '' }
})()
// The zone students are shown dates in (Advanced, "Time zone students see").
const studentTimeZone = computed(() => form.value.timezone || TIMEZONE)
// Each date box's moment in 24-hour time, under the box (lib/date-readout.js).
const openReadout = computed(() =>
  dateReadout(form.value.opens_at_local, { studentTimeZone: studentTimeZone.value, browserTimeZone }))
const deadlineReadout = computed(() =>
  dateReadout(form.value.deadline_at_local, { studentTimeZone: studentTimeZone.value, browserTimeZone }))

function autoSyncSlug() {
  if (isNew.value && !manualSlug.value) {
    form.value.id = toSlug(form.value.title)
    // The slug just changed without an @input on its own field, so a refusal
    // decided for the previous one is now about a different id.
    clearCollision()
    // Also keep repository_name_pattern in sync with slug if it has not been manually edited
    if (!manualRepositoryNamePattern.value) {
      form.value.repository_name_pattern = form.value.assignment_type === 'group'
        ? `${form.value.id}-{team_slug}`
        : `${form.value.id}-{github_login}`
    }
  }
}

// THE ONE DEADLINE QUESTION and the two fields it writes. Each answer sets
// both, so no answer can leave the other field behind; the stored document is
// unchanged in shape (late_policy, lock_down_enabled). `legacy` is the fourth
// combination, offered only where it is already stored (`legacyDeadlineOffered`).
const DEADLINE_CHOICES = Object.freeze({
  nothing: { late_policy: 'report', lock_down_enabled: false },
  'stop-pushes': { late_policy: 'block', lock_down_enabled: false },
  'read-only': { late_policy: 'block', lock_down_enabled: true },
  legacy: { late_policy: 'report', lock_down_enabled: true },
})
const deadlineChoice = computed({
  get() {
    const block = form.value.late_policy === 'block'
    const demote = form.value.lock_down_enabled === true
    if (block) return demote ? 'read-only' : 'stop-pushes'
    return demote ? 'legacy' : 'nothing'
  },
  set(choice) {
    const fields = DEADLINE_CHOICES[choice]
    if (!fields) return
    form.value.late_policy = fields.late_policy
    form.value.lock_down_enabled = fields.lock_down_enabled
  },
})
// Whether the STORED document holds the fourth combination. Read off the
// document as loaded, not the form, so choosing another answer and coming back
// is still possible before saving.
const legacyDeadlineOffered = ref(false)
function storesLegacyDeadline(doc) {
  return (doc?.late_policy || 'report') !== 'block' && (doc?.lock_down_enabled ?? true) === true
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

// Assignment files the last list read could not read or parse. Left out of the
// list, but NOT absent: a transient 500 on one file made the next tab switch
// drop the editor and say "There is no assignment called X" under a header
// showing that very assignment (review 2026-10-06).
const unreadableIds = ref(new Set())

async function loadAssignments() {
  loadingList.value = true
  assignmentsError.value = null
  const token = getToken()
  try {
    const repoRes = await getRepo(token, props.org, config.controlRepo)
    if (!repoRes.ok) {
      if (repoRes.status === 404) {
        // Not "isn't onboarded yet (or you can't see it)" - that sentence was
        // shown to an owner of the hub org about a course running for days,
        // under a New assignment button that could only fail. The dashboard
        // asks the same question of the same judge.
        controlRepoAccess.value = await classifyUnreadableControlRepo(
          (method, path) => ghApi(token, method, path),
          { org: props.org, hubOwner: config.hubOwner, hubRepo: config.hubRepo },
        )
        assignmentsError.value = 'no-control-repo'
        markStaff(props.org, false)
      } else {
        assignmentsError.value = `Failed to load control repository (HTTP ${repoRes.status})`
      }
      loadingList.value = false
      return
    }
    // Read the control repository: staff here, so the org's tabs in the
    // shared top bar can show (lib/org-session.js).
    markStaff(props.org, true)

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
          // Not "there is no such assignment" - see unreadableIds.
          return { __unreadable: true, id: f.name.replace(/\.yml$/, '') }
        }
      })
    )
    unreadableIds.value = new Set(docs.filter((d) => d?.__unreadable).map((d) => d.id))
    assignments.value = docs.filter((d) => d && !d.__unreadable).sort((a, b) => {
      // draft first, then published, then closed, then archived
      const order = { draft: 0, published: 1, closed: 2, archived: 3 }
      return (order[a.state] ?? 9) - (order[b.state] ?? 9) || a.id.localeCompare(b.id)
    })

    // Nothing about the URL is acted on here, and that is the point.
    //
    // This function used to apply `?new=1` and `?edit=<id>` itself, and it runs
    // every time the list is refreshed - including from inside saveAssignment(),
    // which awaits it immediately after the commit lands. So a save went:
    //
    //   commit the YAML with state: published   written
    //   form.value.state = 'published'          set
    //   await loadAssignments()   ->  re-applies the URL  ->  form.value is
    //                                 replaced by a blank draft, or by a
    //                                 DIFFERENT assignment
    //   back in saveAndPublish:   form.value.state === 'published' is false
    //                             -> no dispatch, and no revert either
    //
    // and the assignment was left saying "published" with no broker, no
    // workflow run, and no error anywhere. Worse with `?edit=<id>`: the form
    // became that OTHER assignment, so publishExisting() dispatched with its
    // id - a publish for a repository the lecturer had not touched. That is
    // exactly what happened on 2026-09-02: test-pe-2 was committed at 17:21:41Z
    // and four seconds later a publish ran for test-pe-1.
    //
    // A loader loads. Route intents are applied by applyRouteIntent(), once on
    // mount and once per query change, where re-running is not a thing that
    // happens.
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

async function newAssignment({ confirmed = false } = {}) {
  if (controlRepoUnreadable.value) return
  if (!confirmed && !(await confirmDiscard())) return
  stopPublishWatch()
  templateNotice.value = null
  permissionNotice.value = null
  storedStudentPermission.value = null
  legacyDeadlineOffered.value = false
  editing.value = { __new: true, id: '' }
  // Nothing stored yet, so nothing to compare a pin against - and a stale one
  // from the previously open assignment would accuse the wrong template.
  storedTemplate.value = null
  manualSlug.value = false
  manualRepositoryNamePattern.value = false
  manualSubmissionRef.value = false
  slugEditing.value = false
  patternEditing.value = false
  descriptionOpen.value = false
  templateSearchText.value = ''
  clearCollision()
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
  // A new assignment has been asked nothing, whatever the last one answered.
  existingRepoAnsweredFor.value = ''
  // Auto-select sole template if we already have it loaded
  if (templates.value.length === 1) {
    form.value.template = templates.value[0].full_name
    templateSearchText.value = templates.value[0].full_name
  }
  publishWatch.value = ''
  brokerExists.value = null
  pagesLive.value = null
  liveCheckLoading.value = false

  snapshotForm()
}

async function editAssignment(a, { confirmed = false } = {}) {
  if (!confirmed && editing.value && editing.value.id !== a.id && !(await confirmDiscard())) return
  stopPublishWatch()
  if (templateNotice.value?.id !== a.id) templateNotice.value = null
  if (permissionNotice.value?.id !== a.id) permissionNotice.value = null
  editing.value = { id: a.id }
  // A stored policy was given about the pattern stored beside it, so opening
  // this assignment asks nothing - and changing its pattern asks again, which
  // is the whole reason this is a pattern rather than a flag.
  existingRepoAnsweredFor.value = a.existing_repo_policy ? (a.repository_name_pattern || '') : ''
  // The STORED template block, kept beside the form rather than inside it: the
  // pin is compared against what the document says, and `form` carries only
  // the `owner/repo` string. Not folded into `editing.value`, which other code
  // compares as an identity.
  storedTemplate.value = a.template || null
  // Absent is what every older assignment was provisioned with.
  storedStudentPermission.value = a.student_permission || 'admin'
  legacyDeadlineOffered.value = storesLegacyDeadline(a)
  manualSlug.value = true // existing assignments - never auto-rewrite the slug
  manualRepositoryNamePattern.value = true
  // Never editable on an existing assignment - changing it orphans the YAML -
  // so the derived line stays a reading, and the input is not offered.
  slugEditing.value = false
  patternEditing.value = false
  descriptionOpen.value = false
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
    timezone: a.timezone || TIMEZONE,
    submission_ref: a.submission_ref || 'refs/heads/main',
    student_permission: a.student_permission || 'admin',
    acceptance_mode: a.acceptance_mode || 'self-service',
    // normalizeRosterMode, not a hand-written ternary: the ternary rewrote any
    // mode it predated to 'enforced' on load, and buildDoc saved the rewrite
    // back - the same silent field-loss as the invitation tokens.
    roster_mode: normalizeRosterMode(a.roster_mode),
    require_claim: a.require_claim === true,
    // Read, never re-derived: an absent list means every group, and turning
    // that into anything else on load would let a save write a restriction the
    // lecturer never chose.
    cohort: Array.isArray(a.cohort) ? [...a.cohort] : [],

    // THE COHORT AS PUBLISHED, kept beside the editable one so the picker can
    // add without removing. Once students can accept, taking one out of the
    // cohort does not un-provision their repository, un-invite them or delete
    // their work - so a control that appeared to remove them would describe
    // behaviour the system does not have (DESIGN.md §1.5).
    _cohort_published: a.state && a.state !== 'draft' && Array.isArray(a.cohort) ? [...a.cohort] : [],
    late_policy: a.late_policy || 'report',
    // Read back as stored, empty when the assignment does not say - `||
    // 'reuse'` would turn silence into an explicit answer the first time
    // anyone opened the assignment to change its title.
    existing_repo_policy: a.existing_repo_policy || '',
    state: a.state || 'draft',
    // 50 is the default for a NEW assignment (emptyForm), not a value to
    // invent for an existing one. buildDoc rebuilds the whole document, so
    // `?? 50` here silently capped an uncapped assignment the first time
    // anyone opened it to change the title. Empty means no cap, and buildDoc
    // omits the field.
    max_acceptances: a.max_acceptances ?? '',
    lock_down_enabled: a.lock_down_enabled ?? true,
    // No control renders this - organization scope is the default under
    // `does not count` and `false` is the explicit opt-out - but the editor
    // rebuilds the whole document on save, so BOTH booleans have to be read in.
    // Dropping a `false` here would move a cohort to organization scope on an
    // unrelated edit, and the form offers no way back.
    ...(typeof a.org_scoped_lock === 'boolean' ? { org_scoped_lock: a.org_scoped_lock } : {}),
    invite_token: a.invite_token || '',
    invite_nonce: a.invite_nonce || '',
    invite_expires_at: a.invite_expires_at || '',
    invite_key: a.invite_key || '',
    invite_pubkey: a.invite_pubkey || '',
    // Absent stays absent and [] stays [], so buildDoc can tell a deliberate
    // opt-out from a lecturer who never set one. Loaded purely so the save
    // carries it back out - there is no control for it.
    claim_domains: Array.isArray(a.claim_domains) ? a.claim_domains : undefined,
    // Tri-state, read as stored: false is the opt-out, anything else the
    // deployment's rule. Not defaulted, or a load would write an answer.
    claim_address_format: a.claim_address_format === false ? false : undefined,
    feedback_pr: a.feedback_pr === true,
    feedback_pr_baseline_branch: a.feedback_pr_baseline_branch || 'pxl-baseline',
    // The configuration's existence is the flag (ARCHITECTURE §11.6), so
    // `enabled: true` with no checks loads as off rather than as a state the
    // summary calls "Off" while Save fails on `tests.minItems`. A hand-edited
    // YAML in that shape gets repaired by the next save instead of trapping
    // the lecturer behind an error they cannot reach a control for.
    autograde_enabled: a.autograde?.enabled === true && (a.autograde?.tests || []).length > 0,
    // READ, NEVER RE-DERIVED. An assignment saved before this field existed
    // carries no answer, and `=== true` keeps that as false here rather than
    // guessing one from the autograde block - a made-up answer in the field
    // whose whole purpose is to record the one the lecturer actually gave
    // would be indistinguishable from a real one. Those documents are decided
    // by positive evidence instead (frontend/src/lib/autograde.js).
    template_grades: a.template_grades ?? null,
    autograde_execution_environment: a.autograde?.execution_environment || 'lecturer_local',
    autograde_tests: a.autograde?.tests || [],
    // The hand-in commit message, when the template's own workflow gates on
    // one. `type` is the schema's only member today, and a SECOND member has to
    // arrive with its own control: buildDoc rebuilds the document field by
    // field, so a marker this does not load is deleted by the next save - the
    // invite_token bug, one field over.
    submission_marker_value:
      a.submission_marker?.type === 'commit_message' ? a.submission_marker.value || '' : '',
    // `!== false`, so a hand-written YAML that omits it loads the way
    // `readSubmissionMarker` reads it rather than the way a truthy check would.
    submission_marker_multiple: a.submission_marker?.multiple !== false,
    // Read through the grader's own judge, so a hand-edited `0` or "5" shows
    // as no limit here exactly as it grades.
    submission_marker_max_hand_ins: readMaxHandIns(a.submission_marker?.max_hand_ins) ?? '',
    assignment_type: a.assignment_type || 'individual',
    group_config: {
      max_team_size: teamMaxSize(a.group_config),
      min_team_size: a.group_config?.min_team_size || 2,
      formation_mode: a.group_config?.formation_mode || 'self-service',
      allow_team_creation: a.group_config?.allow_team_creation !== false,
      require_join_code: requiresJoinCode(a.group_config),
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
  // Not while a publish is being carried onto this page (`?publishing=`, a new
  // assignment's Save & publish): its broker is still being made, and the
  // check flashed the red "Publish Incomplete" card until the watch began.
  if (a.state === 'published' && !route.query.publishing) {
    verifyLiveInfrastructure(a.id)
  } else {
    brokerExists.value = null
    pagesLive.value = null
    liveCheckLoading.value = false
  }
  snapshotForm()
}

// Leaving asks about unsaved edits on the way out (onBeforeRouteLeave).
// A new assignment: back to the list (leaving asks about what was typed).
// Settings: undo the edits and stay, because this tab IS the assignment's
// settings - there is nowhere to go back to.
async function cancelEdit() {
  if (!props.embedded) return leaveEditor()
  const stored = assignments.value.find((a) => a.id === props.assignmentId)
  if (!stored || !(await confirmDiscard())) return
  editAssignment(stored, { confirmed: true })
}

// ---------------------------------------------------------------- automated checks

// The row editor lives in AutogradeModal.vue now; this view holds the one-line
// summary and the resulting configuration (ARCHITECTURE §11.6).
const showAutogradeModal = ref(false)
const showDeleteModal = ref(false)

// The same condition the Edit/Set up button and the Remove button already used
// inline, named once so the three cannot disagree about whether it is on.
const autogradeConfigured = computed(() =>
  Boolean(form.value.autograde_enabled) && (form.value.autograde_tests || []).length > 0)

// Has the lecturer answered the question at all - in EITHER of its two shapes?
//
// `autogradeConfigured` alone is "did they define checks here", which is not
// the same question and made the panel contradict itself: a cloud exam, whose
// checks live in the template's own `classroom.yml`, read "Off · submissions
// are not scored automatically" with a hand-in commit message beside it. Live,
// `proef-pe1` is exactly that assignment (ARCHITECTURE §11.6).
const gradingAnswered = computed(
  () => autogradeConfigured.value || !!String(form.value.submission_marker_value ?? '').trim(),
)

// The note is what is left when the answer is neither, and it says only what
// this screen owns. "Submissions are not scored automatically" was a claim
// about the student's repository that the form cannot evaluate - a template
// may ship a workflow nobody mentioned here - which DESIGN.md §1.5 names
// directly.
const autogradeSummary = computed(() =>
  summariseGrading({
    autograde: {
      enabled: form.value.autograde_enabled,
      execution_environment: form.value.autograde_execution_environment,
      tests: form.value.autograde_tests,
    },
    submissionMarker: form.value.submission_marker_value,
    // Only while "more than once" is on - the save drops it otherwise.
    maxHandIns: form.value.submission_marker_multiple !== false
      ? readMaxHandIns(Number(form.value.submission_marker_max_hand_ins))
      : null,
  }),
)

// What the template repository actually grades with, read once per repository.
//
// The DIALOG does not do this. It holds no token and makes no requests; it
// shows what this found and emits what the lecturer chose, the way
// FreezeConfirmModal takes a name rather than composing one (DESIGN.md §6).
const templateWorkflow = ref({ state: 'unknown' })
let templateProbedFor = ''

function templateOwnerRepo() {
  const [owner, repo] = String(form.value.template || '').split('/')
  return owner && repo ? { owner, repo, full: `${owner}/${repo}` } : null
}

async function checkTemplateWorkflow({ force = false } = {}) {
  const target = templateOwnerRepo()
  if (!target) {
    templateProbedFor = ''
    templateWorkflow.value = { state: 'unknown' }
    return
  }
  // One probe per template repository. Switching between the two cards should
  // not spend a request re-learning what it just read.
  if (!force && templateProbedFor === target.full && templateWorkflow.value.state !== 'checking') return

  const token = getToken()
  if (!token) {
    templateWorkflow.value = { state: 'error', repo: target.full }
    return
  }

  templateProbedFor = target.full
  templateWorkflow.value = { state: 'checking', repo: target.full }

  try {
    let files = []
    try {
      files = await listRepoDir(token, target.owner, target.repo, '.github/workflows')
    } catch (e) {
      if (e.status !== 404) throw e
      // A 404 is "no workflows directory" OR "no such repository", and those
      // are different answers. Ask which before reporting one of them: a
      // template nobody can read must not come back as a template with no
      // grading in it (§1.5).
      const repoRes = await getRepo(token, target.owner, target.repo)
      if (!repoRes?.ok) {
        templateWorkflow.value = { state: 'error', repo: target.full }
        return
      }
    }

    for (const file of files) {
      if (file.type !== 'file' || !/\.ya?ml$/i.test(file.name)) continue
      const text = await getRepoContent(token, target.owner, target.repo, file.path)
      // The reporter is the signal, not the filename - a lecturer may call it
      // anything, and GitHub Classroom's own is `classroom.yml`.
      if (text && isGradingWorkflow(text)) {
        templateWorkflow.value = {
          state: 'present',
          repo: target.full,
          path: file.path,
          gate: readGateMessage(text),
        }
        return
      }
    }
    templateWorkflow.value = { state: 'absent', repo: target.full }
  } catch {
    templateWorkflow.value = { state: 'error', repo: target.full }
  }
}

async function addStarterWorkflow({ handInMessage } = {}) {
  const target = templateOwnerRepo()
  const token = getToken()
  if (!target || !token) return

  templateWorkflow.value = { ...templateWorkflow.value, writing: true }

  // `commitFile` updates a file that is already there, and "absent" here means
  // no workflow that GRADES - a `classroom.yml` doing something else entirely
  // would be at that path and would be overwritten. Overwriting a file a
  // lecturer wrote is not a repair, so it refuses.
  try {
    const existing = await getRepoContent(token, target.owner, target.repo, STARTER_PATH)
    if (existing !== null) {
      templateWorkflow.value = { ...templateWorkflow.value, writing: false }
      toast.error(
        `${STARTER_PATH} already exists in ${target.full} and does not grade. Open it and add the checks yourself, or rename it first.`,
      )
      return
    }
  } catch {
    templateWorkflow.value = { ...templateWorkflow.value, writing: false }
    toast.error(`Could not read ${target.full}, so nothing was written.`)
    return
  }

  const res = await commitFile(
    token,
    target.owner,
    target.repo,
    STARTER_PATH,
    buildStarterWorkflow({ handInMessage, branch: submissionBranch({ submission_ref: form.value.submission_ref }) }),
    'Add grading workflow (PXL Classroom)',
  )

  if (!res.ok) {
    templateWorkflow.value = { ...templateWorkflow.value, writing: false }
    // A 403 here is one specific thing and it is not transient: writing a file
    // under .github/workflows needs the App's Workflows permission, and an
    // owner of the organization has to approve it. Saying "try again" would be
    // advice that can never come true.
    toast.error(
      res.status === 403
        ? `GitHub refused to write the workflow to ${target.full}. Writing under .github/workflows needs the PXL Classroom App's "Workflows" permission, which an owner of this organization approves.`
        : `Could not write the workflow to ${target.full} (HTTP ${res.status}). Nothing was changed.`,
    )
    return
  }

  templateWorkflow.value = {
    state: 'present',
    repo: target.full,
    path: STARTER_PATH,
    gate: String(handInMessage || '').trim() || null,
    added: true,
  }
  toast.success(`Added ${STARTER_PATH} to ${target.full}.`)
}

function applyAutograde(config) {
  form.value.autograde_enabled = config.enabled
  // The half that distinguishes "the template grades this" from "nothing does".
  // Both leave `enabled` false and write no autograde block, so without this
  // the two saves produce the identical document and the answer the lecturer
  // just gave is gone.
  form.value.template_grades = config.source === 'template'
  form.value.autograde_execution_environment = config.execution_environment
  form.value.autograde_tests = config.tests
  // The modal answers ONE question, so it answers both halves of it. `?? ''`
  // rather than `||`: an explicit empty string is the modal saying "no hand-in
  // message", and treating it as "leave whatever was there" is how a setting
  // survives the screen that was meant to clear it.
  form.value.submission_marker_value = config.submissionMarker ?? ''
  form.value.submission_marker_multiple = config.submissionMarkerMultiple !== false
  form.value.submission_marker_max_hand_ins = config.submissionMarkerMaxHandIns ?? ''
  showAutogradeModal.value = false
}

// Removing the checks removes the flag with them: an enabled-but-empty
// configuration fails `tests.minItems: 1` on save, and promises a score the
// system will never produce.
function clearAutograde() {
  form.value.autograde_enabled = false
  form.value.template_grades = false
  form.value.autograde_tests = []
  // Remove clears the whole answer, including a hand-in message: leaving one
  // behind would keep the summary line saying the template grades this while
  // the button said it had been removed.
  form.value.submission_marker_value = ''
  form.value.submission_marker_multiple = true
  form.value.submission_marker_max_hand_ins = ''
}

// ---------------------------------------------------------------- YAML generation + validation

// The document itself lives in frontend/src/lib/assignment-doc.js, imported by
// the contract test as well. It used to be inline here, and
// tests/contract-form-diagnostics.test.mjs carried a hand-maintained COPY of it
// that had drifted past the signed-acceptance keypair, claim_domains, autograde
// and feedback_pr - so the diagnostics contract was checked against a shape this
// panel had not written for months.
/**
 * The template pin to save: fresh from the probe, or the stored one carried
 * over.
 *
 * Read at SAVE rather than written into `form` while typing, deliberately. The
 * probe is async and fires on load; assigning its answer into the form would
 * make merely OPENING an old assignment - one with no pin yet - look edited,
 * and the discard prompt would fire on a form nobody touched.
 *
 * `resolveTemplatePin` decides, so the carry-over rule is the same one the
 * publish preflight and provisioning apply: the pin belongs to the name it
 * sits beside, a different template is a new pin, and a replaced repository is
 * ADOPTED here because saving is the lecturer's deliberate act of accepting it
 * (the badge told them first, and provisioning refuses until they do).
 */
function currentTemplatePin() {
  const [owner, repo] = String(form.value.template || '').split('/')
  if (!owner || !repo) return null
  const probe = templateValidationStatus.value
  const asked = `${owner}/${repo}`.toLowerCase()
  const probedId =
    probe?.valid && String(probe.fullName || '').toLowerCase() === asked ? probe.repositoryId : null
  const pin = resolveTemplatePin({
    storedTemplate: isNew.value ? null : storedTemplate.value,
    owner,
    repo,
    probedId,
  })
  // A mismatch ADOPTS the new id rather than dropping the pin. The badge has
  // already told the lecturer the repository changed and that saving accepts
  // it; returning null here would instead delete the pin, silence the check
  // permanently, and leave provisioning unable to refuse the next surprise.
  return pin.ok ? pin.repositoryId : probedId
}

function buildDoc(state = null) {
  return buildAssignmentDoc(form.value, { state, templateRepositoryId: currentTemplatePin() })
}


const validationErrors = ref([])

async function validate(state = null) {
  const doc = buildDoc(state)
  const { valid, errors } = await validateAgainst('assignment', doc)
  // Raw AJV names a JSON Pointer, a keyword and a regex - none of which is on
  // the lecturer's screen. ARCHITECTURE §10.4; unmapped errors still come through
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

// What stands between this form and Save, as the names on screen. Every reason
// canSave refuses is a fieldErrors key: an empty required field has one too.
const SAVE_BLOCKER_NAMES = Object.freeze({
  template: 'template',
  title: 'title',
  id: 'slug',
  repository_name_pattern: 'repository name',
  opens_at: 'open date',
  deadline_at: 'deadline',
  max_acceptances: 'max acceptances',
  description: 'description',
  autograde_tests: 'autograding tests',
})
const saveBlockers = computed(() => {
  if (canSave.value) return []
  return [...new Set(Object.keys(fieldErrors.value).map((k) => SAVE_BLOCKER_NAMES[k] || k))]
})

// ---------------------------------------------------------------- save / publish

/**
 * Writes the assignment YAML. Returns whether it was actually saved.
 *
 * It used to return nothing, and `saveAndPublish` read that as success: on an
 * already-published assignment it went straight on to dispatch the publish
 * workflow even when the commit had failed, so the run went out against a YAML
 * that was never written.
 */
// Whether this assignment would land on top of an existing one.
//
// Not a computed: answering needs live reads of the organization.
// `collisionCheckedFor` holds the id+pattern the verdict was decided for, so
// editing either stops showing it immediately rather than re-justifying it for
// a form it was never about.
//
// `collisionError` is the one case with no list behind it: the check could not
// RUN. Everything else is `collisionVerdict`, whose findings say for themselves
// whether they block.
const collisionError = ref('')
const collisionVerdict = ref(null)
const collisionCheckedFor = ref('')
const collisionChecking = ref(false)

// A refusal lists only what stops the save: the consequence line says "delete
// what is listed above", and the retired record is not something anyone has to
// delete. Notes are their own block, in the muted voice, and only when nothing
// blocks - a refusal is not the moment to also mention a bookkeeping detail.
const collisionBlockers = computed(() => blockingFindings(collisionVerdict.value))
// `existing-repos` is deliberately NOT among them - it is said once, in the
// confirm on the way out of Save (`existingRepoNote`), rather than sitting
// under the field for every lecturer who reuses a name. What is left is the
// retired record, which is genuinely worth reading while choosing a name: it
// says a later delete would overwrite the previous run's grades.
const collisionNotes = computed(() =>
  (collisionVerdict.value?.clear ? noteFindings(collisionVerdict.value) : [])
    .filter((f) => f.kind !== 'existing-repos'))

/**
 * The existing-repository finding, for the ONE place that reads it: the confirm
 * on the way out of Save.
 *
 * Deliberately not rendered on the form. It is not a refusal - who will accept
 * is not knowable on this screen, and acceptance decides per student - and a
 * line under the field asking every lecturer to notice a case almost none of
 * them meet is clutter for everyone and an answer for nobody. Said once, at the
 * moment the assignment is actually being created.
 *
 * The count is read off the finding rather than parsed back out of its
 * sentence: a guard reading a string its own module built is the shape this
 * project keeps rediscovering.
 */
const existingRepoNote = (verdict) =>
  (verdict?.clear ? noteFindings(verdict) : []).find((f) => f.kind === 'existing-repos') ?? null

/**
 * How many of those repositories no assignment that still exists would produce.
 *
 * Read off its own finding, the same way and for the same reason. It rides in
 * the dialog rather than under the field, because that is where the lecturer is
 * already answering what should happen to a student who owns one, and the form
 * deliberately renders nothing about existing repositories in place (one
 * lecturer in the deployment meets this; a permanent line is clutter for
 * everyone else).
 */
const retiredRepoCount = (verdict) =>
  (verdict?.clear ? noteFindings(verdict) : []).find((f) => f.kind === 'retired-repos')?.count ?? 0

/**
 * The dialog's props while it is open, and null when it is not.
 *
 * `v-if` on the parent, so the component is created fresh each time and there
 * is no selection left over from a previous open to reset (DESIGN.md §6).
 */
const existingReposPrompt = ref(null)

/**
 * The pattern the stored answer was given about, or '' when there is none.
 *
 * Not a boolean, because "answered" is only meaningful about a set of
 * repositories, and the pattern is what names that set. An assignment loaded
 * from disk seeds this from its own stored pattern - a policy in that document
 * was given about the pattern beside it - so opening an assignment that has
 * already answered asks nothing, and changing its pattern asks again.
 */
const existingRepoAnsweredFor = ref('')

/**
 * Open it and wait, because the save cannot continue until a person answers.
 *
 * A resolver held outside the ref rather than inside it: what is on screen is
 * the parent's state, and putting a function in reactive data makes Vue proxy
 * it. THREE outcomes, not two: the chosen policy, `null` when a team
 * assignment confirms (it was told rather than asked, so there is nothing to
 * record), and `false` for Cancel. Collapsing the last two into one falsy value
 * would make "confirmed without choosing" indistinguishable from "did not
 * confirm", and the save would silently stop.
 */
let existingReposResolve = null
function askExistingRepos({ count, orphans = 0, pattern, teams, confirmLabel }) {
  existingReposPrompt.value = { count, orphans, pattern, teams, confirmLabel }
  return new Promise((resolve) => { existingReposResolve = resolve })
}
function answerExistingRepos(policy) {
  existingReposPrompt.value = null
  const resolve = existingReposResolve
  existingReposResolve = null
  // Guarded: a second close event after the first would resolve a settled
  // promise, which is harmless, and calling null is not.
  if (resolve) resolve(policy)
}

// The remedy names no year and composes no name: nothing here knows whether
// any particular replacement is free, so it states the requirement - the name
// has to be different - and leaves the choice to the lecturer, over a listing
// they can see and this code cannot.
const collisionWays = computed(() => collisionRemedies({ verdict: collisionVerdict.value }))

/** The identity of a check: re-run when either half changes, not just the id. */
const collisionKey = () => `${form.value.id} ${form.value.repository_name_pattern}`

function clearCollision() {
  collisionError.value = ''
  collisionVerdict.value = null
  collisionCheckedFor.value = ''
}

/**
 * Would this assignment land on top of an existing one?
 *
 * The question is about what EXISTS, never about what once happened. An
 * assignment opened by mistake and deleted before anybody joined leaves a
 * `retired/<id>/` record of nothing, and refusing the name for that would
 * refuse an ordinary "changed my mind, starting over". A lecturer who has
 * deleted the archive and the repositories has genuinely freed the name and is
 * believed.
 *
 * The collision key is `repository_name_pattern`, not the id - lib/
 * seed-teams.mjs has said so since it was written, and nothing enforced it. So
 * the authoritative question is put to the ORGANIZATION: list every repository
 * and ask which ones this pattern would produce. One request per 100
 * repositories, at creation time only, and it is the only answer that survives
 * a lecturer deleting the record by hand.
 *
 * `listOrgRepos` with a prefix would be one bounded Search API query instead -
 * and is not used here, because Search is eventually consistent: a repository
 * deleted a minute ago is still in the index, which is exactly the moment a
 * lecturer retries. The paginated org walk is authoritative.
 *
 * Fails CLOSED on an unreadable answer: what it prevents fails weeks later, at
 * the deadline, on a student who did nothing wrong.
 *
 * An EXISTING assignment whose pattern has NOT changed is checked for one thing
 * only: another live assignment sharing its pattern. Its own repositories match
 * its own pattern, its own archive is meant to be there, and its own `retired/`
 * record would be from a previous life of the id - so those questions have no
 * meaning there, and asking them would refuse every save. That costs no
 * requests at all.
 *
 * A CHANGED pattern is checked against the organization too, minus the names
 * the stored pattern already owns. Without it, "save under another name and
 * edit the pattern back" walked past the creation check in silence.
 *
 * @param {string} slug
 * @param {string} pattern
 * @param {{fresh?: boolean}} [opts] `fresh` - this is a new assignment
 * @returns {Promise<{message: string, verdict: object|null}>}
 */
async function checkCollisions(slug, pattern, { fresh = true } = {}) {
  const token = getToken()
  const refuse = (message) => ({ message, verdict: null })
  let manifest = null
  let archiveExists = false

  if (!fresh) {
    const clashes = clashingAssignments(pattern, assignments.value, slug)
    const stored = assignments.value.find((a) => a.id === slug)?.repository_name_pattern || ''
    // An UNCHANGED pattern asks nothing more, and costs no requests: its own
    // repositories match its own pattern, its own archive is meant to be there,
    // and its own `retired/` record would be from a previous life of the id.
    if (!stored || stored === pattern) return { message: '', verdict: assignmentCollisions({ clashes }) }

    // A CHANGED one is a different question, and it was not being asked.
    //
    // The creation check refuses two things, so the way round it was to save
    // under a name it accepts and edit the pattern afterwards - which went
    // straight through, because this branch only ever looked at other
    // assignments. It is the natural move for a lecturer who has been told no,
    // it is written down in RUNBOOK §5.1, and it re-asked nothing.
    let orgRepos
    try {
      orgRepos = await listOrgRepos(token, props.org, '', { failFast: true })
    } catch (e) {
      return refuse(`Could not list the repositories in ${props.org} (${e.message}). Refusing rather than guessing what this pattern would land on.`)
    }
    const names = orgRepos.map((r) => r.name)
    const others = assignments.value.filter((a) => a.id !== slug)
    // MINUS WHAT THE STORED PATTERN ALREADY OWNS. Widening is the case that
    // needs it: a placeholder expands to `[A-Za-z0-9-]+`, so moving from
    // `portfolio-2627-{github_login}` to `portfolio-{github_login}` swallows
    // this assignment's OWN repositories, and reporting those back would be the
    // form telling a lecturer their own cohort is in the way.
    const own = new Set(collidingRepoNames(stored, names, others))
    const existingRepos = collidingRepoNames(pattern, names, others).filter((n) => !own.has(n))
    // Of those, the ones no live assignment explains. Costs no request: both
    // lists are already here, and the answer is a subtraction.
    const orphanRepos = retiredPatternClash(pattern, existingRepos, assignments.value)
    return { message: '', verdict: assignmentCollisions({ existingRepos, orphanRepos, clashes }) }
  }

  try {
    const raw = await getRepoContent(token, props.org, config.controlRepo, retiredManifestPath(slug))
    if (raw) {
      try {
        manifest = JSON.parse(raw)
      } catch {
        // A record that will not parse is still a record that is there.
        manifest = { assignment_id: slug }
      }
    }
  } catch (e) {
    return refuse(`Could not check whether "${slug}" was used before (${e.message}). Refusing rather than guessing.`)
  }

  const archive = archiveRepoName(slug)
  if (archive) {
    const res = await getRepo(token, props.org, archive)
    if (res.ok) archiveExists = true
    else if (res.status !== 404) {
      return refuse(`Could not check whether ${props.org}/${archive} still exists (HTTP ${res.status}). Refusing rather than guessing - a kept archive makes preservation fail at the deadline.`)
    }
  }

  // failFast: a short list would read as "nothing is in the way", which is the
  // one answer an unanswered request must never produce.
  let orgRepos
  try {
    orgRepos = await listOrgRepos(token, props.org, '', { failFast: true })
  } catch (e) {
    return refuse(`Could not list the repositories in ${props.org} (${e.message}). Refusing rather than guessing - a returning student would be handed their old locked repository.`)
  }

  const others = assignments.value.filter((a) => a.id !== slug)
  const existingRepos = collidingRepoNames(pattern, orgRepos.map((r) => r.name), others)
  const orphanRepos = retiredPatternClash(pattern, existingRepos, assignments.value)
  const clashes = clashingAssignments(pattern, assignments.value, slug)

  return { message: '', verdict: assignmentCollisions({ existingRepos, orphanRepos, clashes, archiveExists, manifest }) }
}

/**
 * Check on the way out of the slug or the pattern field, so the answer arrives
 * while the lecturer is still choosing a name rather than after they have
 * filled in the whole form.
 *
 * saveAssignment re-runs it regardless. This one is a courtesy; that one is the
 * gate. Bound to both fields because either one changes the answer.
 *
 * Runs for an existing assignment too - the pattern is editable there, and
 * checkCollisions() narrows what it asks about accordingly.
 */
async function onSlugBlur() {
  const slug = form.value.id
  const pattern = form.value.repository_name_pattern
  if (!slug || !pattern || fieldErrors.value.id || fieldErrors.value.repository_name_pattern) {
    clearCollision()
    return
  }
  const key = collisionKey()
  if (collisionCheckedFor.value === key) return
  collisionChecking.value = true
  try {
    const { message, verdict } = await checkCollisions(slug, pattern, { fresh: isNew.value })
    // The lecturer may have kept typing while this was in flight. A verdict
    // about a form that no longer exists is worse than no verdict.
    if (collisionKey() !== key) return
    collisionError.value = message
    collisionVerdict.value = verdict
    collisionCheckedFor.value = key
  } finally {
    collisionChecking.value = false
  }
}

/**
 * Arm the deadline sentinel when a save leaves an imminent deadline.
 *
 * The sentinel arms from a 4-hourly cron, and a cron cannot see a change made
 * after it last fired. Publishing covers one of the two moments that creates a
 * deadline it has already missed; this covers the other, which is the one a
 * lecturer reaches by accident: an assignment whose deadline was next week,
 * edited to this afternoon. Nothing about that is a publish, so nothing armed.
 *
 * DELIBERATELY SILENT, in both directions. A dispatch that fails changes
 * nothing a lecturer must act on - the cron still arms anything more than four
 * hours out, and the nightly still locks whatever the sentinel misses, so the
 * deadline holds either way and only its precision is at stake. Toasting a
 * failure here would ask someone mid-exam-setup to care about a layer that
 * exists to save them minutes. It is also entirely normal for this to fail:
 * dispatching a hub workflow needs write access on the hub, which most
 * lecturers do not have (OPEN-ITEMS 4).
 *
 * Only for a PUBLISHED assignment: a draft has nobody to freeze.
 */
async function armSentinelIfImminent(doc) {
  if (doc?.state !== 'published') return
  if (!deadlineIsImminent(doc?.deadline_at)) return
  // `.ok`, not try/catch: everything in lib/api.js RESOLVES `{ ok: false }`
  // rather than throwing, so a catch here would never run and would only look
  // like error handling. Silent to the lecturer, visible in the console - the
  // cron and the nightly are both still behind this, so there is nothing for
  // them to do about it.
  const res = await triggerWorkflow(getToken(), config.hubOwner, config.hubRepo, 'deadline-sentinel.yml', {
    org: props.org,
  })
  if (!res?.ok) {
    console.warn(
      `Could not arm the deadline sentinel (HTTP ${res?.status}). The deadline still holds: ` +
        `the 4-hourly cron arms anything further out, and the nightly locks whatever it misses.`,
    )
  }
}

// WHAT THE PRESS IS DOING, from the instant of the click. Save & publish ran
// three seconds of checks - the form, the slug against the control repo, the
// name against the organization's repositories - before anything showed, and a
// lecturer was about to press again (2026-10-08). Shown on the button and in
// the bar; cleared by whoever set it, so a save inside a publish keeps the
// publish's words.
const actionStep = ref('')

async function saveAssignment(stateOverride = null) {
  const own = !actionStep.value
  if (own) actionStep.value = 'Checking…'
  try {
    return await saveAssignmentSteps(stateOverride)
  } finally {
    if (own) actionStep.value = ''
  }
}

async function saveAssignmentSteps(stateOverride) {
  // Touch all fields to show error styling
  for (const k of Object.keys(touchedFields.value)) {
    touchedFields.value[k] = true
  }
  if (Object.keys(fieldErrors.value).length > 0) {
    toast.error('Validation failed. Please fix the errors in the form.')
    return false
  }
  if (!(await validate(stateOverride))) {
    toast.error('Validation failed. Please fix the issues listed below the form.')
    return false
  }
  if (isNew.value) {
    const slug = form.value.id
    if (assignments.value.some((a) => a.id === slug)) {
      toast.error(`${slug} already exists; pick another slug or edit the existing assignment.`)
      return false
    }
    try {
      const token = getToken()
      const path = assignmentPath(slug)
      const exists = await getRepoContent(token, props.org, config.controlRepo, path)
      if (exists !== null) {
        toast.error(`${slug} already exists; pick another slug or edit the existing assignment.`)
        return false
      }
    } catch { /* ignore and let commitFile handle any errors */ }
  }

  // The collision gate. Runs for an existing assignment too, because
  // `repository_name_pattern` is editable and pointing it at another live
  // assignment's namespace is exactly how two assignments come to hand out
  // each other's repositories (lib/seed-teams.mjs, invariant 2).
  //
  // Re-run here even when the blur check already passed: the blur check is a
  // courtesy, this one is the gate, and the org can have changed in between.
  {
    const slug = form.value.id
    const pattern = form.value.repository_name_pattern
    const key = collisionKey()
    const { message, verdict } = await checkCollisions(slug, pattern, { fresh: isNew.value })
    collisionError.value = message
    collisionVerdict.value = verdict
    collisionCheckedFor.value = key
    if (message || (verdict && !verdict.clear)) {
      touchedFields.value.id = true
      touchedFields.value.repository_name_pattern = true
      toast.error(`"${slug}" would collide with something that already exists. See the form.`)
      return false
    }

    // AND THE ONE THING THAT DOES NOT REFUSE, asked once, in a dialog.
    //
    // Repositories the pattern would produce already existing is not a
    // refusal - who will accept is not knowable on this screen, and the
    // judgement is acceptance/accept.mjs step 7 (§5.1.1). It is worth asking
    // about once, and this is the moment: a permanent control under the field
    // asked every lecturer to have an opinion about a case almost none of them
    // meet, and read as clutter for the rest.
    //
    // ASKED ONCE is the load-bearing half. What fires this is "repositories
    // matching the pattern exist", which is not "a student in this cohort will
    // hit one" - that second question cannot be answered here, which is the
    // whole reason the judgement lives in acceptance. So on the one assignment
    // where it does fire, it would fire on every later save too: the title
    // typo, the new deadline, the publish. Same dialog, same answer, four
    // times, which is how a warning becomes something people click past
    // without reading.
    //
    // It asks while the assignment has no recorded answer, and stops once it
    // has one. A CHANGED PATTERN asks again, because it is a different question
    // about a different set of repositories and the stored answer was not given
    // about them.
    // NOT ON A TEAM ASSIGNMENT, and that is not an omission. There the answer
    // is fixed: a `{team_slug}` name is not tied to any student, and the
    // repository name carries the slug without the assignment id - so a
    // repository already at it belonged to a DIFFERENT team, and handing it
    // over would give this year's team another cohort's work.
    // `lib/existing-repo.mjs` refuses it, and a dialog offering a choice that
    // does not exist would be a control describing behaviour the system does
    // not have (DESIGN.md §1.5) - as would asking "when a student already owns
    // one" about a team. (`group` is the stored value; the UI says team.)
    // A TEAM ASSIGNMENT IS TOLD, NOT ASKED, and it used to be neither.
    // Suppressing the question suppressed the warning with it, so a lecturer
    // published, students formed teams, and the first team whose name collided
    // was turned away mid-cohort over something knowable at this click.
    //
    // Skipped where the assignment explicitly says `reuse`: the dialog's whole
    // sentence is "a team whose name matches will be turned away", which is
    // false for that assignment, and a warning that does not apply is
    // DESIGN.md §1.5.
    const teams = form.value.assignment_type === 'group'
    const found = teams && form.value.existing_repo_policy === 'reuse'
      ? null
      : existingRepoNote(verdict)
    // WHICH PATTERN THE ANSWER WAS GIVEN ABOUT, not merely that one exists.
    //
    // This asked "does the assignment carry a policy, and is its STORED pattern
    // the one on screen" - and a new assignment has no stored pattern, so the
    // second half was vacuously true for the whole window between answering and
    // the assignment existing. Answer, have the commit fail, change the name,
    // save again: the second save recorded a decision about a set of
    // repositories nobody had been shown. `tests/e2e/61`.
    if (found && existingRepoAnsweredFor.value !== pattern) {
      // The label of the button that opened this, derived the same way the
      // buttons themselves derive it rather than passed down through three
      // callers - a third spelling of "Save & publish" is a third place for it
      // to drift. `saveAssignment()` with no override is saveAndPublish's
      // already-published path, which is the primary button reading `Save`.
      const answer = await askExistingRepos({
        count: found.count,
        orphans: retiredRepoCount(verdict),
        pattern,
        teams,
        confirmLabel: stateOverride === 'draft' ? 'Save as draft' : saveLabel.value,
      })
      // `false` is Cancel. A team assignment confirms with `null`, because it
      // was told rather than asked and there is no answer to record - which is
      // why Cancel cannot be `null` here.
      if (answer === false) return false
      if (answer) form.value.existing_repo_policy = answer
      // Either way this pattern has now been raised, so it is not raised again.
      existingRepoAnsweredFor.value = pattern
    }
  }
  saving.value = true
  if (actionStep.value) actionStep.value = 'Saving…'
  // This save writes `published` for a publish about to be dispatched.
  const startsPublish = inPublishFlow && stateOverride === 'published'
  try {
    const token = getToken()
    const path = assignmentPath(form.value.id)
    const doc = buildDoc(stateOverride)
    const yaml = stringifyYaml(doc)
    const templateBefore = isNew.value ? null : storedTemplate.value
    const permissionBefore = isNew.value ? null : storedStudentPermission.value
    const res = await commitFile(token, props.org, config.controlRepo, path, yaml, isNew.value ? `Create assignment ${form.value.id}` : `Update assignment ${form.value.id}`)
    if (res.ok) {
      // A save that starts a publish (draft to published) is said by the
      // publish's steps (Saved, then the rest); a toast that flashed and
      // vanished beside them was one more box to read. Saving an assignment
      // already published still says Saved.
      if (!startsPublish) toast.success(`Saved ${form.value.id}`)
      // What the document now says, so the next save compares against it.
      storedTemplate.value = doc.template || null
      storedStudentPermission.value = doc.student_permission || 'admin'
      legacyDeadlineOffered.value = storesLegacyDeadline(doc)
      await noticeTemplateChange(form.value.id, templateBefore, doc.template)
      await noticePermissionChange(form.value.id, permissionBefore, doc)
      form.value.state = stateOverride || form.value.state
      snapshotForm()
      // A retitled or rescheduled assignment goes stale on the overview the
      // same way a closed one does - same file, same reason.
      await syncDashboardState(doc)
      await loadAssignments()
      // Stay on the edited assignment
      const stillExists = assignments.value.find((a) => a.id === form.value.id)
      if (stillExists) editing.value = { id: stillExists.id }
      emit('changed')
      // A new assignment has an address now - unless a publish is about to
      // follow this save, which navigates itself when it is done.
      if (stillExists && !inPublishFlow) await goToSavedAssignment()
      // Not inside a publish: the document says published a moment BEFORE the
      // publish is dispatched, so the broker is missing for a good reason, and
      // checking flashed the red "Publish Incomplete ... Action Required" card
      // over a publish that was going fine (2026-10-08). The watch checks it.
      if (form.value.state === 'published' && !startsPublish) {
        verifyLiveInfrastructure(form.value.id)
      }
      await armSentinelIfImminent(doc)
      return true
    }
    toast.error(`Save failed: ${res.data?.message || 'unknown error'}`)
    return false
  } finally {
    saving.value = false
  }
}




// A template changed on an assignment students have already accepted reaches
// none of them: their repositories keep what they were created with until a
// starter sync brings them across, and nothing on this screen said so - a
// lecturer published again, twice, and went looking. One directory read, only
// when the template actually changed. lib/template-change.js decides.
const templateNotice = ref(null)

// THE TWO WHO QUESTIONS and the two stored fields they write (roster_mode,
// require_claim). Every combination is a real mode, so each setter writes the
// pair from both answers and neither can leave the other behind:
//   anyone + email -> open + require_claim     anyone + click -> open
//   roster + email -> claim                     roster + click -> enforced
// Anything that is neither `open` nor `claim` reads as roster + click, which
// is `enforced`: normalizeRosterMode fails closed, and so does this.
function writeWho(who, identity) {
  if (who === 'anyone') {
    form.value.roster_mode = 'open'
    form.value.require_claim = identity === 'email'
  } else {
    form.value.roster_mode = identity === 'email' ? 'claim' : 'enforced'
  }
}
const whoMayAccept = computed({
  get: () => (form.value.roster_mode === 'open' ? 'anyone' : 'roster'),
  set: (who) => writeWho(who, acceptIdentity.value),
})
const acceptIdentity = computed({
  get: () => {
    if (form.value.roster_mode === 'open') return form.value.require_claim ? 'email' : 'click'
    return form.value.roster_mode === 'claim' ? 'email' : 'click'
  },
  set: (identity) => writeWho(whoMayAccept.value, identity),
})
// What the two answers mean together for a student opening the link.
const acceptanceSentence = computed(() => {
  const email = acceptIdentity.value === 'email'
  if (whoMayAccept.value === 'anyone') {
    return email
      ? `Anyone with the link can accept after confirming their ${INSTITUTION_SHORT} email address. The address records who they are; it turns nobody away.`
      : 'Anyone with the link can accept. You will only know their GitHub username.'
  }
  return email
    ? "Only students whose address is in the roster's Email column can accept. They confirm it when they accept."
    : "Only students whose GitHub username is in the roster's GitHub Account column can accept, so fill that column in first."
})

// `claim_address_format` is tri-state and only its opt-out is ever written:
// ticked leaves the field absent (the deployment's rule), unticked is false.
const requireNamedAddress = computed({
  get: () => form.value.claim_address_format !== false,
  set: (on) => { form.value.claim_address_format = on ? undefined : false },
})

// The count behind the warning under the Template repository field. Read once
// per assignment, and only once the field differs from what is saved - an
// assignment whose template nobody touches costs no request.
const repositoryCountFor = ref({ id: null, count: null })
const templateSwitchCount = computed(() => {
  if (isNew.value || !storedTemplate.value) return 0
  const [owner, repository] = String(form.value.template || '').split('/')
  if (!templateChanged(storedTemplate.value, { owner, repository })) return 0
  return repositoryCountFor.value.id === form.value.id ? (repositoryCountFor.value.count || 0) : 0
})
watch(
  () => !isNew.value && !!storedTemplate.value && String(form.value.template || '').toLowerCase() !==
    `${storedTemplate.value.owner}/${storedTemplate.value.repository}`.toLowerCase(),
  async (differs) => {
    const id = form.value.id
    if (!differs || repositoryCountFor.value.id === id) return
    try {
      const files = await listRepoDir(getToken(), props.org, config.controlRepo, repositoriesDir(id))
      repositoryCountFor.value = { id, count: files.filter((f) => f.type === 'file' && f.name.endsWith('.json')).length }
    } catch (e) {
      // No directory is nobody; anything else stays unsaid - the notice after
      // the save asks again and says what it could not read.
      repositoryCountFor.value = { id, count: e?.status === 404 ? 0 : null }
    }
  },
)

// The same shape for `student_permission`: it is read at acceptance, so a
// change reaches nobody who already has a repository unless it is applied to
// them. lib/permission-change.mjs decides who may be changed (nobody past
// their deadline, whose repository may be locked) and does the change,
// pending invitations included.
const storedStudentPermission = ref(null)
const permissionNotice = ref(null)
// Every change landed: the card is good news now, and says so in its colour.
const permissionApplied = computed(() => !!permissionNotice.value?.done && !permissionNotice.value.done.failed.length)
// Past their deadline, or held by a lock whatever the deadline says now.
const permissionPastDeadline = computed(
  () => (permissionNotice.value?.plan?.skip || []).filter((entry) => entry.reason === 'past-deadline' || entry.reason === 'locked').length,
)

async function readJsonDir(token, dir) {
  let files
  try {
    files = await listRepoDir(token, props.org, config.controlRepo, dir)
  } catch (e) {
    if (e?.status === 404) return { ok: true, docs: [] }
    return { ok: false, docs: [] }
  }
  const docs = []
  for (const f of files.filter((x) => x.type === 'file' && x.name.endsWith('.json'))) {
    try {
      const text = await getRepoContent(token, props.org, config.controlRepo, f.path)
      if (text) docs.push(JSON.parse(text))
    } catch {
      return { ok: false, docs }
    }
  }
  return { ok: true, docs }
}

/**
 * Who may be changed, read NOW. Called when the notice is shown and again at
 * the click: a plan made at 15:55 for a 16:00 deadline and applied at 16:05
 * would re-grant every student the sentinel had just locked.
 *
 * Unreadable extensions or reopenings leave students at the base deadline and
 * not reopened: that only skips more of them, the safe direction. An
 * unreadable LOCK RECORD is not safe that way - a lock with a later deadline
 * is exactly what it is read for - so it refuses. Absent is no lock; a file
 * that is there but cannot be decoded is NOT absent.
 *
 * `doc` is the document just saved; without it (the click) the SAVED
 * assignment is read again - a notice kept open across a later save that moved
 * the deadline earlier judged students against the old, later one.
 */
async function readPermissionPlan(id, doc = null) {
  const token = getToken()
  let assignmentDoc = doc
  if (!assignmentDoc) {
    try {
      const text = await getRepoContent(token, props.org, config.controlRepo, assignmentPath(id))
      assignmentDoc = text ? parseYaml(text) : null
    } catch {
      assignmentDoc = null
    }
    if (!assignmentDoc) return { ok: false }
  }
  const records = await readJsonDir(token, repositoriesDir(id))
  if (!records.ok) return { ok: false }
  let lockRecord = null
  const lock = await ghApi(token, 'GET', `/repos/${props.org}/${config.controlRepo}/contents/${lockdownRecordPath(id)}`)
  if (lock.status !== 404) {
    if (!lock.ok || !lock.data?.content) return { ok: false }
    try {
      const bin = atob(String(lock.data.content).replace(/\n/g, ''))
      lockRecord = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))))
    } catch {
      return { ok: false }
    }
  }
  // The SENTINEL'S timelines, beside the lock record: it stops writes at the
  // instant and writes no lock record, so until the nightly finalizes this is
  // the only record the cohort is stopped. Unreadable refuses, like the lock.
  const sentinelTimelines = []
  const lockDir = lockdownRecordPath(id).replace(/\/[^/]+$/, '')
  let lockFiles = []
  try {
    lockFiles = await listRepoDir(token, props.org, config.controlRepo, lockDir)
  } catch (e) {
    if (e?.status !== 404) return { ok: false }
  }
  for (const f of lockFiles.filter((x) => x.type === 'file' && /^sentinel-.*\.json$/.test(x.name))) {
    try {
      const text = await getRepoContent(token, props.org, config.controlRepo, f.path)
      if (!text) return { ok: false }
      sentinelTimelines.push(JSON.parse(text))
    } catch {
      return { ok: false }
    }
  }
  const overrides = await readJsonDir(token, overridesDir(id))
  const reopened = await readJsonDir(token, unlockedDir(id))
  // The same plan at any moment - Apply asks it again per student, because a
  // cohort takes over a minute and a deadline can pass inside the loop.
  const replan = (now = new Date()) => planPermissionApply({
    records: records.docs,
    assignment: assignmentDoc,
    overrides: overrides.docs,
    reopened: reopened.docs.map((d) => d?.github_login).filter(Boolean),
    lockRecord,
    sentinelTimelines,
    now,
  })
  return {
    ok: true,
    empty: !records.docs.length,
    // What is SAVED, so Apply sends that and not what the notice remembered.
    permission: assignmentDoc.student_permission || 'admin',
    plan: replan(),
    replan,
  }
}

async function noticePermissionChange(id, before, doc) {
  const after = doc.student_permission || 'admin'
  if (!before || before === after) return
  const read = await readPermissionPlan(id, doc)
  if (!read.ok) {
    permissionNotice.value = { id, from: before, to: after, unreadable: true, plan: null, done: null }
    return
  }
  if (read.empty) return
  permissionNotice.value = { id, from: before, to: after, unreadable: false, plan: read.plan, done: null, progress: 0 }
}

async function applyPermissionChange() {
  const n = permissionNotice.value
  if (!n?.plan || n.running) return
  n.running = true
  // Planned again at the click, from the SAVED assignment - not trusted from
  // when the notice appeared.
  const fresh = await readPermissionPlan(n.id)
  if (!fresh.ok) {
    n.running = false
    toast.error('Could not read the assignment, who has a repository or which are locked, so nothing was changed.')
    return
  }
  // THE SAVED PERMISSION, not the one this notice was raised for: another tab
  // or another lecturer may have saved a different one since, and applying
  // the old value gave every student a permission the document did not say
  // (third review, 2026-09-26).
  if (fresh.permission !== n.to) {
    n.running = false
    toast.error(`Nothing was changed: the assignment now says ${fresh.permission}, not ${n.to} - it was saved again since this appeared. Save it again to be offered the change.`)
    return
  }
  const promised = n.plan.apply.length
  n.plan = fresh.plan
  if (!n.plan.apply.length) {
    // Not a success: the button promised N and nobody may be changed NOW (the
    // deadline passed, or a lock landed, since the notice appeared).
    n.running = false
    toast.error(`Nobody was changed: the ${promised} student${promised === 1 ? '' : 's'} this offered to change ${promised === 1 ? 'is' : 'are'} now past their deadline or locked.`)
    return
  }
  const token = getToken()
  const request = (method, path, body) => ghApi(token, method, path, body)
  const failed = []
  const gone = []
  const lateNow = []
  let changed = 0
  for (const s of n.plan.apply) {
    // ASKED AGAIN AT THE MOMENT: a cohort costs several requests a student,
    // and a deadline that passes inside the loop must stop the grant there -
    // past it, a grant is an unlock (third review, 2026-09-26).
    if (!fresh.replan(new Date()).apply.some((a) => a.login === s.login)) {
      lateNow.push(s.login)
      n.progress++
      continue
    }
    // onlyIfPresent: a student removed from the repository in GitHub's own
    // settings is skipped, not re-invited (lib/permission-change.mjs).
    const res = await applyStudentPermission(request, { repo: s.repo, login: s.login, permission: n.to, onlyIfPresent: true })
    if (res.ok) changed++
    else if (res.skipped) gone.push(s.login)
    else failed.push(`${s.login} (${res.status ? `HTTP ${res.status}` : res.message || 'no answer'})`)
    n.progress++
  }
  n.running = false
  n.done = { changed, failed, gone }
  const goneNote = (gone.length ? ` ${gone.length} no longer ${gone.length === 1 ? 'has' : 'have'} access and ${gone.length === 1 ? 'was' : 'were'} not re-invited: ${gone.join(', ')}.` : '') +
    (lateNow.length ? ` ${lateNow.length} reached their deadline while this ran and ${lateNow.length === 1 ? 'was' : 'were'} left as ${lateNow.length === 1 ? 'it was' : 'they were'}: ${lateNow.join(', ')}.` : '')
  if (failed.length) toast.error(`Could not change ${failed.length} student${failed.length === 1 ? '' : 's'}: ${failed.join(', ')}.${goneNote}`)
  else toast.success(`${changed} student${changed === 1 ? ' now has' : 's now have'} ${n.to}.${goneNote}`)
}

async function noticeTemplateChange(id, before, after) {
  if (!templateChanged(before, after)) return
  let repositoryCount = null
  try {
    const files = await listRepoDir(getToken(), props.org, config.controlRepo, repositoriesDir(id))
    repositoryCount = files.filter((f) => f.type === 'file' && f.name.endsWith('.json')).length
  } catch (e) {
    // No directory is nobody has accepted; anything else is unknown.
    if (e?.status === 404) repositoryCount = 0
  }
  const notice = templateChangeNotice({ before, after, repositoryCount })
  templateNotice.value = notice ? { ...notice, id } : null
}

/** Save a closed or archived assignment without changing its state. */
async function saveKeepingState() {
  const state = form.value.state
  if (!(await saveAssignment())) return
  // A closed assignment still has a card on the student page (lib/publish.js).
  if (writeReachesStudentPage(state, state)) {
    const started = await republishStudentPages({
      token: getToken(),
      org: props.org,
      failure: 'Saved, but updating the student page failed',
    })
    if (!started) emit('student-page-failed', 'GitHub refused to start it')
  }
}

async function saveAndPublish() {
  inPublishFlow = true
  actionStep.value = 'Checking…'
  let started = false
  try {
    started = await saveAndPublishSteps()
  } finally {
    inPublishFlow = false
    actionStep.value = ''
  }
  // A new assignment moves to its page now that nothing is left running here.
  await goToSavedAssignment({ publishing: started })
  emit('changed')
}

/** @returns {Promise<boolean>} whether a publish was dispatched and is going live */
async function saveAndPublishSteps() {
  // Save current edits first (with state=published) then trigger publish workflow.
  if (form.value.state === 'published') {
    // Gated on the save actually landing: dispatching the publish workflow for
    // a YAML the commit failed to write runs it against the OLD document.
    if (!(await saveAssignment())) return false

    // `!== true`, NOT `=== false`. brokerExists is a THREE-state flag and the
    // third state was being read as "fine": `null` means nobody has looked yet.
    // It is null on arrival and stays null until verifyLiveInfrastructure()
    // resolves, so saving a published assignment inside that window dispatched
    // nothing at all - no broker, and no complaint either.
    //
    // Unknown now dispatches. Publishing again where a broker already exists is
    // a supported operation - it is exactly what Republish broker does - so the
    // cost of guessing wrong is one redundant workflow run. The cost of the
    // other guess is an assignment that says "published" and cannot be
    // accepted.
    //
    // A broker that exists still needs the student page rebuilt: the hub
    // enforces the stored document from this commit on, while the page shows
    // the card from the last regeneration. See publishedSaveWorkflow.
    // A finished one is not published again (the workflow would refuse it and
    // go red over a plain edit); its student page is rebuilt instead.
    if (publishedSaveWorkflow(brokerExists.value) === 'publish-assignment.yml' && !(await finishedRefusal())) {
      await publishExisting()
    } else if (!(await republishStudentPages({
      token: getToken(),
      org: props.org,
      failure: 'Saved, but publishing the change to students failed',
    }))) {
      // The toast says why, once; the status at the top keeps saying it.
      emit('student-page-failed', 'GitHub refused to start it')
    }
    // No "students see this in about two minutes" toast that vanished: the
    // page says, from what students are actually served, when they do
    // (props.studentPage; 2026-10-08).
    return false
  }
  // Where to go back to if the dispatch does not happen. Captured BEFORE the
  // save, because saveAssignment writes 'published' into the form.
  let priorState = form.value.state === 'closed' || form.value.state === 'archived'
    ? form.value.state
    : 'draft'
  // What it IS, not what this tab believes. The workflow trusts prior_state
  // over the file, so a tab still showing a draft that another tab has since
  // published sent `draft`, and a failed run would then demote a live
  // assignment. Unreadable keeps the tab's answer; the workflow is no worse
  // off than before it had one.
  if (!isNew.value) {
    try {
      const text = await getRepoContent(getToken(), props.org, config.controlRepo, assignmentPath(form.value.id))
      const stored = text ? parseYaml(text)?.state : null
      if (['draft', 'published', 'closed', 'archived'].includes(stored)) priorState = stored
    } catch {
      // keep the tab's answer
    }
  }

  // A FINISHED assignment is not published again - the workflow refuses it
  // (lib/finished-assignment.mjs), and by then this page had already written
  // `published` over `closed`. Asked here first, with the deadline about to be
  // saved: moving it into the future is how one is reopened. Unreadable lets
  // the workflow decide; it asks again either way.
  const refusal = await finishedRefusal()
  if (refusal) {
    toast.error(refusal)
    return false
  }

  await saveAssignment('published')
  if (form.value.state === 'published') {
    // Wrapped, because "the dispatch returned a failure" and "the dispatch
    // never returned" leave the SAME wreckage: a YAML that says published with
    // no broker behind it, and a student-facing accept link that goes nowhere.
    //
    // Only the first was handled. `publishExisting` has a try/finally and no
    // catch, and this function had neither, so anything that THREW between the
    // commit and the revert walked straight out of both and left the assignment
    // stranded - silently, because the toast that explains a failed dispatch is
    // in the branch that no longer runs.
    //
    // PXL-Automation-II/test-pe-1 (2026-09-02) reached exactly that state: the
    // file committed as published at 01:18:21Z, no publish workflow ran all
    // day, and no revert commit was ever made. The trigger is not established -
    // it may have been the page going away rather than an exception - so this
    // does not claim to fix the cause. It makes the outcome survivable.
    let dispatched = false
    try {
      dispatched = await publishExisting({ prior: priorState })
    } catch (e) {
      console.error('Publish dispatch threw', e)
      dispatched = false
    }
    if (!dispatched) await revertAfterFailedPublish(priorState)
    return dispatched
  }
  return false
}

/**
 * Put the state back after a dispatch that never happened.
 *
 * Takes the state to return to rather than assuming `draft`. Reopening a
 * `closed` assignment goes through the same publish path, and a failed dispatch
 * used to leave it `draft` - a different assignment from the one the lecturer
 * had, and not a change they asked for.
 *
 * @param {'draft'|'closed'|'archived'} toState
 */
async function revertAfterFailedPublish(toState = 'draft') {
  try {
    const token = getToken()
    const path = assignmentPath(form.value.id)
    const doc = buildDoc(toState)
    const yaml = stringifyYaml(doc)
    const res = await commitFile(token, props.org, config.controlRepo, path, yaml, `Revert ${form.value.id} to ${toState} (publish dispatch failed)`)
    if (res.ok) {
      form.value.state = toState
      brokerExists.value = null
      pagesLive.value = null
      snapshotForm()
      // The publish did not happen, so nothing else will correct the overview -
      // and "published" is exactly the state it must not be left saying.
      await syncDashboardState(doc)
      await loadAssignments()
      toast.error(`Publish dispatch failed. ${form.value.id} was reverted to ${toState}. Fix hub access and publish again.`)
    } else {
      toast.error(`Publish dispatch failed AND the revert to ${toState} failed: ${res.data?.message || 'unknown error'}. The YAML still says "published" but no broker exists. Set the state back to ${toState} manually.`)
    }
  } catch (e) {
    console.error('Failed to revert state after failed publish:', e)
  }
}

async function handlePublishClick() {
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
  if (reopening && !(await askConfirm({
    title: `Reopen "${form.value.title || form.value.id}" for acceptance?`,
    paragraphs: ['Publishing sets it back to published, so students with the link can accept it again until the deadline.'],
    confirmLabel: 'Reopen for acceptance',
  }))) return

  // SAVE FIRST. publish-assignment.yml reads the STORED document, so pressing
  // Publish with edits on screen dispatched against the previously saved
  // version - the workflow then wrote `state: published` onto that older
  // document and the edits were simply not part of what went live. Nothing said
  // so: the publish succeeded, the broker appeared, and the assignment students
  // accepted was not the one on screen.
  //
  // saveAssignment's own docstring already warns about exactly this - "dispatching
  // the publish workflow for a YAML the commit failed to write runs it against
  // the OLD document" - and saveAndPublish was gated on it. This path never was.
  //
  // Delegated rather than reimplemented, so there is ONE save-then-dispatch:
  // saveAndPublish carries the failed-dispatch revert and the broker gate, and a
  // second copy here would drift from them the way every other duplicated rule
  // in this repository has.
  await saveAndPublish()
}

// `regenerate` arrives from the dialog, which owns the tick. `regenerateInvite`
// is now only what the dialog OPENS with - openRegenerate() sets it, and the
// repair path clears it - so the two are deliberately different things.
async function confirmRepublish(regenerate) {
  // The secret being retired, taken before the form forgets it: the page
  // around the editor must stop offering it too (`regenerated`).
  const retiring = form.value.invite_key || form.value.invite_token || ''
  const ok = await publishExisting({ regenerate })
  if (ok) {
    showRepublishModal.value = false
    if (regenerate) {
      emit('regenerated', retiring)
      // The old secret is still in the form until the workflow writes the new
      // one; clear it so nothing can copy a link the broker is about to reject.
      // BOTH halves: clearing only the token would leave a migrated
      // assignment's key in place and the panel would go on offering a link
      // that regeneration has just retired.
      form.value.invite_token = ''
      form.value.invite_key = ''
      form.value.invite_pubkey = ''
      toast.info('Regenerating - the new link appears in the Invite link menu once the workflow finishes. The old one stops working now.')
    }
    regenerateInvite.value = false
    emit('changed')
  }
}

/**
 * Why publishing this assignment now would be refused as finished, or null.
 * The workflow's own judge (lib/finished-assignment.mjs), asked with the
 * deadline on screen - that is what the save is about to write, and moving it
 * into the future is how a finished assignment is reopened. A lock record that
 * cannot be read is null: the workflow asks again with its own checkout.
 */
async function finishedRefusal() {
  if (isNew.value || !form.value.id) return null
  const local = form.value.deadline_at_local
  const deadlineAt = local ? localToUtc(local) : (form.value._deadline_at_original || null)
  if (!deadlineAt || !Number.isFinite(Date.parse(deadlineAt)) || Date.parse(deadlineAt) > Date.now()) return null
  const lock = await ghApi(getToken(), 'GET', `/repos/${props.org}/${config.controlRepo}/contents/${lockdownRecordPath(form.value.id)}`)
  if (lock.status !== 200 && lock.status !== 404) return null
  if (!republishRefusal({ deadlineAt: new Date(deadlineAt).toISOString(), lockRan: lock.status === 200 })) return null
  // The judge's sentence is the workflow log's; this is the lecturer's - and
  // only what the record says: an assignment that does not lock gets a record
  // too (`lock_method: none`), and "its submissions are locked" was untrue there.
  let lockMethod = null
  try {
    lockMethod = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(String(lock.data?.content || '').replace(/\n/g, '')), (c) => c.charCodeAt(0))))?.lock_method ?? null
  } catch {
    lockMethod = null
  }
  const what = lockMethod === 'none' ? 'its work was collected' : 'its submissions are locked'
  return `"${form.value.title || form.value.id}" is finished: its deadline has passed and ${what}. To reopen it, move the deadline into the future first.`
}

// Returns true when the workflow_dispatch was accepted by GitHub.
//
// `regenerate` mints a fresh nonce, which retires every link already handed
// out. It is an input on publish-assignment.yml that nothing in the app ever
// sent, so the only way to rotate a leaked link was the Actions tab.
async function publishExisting({ regenerate = false, prior = form.value.state } = {}) {
  publishing.value = true
  lastPublishRunId = null
  const own = !actionStep.value
  actionStep.value = 'Starting the publish…'
  try {
    const token = getToken()
    // WITH the run it started (`return_run_details`), so the publishing line
    // follows this publish and nobody else's (lib/publish-progress.js).
    const res = await dispatchWorkflowRun(token, config.hubOwner, config.hubRepo, 'publish-assignment.yml', {
      org: props.org,
      assignment_id: form.value.id,
      // workflow_dispatch boolean inputs arrive as strings over the REST API.
      regenerate_invite: regenerate ? 'true' : 'false',
      // What it was before this publish. Save & publish has already written
      // `published` by now, so the workflow cannot read it from the file -
      // and a failed or refused publish puts back exactly this.
      prior_state: ['draft', 'published', 'closed', 'archived'].includes(prior) ? prior : '',
    })
    if (res.ok || res.status === 204) {
      // No toast: the steps at the top and in the bar say it, and stay.
      lastPublishRunId = res.runId
      startPublishWatch({ runId: res.runId })
      return true
    }
    toast.error(explainDispatchFailure(res, 'Publish failed'))
    return false
  } finally {
    publishing.value = false
    if (own) actionStep.value = ''
  }
}



// Copying the link lives in InvitationShare.vue, not here. There were three
// implementations of "put the link on the clipboard" across two views, each
// with its own guard against writing the string "null" - one of them silently
// broken for months (tests/invitation-link-surface.test.mjs). One component
// owns it now.

async function deleteDraft() {
  if (form.value.state !== 'draft') return
  // Only a draft that never went live: removing the file is all there is to
  // it. One that did (Back to draft) has a broker and maybe students, and the
  // full delete is what removes those (lib/state-actions.js).
  if (everPublished(form.value)) {
    showDeleteModal.value = true
    return
  }
  // Said by the assignment's title and in what it means to the lecturer, not
  // by its id and the file it lives in (DESIGN.md §1.6).
  const name = form.value.title || form.value.id
  if (!(await askConfirm({
    title: `Delete the draft "${name}"?`,
    paragraphs: ['It was never published, so nobody can have accepted it.'],
    confirmLabel: 'Delete draft',
    destructive: true,
  }))) return
  deleting.value = true
  try {
    const token = getToken()
    const res = await deleteFile(token, props.org, config.controlRepo, assignmentPath(form.value.id), `Delete draft assignment ${form.value.id}`)
    if (res.ok) {
      toast.success(`Deleted the draft "${name}".`)
      editing.value = null
      await leaveEditor({ deleted: true })
    } else {
      toast.error(`Delete failed: ${res.data?.message || 'unknown error'}`)
    }
  } finally {
    deleting.value = false
  }
}

/**
 * Keep `reports/dashboard.json` telling the truth about a document we just wrote.
 *
 * The overview reads its state, its title and its dates from that file, and
 * only `publish-assignment.yml` ever asks for a regeneration. So closing or
 * archiving an assignment left the overview reading **accepting** - and for an
 * archived one nothing was ever going to correct it, because the nightly that
 * regenerates disables itself once no assignment is active (reported
 * 2026-09-04, two assignments, both still "accepting").
 *
 * MERGE, NEVER REPLACE. Only the fields the document owns are overwritten;
 * the counts came from a report this has not read and are none of its
 * business. `assignmentFacts` is the one list of which is which.
 *
 * Silent about everything else on purpose. It is a repair on the way past, not
 * an operation the lecturer asked for: no entry yet means the assignment has
 * never been reported on and regeneration owns creating it, and a failed write
 * must not turn a successful save into an error message.
 */
async function syncDashboardState(doc) {
  if (!doc?.id) return
  try {
    const token = getToken()
    const path = 'reports/dashboard.json'
    const existing = await getRepoContent(token, props.org, config.controlRepo, path)
    if (!existing) return
    const dashboard = JSON.parse(existing)
    const entry = dashboard?.assignments?.[doc.id]
    if (!entry) return

    const patched = { ...entry, ...assignmentFacts(doc) }
    // Nothing changed that this file records - do not spend a commit saying so.
    if (JSON.stringify(patched) === JSON.stringify(entry)) return

    dashboard.assignments[doc.id] = patched
    const res = await commitFile(
      token,
      props.org,
      config.controlRepo,
      path,
      JSON.stringify(dashboard, null, 2) + '\n',
      `Update ${doc.id} on the dashboard`,
    )
    // A failed repair is worth one sentence. Staying quiet is what let the
    // overview go on saying "accepting" about an archived assignment in the
    // first place, and the lecturer at least needs to know not to trust it.
    if (!res.ok) {
      toast.info(`Saved. The assignments overview may still show the old state until it is regenerated.`)
    }
  } catch (e) {
    console.error('Could not update the dashboard entry', e)
  }
}

/**
 * The report's student rows, for the manifest - or none, if it cannot be read.
 *
 * A report that will not parse must not take the delete down with it: the
 * evidence copy is written verbatim either way, and the manifest simply records
 * nothing about the archive rather than guessing. An unreadable report is not
 * evidence of an empty cohort.
 */
function retiredStudents(reportJson) {
  if (!reportJson) return []
  try {
    const parsed = JSON.parse(reportJson)
    return Array.isArray(parsed?.students) ? parsed.students : []
  } catch {
    return []
  }
}

/**
 * Delete an assignment: everything PXL Classroom made, except the evidence.
 *
 * GitHub Classroom's delete takes the student repositories with it, which is
 * the reputation the word carries. Classroom50's keeps them. So does this.
 *
 * ORDER MATTERS, and it is broker-first. The nightly finds work by walking
 * `assignments/`, so an assignment removed while its broker still stands is a
 * public repository nothing will ever close or clean - CLAUDE.md's rule that
 * whatever `publish` switches on, something has to switch off. Deleting the
 * broker first fails in the safe direction: an assignment that still exists
 * with no broker is closed anyway.
 *
 * The control-repo half is ONE atomic commit: the evidence is written and the
 * working data removed together, so there is no state where the report is gone
 * and `retired/` was never written.
 */
async function deleteAssignment() {
  const id = form.value.id
  const token = getToken()
  if (!id || !token) return

  deleting.value = true
  try {
    // 1. EVIDENCE FIRST, read before anything is removed.
    // A failed read is not an absent report: `null` would read as "no report"
    // and the check below would blame a regeneration for a read that failed.
    let reportUnreadable = false
    const [reportJson, reportCsv, gradingJson] = await Promise.all([
      getRepoContent(token, props.org, config.controlRepo, reportPath(id)).catch(() => {
        reportUnreadable = true
        return null
      }),
      getRepoContent(token, props.org, config.controlRepo, reportCsvPath(id)).catch(() => null),
      getRepoContent(token, props.org, config.controlRepo, gradingSummaryPath(id)).catch(() => null),
    ])

    // 1b. ...AND CURRENT. The report is rebuilt a minute or so after a
    //     finalize commits the lock and preservation, and this commit removes
    //     those sources while keeping the report as evidence - so a report read
    //     inside that minute would be kept for ever saying nothing was
    //     preserved. Refuse, and start the rebuild the lecturer is waiting for
    //     (lib/report-freshness.mjs). Before the broker: nothing has changed yet.
    if (deleteWaitsForReport(form.value.state)) {
      if (reportUnreadable) {
        toast.error(UNREADABLE_REPORT_REFUSAL)
        return
      }
      let report = null
      try { report = reportJson ? JSON.parse(reportJson) : null } catch { report = null }
      const freshness = await readReportFreshness(
        (method, path) => ghApi(token, method, path),
        { owner: props.org, repo: config.controlRepo, assignmentId: id, derivedFrom: report?.derived_from },
      )
      if (freshness === 'unknown') {
        toast.error(UNKNOWN_REPORT_REFUSAL)
        return
      }
      if (freshness === 'stale') {
        toast.error(STALE_REPORT_REFUSAL)
        await republishStudentPages({ token, org: props.org, failure: 'Nothing was deleted, and starting the report rebuild failed' })
        return
      }
    }

    // 2. Every path this assignment owns, from ONE tree read rather than a
    //    listing per directory. `observations/<id>/<login>/<file>` is three
    //    levels deep, and walking it a directory at a time is a request per
    //    student.
    const tree = await ghApi(
      token,
      'GET',
      `/repos/${props.org}/${config.controlRepo}/git/trees/main?recursive=1`,
    )
    if (!tree.ok) {
      toast.error(`Could not read the control repository, so nothing was deleted (HTTP ${tree.status}).`)
      return
    }
    if (tree.data?.truncated) {
      // A truncated tree is a partial answer, and deleting from one leaves
      // whatever it did not list behind for ever - unreachable from any surface
      // because the assignment is gone. Refuse rather than half-delete.
      toast.error('The control repository is too large to enumerate safely. Nothing was deleted.')
      return
    }

    const owned = (tree.data.tree || [])
      .filter((e) => e.type === 'blob')
      .map((e) => e.path)
      .filter(
        (p) =>
          p === assignmentPath(id) ||
          p === reportPath(id) ||
          p === reportCsvPath(id) ||
          ASSIGNMENT_OWNED_DIRS.some((d) => p.startsWith(`${d}/${id}/`)),
      )

    // 3. The broker, before any record is removed.
    const broker = brokerRepoName({ assignment: form.value })
    const brokerRes = await getRepo(token, props.org, broker)
    if (brokerRes.ok) {
      const del = await ghApi(token, 'DELETE', `/repos/${props.org}/${broker}`)
      if (!del.ok && del.status !== 404) {
        toast.error(
          del.status === 403
            ? `GitHub refused to delete ${broker}. Deleting a repository needs the PXL Classroom App's "Administration" permission and an organization owner. Nothing else was changed.`
            : `Could not delete ${broker} (HTTP ${del.status}). Nothing else was changed.`,
        )
        return
      }
    } else if (brokerRes.status !== 404) {
      toast.error(`Could not check whether ${broker} still exists, so nothing was deleted.`)
      return
    }

    // 3b. The ORGANIZATION ruleset, if this cohort was locked with one.
    //
    // Repository rulesets need no cleanup: they live inside student
    // repositories, which this delete deliberately never touches, so they die
    // with the repositories whenever the lecturer removes those. An
    // organization ruleset lives in the ORGANIZATION and would simply be left
    // behind - still named after an assignment that no longer exists, still
    // blocking pushes to whatever repositories it targets.
    //
    // Not fatal, unlike the broker. A leftover ruleset is untidy and visible in
    // the organization's settings; a leftover broker is a public repository
    // holding a key with a door nothing will ever close. Different costs, so
    // different handling - the delete continues and the manifest records what
    // happened either way.
    let orgRulesetRemoved = null
    const orgLock = await findOrgSubmissionLock(
      (method, path, body) => ghApi(token, method, path, body),
      { org: props.org, assignmentId: id },
    )
    if (orgLock.ok && orgLock.ruleset) {
      const del = await ghApi(token, 'DELETE', `/orgs/${props.org}/rulesets/${orgLock.ruleset.id}`)
      orgRulesetRemoved = del.ok || del.status === 404
      if (!orgRulesetRemoved) {
        toast.warning(
          `The organization ruleset "${orgLock.ruleset.name}" could not be removed (HTTP ${del.status}). ` +
            `Delete it by hand in the organization's Settings → Rules; the rest of the deletion continued.`,
        )
      }
    }

    // 4. One commit: write the evidence, remove the working data, and take the
    //    entry off the dashboard.
    const changes = [
      {
        path: retiredManifestPath(id),
        // The record that outlives the assignment - what went, when, by whom,
        // and where the code still is. lib/retired-manifest.mjs owns its shape,
        // so schemas/retired-manifest.schema.json has one document to describe
        // and the e2e fixture checks every write of it against that schema.
        content: JSON.stringify(
          buildRetiredManifest({
            org: props.org,
            assignmentId: id,
            title: form.value.title,
            deletedBy: user.value?.login,
            brokerRepo: broker,
            brokerDeleted: brokerRes.ok,
            removedPaths: owned,
            // The report this delete already read as evidence, so the manifest
            // can say where the submissions actually went and how many there
            // were - rather than composing an archive name and hoping.
            students: retiredStudents(reportJson),
            // Null when this cohort was never held by an organization ruleset,
            // so the manifest omits the field rather than recording a `false`
            // that reads as a failed removal.
            orgRulesetRemoved,
          }),
          null,
          2,
        ) + '\n',
      },
      ...owned.map((path) => ({ path, content: null })),
    ]
    if (reportJson) changes.push({ path: `${retiredDir(id)}/report.json`, content: reportJson })
    if (reportCsv) changes.push({ path: `${retiredDir(id)}/report.csv`, content: reportCsv })
    if (gradingJson) changes.push({ path: `${retiredDir(id)}/grading.json`, content: gradingJson })

    const dashboardText = await getRepoContent(token, props.org, config.controlRepo, DASHBOARD_PATH).catch(() => null)
    if (dashboardText) {
      try {
        const dashboard = JSON.parse(dashboardText)
        if (dashboard?.assignments?.[id]) {
          delete dashboard.assignments[id]
          changes.push({ path: DASHBOARD_PATH, content: JSON.stringify(dashboard, null, 2) + '\n' })
        }
      } catch { /* a dashboard we cannot parse is not ours to rewrite */ }
    }

    const res = await commitFiles(
      token,
      props.org,
      config.controlRepo,
      changes,
      `Delete assignment ${id}`,
    )
    if (!res.ok) {
      toast.error(`Delete failed: ${res.error || `HTTP ${res.status}`}. The broker is gone; nothing else changed.`)
      return
    }

    toast.success(`Deleted ${id}. Grades and the report are in ${retiredDir(id)}/.`)
    showDeleteModal.value = false
    editing.value = null
    await leaveEditor({ deleted: true })
  } catch (e) {
    toast.error(`Delete failed: ${e.message || String(e)}`)
  } finally {
    deleting.value = false
  }
}

async function setState(newState) {
  // Asked in the state menu's own words (lib/state-actions.js), by title.
  const name = form.value.title || form.value.id
  const questions = {
    draft: {
      title: `Move "${name}" back to draft?`,
      paragraphs: ['The invitation link stops working, so students can no longer open it. Existing repositories are untouched.'],
      confirmLabel: 'Back to draft',
      destructive: true,
    },
    closed: {
      title: `Stop accepting "${name}"?`,
      paragraphs: ['Nobody new can accept it. Existing repositories are untouched.'],
      confirmLabel: 'Stop accepting',
      destructive: true,
    },
    archived: {
      title: `Archive "${name}"?`,
      paragraphs: ['It leaves the student-facing list and day-to-day tracking. Existing repositories are untouched.'],
      confirmLabel: 'Archive',
      destructive: true,
    },
  }
  if (questions[newState] && !(await askConfirm(questions[newState]))) return
  const before = form.value.state
  saving.value = true
  try {
    const token = getToken()
    const path = assignmentPath(form.value.id)
    const doc = buildDoc(newState)
    const yaml = stringifyYaml(doc)
    const res = await commitFile(token, props.org, config.controlRepo, path, yaml, `Set ${form.value.id} state to ${newState}`)
    if (res.ok) {
      form.value.state = newState
      snapshotForm()
      toast.success(`${form.value.id} -> ${newState}`)
      await syncDashboardState(doc)
      // After the sync, so the run checks out the overview this just wrote. A
      // closed assignment whose page still says published offers an Accept
      // button the hub refuses.
      if (writeReachesStudentPage(before, newState)) {
        await republishStudentPages({
          token,
          org: props.org,
          failure: 'Saved, but publishing the change to students failed',
        })
      }
      await loadAssignments()
      emit('changed')
    } else {
      toast.error(`Update failed: ${res.data?.message || 'unknown error'}`)
    }
  } finally {
    saving.value = false
  }
}

// ---------------------------------------------------------------- lifecycle

/**
 * Open what the URL asks for. The ONLY place that reads a route query.
 *
 * There were two copies of this - one here and one inside loadAssignments() -
 * which is how they came to disagree about whether the query had been consumed.
 * A loader must never change what the user is editing; see the comment in
 * loadAssignments() for what that cost.
 *
 * The page is a LOCATION - a new assignment, or one assignment's settings -
 * and a refresh lands back on it. Two queries ride on it, and both are
 * ACTIONS, consumed once so a refresh never repeats them:
 *
 *   ?action=<key>   a state change asked for from another tab's state button
 *                   (runStateAction), carried out here with its own
 *                   confirmation.
 *   ?section=<name> where to scroll: `grading` is the Grading tab's "Set up
 *                   grading".
 *
 * The route has already been left or changed by the time this runs, and the
 * router's leave guard asked about unsaved edits on the way, so opening what
 * the address names does not ask again.
 */
async function applyRouteIntent() {
  if (props.mode === 'new') {
    if (!isNew.value) newAssignment({ confirmed: true })
    return
  }
  const a = assignments.value.find((x) => x.id === props.assignmentId)
  if (!a) {
    // A file that failed to read this time is not gone: the form on screen,
    // and any edit waiting in it, stays.
    if (unreadableIds.value.has(props.assignmentId) && editing.value?.id === props.assignmentId) return
    editing.value = null
    return
  }
  if (!editing.value || editing.value.id !== a.id) editAssignment(a, { confirmed: true })
  // `publishing`: a new assignment's Save & publish is going live, and the
  // page that started it is gone (goToSavedAssignment) - carry the watch on.
  const { action, section, publishing, ...rest } = route.query
  if (!action && !section && !publishing) return
  await router.replace({ query: rest })
  await nextTick()
  if (typeof publishing === 'string' && publishing) startPublishWatch({ runId: publishRunIdFrom(publishing) })
  if (section === 'grading') await scrollToSection('settings-grading')
  if (typeof action === 'string') runStateAction(action)
}

onMounted(async () => {
  if (window.location.hash === LEGACY_ROSTER_HASH) {
    router.replace({ name: 'roster', params: { org: props.org } })
    return
  }
  window.pxlHasUnsavedState = () => hasUnsavedEdits()
  window.addEventListener('beforeunload', onBeforeUnload)
  document.addEventListener('click', handleClickOutside)
  if (!isAuthenticated()) { loadingList.value = false; return }
  user.value = getUser()
  // Chained onto the LIST only, not onto all three. `?edit=<id>` needs the
  // assignment list and nothing else, and hanging it off Promise.all made
  // opening a deep link wait for the cohort report - a request that can be
  // slow, and which tests/e2e/38 holds open on purpose to check the card says
  // "reading the report…" rather than guessing a number. Behind Promise.all
  // the assignment was never selected at all while that request was in flight.
  const listed = loadAssignments().then(() => applyRouteIntent())
  await Promise.all([listed, loadTemplates(), loadRoster()])
})

onUnmounted(() => {
  window.pxlHasUnsavedState = null
  window.removeEventListener('beforeunload', onBeforeUnload)
  document.removeEventListener('click', handleClickOutside)
  stopPublishWatch()
})

watch(
  () => form.value.title,
  () => {
    if (isNew.value && !manualSlug.value) autoSyncSlug()
  }
)

// The route, not only its query: Settings and New are the same component, so
// saving a new assignment, or going from one to the other, changes the
// props under a page that stays mounted.
watch(
  () => route.fullPath,
  () => applyRouteIntent(),
)
</script>

<style scoped>
.admin-page {
  padding-top: var(--space-xl);
  padding-bottom: var(--space-2xl);
  max-width: 1400px;
}
.new-assignment-back {
  margin-bottom: var(--space-md);
}
/* `.back-link` lives in style.css - it is on two views, so a scoped copy here
   was a fork with a second chance to drift. */

.btn-with-icon { display: inline-flex; align-items: center; gap: var(--space-xs); }

/* Under the template badge, because Submission ref itself is inside the
   collapsed Advanced section (lib/template-source.mjs, submissionBranchProvisioned). */
.submission-branch-warning { display: block; margin-top: var(--space-xs); }

/* Inside the assignment page as its Settings tab: that page's container and
   header already frame it, so no page padding of its own. */
.admin-embedded {
  padding-bottom: var(--space-lg);
}
/* No card around the form there (DESIGN.md §1.1): the other tabs put their
   content straight on the page, and a bordered box under the tabs is what made
   Settings look like a different application (reported 2026-10-03). The column
   width stays - it is the form's reading measure (DESIGN.md §1.8). */
.admin-embedded .editor-pane {
  background: transparent;
  border: none;
  padding: 0;
  max-width: var(--form-measure);
}

/* What is left of the cohort card on Settings: Add students. */
.settings-quick-actions {
  display: flex;
  gap: var(--space-sm);
}

/* The section list, the form's left neighbour. Its marker is the tabs' own -
   the active one in orange, standing on a side instead of underneath - so it
   reads as navigation of the same family (DESIGN.md §1.4). */
.settings-nav { display: none; }
@media (min-width: 960px) {
  .admin-layout.has-section-nav {
    grid-template-columns: 11rem minmax(0, 1fr);
    column-gap: var(--space-xl);
  }
  .settings-nav {
    display: flex;
    flex-direction: column;
    position: sticky;
    top: var(--sticky-top);
    align-self: start;
    border-left: 1px solid var(--border-muted);
  }
}
.settings-nav-link {
  color: var(--text-secondary);
  font-size: 0.88rem;
  padding: 6px var(--space-md);
  margin-left: -1px;
  border-left: 2px solid transparent;
  text-decoration: none;
}
.settings-nav-link:hover {
  color: var(--text-primary);
  border-left-color: var(--border-default);
  text-decoration: none;
}
.settings-nav-link.active {
  color: var(--text-primary);
  font-weight: 600;
  border-left-color: var(--accent-orange);
}
/* A section jumped to lands below the sticky header, not under it. */
.editor-form fieldset,
.editor-form .advanced,
.editor-form .lifecycle { scroll-margin-top: var(--sticky-top); }

.admin-layout {
  display: grid;
  /* `minmax(0, 1fr)`, never a bare `1fr`. A `1fr` track's automatic minimum is
     its content's min-content size, and the invitation link is `white-space:
     nowrap`, so its min-content IS its max-content - a 122-character URL. The
     track grew to fit it and the editor pane pushed the page 208px wider than
     a 375px phone, sideways-scrolling the whole admin route. The floor makes
     the child ellipsise (which it is already styled to do) instead of the
     track widening. tests/e2e/25-responsive-layout.spec.mjs covers this route.
     One column: the list of assignments that sat beside the editor is the
     Assignments tab now. */
  grid-template-columns: minmax(0, 1fr);
}

.list-loading, .list-empty {
  padding: var(--space-md);
  color: var(--text-secondary);
  text-align: center;
}
/* BADGES */
.badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 0.75rem;
  text-transform: lowercase;
}

/* EDITOR */
.editor-pane {
  /* THE BORDER HUGS THE FORM, because a card that grows around contents that
     do not is a card with a hole in it. The pane is the grid's `1fr` track, so
     it filled whatever was going: measured at 818px on a 1200px window and
     1008px on anything from 1600px up, around a form fixed at 640px - 368px of
     empty space INSIDE a border. Capping the pane moves that space outside,
     where it reads as page margin instead of a gap in a panel.

     ONE NUMBER, USED TWICE. `--form-measure` is the form's width and the thing
     this border is sized from, so the two cannot drift; the +2px is the border
     itself. It lives in style.css's `:root` beside `--gutter` rather than here
     - a component-local custom property reads as dangling to the guard that
     stops a `var()` silently dropping, and it cannot tell the difference.

     Left-aligned, not centred: the tabs and the assignment list above and
     beside it are, and a centred card under left-aligned tabs would be the odd
     one out. The whole content column already centres in `.container`, which
     is where the page-level balance comes from. */
  max-width: calc(var(--form-measure) + 2 * var(--space-lg) + 2px);
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
/* THE FORM IS A COLUMN, AND THE COLUMN IS WHAT HAS A WIDTH.
   The pane is 958px and everything in it used to be measured separately: the
   inputs at 353px, the template picker at 518px, and the help text at the full
   908px - three edges, so the eye never found one. The <small> under a field
   was twice the width of the field, which is most of what read as "terrible".
   Bounding the column instead gives one left edge and one right edge, and the
   controls simply fill it.
   640px is chosen for the TEXT: at 14px it is about 90 characters, against the
   ~110 the full pane was giving, and the longest thing a control has to show
   (`PXL-2TIN-CloudEssentials-2627/linux-processes-starter`, 52 characters plus
   a refresh button) still fits without truncating. A max, so a narrow window
   still collapses it rather than scrolling sideways. */
.editor-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-md);
  /* The same token `.editor-pane` sizes its border from, so the card and the
     column it wraps cannot drift apart. */
  max-width: var(--form-measure);
}
/* The Advanced disclosure is not a fieldset and carried no styling at all, so
   its three fields sat 16px wider than every other field on the form - the one
   ragged edge left once the column was bounded, and invisible until the widths
   were measured rather than looked at. A fieldset's content starts at its 1px
   border plus its padding; this matches that and takes no border of its own,
   because it is a disclosure rather than a group. */
.advanced {
  padding: 0 var(--space-md);
}
/* TWO FIELDS ON ONE ROW, for a pair that is read together and is short enough
   that a full-width box overstates it. `minmax(0, 1fr)` and not `1fr`
   (DESIGN.md 7): a bare `1fr` floors at the content's min-width, so a long
   validation message under one date would push the row wider than the column
   instead of wrapping inside its half.
   Collapses to a stack before the boxes get too narrow to read a date in. */
.field-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: var(--space-md);
}
.field-row > .field { margin-bottom: 0; }
@media (max-width: 560px) {
  .field-row { grid-template-columns: minmax(0, 1fr); }
  .field-row > .field:not(:last-child) { margin-bottom: var(--space-md); }
}
/* THE FORM'S ONE ACTION ROW, stuck to the bottom of the window while the form
   scrolls under it, so Save is reachable from the last section without
   scrolling back up. A surface of its own with a single top divider - not a
   box (DESIGN.md §1.1). `position: sticky` and no transform: an ancestor with
   a transform would turn every modal on this page into a child of it
   (tests/e2e/47). */
.editor-action-bar {
  position: sticky;
  bottom: 0;
  z-index: 5;
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  flex-wrap: wrap;
  padding: var(--space-sm) 0;
  background: var(--bg-canvas);
  border-top: 1px solid var(--border-muted);
}
.editor-action-buttons {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  flex-wrap: wrap;
  margin-left: auto;
}
/* Beside the buttons it explains. */
.save-blockers {
  margin: 0;
  font-size: 0.8rem;
  color: var(--text-secondary);
}
.unsaved-note {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 0.8rem;
  color: var(--text-secondary);
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
/* A `.field` is a flex COLUMN, so a child with no width of its own stretches
   the full measure - which centred the text of "Add a description" and made a
   link look like a heading. Everything else in a field is a full-width control
   or a line of text, so this only ever bites a bare button. */
.field > .btn-link { align-self: flex-start; }
/* ONE MEASURE, ON THE COLUMN - see `.editor-form` below.
   Per-control caps lived here and were the wrong answer: they produced THREE
   widths on one screen (353px inputs, a 518px template picker, and help text
   running the full 908px), which is neither uniform nor meaningful. The
   controls fill their column now and the column is what is bounded. */
/* What a name would land on top of. Scoped, because this is the only place
   they are listed - style.css is for classes more than one component reaches.
   No colour of its own: it inherits from whichever block wraps it, which is
   .field-error-msg for a refusal and .text-muted for a warning. */
.collision-list {
  margin: 4px 0;
  padding-left: var(--space-md);
  list-style: disc;
}
.collision-list li { margin: 2px 0; }
/* The remedies sit under the findings with air between them: what is wrong and
   what to do about it are two thoughts, and run together they read as one
   paragraph of red. `ol` keeps its numbers - they are how a lecturer says
   "I did the first one". */
.collision-ways { margin-top: var(--space-sm); }
.collision-ways .collision-list { list-style: decimal; }
.collision-rec { margin-left: 0.35em; }
/* Matches the <small> the field already renders beneath it, so a warning and
   the field's own help text read as one voice. */
.collision-note { font-size: 0.82rem; }
/* A VALUE THIS FORM WORKED OUT, not a question it is asking. One row so the
   label, the value and the way to change it read as a single statement rather
   than as another field - which is the whole point of demoting the slug.
   `align-items: baseline` because the <code> and the <button> have different
   line boxes and a centred row makes the text look dropped. */
.derived-line {
  display: flex;
  align-items: baseline;
  gap: var(--space-xs);
  flex-wrap: wrap;
  font-size: 0.82rem;
}
.derived-line code { font-size: 0.82rem; }
/* Opened, it shares the row with its label, so it takes the rest of it rather
   than a width of its own - the column above is what bounds it. */
.derived-line input { flex: 1 1 24ch; }
/* A checkbox field is a LABEL ROW with its explanation UNDER it.
   As `flex-direction: row` the field's own <small> became a second COLUMN: the
   label was squeezed to about 40% of the width and its help text floated
   alongside at a different height, which is what made this section read as
   "all over the place" (reported 2026-09-02). */
.field.checkbox { flex-direction: column; align-items: stretch; gap: var(--space-xs); }
/* The `?` goes BESIDE the label. `.field.checkbox` stacks its children, so a
   HelpButton written as a sibling of the label dropped onto its own line under
   it (reported 2026-09-04). This row holds the two together; the label keeps
   the layout the rule below gives it, which is why that rule matches here too
   rather than only as a direct child. */
.checkbox-with-help {
  display: flex;
  align-items: flex-start;
  gap: var(--space-xs);
}
.field.checkbox > label,
.checkbox-with-help > label {
  display: flex;
  align-items: flex-start;
  gap: var(--space-sm);
  cursor: pointer;
}
.field.checkbox > label input[type="checkbox"],
.checkbox-with-help > label input[type="checkbox"] { margin-top: 3px; flex-shrink: 0; }
/* Indented to line up with the label's TEXT rather than with its box, so the
   explanation reads as belonging to the thing above it. */
.field.checkbox > small { padding-left: calc(var(--space-md) + var(--space-xs)); }

/* Class-group chips. Tonal like the late-work options rather than bordered
   cards: this fieldset is already a box (DESIGN.md §1.1). */
/* The cohort picker: filter chips, a scrolling list, a footer that counts.
   Tonal steps rather than nested boxes - the fieldset already draws one edge
   and DESIGN.md §1.1 forbids the third. */
.cohort-filters {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-xs);
  margin: var(--space-2xs) 0 var(--space-xs);
}
.cohort-search {
  flex: 1 1 14rem;
  min-width: 0;
  padding: 4px 8px;
  font-size: 0.85rem;
}
.cohort-list {
  max-height: 20rem;
  overflow-y: auto;
  background: var(--bg-inset);
  border-radius: var(--radius-sm);
  padding: var(--space-2xs);
}
.cohort-row {
  display: grid;
  grid-template-columns: auto 6.5rem minmax(0, 1fr) 5rem minmax(0, 9rem);
  align-items: center;
  gap: var(--space-xs);
  padding: 4px var(--space-xs);
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-size: 0.85rem;
  user-select: none;
}
/* `--bg-surface-hover` is the token DESIGN.md §2 names for list item hover.
   `--bg-surface` would have worked in light and read as a raised card in dark. */
.cohort-row:hover { background: var(--bg-surface-hover); }
/* Already in a published assignment: readable, and plainly not yours to untick.
   No hover response, because the row does not respond. */
.cohort-row.is-locked { cursor: default; color: var(--text-secondary); }
.cohort-row.is-locked:hover { background: none; }
/* Unfilled: `code`'s default inset background makes a plain identifier read as
   an input, and five of them down a column read as an editable form. */
/* `.field code` further down this sheet is (0,2,1) once Vue adds the scope
   attribute, and a bare `.cohort-num` is (0,2,0) - so the plain class lost and
   every student number kept the filled `code` background, reading as a column
   of input boxes. It looked fixed in a screenshot; it was not, in either theme.
   Qualified so the two cannot cancel out. */
.field code.cohort-num {
  font-size: 0.78rem;
  background: none;
  padding: 0;
  color: var(--text-secondary);
}
.cohort-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cohort-group, .cohort-acct {
  font-size: 0.78rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cohort-empty { padding: var(--space-sm); margin: 0; font-size: 0.85rem; }

/* The select-all row. A divider, not a box - it is the head of the list, and
   DESIGN.md §1.1 reserves borders for structural dividers exactly like this. */
.cohort-all {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  gap: var(--space-xs);
  padding: 4px var(--space-xs);
  font-size: 0.85rem;
  cursor: pointer;
  user-select: none;
  border-bottom: 1px solid var(--border-muted);
  margin-bottom: 2px;
  /* Stays reachable while scrolling 200 rows - taking a class should not mean
     scrolling back to the top to find the control that does it. */
  position: sticky;
  top: calc(var(--space-2xs) * -1);
  background: var(--bg-inset);
  z-index: 1;
}
.cohort-all-label { font-weight: 600; }
.cohort-hint { margin: var(--space-2xs) 0 0; font-size: 0.85rem; }
.cohort-foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-sm);
  margin-top: var(--space-2xs);
}
.cohort-count { margin-left: auto; font-size: 0.85rem; color: var(--text-secondary); }
.cohort-count.is-narrowed { color: var(--text-primary); font-weight: 600; }

@media (max-width: 720px) {
  /* The number and the account fall away first: the name is what a lecturer
     scans, and a row that wraps is a row that cannot be scanned at all. */
  .cohort-row { grid-template-columns: auto minmax(0, 1fr) 4.5rem; }
  .cohort-num, .cohort-acct { display: none; }
}

/* The late-work alternatives used to be declared here. They moved to
   style.css when ExistingReposModal.vue started using the same vocabulary:
   a scoped block cannot reach another component, so leaving them would have
   rendered that dialog's options completely unstyled, with no build error and
   no console warning (DESIGN.md §7). */
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
  /* Sized to its own content now that a sentence can follow it; the button is
     pushed right by its own margin rather than by this growing to fill. */
  flex: 0 0 auto;
  min-width: 0;
  color: var(--text-secondary);
  font-size: 0.9rem;
}
.autograde-summary-note {
  flex: 1 1 18ch;
  min-width: 0;
  color: var(--text-muted);
  font-size: 0.85rem;
}
.autograde-summary-row button:first-of-type { margin-left: auto; }
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
/* The steps above the line, while a publish goes live. */
.publish-progress {
  flex-direction: column;
  align-items: flex-start;
}
.publish-steps {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-xs) var(--space-md);
  margin: 0;
  padding: 0;
  list-style: none;
}
/* `.status-indicator` lays out dot and text; only the weight says which step
   is the current one, and steps not reached yet are muted. */
.publish-step.is-todo { color: var(--text-muted); }
.publish-step.is-active { color: var(--text-primary); font-weight: 600; }
/* What students see against what is saved, one line per field. */
.student-page-differences {
  margin: 0;
  padding-left: var(--space-lg);
}
.publish-progress-line {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-xs);
}
/* The short version, in the bar where Save & publish was pressed. */
.publish-bar-status {
  display: inline-flex;
  align-items: center;
  gap: var(--space-xs);
  color: var(--text-secondary);
  font-size: 0.875rem;
  min-width: 0;
}

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
/* Refresh, and open-on-GitHub beside it: one face, two names, so a test (or
   a reader) asking for the refresh button finds exactly one. Not a `btn-`
   name: DESIGN.md §3 lists every button variant there is. */
.btn-refresh,
.template-open {
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
.btn-refresh:hover:not(:disabled),
.template-open:hover:not(:disabled) {
  border-color: var(--text-secondary);
  color: var(--text-primary);
}
/* The link wears the button's face; not the global link hover. */
a.template-open:hover {
  text-decoration: none;
}
.btn-refresh:disabled,
.template-open:disabled {
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

/* The blank starter, under whichever of the three states above rendered. No
   well and no border: it is an offer beside the field, not a second wall, and
   `.template-empty` is already a tonal block that this must not look like a
   rival to. */
.blank-starter {
  margin-top: var(--space-sm);
  font-size: 0.85rem;
  color: var(--text-secondary);
}
.blank-starter-row {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  flex-wrap: wrap;
}
.blank-starter small { display: block; margin-top: var(--space-xs); }
.blank-starter code { font-size: 0.95em; }

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
/* Declared even though the BASE is already the success tint. The markup applies
   `is-success` and the trio was two-thirds written, so the success state was the
   unnamed default - which reads as an oversight and is the shape somebody adds
   `.is-info` on top of. Stating it costs nothing and changes nothing. */
.published-info-card.is-success {
  background: var(--tint-success-subtle);
  border-color: var(--tint-success-muted);
}
/* Tonal step, no border: the editor pane already draws one and the fieldsets
   below draw another (DESIGN.md §1.1 - never nest three boxes). --bg-inset is
   the recessed step that differs from --bg-surface in BOTH themes. */
/* Both card actions travel together when the card wraps on a narrow window;
   without this the button and the link separate and the second one orphans. */
.cohort-actions {
  display: flex;
  align-items: center;
  gap: var(--space-xs);
  flex-wrap: wrap;
}

/* The fields kept the inset they had inside the old fold (`details .field`),
   so removing it moved nothing. */
.settings-fields .field { padding: 0 var(--space-sm); }

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
/* The heading follows the card's state. It was green on every card, and the
   older warning cards each overrode it inline - so a new warning card that did
   not know to read as good news in green on a yellow wash. */
.published-info-card.is-warning .published-header h4 {
  color: var(--accent-yellow);
}
.published-info-card.is-error .published-header h4 {
  color: var(--accent-red);
}
.published-desc {
  font-size: 0.9rem;
  color: var(--text-secondary);
  line-height: 1.4;
  margin: 0;
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
/* Named for the alert family (info/success/danger), coloured from the
   `attention` token family - the two vocabularies differ and only one of them
   has a warning tint. Declaring it matters: an undeclared class renders as a
   plain div with no error anywhere, which is how a warning-coloured button
   variant shipped seven times across two components looking unstyled. */

/* DESIGN.md §1.1: the modal already outlines itself and its alerts. A third
   bordered box here is the prison - this is a tonal step instead, and
   --bg-inset is the one that actually differs in both themes. */

/* ------------------------------------------------------------------------
   Vocabulary that was carried INLINE.

   Each of these classes was written in the markup beside a `style="…"` that
   said what it meant, so the class itself was declared nowhere and the look
   lived on the element. Moving the declarations here changes nothing on
   screen - the values are unchanged - but it takes them off
   tests/fixtures/undeclared-classes.backlog.json and puts the appearance
   where DESIGN.md §5 says colour and spacing belong.
   ------------------------------------------------------------------------ */

/* AFTER `.list-empty` on purpose. Both are scoped, so both carry this
   component's [data-v-*] and their specificity is equal - source order is what
   decides, and the inline style this replaces used to win outright. */
.error-state-box {
  padding: var(--space-md);
  border: 1px dashed var(--accent-red);
  border-radius: var(--radius-md);
  text-align: center;
}

/* Scoped, so `[data-v-*].badge-danger` (0,2,0) out-specifies the global
   `.badge` (0,1,0) and this font-size still wins - which is what the inline
   declaration was doing. */
.badge-danger {
  margin-left: auto;
  font-size: 0.75rem;
}

/* NO THIRD BOX. The card draws one edge and the fieldset another; a bordered
   panel inside those is DESIGN.md §1.1's prison. It already had the tonal step
   the rule asks for, so the border was doing nothing but adding a line. */
.group-config-box {
  margin-top: var(--space-md);
  padding: var(--space-md);
  background: var(--bg-inset);
  border-radius: var(--radius-sm);
  display: flex;
  flex-direction: column;
  gap: var(--space-md);
}

.radio-group {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-xs) var(--space-lg);
  margin-top: 4px;
}
/* An answer, not a field label: after `.field label` on purpose, which would
   otherwise make each one a bold block. */
.radio-group > label {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  font-weight: normal;
  color: var(--text-primary);
}
</style>
