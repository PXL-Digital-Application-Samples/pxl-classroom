<template>
  <section class="roster-tab">
    <div class="roster-header">
      <!-- The one place a lecturer meets the roster, class groups and cohorts
           at once, and has to hold all three apart. The topic is the four-line
           orientation, not this tab's own instructions. -->
      <h3>Roster - {{ org }} <HelpButton topic="how-the-pieces-fit" label="how the roster, groups and teams fit together" /></h3>
      <p class="text-secondary">
        Import or update <code>students/roster.yml</code> in <code>{{ org }}/{{ controlRepo }}</code>.
        Drop a CSV (header row required) or paste below. The diff is previewed before commit.
      </p>
    </div>

    <div class="roster-grid" :class="{ 'has-roster': existingRoster && !parsedRoster }">
      <!-- INPUT -->
      <div
        :class="['input-pane', { dragging }]"
        @dragover.prevent="dragging = true"
        @dragleave="dragging = false"
        @drop.prevent="onDrop"
      >
        <div class="field">
          <label>Upload CSV</label>
          <input type="file" accept=".csv,text/csv" @change="onFileChange" />
          <small>
            Required: <code>full_name</code>, plus one of <code>email</code>, <code>github_login</code>
            or <code>student_number</code> so the row can be found again.
            Also accepted: <code>class_group</code>, <code>github_id</code>, <code>active</code>,
            <code>team_slug</code>, <code>team_name</code>.
            <button class="btn-link" type="button" @click="downloadSampleCsv">Download sample CSV</button>
          </small>
        </div>

        <div class="field">
          <label>or paste CSV</label>
          <textarea
            v-model="csvText"
            rows="10"
            :placeholder="`student_number,full_name,email,class_group,github_login,team_slug,team_name\n0123456,Alice Example,alice@${exampleDomain},3A,alice-test,team-alpha,Alpha Team`"
            @input="onCsvInput"
          ></textarea>
        </div>

        <div v-if="parseError" class="validation-errors">
          <strong>Parse error:</strong>
          <p>{{ parseError }}</p>
        </div>

        <div v-if="validationErrors.length" class="validation-errors">
          <strong>Schema validation failed:</strong>
          <ul>
            <li v-for="(e, i) in validationErrors" :key="i">{{ e }}</li>
          </ul>
        </div>
      </div>

      <!-- DIFF + COMMIT -->
      <div class="diff-pane">
        <div v-if="!parsedRoster && !existingRoster" class="empty-state">
          <h4>Drop a CSV to start</h4>
          <p>If no roster exists yet, the file will be created.</p>
        </div>
        <div v-else-if="!parsedRoster && existingRoster" class="existing-summary">
          <div class="roster-overview-header flex justify-between items-center w-full">
            <div>
              <h4 style="margin: 0 0 var(--space-xs) 0;">Committed Roster</h4>
              <p class="text-secondary text-sm" style="margin: 0;">
                <strong>{{ existingRoster.students?.length || 0 }}</strong> enrolled student(s) in <code>{{ org }}/{{ controlRepo }}</code><template
                  v-if="autoLinkedCount > 0"
                >, <strong>{{ autoLinkedCount }}</strong> linked to a GitHub account</template>.
              </p>
            </div>
            <div class="flex gap-xs flex-wrap">
              <button class="btn btn-sm btn-primary" type="button" @click="openQuickAddModal">
                + Add student
              </button>
              <button
                class="btn btn-sm btn-secondary"
                type="button"
                :disabled="unlinkedStudents.length === 0"
                @click="copyUnlinkedEmails"
                :title="unlinkedStudents.length === 0 ? 'Every student already has a GitHub account on their row' : `Copy the ${unlinkedStudents.length} address(es) whose student has no GitHub account yet`"
              >
                Copy emails with no account ({{ unlinkedStudents.length }})
              </button>
              <button class="btn btn-sm btn-secondary" type="button" @click="exportRosterCsv">Export CSV</button>

              <!-- Absent when there is nothing to fill in, rather than present
                   and disabled: a control for a thing this organization has
                   never needed invites a hunt for it (DESIGN.md §1.5, the
                   class-group picker's lesson). The hints under the rows appear
                   whether or not anything is writable, which is the half that
                   is useful either way. -->
              <button
                v-if="harvest.fillable.length > 0"
                class="btn btn-sm btn-secondary"
                type="button"
                :disabled="harvesting"
                :title="`Write in ${harvest.fillable.length} address(es) the students' own commits carry, where the domain is one of ${claimDomainList}`"
                @click="fillFromReports"
              >{{ harvesting ? 'Filling in…' : `Fill in ${harvest.fillable.length} email${harvest.fillable.length === 1 ? '' : 's'} from assignments` }}</button>

              <!-- Adding the students who accepted an assignment writes THIS
                   file, so the action lives here as well as on the assignment
                   that prompts it. It is per-assignment and the roster is
                   org-wide, so it asks which first rather than guessing.
                   Absent entirely when there is no open assignment to add
                   from - under `enforced` and `claim` everyone who accepted was
                   already on the roster, so there would be nobody to add. -->
              <!-- Its own anchor rather than AssignmentDetailView's
                   `.dropdown-container`, which is scoped there and would render
                   this unstyled (DESIGN.md §7). One line of positioning is not
                   shared vocabulary worth moving to style.css for. -->
              <div v-if="promotableAssignments.length > 0" class="promote-picker-anchor" ref="promotePickerRef">
                <button
                  class="btn btn-sm btn-secondary"
                  type="button"
                  :aria-expanded="promotePickerOpen"
                  aria-haspopup="true"
                  @click.stop="promotePickerOpen = !promotePickerOpen"
                >Add students who accepted</button>
                <HelpButton topic="adding-students-who-accepted" label="adding students who accepted" />

                <div v-if="promotePickerOpen" class="promote-picker" role="menu">
                  <p class="promote-picker-head">From which assignment?</p>
                  <button
                    v-for="a in promotableAssignments"
                    :key="a.id"
                    class="promote-picker-item"
                    type="button"
                    role="menuitem"
                    @click="pickPromotionSource(a)"
                  >
                    <span class="promote-picker-title">{{ a.title || a.id }}</span>
                    <span class="promote-picker-sub">{{ a.id }}</span>
                  </button>
                </div>
              </div>
            </div>
          </div>

          <!-- WHAT THE NIGHTLY COULD NOT DECIDE.
               Verified claims link themselves overnight. These three kinds do
               not, because each is a decision: an address the student typed
               rather than confirmed, a claim naming a different account than
               the row already holds, and an address two accounts claim. They
               used to exist only in the workflow log, which is not where a
               lecturer looks. Only rendered when there is something to decide -
               an empty review box is a chore that is never finished. -->
          <div v-if="heldClaims.length > 0" class="claim-review w-full">
            <div class="claim-review-head flex items-center gap-xs">
              <span class="status-dot dot-warning"></span>
              <strong>{{ heldClaims.length }} need{{ heldClaims.length === 1 ? 's' : '' }} your decision</strong>
              <span class="text-secondary text-sm">
                — everything else linked automatically
              </span>
            </div>
            <ul class="claim-review-list">
              <li v-for="row in heldClaims" :key="row.key" class="claim-review-row">
                <span class="claim-review-who">
                  <code>{{ row.email }}</code>
                  <span v-if="row.full_name" class="text-secondary"> · {{ row.full_name }}</span>
                </span>
                <span class="claim-review-why text-secondary text-sm">
                  <template v-if="row.login">@{{ row.login }} — </template>{{ row.reason }}
                </span>
                <button
                  v-if="row.canLink"
                  class="btn btn-sm btn-secondary"
                  type="button"
                  :disabled="linkingEmail === row.email"
                  :title="`Accept this address and link it to @${row.login}`"
                  @click="linkAnyway(row)"
                >{{ linkingEmail === row.email ? 'Linking…' : 'Link anyway' }}</button>
                <!-- No button where one click cannot settle it: a conflict needs
                     the account in the way unlinked first (the row below), and
                     an address two accounts claim needs one of them removed.
                     Offering a control that would refuse is worse than none. -->
                <span v-else class="text-muted text-sm claim-review-hint">Unlink below to resolve</span>
              </li>
            </ul>
          </div>

          <!-- Roster Filter Chips -->
          <div class="roster-filter-chips flex gap-xs items-center w-full">
            <button
              :class="['chip-btn', { active: rosterFilter === 'all' }]"
              type="button"
              @click="rosterFilter = 'all'"
            >
              All ({{ existingRoster.students?.length || 0 }})
            </button>
            <button
              :class="['chip-btn', { active: rosterFilter === 'linked' }]"
              type="button"
              @click="rosterFilter = 'linked'"
            >
              Has account ({{ linkedStudents.length }})
            </button>
            <button
              :class="['chip-btn', { active: rosterFilter === 'unlinked' }]"
              type="button"
              @click="rosterFilter = 'unlinked'"
            >
              No account yet ({{ unlinkedStudents.length }})
            </button>
          </div>

          <!-- The groups this org already uses, offered as completions so a
               lecturer does not invent "3a" beside an existing "3A" and split a
               section in two. A datalist SUGGESTS - a new group is still typed
               freely, which is how the first one ever gets created. -->
          <datalist id="roster-class-groups">
            <option v-for="g in existingClassGroups" :key="g" :value="g"></option>
          </datalist>

          <!-- Student List Table -->
          <div class="roster-table-wrapper w-full">
            <table class="roster-table w-full text-left text-sm" style="border-collapse: collapse;">
              <thead>
                <tr style="border-bottom: 1px solid var(--border-default); color: var(--text-secondary);">
                  <th style="padding: 6px 8px;">Number</th>
                  <th style="padding: 6px 8px;">Name</th>
                  <th style="padding: 6px 8px;">Email</th>
                  <th style="padding: 6px 8px;">Group</th>
                  <th style="padding: 6px 8px;">GitHub Account</th>
                  <th style="padding: 6px 8px;"></th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="s in filteredRosterStudents"
                  :key="rosterKey(s)"
                  style="border-bottom: 1px solid var(--border-default);"
                >
                  <!-- Every one of these is editable in place, through ONE
                       editor over a field descriptor. A row promoted from an
                       acceptance arrives with a login and nothing else, and
                       nothing fills it in afterwards - promotion skips rows it
                       has seen, and a claim joins on email, which such a row
                       does not have. Before this, the only route was a CSV
                       round trip for one cell. -->
                  <td style="padding: 6px 8px;">
                    <RosterCell :student="s" field="student_number" :editor="cellEditor" v-model:draft="cellEdit.draft" mono />
                  </td>
                  <td style="padding: 6px 8px; font-weight: 500;">
                    <!-- "Not yet identified" is only true while the row knows
                         NOTHING. Once an address is on it - filled from a claim,
                         harvested, or typed - the person IS identified and it is
                         the name that is missing. Saying otherwise beside
                         `lowie.serneels@student.pxl.be` is DESIGN.md §1.5: a line
                         asserting more than it can evaluate. -->
                    <RosterCell
                      :student="s"
                      field="full_name"
                      :editor="cellEditor"
                      v-model:draft="cellEdit.draft"
                      :empty-text="String(s.email ?? '').trim() ? 'Name unknown' : 'Not yet identified'"
                    />
                    <!-- The NAME the reports know, and only that. An address
                         goes in the Email column, where addresses live: the
                         hint used to render both here, so the single most
                         useful string on the row sat under the wrong heading. -->
                    <div v-if="harvestFor(s)?.name" class="harvest-hint">
                      <span class="text-muted">commits as</span>
                      <code>{{ harvestFor(s).name }}</code>
                    </div>
                  </td>
                  <td style="padding: 6px 8px; color: var(--text-secondary);">
                    <RosterCell :student="s" field="email" :editor="cellEditor" v-model:draft="cellEdit.draft" />
                    <!-- Where it came from, when a person did not put it there.
                         A claim is an address GitHub verified on the student's
                         own account; a commit is whatever they typed into `git
                         config`. One column, two writers of very different
                         trust - the marker is what tells them apart. -->
                    <span
                      v-if="s.email_source"
                      :class="['email-source', `email-source-${s.email_source}`]"
                      :title="s.email_source === 'claim'
                        ? 'The student supplied this address themselves when they accepted an assignment'
                        : 'Read off their own commits - self-declared, and not confirmed by anyone'"
                    >{{ s.email_source === 'claim' ? 'claimed' : 'from commits' }}</span>
                    <!-- An address the reports know, on a row that has none.
                         SHOWN here regardless of whether it may be written: it
                         is an address, so it belongs in the address column, and
                         the domain check decides storage rather than
                         visibility. `looksLikeEmail` is what keeps a git config
                         field holding "Tom Cool" - or an @github.com address,
                         which is not a mailbox - out of a column of mailboxes. -->
                    <div v-if="harvestFor(s)?.email" class="harvest-hint">
                      <code>{{ harvestFor(s).email }}</code>
                      <span
                        class="text-muted"
                        title="Read off their own commits - self-declared, and not confirmed by anyone"
                      >from commits</span>
                      <span
                        v-if="!harvestFor(s).emailAllowed"
                        class="text-warning"
                        :title="`Not one of the allowed domains (${claimDomainList}), so it is not written into the roster. Often a typo - click the cell above and it opens with this in it, ready to fix.`"
                      >domain not allowed</span>
                    </div>
                  </td>
                  <td style="padding: 6px 8px;">
                    <RosterCell :student="s" field="class_group" :editor="cellEditor" v-model:draft="cellEdit.draft" empty-text="—" />
                  </td>
                  <!-- The account this student can actually accept with.
                       `github_login` alone was the whole answer under
                       `enforced`; under `claim` the binding lives in
                       students/claims/<github_id>.json and the roster column is
                       often deliberately empty, so a badge reading "Pending
                       linking" over a student who claimed an hour ago is the
                       opposite of the truth. -->
                  <td style="padding: 6px 8px;">
                    <span
                      v-if="bindingFor(s).state === 'claimed'"
                      class="badge badge-success mono"
                      :title="`Claimed ${bindingFor(s).claim.email}${bindingFor(s).verified ? ', verified by GitHub' : ', address typed by the student'}`"
                    >@{{ bindingFor(s).login }}</span>
                    <span
                      v-else-if="bindingFor(s).state === 'conflict'"
                      class="badge badge-warning mono"
                      :title="`Claimed by @${bindingFor(s).login}, but the roster names @${bindingFor(s).rosterLogin}. One of the two is wrong.`"
                    >@{{ bindingFor(s).login }} &ne; roster</span>
                    <span v-else-if="bindingFor(s).state === 'roster'" class="badge badge-success mono">@{{ bindingFor(s).login }}</span>
                    <!-- `unclaimable` used to render "No address" HERE, one
                         column to the right of the Email column that already
                         says so. Two columns answering one question, in
                         different words. It falls through to the line below,
                         which is true of it as well. -->
                    <!-- A DASH, not "Pending linking". The column is headed
                         GitHub Account; an empty one means we do not have one,
                         and naming that state invented a word - it read as
                         something in progress when nothing is. The tooltip
                         carries the rest.
                         Deliberately mode-neutral: this tab is ORG-scoped and
                         an org can hold `enforced` and `claim` assignments at
                         once, so it cannot know which route a given student
                         will arrive by. -->
                    <span
                      v-else
                      class="text-muted"
                      title="No GitHub account on this row yet. It arrives when they accept an assignment, or when they use a confirm-email link."
                    >&mdash;</span>
                    <span
                      v-if="bindingFor(s).state === 'claimed' && !bindingFor(s).verified"
                      class="text-xs text-muted"
                      style="margin-left: 4px;"
                      title="The student typed this address rather than confirming one GitHub had already verified."
                    >unverified</span>
                  </td>
                  <!-- THE ROW'S ACTIONS, in one menu.
                       Editing used to be discoverable only by clicking a "-" in
                       an empty cell, which was reported as "really, really
                       confusing" - a dash does not read as a control. Clicking a
                       cell still works and is still the fast way to fix one
                       value; this is the way you find out that you can.
                       Unlink lived here as a bare red button, and only appeared
                       when there was a claim - so a row with nothing to unlink
                       had an empty column and no actions at all. -->
                  <td style="padding: 6px 8px; text-align: right;">
                    <div class="row-menu-anchor" :ref="(el) => setRowMenuRef(s, el)">
                      <button
                        class="btn btn-ghost btn-icon btn-xs"
                        type="button"
                        :aria-expanded="rowMenuFor === rosterKey(s)"
                        aria-haspopup="true"
                        :aria-label="`Actions for ${whoIs(s)}`"
                        title="Actions"
                        @click.stop="toggleRowMenu(s, $event)"
                      >&hellip;</button>

                      <div v-if="rowMenuFor === rosterKey(s)" class="row-menu" role="menu" :style="rowMenuStyle">
                        <button class="row-menu-item" type="button" role="menuitem" @click="openStudentEditor(s)">
                          <span class="row-menu-title">Edit details&hellip;</span>
                          <span class="row-menu-note">Number, name, email and group, saved in one go.</span>
                        </button>

                        <!-- "Forget", never "Remove GitHub account": the second
                             reads as deleting the student's actual account.
                             This deletes OUR record of which account they are,
                             and nothing else. -->
                        <button
                          v-if="bindingFor(s).claim"
                          class="row-menu-item"
                          type="button"
                          role="menuitem"
                          :disabled="unlinking"
                          @click="fromRowMenu(() => confirmUnlink(s, bindingFor(s)))"
                        >
                          <span class="row-menu-title">Forget this account</span>
                          <span class="row-menu-note">
                            Removes the link on this row. Nothing on GitHub changes, and they can confirm again.
                          </span>
                        </button>

                        <button
                          class="row-menu-item row-menu-item-danger"
                          type="button"
                          role="menuitem"
                          :disabled="removingStudent"
                          @click="fromRowMenu(() => confirmRemoveStudent(s))"
                        >
                          <span class="row-menu-title">Remove from roster&hellip;</span>
                          <span class="row-menu-note">
                            Takes them off this list. Their repository and their work are untouched.
                          </span>
                        </button>
                      </div>
                    </div>
                  </td>
                </tr>
                <tr v-if="filteredRosterStudents.length === 0">
                  <td colspan="7" class="text-center text-muted" style="padding: 16px;">
                    No students match the current filter.
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <!-- THE NEED IS DISCOVERED HERE AND THE CONTROL LIVES ELSEWHERE.
               A row with a login and no address is the case the confirm-email
               link exists for, but that link is per assignment, so this tab
               cannot render one - it can only say where to find it. Without
               this line a lecturer reading "Not yet identified" six times had
               no route to the feature at all unless they already knew.
               Only when there is somebody it would help: a permanent pointer to
               a thing you do not need is noise. -->
          <p v-if="awaitingAddress > 0" class="text-sm text-muted roster-ask-hint">
            {{ awaitingAddress }} {{ awaitingAddress === 1 ? 'student has' : 'students have' }}
            no email address. You can ask them for one:
            <!-- WHICH SENTENCE IS TRUE DEPENDS ON THE ORG. The link rides a
                 published assignment, so with none published there is nothing
                 to copy - and pointing a lecturer at a control that is not
                 there is DESIGN.md 1.5. The second branch says what to do
                 instead, which is what RUNBOOK says too. -->
            <template v-if="hasPublishedAssignment">
              every published assignment has a <strong>Confirm-email link</strong>
              beside its invitation link.
            </template>
            <template v-else>
              publish an assignment and it gets a <strong>Confirm-email link</strong> beside its
              invitation link. Confirming hands out no repository, so one published for the
              purpose costs nothing.
            </template>
            <HelpButton topic="confirming-an-email-address" label="the confirm-email link" />
          </p>
        </div>
        <div v-else>
          <h4>Diff vs. committed roster</h4>
          <div v-if="!existingRoster" class="diff-info">
            No existing <code>students/roster.yml</code> in <code>{{ org }}/{{ controlRepo }}</code>. This will create one.
          </div>

          <div class="diff-summary">
            <span class="diff-badge added">+ {{ diff.added.length }} added</span>
            <span class="diff-badge updated">~ {{ diff.updated.length }} updated</span>
            <span class="diff-badge removed">- {{ diff.removed.length }} removed</span>
          </div>

          <details v-if="diff.added.length" open>
            <summary>Added ({{ diff.added.length }})</summary>
            <ul>
              <li v-for="s in diff.added" :key="rosterKey(s)">
                {{ describeRosterEntry(s) }}
                <span v-if="s.class_group"> · {{ s.class_group }}</span>
              </li>
            </ul>
          </details>

          <details v-if="diff.updated.length">
            <summary>Updated ({{ diff.updated.length }})</summary>
            <ul>
              <li v-for="u in diff.updated" :key="rosterKey(u.after)">
                {{ describeRosterEntry(u.after) }}
                <span class="changed-fields">[{{ changedFields(u).join(', ') }}]</span>
              </li>
            </ul>
          </details>

          <!-- Removed is the destructive part of the diff - always expanded. -->
          <details v-if="diff.removed.length" open>
            <summary>Removed ({{ diff.removed.length }})</summary>
            <ul>
              <li v-for="s in diff.removed" :key="rosterKey(s)">
                {{ describeRosterEntry(s) }}
              </li>
            </ul>
          </details>

          <div v-if="diff.added.length + diff.updated.length + diff.removed.length === 0" class="diff-empty">
            Roster matches what's already committed. Nothing to do.
          </div>

          <div class="actions">
            <button
              class="btn btn-primary"
              type="button"
              :disabled="!canCommit || committing"
              @click="commitRoster"
            >
              {{ committing ? 'Committing…' : 'Commit roster' }}
            </button>
          </div>
        </div>

        <div v-if="loadingExisting" class="loading-inline">
          <div class="spinner sm"></div> Loading committed roster…
        </div>
      </div>
    </div>

    <!-- Modal: Quick Add Student (2.A) -->
    <div v-if="showQuickAddModal" class="modal-overlay" @click.self="showQuickAddModal = false">
      <div class="modal card" style="max-width: 500px;">
        <header class="modal-head flex justify-between items-center">
          <h3 style="margin: 0;">Add Student to Roster</h3>
          <button class="modal-close" type="button" @click="showQuickAddModal = false" aria-label="Close">×</button>
        </header>
        <form @submit.prevent="submitQuickAddStudent" class="modal-body flex flex-col gap-md" style="padding: var(--space-md);">
          <div v-if="quickAddError" class="validation-errors" style="margin-bottom: 0;">
            <p style="margin: 0;">{{ quickAddError }}</p>
          </div>

          <!-- THE NUMBER IS NO LONGER ASKED FOR FIRST, OR AT ALL.
               It was required so the row would have a key, back when a roster
               entry could only be keyed by number or GitHub login - and most
               institutions hand a lecturer addresses, not SIS numbers, so the
               form demanded a value they could only invent. A row now needs a
               name and ONE of number, address or account; the address is the
               one a lecturer actually has, so it leads. -->
          <div class="field" style="margin-bottom: 0;">
            <label for="qa-name">Full Name <span class="req" style="color: var(--accent-red);">*</span></label>
            <input
              id="qa-name"
              v-model="quickAddForm.full_name"
              type="text"
              class="form-control"
              placeholder="e.g. Alice Example"
              required
            />
          </div>

          <div class="field" style="margin-bottom: 0;">
            <label for="qa-email">Email Address</label>
            <input
              id="qa-email"
              v-model="quickAddForm.email"
              type="email"
              class="form-control"
              :placeholder="`e.g. alice.example@${exampleDomain}`"
            />
            <small>Assignments match students to accounts on this address.</small>
          </div>

          <div class="field" style="margin-bottom: 0;">
            <label for="qa-number">Student Number</label>
            <input
              id="qa-number"
              v-model="quickAddForm.student_number"
              type="text"
              class="form-control"
              placeholder="e.g. 0123456"
            />
            <small>Your institution's own number, if you have one. Nothing here needs it.</small>
          </div>

          <div class="flex gap-sm">
            <div class="field" style="flex: 1; margin-bottom: 0;">
              <label for="qa-group">Class Group (Optional)</label>
              <input
                id="qa-group"
                v-model="quickAddForm.class_group"
                type="text"
                class="form-control"
                placeholder="e.g. 1TIN-A"
              />
            </div>
            <div class="field" style="flex: 1; margin-bottom: 0;">
              <label for="qa-login">GitHub Login (Optional)</label>
              <input
                id="qa-login"
                v-model="quickAddForm.github_login"
                type="text"
                class="form-control"
                placeholder="e.g. alice-dev"
              />
            </div>
          </div>

          <footer class="modal-foot flex justify-end gap-sm">
            <button class="btn btn-secondary" type="button" @click="showQuickAddModal = false">Cancel</button>
            <button class="btn btn-primary" type="submit" :disabled="quickAddSaving">
              {{ quickAddSaving ? 'Adding…' : 'Add Student' }}
            </button>
          </footer>
        </form>
      </div>
    </div>

    <!-- The same modal the assignment's own menu opens. One component, so the
         two entry points cannot drift about what promotion writes. -->
    <PromoteRosterModal
      v-if="promoteFrom"
      :org="org"
      :assignment="promoteFrom"
      @close="promoteFrom = null"
      @promoted="onPromoted"
    />

    <RosterStudentModal
      v-if="editingStudent"
      :student="editingStudent"
      :suggestion="harvestFor(editingStudent)"
      :saving="studentSaving"
      @save="onStudentSave"
      @close="editingStudent = null"
    />
  </section>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onUnmounted, watch } from 'vue'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { csvToRoster, diffRosters, rosterKey, describeRosterEntry } from '../lib/csv.js'
import { validateAgainst } from '../lib/validate.js'
import { ROSTER_PATH } from '../lib/roster.js'
import { REPORTS_DIR } from '../../../lib/control-layout.mjs'
import { rosterClassGroups } from '../lib/class-groups.js'
import { getToken, getUser } from '../lib/auth.js'
import HelpButton from './HelpButton.vue'
import { commitFile, getRepoContent, listRepoDir, listClaims, deleteFile } from '../lib/api.js'
// The one join between a claim and a roster entry. See lib/claim-bindings.mjs.
import { indexClaims, bindingForEntry } from '../lib/claim-bindings.js'
import { normalizeEmail, domainAllowed } from '../lib/claim.js'
import { harvestPlan, applyHarvest } from '../lib/roster-harvest.js'
// The SAME planner the nightly runs. Imported, never re-implemented: a review
// list computed a second way could show a lecturer something different from
// what was actually held back, which is worse than showing nothing.
import { planClaimPromotion } from '../../../lib/promote-roster.mjs'
// The exporter's half of the pair whose other half is coerceCell's
// stripFormulaGuard. Shared so export -> edit -> import cannot become lossy again.
import { csvCell } from '../../../lib/csv-cell.mjs'
import PromoteRosterModal from './PromoteRosterModal.vue'
import RosterStudentModal from './RosterStudentModal.vue'
import RosterCell from './RosterCell.vue'
import { config } from '../lib/config.js'
import { toast } from '../lib/toast.js'
import { copyText } from '../lib/clipboard.js'
import { CLAIM_DOMAINS } from '../lib/deployment.js'

// The worked examples on this tab - a CSV placeholder, the email field's
// placeholder and the downloadable sample roster - all showed
// `@student.pxl.be`. A fork's lecturer would be handed a sample CSV full of
// somebody else's institution, from the one file deployment.yml promises is the
// only one they have to edit. The first configured domain is the cohort's.
const exampleDomain = CLAIM_DOMAINS[0] || 'example.edu'

const props = defineProps({
  org: { type: String, required: true },
  // The org's assignments, so this tab can offer to add the students who
  // accepted one. Optional: the tab works without them, it simply has nothing
  // to offer.
  assignments: { type: Array, default: () => [] },
})

const controlRepo = config.controlRepo

const csvText = ref('')
const parsedRoster = ref(null)
const parseError = ref('')
const validationErrors = ref([])

const existingRoster = ref(null)
const rosterRaw = ref(null)
const loadingExisting = ref(false)
const committing = ref(false)

// Filter & Quick Add State (2.A)
const rosterFilter = ref('all')
const showQuickAddModal = ref(false)
const quickAddSaving = ref(false)
const quickAddError = ref('')
const quickAddForm = ref({
  student_number: '',
  full_name: '',
  email: '',
  class_group: '',
  github_login: '',
})

const linkedStudents = computed(() =>
  (existingRoster.value?.students || []).filter((s) => !!s.github_login)
)

const unlinkedStudents = computed(() =>
  (existingRoster.value?.students || []).filter((s) => !s.github_login)
)

const filteredRosterStudents = computed(() => {
  const all = existingRoster.value?.students || []
  if (rosterFilter.value === 'linked') return linkedStudents.value
  if (rosterFilter.value === 'unlinked') return unlinkedStudents.value
  return all
})

function copyUnlinkedEmails() {
  const emails = unlinkedStudents.value
    .map((s) => s.email)
    .filter(Boolean)
  if (emails.length === 0) {
    toast.info('No unlinked student emails found.')
    return
  }
  const formatted = emails.join('; ')
  // `copyText`, not navigator.clipboard directly: the API rejects outright when
  // the document is not focused, and lib/clipboard.js carries the execCommand
  // fallback that exists because of it.
  copyText(formatted).then((ok) => {
    if (ok) toast.success(`Copied ${emails.length} address(es) to the clipboard`)
    else toast.error('Failed to copy emails to clipboard')
  })
}

function openQuickAddModal() {
  quickAddForm.value = {
    student_number: '',
    full_name: '',
    email: '',
    class_group: '',
    github_login: '',
  }
  quickAddError.value = ''
  showQuickAddModal.value = true
}

async function submitQuickAddStudent() {
  quickAddError.value = ''
  const num = quickAddForm.value.student_number?.trim()
  const name = quickAddForm.value.full_name?.trim()
  const email = quickAddForm.value.email?.trim()
  const group = quickAddForm.value.class_group?.trim()
  const login = quickAddForm.value.github_login?.trim()

  // A NAME AND ONE IDENTITY, the same rule the CSV import and the schema apply.
  // Without one of the three `rosterKey` returns null, and the row would be
  // added once and then be unreachable - no import diff could match it, and
  // neither could the cell editor, Edit details or Remove.
  if (!name) {
    quickAddError.value = 'A full name is required.'
    return
  }
  if (!email && !num && !login) {
    quickAddError.value =
      'Add an email address, a GitHub account or a student number, so this student can be found again.'
    return
  }

  const currentStudents = [...(existingRoster.value?.students || [])]

  // DUPLICATES ON WHICHEVER IDENTITY WAS GIVEN, not on the number alone. Any of
  // the three keys a row, so two rows sharing any one of them are two students
  // claiming to be the same person - and the second would be unreachable,
  // because `rosterKey` would resolve both to the same key.
  const clash = [
    ['student number', num, (s) => s.student_number, (a, b) => a.toLowerCase() === b.toLowerCase()],
    ['email address', email, (s) => s.email, (a, b) => a.toLowerCase() === b.toLowerCase()],
    ['GitHub account', login, (s) => s.github_login, (a, b) => a.toLowerCase() === b.toLowerCase()],
  ].find(([, value, read, eq]) =>
    value && currentStudents.some((s) => read(s) && eq(String(read(s)), value)))
  if (clash) {
    quickAddError.value = `That ${clash[0]} is already on the roster.`
    return
  }

  // ONLY WHAT WAS FILLED IN. `student_number`, `full_name` and `email` all
  // declare `minLength: 1`, so writing "" is not merely untidy - it is a
  // document the schema rejects, and the empty field would then be a value
  // rather than an absence to everything that reads it.
  const newStudent = {
    full_name: name,
    ...(num ? { student_number: num } : {}),
    ...(email ? { email } : {}),
    ...(group ? { class_group: group } : {}),
    ...(login ? { github_login: login } : {}),
  }

  const updatedDoc = {
    schema_version: existingRoster.value?.schema_version || 2,
    students: [...currentStudents, newStudent],
  }

  // Validate before commit
  const { valid, errors } = await validateAgainst('roster', updatedDoc)
  if (!valid) {
    quickAddError.value = errors.map((e) => e.message).join(', ')
    return
  }

  quickAddSaving.value = true
  try {
    const token = getToken()
    const yaml = stringifyYaml(updatedDoc)
    const message = `Add student ${num} (${name}) to roster`
    const res = await commitFile(token, props.org, controlRepo, ROSTER_PATH, yaml, message)
    if (res.ok) {
      toast.success(`Student ${name} added to roster`)
      showQuickAddModal.value = false
      await loadExisting()
    } else {
      quickAddError.value = `Commit failed: ${res.data?.message || 'unknown error'}`
    }
  } catch (e) {
    quickAddError.value = `Error saving student: ${e.message}`
  } finally {
    quickAddSaving.value = false
  }
}

// --- what the reports already know ------------------------------------------
//
// A row promoted from an acceptance carries a login and nothing else, and
// NOTHING fills it in afterwards: promotion skips rows it has seen
// (planPromotion Rule 1) and a claim joins to an entry by email, which such a
// row does not have. So the lecturer read "Not yet identified" with no route
// that did not begin with typing.
//
// The collector already knows more. It records the author of each student's
// latest commit, discards the provisioning bot and any noreply address, and
// falls back to the account's public GitHub profile - so every report carries
// the best guess available for every student in it, gathered for free.
//
// Loaded beside the roster and NOT awaited with it: a failed report read must
// not take the roster down, the rule the acceptance card learned when one
// rejected lookup replaced a loaded assignment with an error.
const reports = ref([])
const harvesting = ref(false)

const claimDomainList = CLAIM_DOMAINS.join(', ')

const harvest = computed(() => harvestPlan({
  roster: existingRoster.value,
  reports: reports.value,
  emailAllowed: (email) => domainAllowed(email, CLAIM_DOMAINS),
}))

const harvestByLogin = computed(() => {
  const m = new Map()
  for (const h of harvest.value.hints) m.set(h.login.toLowerCase(), h)
  return m
})

/** The hint for one row, or null. Null is the common case and renders nothing. */
function harvestFor(student) {
  const login = String(student?.github_login ?? '').trim().toLowerCase()
  return login ? harvestByLogin.value.get(login) ?? null : null
}

/**
 * Roster rows with no email address.
 *
 * NOT narrowed to rows that already have a GitHub account, which is where this
 * started. A confirmation supplies both facts at once, so it helps a row that
 * has neither exactly as much - and the sentence beside the count is about the
 * address, which is missing either way. Narrowing it left a student who has
 * nothing on their row out of the one count that would have found them.
 *
 * Not the same question as `wantsHints` below, which also counts a row missing
 * only a name - something confirming an address does nothing about.
 */
const awaitingAddress = computed(() =>
  (existingRoster.value?.students || []).filter(
    (s) => !String(s?.email ?? '').trim(),
  ).length)

/**
 * Is there any row a hint could help?
 *
 * Computed from the roster alone, for free, BEFORE any request. The reports
 * cost one read each and an organization accumulates them for as long as it
 * runs a course - paying that on every visit to identify nobody is a cost with
 * no benefit attached, which is what the first cut did.
 */
const wantsHints = computed(() =>
  (existingRoster.value?.students || []).some((s) =>
    s?.github_login && (!String(s.full_name ?? '').trim() || !String(s.email ?? '').trim())))

async function loadReports() {
  if (!wantsHints.value) { reports.value = []; return }
  try {
    const token = getToken()
    const files = await listRepoDir(token, props.org, controlRepo, REPORTS_DIR)
    // `dashboard.json` is an aggregate with no student rows and `usage-*` are
    // billing counters - reading them would cost a request each to find nothing.
    const wanted = files.filter((f) =>
      f.name?.endsWith('.json') && f.name !== 'dashboard.json' && !f.name.startsWith('usage-'))
    // Four at a time rather than one after another: a course that has run for
    // a few years has a report per assignment, and sequentially that is a
    // visible stall on a tab whose main job is elsewhere. Four is what
    // StarterSyncModal uses for the same reason.
    const loaded = []
    const queue = [...wanted]
    const readOne = async () => {
      while (queue.length) {
        const f = queue.shift()
        try {
          const text = await getRepoContent(token, props.org, controlRepo, `${REPORTS_DIR}/${f.name}`)
          if (text) loaded.push(JSON.parse(text))
        } catch { /* one unreadable report is not worth losing the others over */ }
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, wanted.length) }, readOne))
    reports.value = loaded
  } catch {
    // An org with no reports directory yet, or a token that cannot read it.
    // The hints simply do not appear; nothing else on this tab depends on them.
    reports.value = []
  }
}

/**
 * Write in the addresses that passed the domain check.
 *
 * ONLY the addresses, and only into empty fields. A name harvested from a
 * commit is `rayaneW` or `LowieSerneelsPXL` as often as it is a name, and
 * unlike a blank it LOOKS filled in - so nothing later flags the row and an
 * exported grading list carries it. The names are shown as hints and stay
 * there; the Name column is one click away for anyone who wants to keep one.
 */
async function fillFromReports() {
  const fillable = harvest.value.fillable
  if (fillable.length === 0) return
  const lines = fillable.map((f) => `  @${f.login} → ${f.email}`).join('\n')
  if (!window.confirm(
    `Fill in ${fillable.length} email address${fillable.length === 1 ? '' : 'es'} from the students' own commits?\n\n${lines}\n\n` +
    `These come from git config and are not verified - they are written because their domain is one of ${claimDomainList}.`,
  )) return

  harvesting.value = true
  try {
    const token = getToken()
    // REFUSE, DO NOT OVERWRITE - the same guard the in-place edit uses. This
    // plan was built against the roster as it loaded, and commitFile fetches a
    // fresh sha before it PUTs, so a change made in between would be silently
    // replaced by our older copy.
    const onDisk = await getRepoContent(token, props.org, controlRepo, ROSTER_PATH)
    if (onDisk !== null && onDisk !== rosterRaw.value) {
      toast.error('The roster changed since this page loaded. Reload before filling in, so your change is not built on a stale copy.')
      return
    }

    const updatedDoc = applyHarvest(existingRoster.value, fillable)
    const { valid, errors } = await validateAgainst('roster', updatedDoc)
    if (!valid) {
      toast.error(`Roster would be invalid: ${errors.map((e) => e.message).join(', ')}`)
      return
    }

    const res = await commitFile(
      token, props.org, controlRepo, ROSTER_PATH,
      stringifyYaml(updatedDoc),
      `Fill in ${fillable.length} email address(es) from assignment reports`,
      // What this document was built from. A sha conflict on a roster write is
      // usually GitHub's Contents API answering with a stale sha rather than a
      // real concurrent edit; passing the baseline is what lets commitFile tell
      // the two apart instead of retrying blind over somebody else's write.
      { baseContent: rosterRaw.value },
    )
    if (!res.ok) {
      toast.error(writeFailure(res))
      return
    }
    toast.success(`Filled in ${fillable.length} email address${fillable.length === 1 ? '' : 'es'}.`)
    await loadExisting()
  } catch (e) {
    toast.error(`Could not save: ${e.message}`)
  } finally {
    harvesting.value = false
  }
}

// --- one student, one dialog ------------------------------------------------
//
// The same four fields the cells edit, saved together. That is not only
// convenience: identifying a promoted row means a number, a name and an address,
// and doing it cell by cell is three commits to roster.yml in a few seconds -
// which is exactly what produced a refused save on PXL-Automation-II when the
// Contents API answered the second one with a stale sha.
const editingStudent = ref(null)
const studentSaving = ref(false)
const removingStudent = ref(false)

/** The dialog emits its values; the write and its reporting live here. */
async function onStudentSave(values) {
  studentSaving.value = true
  try {
    await saveStudentDetails(values)
  } catch (e) {
    toast.error(`Could not save: ${e.message}`)
  } finally {
    studentSaving.value = false
  }
}

function openStudentEditor(student) {
  rowMenuFor.value = null
  // Cancel any open cell edit: two editors over one row, both spreading the
  // roster as it was when they opened, is a lost update waiting to happen.
  cancelCellEdit()
  editingStudent.value = student
}

/**
 * Write the dialog's fields onto the stored roster.
 *
 * MERGE, NEVER REPLACE, exactly as the cell editor does - the row is spread and
 * only the four fields are overridden, because this table shows five of the nine
 * columns an entry can carry.
 */
async function saveStudentDetails(values) {
  const key = rosterKey(editingStudent.value)
  const doc = existingRoster.value
  const students = (doc?.students || []).map((entry) => {
    if (rosterKey(entry) !== key) return entry
    const next = { ...entry }
    for (const [field, raw] of Object.entries(values)) {
      const trimmed = typeof raw === 'string' ? raw.trim() : ''
      if (trimmed) next[field] = trimmed
      else delete next[field]
    }
    // `email_source` describes the address beside it. A person typing here
    // outranks a claim and a commit, so the marker goes rather than staying to
    // describe a value that is no longer theirs.
    if ((values.email ?? '').trim() !== (entry.email ?? '')) delete next.email_source
    return next
  })
  const updatedDoc = { ...doc, schema_version: doc?.schema_version || 2, students }

  const { valid, errors } = await validateAgainst('roster', updatedDoc)
  if (!valid) {
    toast.error(`Roster would be invalid: ${errors.map((e) => e.message).join(', ')}`)
    return false
  }

  const res = await commitFile(
    getToken(), props.org, controlRepo, ROSTER_PATH,
    stringifyYaml(updatedDoc),
    `Update ${whoIs(editingStudent.value)} on the roster`,
    { baseContent: rosterRaw.value },
  )
  if (!res.ok) {
    toast.error(writeFailure(res))
    return false
  }
  toast.success(`Saved ${whoIs(editingStudent.value)}`)
  editingStudent.value = null
  await loadExisting()
  return true
}

/**
 * Take one student off the roster.
 *
 * Only possible before this by exporting a CSV, deleting a line and importing
 * it back - and that path removes anyone the CSV does not name, so it is a far
 * blunter instrument than it looks.
 *
 * What it does NOT do is said in the prompt, because it is the thing a lecturer
 * will assume: their repository, their acceptance and their work all survive.
 * The roster is a list of who the course is about, not the store of their work.
 */
async function confirmRemoveStudent(student) {
  const who = whoIs(student)
  const ok = window.confirm(
    `Remove ${who} from the roster?

` +
    `They come off this list only. Their repository, their submitted work and ` +
    `any assignment they accepted are untouched.

` +
    `If they accept another assignment, or use a confirm-email link, they come back.`,
  )
  if (!ok) return

  removingStudent.value = true
  try {
    const key = rosterKey(student)
    const doc = existingRoster.value
    const students = (doc?.students || []).filter((entry) => rosterKey(entry) !== key)
    if (students.length === (doc?.students || []).length) {
      toast.error('That student is no longer on the roster. Reload the page.')
      return
    }
    const updatedDoc = { ...doc, schema_version: doc?.schema_version || 2, students }
    const { valid, errors } = await validateAgainst('roster', updatedDoc)
    if (!valid) {
      toast.error(`Roster would be invalid: ${errors.map((e) => e.message).join(', ')}`)
      return
    }
    const res = await commitFile(
      getToken(), props.org, controlRepo, ROSTER_PATH,
      stringifyYaml(updatedDoc),
      `Remove ${who} from the roster`,
      { baseContent: rosterRaw.value },
    )
    if (!res.ok) {
      toast.error(writeFailure(res))
      return
    }
    toast.success(`${who} removed from the roster`)
    await loadExisting()
  } catch (e) {
    toast.error(`Could not remove: ${e.message}`)
  } finally {
    removingStudent.value = false
  }
}

// --- editing one student's details, in place -------------------------------
//
// It took a full CSV round trip to change one cell: export, open a
// spreadsheet, edit, import, confirm a diff. Fine once a year for a whole
// cohort, absurd for the late enroller who turns up in week three - and worse
// for a row promoted from an acceptance, which arrives carrying a login and
// nothing else and which NOTHING fills in afterwards: promotion skips rows it
// has already seen, and a claim is joined to an entry by email, so a row with
// no email can never receive one.
//
// ONE editor over a field descriptor, rather than four copies of the same
// guarded save. The guards are the reason: escape-must-not-commit, merge-never-
// replace, refuse-a-stale-write. Four copies is four places for one of those to
// go missing.
const EDITABLE_FIELDS = Object.freeze({
  student_number: { label: 'student number', placeholder: 'e.g. 0123456' },
  full_name: { label: 'name', placeholder: 'e.g. Lowie Serneels' },
  // type="email" so a browser rejects the obvious mistakes before the schema
  // has to; `format: email` on the roster schema is the one that decides.
  // The domain comes from CLAIM_DOMAINS, never a literal: a fork that shows a
  // PXL address in its own placeholder is the defect tests/institution-name
  // exists to catch, and it caught this one.
  email: { label: 'email address', placeholder: `e.g. name@${CLAIM_DOMAINS[0] || 'example.edu'}`, type: 'email' },
  class_group: { label: 'class group', placeholder: 'e.g. 3A', list: 'roster-class-groups' },
})

// ONE object rather than three refs, so the whole editor passes to <RosterCell>
// as a single prop and `v-model="editor.draft"` works - a ref nested inside a
// plain prop object does not auto-unwrap in a template, and `.value` in markup
// is the kind of detail that is wrong once and then wrong everywhere.
const cellEdit = reactive({ key: null, field: null, draft: '', suggestion: '', saving: false })

/** The spellings already in use, so a lecturer completes rather than invents. */
const existingClassGroups = computed(() => rosterClassGroups(existingRoster.value))

const isEditing = (student, field) =>
  cellEdit.key === rosterKey(student) && cellEdit.field === field

/**
 * What the reports would put in this cell, or '' if they know nothing useful.
 *
 * The same two hints already rendered under the cell - so the box opens holding
 * the string the lecturer can read directly beneath it, rather than asking them
 * to copy it across by hand. `harvestPlan` has already dropped anything that
 * merely repeats the login and anything that is not an address, so there is no
 * second filter here: one judge, and this reads its answer.
 */
function suggestionFor(student, field) {
  const h = harvestFor(student)
  if (!h) return ''
  if (field === 'full_name') return h.name || ''
  if (field === 'email') return h.email || ''
  return ''
}

function startCellEdit(student, field) {
  // A save in flight owns the state until it finishes. Without this, opening
  // another cell during the write (schema validation and a lost-update read are
  // both awaited) let the in-flight save's closing cancel shut the NEW cell -
  // your second edit vanished with nothing said.
  if (cellEdit.saving) return
  const stored = typeof student[field] === 'string' ? student[field] : ''
  // NEVER over a stored value. A suggestion fills a blank; it does not argue
  // with an answer somebody already gave, and a lecturer opening a filled cell
  // has to see what is actually in the roster.
  cellEdit.suggestion = stored.trim() ? '' : suggestionFor(student, field)
  cellEdit.key = rosterKey(student)
  cellEdit.field = field
  cellEdit.draft = stored || cellEdit.suggestion
}

function cancelCellEdit() {
  cellEdit.key = null
  cellEdit.field = null
  cellEdit.draft = ''
  cellEdit.suggestion = ''
}

/** Everything <RosterCell> needs, as one prop. */
const cellEditor = { fields: EDITABLE_FIELDS, state: cellEdit, isEditing, start: startCellEdit, save: saveCellEdit, cancel: cancelCellEdit }

/**
 * What to say when a roster write did not land.
 *
 * GitHub's own words for a sha conflict are "is at 7575ba... but expected
 * f7a2cd...", which was shown to a lecturer verbatim - two hashes, no subject,
 * and nothing to do about it. `commitFile` marks the case it could not retry
 * safely, and that case has exactly one remedy.
 */
function writeFailure(res) {
  if (res.conflict) {
    return 'The roster changed while you were editing, so this was not saved. Reload the page and try again.'
  }
  return `Could not save: ${res.data?.message || `HTTP ${res.status}`}`
}

/**
 * MERGE, NEVER REPLACE. The stored document is read, spread, and only this one
 * field changed - a roster rebuilt field by field from what a table renders
 * drops whatever nobody thought to list, and this table shows five of the nine
 * columns an entry can carry.
 *
 * An emptied box REMOVES the field rather than storing "", because the roster
 * schema distinguishes the two: `student_number` and `full_name` declare
 * `minLength: 1`, so "" is not merely odd, it is invalid - and an empty
 * `class_group` is a section whose name is nothing, which would render as a
 * chip in the assignment picker.
 */
async function saveCellEdit(student, field, via) {
  const key = rosterKey(student)
  // ESCAPE MUST NOT COMMIT. Cancelling unmounts the input, which fires its own
  // blur - and blur saves. So Escape cleared the draft and the blur that
  // followed wrote the cleared value, removing what the lecturer had just
  // decided not to touch. The cancel is what sets this to null, so an edit that
  // is no longer open is an edit that was abandoned.
  if (!isEditing(student, field)) return
  const next = cellEdit.draft.trim()
  const current = typeof student[field] === 'string' ? student[field].trim() : ''
  if (next === current) { cancelCellEdit(); return }

  // A SUGGESTION IS NOT AN ANSWER until a person accepts it. The box was seeded
  // from a git-config address nobody checked, so ENTER commits it - a keystroke
  // aimed at this cell, over a value tinted to say it is not yours yet - and
  // BLUR does not: clicking a cell and clicking away has to leave the row
  // exactly as it was. Same shape as the escape guard above; a value the
  // lecturer never touched must not be written by the act of looking at it.
  // `via` is missing only if some future caller forgets it, and the safe
  // reading of "I don't know how this was triggered" is "do not write".
  if (via !== 'enter' && next && next === cellEdit.suggestion) { cancelCellEdit(); return }

  const doc = existingRoster.value
  const students = (doc?.students || []).map((s) => {
    // Matched on the key as it was BEFORE the edit: setting a student number on
    // a promoted row changes that row's own key from `login:` to `num:`.
    if (rosterKey(s) !== key) return s
    // `email_source` describes the address BESIDE it. A person typing here is
    // the third writer of that column and the most trusted one, so the marker
    // goes rather than staying to describe a value that is no longer there.
    // It goes for an ACCEPTED suggestion too, even though the string came off a
    // commit: "Fill in 3 emails" writes the same addresses unread and marks
    // them `commit`, while this path took one cell, one person and one Enter
    // over a value flagged as unvouched. That asymmetry is the marker doing its
    // job - it records whether anybody looked, not where the bytes came from.
    const { [field]: _dropped, ...rest } = s
    if (field === 'email') delete rest.email_source
    return next ? { ...rest, [field]: next } : rest
  })
  const updatedDoc = { ...doc, schema_version: doc?.schema_version || 2, students }

  // Claimed BEFORE the first await, not after: validation is asynchronous, and
  // the window between here and the write is long enough to click another cell.
  cellEdit.saving = true
  try {
    const { valid, errors } = await validateAgainst('roster', updatedDoc)
    if (!valid) {
      toast.error(`Roster would be invalid: ${errors.map((e) => e.message).join(', ')}`)
      return
    }
    const token = getToken()
    // REFUSE, DO NOT OVERWRITE. This edit is built by spreading the roster as it
    // was when the page loaded, and `commitFile` fetches a fresh sha before it
    // PUTs - so a change made in between is not a conflict, it is silently
    // replaced by our older copy. The CSV import shows a diff and asks before
    // it commits; a one-cell edit should be at least as honest.
    const onDisk = await getRepoContent(token, props.org, controlRepo, ROSTER_PATH)
    if (onDisk !== null && onDisk !== rosterRaw.value) {
      toast.error('The roster changed since this page loaded. Reload before editing, so your change is not built on a stale copy.')
      cancelCellEdit()
      return
    }

    const who = student.full_name || student.student_number || student.github_login
    const what = EDITABLE_FIELDS[field].label
    const res = await commitFile(
      token, props.org, controlRepo, ROSTER_PATH,
      stringifyYaml(updatedDoc),
      next ? `Set ${who}'s ${what} to ${next}` : `Clear ${who}'s ${what}`,
      { baseContent: rosterRaw.value },
    )
    if (!res.ok) {
      toast.error(writeFailure(res))
      return
    }
    cancelCellEdit()
    await loadExisting()
  } catch (e) {
    toast.error(`Could not save: ${e.message}`)
  } finally {
    cellEdit.saving = false
  }
}

// `merged` in the empty shape too: `canCommit` is false without a parsed CSV so
// nothing reads it, but a fallback missing a field the real one has is how a
// guard that was true everywhere ends up throwing on the one path that changed.
const diff = computed(() => parsedRoster.value
  ? diffRosters(existingRoster.value, parsedRoster.value)
  : { added: [], updated: [], removed: [], unkeyed: { current: [], next: [] }, merged: null })

const canCommit = computed(() =>
  parsedRoster.value
  && !parseError.value
  && validationErrors.value.length === 0
  && diff.value.added.length + diff.value.updated.length + diff.value.removed.length > 0)

function changedFields(u) {
  const keys = new Set([...Object.keys(u.before), ...Object.keys(u.after)])
  return [...keys].filter((k) => JSON.stringify(u.before[k]) !== JSON.stringify(u.after[k]))
}

// "There is no roster" and "the roster could not be read" are different facts,
// and the assignment form turns the first into "nobody can accept". Conflating
// them would put that warning on screen because a token expired.
const rosterReadFailed = ref(false)

// Claims are org-scoped and live in separate files, so the account a student
// can actually accept with is not in roster.yml at all.
const claims = ref([])
const claimsFailed = ref(0)
const claimsReadFailed = ref(false)
const unlinking = ref(false)

const claimIndex = computed(() => indexClaims(claims.value))

// WHAT THE NIGHTLY COULD NOT DECIDE.
//
// Verified claims fold themselves into the roster overnight. Three kinds do not
// - a typed address GitHub never verified, a claim naming a different account
// than the row already holds, and an address two accounts claim - because each
// is a decision and there is nobody there to make it. They were only visible in
// the workflow log, which is not where a lecturer looks.
//
// Computed with `verifiedOnly: true`, which is exactly what the nightly passes,
// so this list IS that list rather than a second opinion about it.
const claimReview = computed(() => {
  if (!existingRoster.value || claims.value.length === 0) return null
  const plan = planClaimPromotion({
    claims: claims.value,
    roster: existingRoster.value,
    verifiedOnly: true,
  })
  return plan?.ok ? plan : null
})

/** One flat list, each row saying which decision it is waiting for. */
const heldClaims = computed(() => {
  const p = claimReview.value
  if (!p) return []
  return [
    ...p.unverified.map((u) => ({
      key: `u:${u.email}`,
      email: u.email,
      full_name: u.full_name,
      login: u.claim_login,
      reason: 'typed by the student, not verified by GitHub',
      // The only one a single button can settle: the lecturer IS the check
      // that GitHub could not perform.
      canLink: true,
    })),
    ...p.conflicts.map((c) => ({
      key: `c:${c.email}`,
      email: c.email,
      full_name: c.full_name,
      login: c.claim_login,
      // Two shapes of conflict now: a claim naming a different account than
      // the row already holds, and a claim whose address another row already
      // holds. `reason` is carried on the finding for the second, because a
      // sentence about @roster_login would be wrong for it.
      reason: c.reason || `the roster already names @${c.roster_login}`,
      // Not a one-click fix: something has to give first, and choosing which
      // account is the lecturer's call. Unlink below is that action.
      canLink: false,
    })),
    // Verified by GitHub, and simply not an institutional address. Held rather
    // than written, because the roster's `email` column is what a claim is
    // matched against and what a mail merge reads. Not one-click either: the
    // decision is what the address SHOULD be, and the Email cell takes it.
    ...(p.outsideDomains ?? []).map((o) => ({
      key: `d:${o.email}`,
      email: o.email,
      full_name: o.full_name,
      login: o.claim_login,
      reason: 'verified by GitHub, but outside the allowed domains',
      canLink: false,
    })),
    ...p.ambiguous.map((a) => ({
      key: `a:${a.email}`,
      email: a.email,
      full_name: a.full_name,
      login: null,
      reason: 'claimed by more than one account',
      canLink: false,
    })),
  ]
})

const autoLinkedCount = computed(() => linkedCount.value)
const linkingEmail = ref('')

// --- adding the students who accepted an assignment -------------------------
//
// Per-assignment, offered from the org-wide roster, so the tab has to ask WHICH
// before it can do anything. Only `open` assignments qualify: under `enforced`
// and `claim` a student had to be on the roster to accept at all, so there is
// nobody to add.
const promoteFrom = ref(null)
const promotePickerOpen = ref(false)

/**
 * Is there an assignment that could carry a confirm-email link?
 *
 * The link is minted per assignment and dies when that assignment finishes, so
 * an organization with nothing published has no link to copy - and the hint
 * under the table would be naming a control the lecturer cannot find.
 *
 * `published` only. A draft has no link at all, and a closed one's is refused
 * by the page that opens it.
 */
const hasPublishedAssignment = computed(() =>
  (props.assignments || []).some((a) => a?.state === 'published'))

const promotableAssignments = computed(() =>
  (props.assignments || []).filter((a) => a?.roster_mode === 'open' && a?.state !== 'draft'))

function pickPromotionSource(assignment) {
  promotePickerOpen.value = false
  promoteFrom.value = assignment
}

async function onPromoted() {
  promoteFrom.value = null
  await loadExisting()
}

/**
 * Link one held claim, on the lecturer's say-so.
 *
 * Scoped to a SINGLE claim rather than re-running the whole plan, so the button
 * does exactly what its row says and cannot quietly fold somebody else's
 * unverified address at the same time.
 */
async function linkAnyway(row) {
  const claim = claims.value.find((c) => normalizeEmail(c.email) === normalizeEmail(row.email))
  if (!claim) return

  const plan = planClaimPromotion({
    claims: [claim],
    roster: existingRoster.value,
    actor: getUser()?.login || 'lecturer',
  })
  if (!plan.ok || plan.updated.length === 0) {
    toast.error('Nothing to link - the roster may have changed since this list was drawn.')
    return
  }

  const { valid, errors } = await validateAgainst('roster', plan.nextRoster)
  if (!valid) {
    toast.error(`Refusing to write an invalid roster: ${errors.map((e) => e.message).join(', ')}`)
    return
  }

  linkingEmail.value = row.email
  try {
    const res = await commitFile(
      getToken(),
      props.org,
      controlRepo,
      ROSTER_PATH,
      stringifyYaml(plan.nextRoster),
      `Link ${row.email} to @${claim.github_login} (reviewed)`,
    )
    if (res.ok) {
      toast.success(`${row.email} linked to @${claim.github_login}.`)
      await loadExisting()
    } else {
      toast.error(`Commit failed: ${res.data?.message || 'unknown error'}`)
    }
  } catch (e) {
    toast.error(`Could not link: ${e.message}`)
  } finally {
    linkingEmail.value = ''
  }
}
function bindingFor(entry) {
  return bindingForEntry(entry, claimIndex.value)
}

async function loadClaims() {
  claimsReadFailed.value = false
  try {
    const { records, failed } = await listClaims(getToken(), props.org, controlRepo)
    claims.value = records
    claimsFailed.value = failed
  } catch (e) {
    // Unreadable is not evidence of none. An empty list here would paint every
    // claimed student as "Not claimed" and offer no Unlink on the one screen
    // that fixes a wrong binding.
    claimsReadFailed.value = true
    claims.value = []
    claimsFailed.value = 0
    if (e?.status !== 401) console.error('Failed to load claims', e)
  }
}

async function confirmUnlink(student, binding) {
  const who = student.full_name || student.email || `@${binding.login}`
  // Refuse on a partial read: unlinking off an incomplete list can remove the
  // wrong binding, and "no such claim" for a file that would not load reads as
  // success. Same rule PromoteRosterModal carries for acceptances.
  if (claimsFailed.value > 0 || claimsReadFailed.value) {
    toast.error(`Cannot unlink: ${claimsFailed.value || 'some'} claim record(s) could not be read, so the bindings shown are incomplete.`)
    return
  }
  const ok = window.confirm(
    `Unlink @${binding.login} from ${binding.claim.email}?\n\n` +
    `${who} will be able to claim again with any allowed address. ` +
    `Their repository and acceptance are untouched.`
  )
  if (!ok) return

  unlinking.value = true
  try {
    const token = getToken()
    const id = binding.claim.github_id
    const message = `Unlink claim for @${binding.login} (${binding.claim.email})`
    // deleteFile RESOLVES `{ ok: false, status }`; it does not throw, so the
    // catch below never sees a 403 or a conflict. Announcing the unlink
    // without reading this told the lecturer the binding was gone while the
    // student stayed locked to the old address.
    const claimRes = await deleteFile(token, props.org, controlRepo, `students/claims/${id}.json`, message)
    if (!claimRes.ok) {
      toast.error(
        `Could not unlink @${binding.login}: the claim record could not be removed (HTTP ${claimRes.status}). The binding is unchanged.`
      )
      await loadClaims()
      return
    }
    // The attempt counter goes too, and that is the point rather than tidiness:
    // a lecturer unlinks because the binding is wrong, which usually means the
    // student has been failing to claim - and an exhausted counter locks them
    // out of the door that was just reopened.
    //
    // 404 is the end state we wanted: a student who never exhausted their
    // attempts has no counter file, which is the common case and not a failure.
    const attemptsRes = await deleteFile(token, props.org, controlRepo, `students/claim-attempts/${id}.json`, message)
    if (!attemptsRes.ok && attemptsRes.status !== 404) {
      toast.warning(
        `Unlinked @${binding.login}, but their failed-attempt counter could not be cleared (HTTP ${attemptsRes.status}). If they are locked out, clear it before they retry.`
      )
    } else {
      toast.success(`Unlinked @${binding.login}. They can claim again.`)
    }
    await loadClaims()
  } catch (e) {
    toast.error(`Could not unlink: ${e?.message || e}`)
  } finally {
    unlinking.value = false
  }
}

async function loadExisting() {
  loadingExisting.value = true
  rosterReadFailed.value = false
  try {
    const token = getToken()
    // getRepoContent resolves to null on a 404 and throws on anything else, so
    // a falsy body here is a genuine absence.
    const text = await getRepoContent(token, props.org, controlRepo, ROSTER_PATH)
    existingRoster.value = text ? parseYaml(text) : null
    // The bytes as loaded, so an in-place edit can tell "nothing changed under
    // me" from "somebody else committed while this page was open". Comparing
    // the parsed document would not do: key order and formatting survive a
    // round trip through the API but not through parse-and-restringify.
    rosterRaw.value = text ?? null
  } catch (e) {
    rosterReadFailed.value = true
    existingRoster.value = null
    rosterRaw.value = null
    if (e?.status === 401) {
      toast.error('Session expired. Sign in again.')
      return
    }
    console.error('Failed to load roster', e)
  } finally {
    loadingExisting.value = false
  }
}

function formatRosterValidationError(e, doc) {
  const match = e.instancePath.match(/^\/students\/(\d+)(?:\/([a-zA-Z0-9_]+))?$/)
  if (match) {
    const idx = parseInt(match[1], 10)
    const rowNo = idx + 2
    const field = match[2]
    
    const student = doc?.students?.[idx]
    const studentDesc = student
      ? ` (${student.full_name || 'Unknown'} - SIS: ${student.student_number || 'N/A'})`
      : ''

    let friendlyMsg = e.message
    if (field) {
      if (e.keyword === 'format' && e.params?.format === 'email') {
        friendlyMsg = `'${field}' is not a valid email address.`
      } else if (e.keyword === 'minLength') {
        friendlyMsg = `'${field}' cannot be blank.`
      } else {
        friendlyMsg = `'${field}' ${e.message}.`
      }
      return `Row ${rowNo}${studentDesc}: ${friendlyMsg}`
    } else {
      return `Row ${rowNo}${studentDesc}: ${e.message}`
    }
  }
  return `${e.instancePath || '(root)'} ${e.message}` + (e.params?.allowedValue !== undefined ? ` (allowed: ${JSON.stringify(e.params.allowedValue)})` : '')
}

async function parseAndValidate() {
  parseError.value = ''
  validationErrors.value = []
  parsedRoster.value = null
  if (!csvText.value.trim()) return
  try {
    const doc = csvToRoster(csvText.value)
    const { valid, errors } = await validateAgainst('roster', doc)
    if (!valid) {
      validationErrors.value = errors.map((e) => formatRosterValidationError(e, doc))
      return
    }
    parsedRoster.value = doc
  } catch (e) {
    parseError.value = e.message
  }
}

function onCsvInput() {
  parseAndValidate()
}

const CSV_COLUMNS = ['student_number', 'full_name', 'email', 'class_group', 'github_login', 'github_id', 'active', 'team_slug', 'team_name']

function downloadBlob(text, filename, type) {
  // UTF-8 BOM on CSVs so Excel decodes accented names correctly.
  const payload = type.startsWith('text/csv') ? '﻿' + text : text
  const blob = new Blob([payload], { type })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

function downloadSampleCsv() {
  const sample = [
    CSV_COLUMNS.join(','),
    `0123456,Alice Example,alice@${exampleDomain},3A,alice-gh,,true,team-alpha,Alpha Team`,
    `0123457,Bob Example,bob@${exampleDomain},3B,,,true,team-alpha,Alpha Team`,
  ].join('\n') + '\n'
  downloadBlob(sample, 'roster-sample.csv', 'text/csv')
}

function exportRosterCsv() {
  const students = existingRoster.value?.students || []
  if (students.length === 0) return
  const lines = [CSV_COLUMNS.join(',')]
  for (const s of students) {
    lines.push(CSV_COLUMNS.map((c) => csvCell(s[c])).join(','))
  }
  downloadBlob(lines.join('\n') + '\n', `roster-${props.org}.csv`, 'text/csv')
}

async function onFileChange(ev) {
  const file = ev.target.files?.[0]
  if (!file) return
  const text = await file.text()
  csvText.value = text
  ev.target.value = ''
  await parseAndValidate()
}

// The pane's copy says "drop a CSV" - honor it.
const dragging = ref(false)
async function onDrop(ev) {
  dragging.value = false
  const file = ev.dataTransfer?.files?.[0]
  if (!file) return
  csvText.value = await file.text()
  await parseAndValidate()
}

async function commitRoster() {
  if (!canCommit.value) return
  // Removals are the destructive part - one extra look before they land.
  if (diff.value.removed.length > 0 && !window.confirm(
    `This commit removes ${diff.value.removed.length} student(s) from the roster ` +
    `(listed under "Removed"). Continue?`,
  )) return
  committing.value = true
  try {
    const token = getToken()
    // The MERGED document, not the parsed CSV. diffRosters matches a row on
    // either identity it carries and spreads the stored entry under the
    // incoming one, so a promoted row keeps its login and its provenance when
    // a CSV names the same student by number. Committing parsedRoster instead
    // would write exactly the document the preview did not describe.
    const yaml = stringifyYaml(diff.value.merged)
    const message = `Update ${ROSTER_PATH} via Admin Panel (+${diff.value.added.length} ~${diff.value.updated.length} -${diff.value.removed.length})`
    const res = await commitFile(token, props.org, controlRepo, ROSTER_PATH, yaml, message)
    if (res.ok) {
      toast.success(`Roster committed (${diff.value.merged.students.length} students)`)
      await loadExisting()
    } else {
      toast.error(`Commit failed: ${res.data?.message || 'unknown error'}`)
    }
  } finally {
    committing.value = false
  }
}

// Claims are loaded beside the roster and switched with it: they are org-scoped,
// so a stale list from the previous org would show bindings that belong to
// somebody else's cohort. Deliberately NOT awaited together - a failed claim
// read must not take the roster down with it, the rule the acceptance card
// learned when one rejected lookup replaced a loaded assignment with an error.
// The hints are loaded AFTER the roster, not beside it: whether to read the
// reports at all is decided from the roster, so racing them means deciding with
// nothing to decide from - and `wantsHints` would be false every time.
watch(() => props.org, () => { loadExisting().then(loadReports); loadClaims() })
watch(csvText, () => parseAndValidate())

const promotePickerRef = ref(null)

// --- the row's actions menu -------------------------------------------------
//
// One menu per row, holding the three things you can do to one student. It
// exists because editing was discoverable only by clicking a "-" in an empty
// cell, which a lecturer reported as "really, really confusing" - a dash is not
// a control, and hover is not discoverable either (the same lesson the resting
// dotted underline was written for).
//
// Keyed by rosterKey, not by index: a filter change reorders the list, and an
// index would leave the menu open over a different student.
const rowMenuFor = ref(null)
const rowMenuRefs = new Map()

function setRowMenuRef(student, el) {
  const key = rosterKey(student)
  if (el) rowMenuRefs.set(key, el)
  else rowMenuRefs.delete(key)
}

// FIXED, not absolute, and positioned from the trigger's own rectangle.
//
// The table sits in `.roster-table-wrapper`, which is `overflow-x: auto` - and
// a box that is not `visible` on one axis computes to `auto` on the other, so
// the wrapper clips vertically as well. An absolutely positioned panel inside
// it was cut off after its first item.
//
// Fixed escapes the scroller. It is safe here because nothing between this and
// the viewport carries a `transform`, `filter`, `perspective`, `will-change` or
// `contain` - any of those would become the containing block and put the panel
// somewhere else entirely (DESIGN.md, and the failure tests/e2e/47 exists for).
const rowMenuStyle = ref(null)

function toggleRowMenu(student, event) {
  const key = rosterKey(student)
  if (rowMenuFor.value === key) {
    rowMenuFor.value = null
    return
  }
  const r = event?.currentTarget?.getBoundingClientRect?.()
  if (r) {
    const WIDTH = 280
    const ESTIMATED_HEIGHT = 210
    // Flip up when there is no room below, so the last rows of a long roster
    // are not the ones whose menu you cannot read.
    const below = window.innerHeight - r.bottom
    rowMenuStyle.value = {
      left: `${Math.max(8, Math.min(r.right - WIDTH, window.innerWidth - WIDTH - 8))}px`,
      ...(below < ESTIMATED_HEIGHT
        ? { bottom: `${window.innerHeight - r.top + 4}px` }
        : { top: `${r.bottom + 4}px` }),
    }
  }
  rowMenuFor.value = key
}

/** Run a menu action and close the menu, so the answer is not behind it. */
function fromRowMenu(action) {
  rowMenuFor.value = null
  action()
}

/** Whatever this row can be called, for a label a person reads. */
function whoIs(s) {
  return s.full_name || s.student_number || (s.github_login ? `@${s.github_login}` : 'this student')
}

// Closes on an outside click and on Escape, like every other menu in the app.
function onDocumentClick(e) {
  if (promotePickerRef.value && !promotePickerRef.value.contains(e.target)) {
    promotePickerOpen.value = false
  }
  const openRow = rowMenuFor.value && rowMenuRefs.get(rowMenuFor.value)
  if (openRow && !openRow.contains(e.target)) rowMenuFor.value = null
}
function onEscape(e) {
  if (e.key !== 'Escape') return
  promotePickerOpen.value = false
  rowMenuFor.value = null
}

onMounted(() => {
  loadExisting().then(loadReports)
  loadClaims()
  document.addEventListener('click', onDocumentClick)
  window.addEventListener('keydown', onEscape)
})
onUnmounted(() => {
  document.removeEventListener('click', onDocumentClick)
  window.removeEventListener('keydown', onEscape)
})

// A parsed import with an uncommitted diff is unsaved work - the parent
// includes it in the route-leave / beforeunload guards.
//
// The count is exposed because the assignment form has to say whether anyone
// can accept at all under `roster_mode: enforced`, and this component has
// already fetched `students/roster.yml` on mount. Re-reading it there would be
// a second request for a file that is open in the next tab - and two readers
// that could disagree. `loadExisting()` runs again after a commit, so the
// number the form shows follows an import without being told.
// null means "not known": still loading, or the read failed. A roster file that
// does not exist is 0 - that is a known fact, and it is the one that stops
// every acceptance under `roster_mode: enforced`.
const studentCount = computed(() => {
  if (loadingExisting.value || rosterReadFailed.value) return null
  const students = existingRoster.value?.students
  return Array.isArray(students) ? students.length : 0
})

// `github_login` is the optional column, and `accept.mjs` matches on it and
// nothing else - so a roster of 200 students imported before anyone handed in
// their username lets exactly nobody accept. "200 students on the roster" is
// true and answers the wrong question.
const linkedCount = computed(() => {
  const students = existingRoster.value?.students
  if (!Array.isArray(students)) return 0
  return students.filter((s) => typeof s?.github_login === 'string' && s.github_login.trim()).length
})

defineExpose({
  isDirty: () => canCommit.value,
  studentCount,
  linkedCount,
  // The roster as read, so the assignment form can offer this org's real class
  // groups and say who a cohort restriction would shut out. It has already
  // fetched the file; a second read there would be the same request twice.
  rosterStudents: computed(() => existingRoster.value?.students || []),
})
</script>

<style scoped>
.roster-tab { display: flex; flex-direction: column; gap: var(--space-md); }
.roster-header h3 { margin: 0 0 var(--space-xs) 0; }
.roster-header p { margin: 0; }

/* IMPORT IS A ONCE-A-SEMESTER ACTION; THE ROSTER IS THE EVERYDAY VIEW. An even
   split gave the CSV box half the screen for ever, squeezing the table nobody
   stops looking at. Once a roster is committed the import pane steps back to a
   column, and takes the full half again the moment a CSV is staged and there is
   a diff to read.

   `minmax(0, 1fr)`, never a bare `1fr` (DESIGN.md §7): a bare track's minimum is
   its content's min-content width, and the roster table does not wrap. */
.roster-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: var(--space-lg);
  align-items: start;
}
.roster-grid.has-roster { grid-template-columns: minmax(0, 20rem) minmax(0, 1fr); }
@media (max-width: 900px) {
  .roster-grid,
  .roster-grid.has-roster { grid-template-columns: minmax(0, 1fr); }
}

.input-pane, .diff-pane {
  background: var(--bg-secondary);
  border: 1px solid var(--border-default);
  border-radius: 8px;
  padding: var(--space-md);
}
.input-pane.dragging {
  border-color: var(--accent-blue);
  box-shadow: var(--ring-focus);
}

.field { display: flex; flex-direction: column; gap: 4px; margin-bottom: var(--space-md); }
.field label { font-weight: 500; font-size: 0.9rem; color: var(--text-secondary); }
.field small { color: var(--text-muted); font-size: 0.8rem; }
.field input[type="file"] { padding: var(--space-xs) 0; }
.field textarea {
  width: 100%;
  padding: 8px 10px;
  background: var(--bg-primary);
  border: 1px solid var(--border-default);
  border-radius: 4px;
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-size: 0.85rem;
  resize: vertical;
}

.empty-state { text-align: center; padding: var(--space-2xl) 0; color: var(--text-secondary); }
.empty-state h4 { margin: 0 0 var(--space-xs) 0; }

/* LEFT, like everything under it. It was centred from when this pane held two
   lines and an empty state; with a table below, a centred heading over
   left-aligned rows reads as a different component. */
.existing-summary {
  padding: var(--space-md) 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-md);
  align-items: stretch;
}
.existing-summary p { margin: 0; }
.text-secondary { color: var(--text-secondary); }


.diff-info {
  padding: var(--space-sm) var(--space-md);
  background: var(--tint-success-subtle);
  border-left: 3px solid var(--accent-green-bright);
  border-radius: 4px;
  margin-bottom: var(--space-md);
}

.diff-summary { display: flex; gap: var(--space-sm); margin-bottom: var(--space-md); flex-wrap: wrap; }
.diff-badge {
  display: inline-block;
  padding: 4px 10px;
  border-radius: 4px;
  font-size: 0.85rem;
  font-family: var(--font-mono);
}
.diff-badge.added   { background: var(--tint-success-muted);  color: var(--accent-green-bright); }
.diff-badge.updated { background: var(--tint-attention-muted);  color: var(--accent-yellow-bright); }
.diff-badge.removed { background: var(--tint-danger-muted);  color: var(--accent-red); }

.diff-pane details { border: 1px solid var(--border-default); border-radius: 6px; padding: var(--space-sm); margin-bottom: var(--space-sm); }
.diff-pane summary { cursor: pointer; font-weight: 600; padding: var(--space-xs); }
.diff-pane ul { list-style: none; padding: 0 var(--space-sm); margin: var(--space-xs) 0 0 0; max-height: 240px; overflow-y: auto; }
.diff-pane li { font-size: 0.9rem; padding: 2px 0; }
.diff-pane code { background: var(--bg-tertiary); padding: 0 4px; border-radius: 3px; font-family: var(--font-mono); font-size: 0.85em; }
.changed-fields { color: var(--text-muted); font-size: 0.8rem; font-family: var(--font-mono); margin-left: 6px; }

.diff-empty { padding: var(--space-md); color: var(--text-secondary); text-align: center; }

.validation-errors {
  background: var(--tint-danger-subtle);
  border: 1px solid var(--accent-red);
  border-radius: 6px;
  padding: var(--space-sm) var(--space-md);
  color: var(--accent-red);
  margin-bottom: var(--space-md);
}
.validation-errors ul { margin: var(--space-xs) 0 0 var(--space-md); padding: 0; }

.actions { display: flex; justify-content: flex-end; padding-top: var(--space-md); border-top: 1px solid var(--border-default); }

.loading-inline { display: flex; align-items: center; gap: var(--space-sm); color: var(--text-secondary); padding: var(--space-sm); }
.spinner.sm { width: 14px; height: 14px; border-width: 2px; }

/* `.chip-btn` moved to style.css when the cohort picker started using it too -
   DESIGN.md §7, a class more than one component uses is shared vocabulary. */

.modal-overlay {
  position: fixed;
  inset: 0;
  background: var(--bg-scrim);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  backdrop-filter: blur(2px);
}
.modal {
  background: var(--bg-secondary);
  border: 1px solid var(--border-default);
  border-radius: 8px;
  width: 90%;
  box-shadow: var(--shadow-lg, 0 10px 25px var(--shadow-color-modal));
}
.modal-head {
  padding: var(--space-md);
  border-bottom: 1px solid var(--border-default);
}
.modal-close {
  background: none;
  border: none;
  font-size: 1.4rem;
  color: var(--text-muted);
  cursor: pointer;
}
.modal-close:hover {
  color: var(--text-primary);
}
.mono {
  font-family: var(--font-mono);
}

/* ------------------------------------------------------------------------
   Vocabulary that was carried INLINE.

   Each class below was written in the markup beside a `style="…"` that said
   what it meant, so the class itself was declared nowhere and the look lived on
   the element. Moving the declarations here changes nothing on screen - the
   values are unchanged - but it takes them off the undeclared-class register
   and puts the appearance where DESIGN.md says it belongs.
   ------------------------------------------------------------------------ */

/* Anchor for the "which assignment?" picker. */
.promote-picker-anchor { position: relative; display: inline-flex; }
/* The row's actions menu. Same shape as .promote-picker above - an absolutely
   positioned panel under its trigger - kept scoped because only this component
   has one. If a second table grows one, both move to style.css (DESIGN.md 7).

   NO TRANSFORM anywhere on the anchor or the panel: this table sits inside
   .roster-table-wrapper, which scrolls, and a transform on an ancestor becomes
   the containing block for anything fixed inside it. The panel is absolute
   rather than fixed for the same reason - it has to travel with its row. */
.row-menu-anchor {
  position: relative;
  display: inline-block;
}

.row-menu {
  position: fixed;
  z-index: 100;
  width: 280px;
  padding: var(--space-xs);
  /* DESIGN.md 2 names --bg-surface-elevated for dropdown menus. In light both
     resolve to #ffffff and the panel separates by shadow; in dark it is a real
     step up, which is what a panel floating over a table wants. */
  background: var(--bg-surface-elevated);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-lg);
  text-align: left;
}

.row-menu-item {
  display: block;
  width: 100%;
  padding: var(--space-sm);
  background: none;
  border: 0;
  border-radius: var(--radius-sm);
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.row-menu-item:hover:not(:disabled),
.row-menu-item:focus-visible {
  background: var(--bg-surface-hover);
}
.row-menu-item:disabled {
  opacity: 0.5;
  cursor: default;
}

.row-menu-title {
  display: block;
  font-weight: 500;
  color: var(--text-primary);
}

/* What the action does, under its name. A destructive action a lecturer has to
   guess at is how somebody removes the wrong thing. */
.row-menu-note {
  display: block;
  margin-top: 2px;
  font-size: 0.75rem;
  line-height: 1.35;
  color: var(--text-muted);
}

.row-menu-item-danger .row-menu-title {
  color: var(--accent-red);
}

.promote-picker {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  z-index: 100;
  min-width: 240px;
  max-height: 320px;
  overflow-y: auto;
  padding: var(--space-xs);
  background: var(--bg-surface-elevated);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-lg);
  text-align: left;
}
.promote-picker-head {
  margin: 0 0 var(--space-2xs);
  padding: 4px 8px;
  font-size: 0.78rem;
  color: var(--text-muted);
}
.promote-picker-item {
  display: flex;
  flex-direction: column;
  gap: 1px;
  width: 100%;
  padding: 6px 8px;
  background: none;
  border: 0;
  border-radius: var(--radius-xs);
  text-align: left;
  cursor: pointer;
  color: var(--text-primary);
}
.promote-picker-item:hover { background: var(--bg-surface-hover); }
.promote-picker-title { font-size: 0.9rem; }
.promote-picker-sub { font-family: var(--font-mono); font-size: 0.75rem; color: var(--text-muted); }

/* The review box. A tonal step with a single attention edge rather than a
   bordered card - this sits inside the roster panel, which is already a box
   (DESIGN.md §1.1), and the colour is the warning token because it needs a look
   rather than an alarm (§4). */
.claim-review {
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
  padding: var(--space-sm) var(--space-md);
  background: var(--bg-inset);
  border-radius: var(--radius-sm);
  box-shadow: inset 2px 0 0 var(--accent-yellow);
}
.claim-review-head {
  flex-wrap: wrap;
}
.claim-review-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-xs);
}
.claim-review-row {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  flex-wrap: wrap;
}
.claim-review-who { flex: 0 1 auto; min-width: 0; }
/* Takes the slack so the action stays at the right edge on a wide row, and
   wraps under rather than squeezing the button on a narrow one. */
.claim-review-why { flex: 1 1 16ch; min-width: 0; }
.claim-review-hint { white-space: nowrap; }

.roster-filter-chips {
  margin-top: var(--space-sm);
}

.roster-table-wrapper {
  margin-top: var(--space-sm);
  max-height: 380px;
  overflow-y: auto;
  /* DECLARED, not inherited from a quirk. This table is wider than a phone -
     five columns, one of them an email address - and what kept the PAGE from
     scrolling sideways was the CSS rule that `overflow-x: visible` computes to
     `auto` when the other axis is not visible. Correct, and entirely implicit:
     drop the max-height above and horizontal scrolling disappears with it,
     taking the page sideways at 375px. DESIGN.md's rule is that wide content
     scrolls in its own container, so the container says so. */
  overflow-x: auto;
}

/* The group cell, editable in place. A button rather than a span with a click
   handler, so it is reachable by keyboard and announced as something you can
   operate - which is what it is. Muted until hovered, because 200 of these
   should not read as 200 controls. */
/* THE ROW READ BACKWARDS. `.diff-pane code` fills every <code> in this pane,
   so the student number - which nothing can edit - looked like an input, while
   the group cell, which is now the one editable thing in the row, was plain
   text. Qualified rather than relying on source order, the way `.field code`
   beat a bare class in AdminView. */
.diff-pane .roster-table code {
  background: none;
  padding: 0;
}

/* What the reports know, under the name that is not yet known. Muted and
   small: it is evidence to read, not a value the roster holds. */
/* Under the table, with the rows it is about, rather than up in the toolbar
   where it would read as another action. */
.roster-ask-hint {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 4px;
  margin: var(--space-sm) 0 0;
}

.harvest-hint {
  display: flex;
  align-items: baseline;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 2px;
  font-size: 0.78rem;
  font-weight: 400;
}
.harvest-hint code {
  font-size: inherit;
  /* An address is one unbreakable token, and it sets the column's intrinsic
     width: on a 375px phone this hint alone took the table's horizontal scroll
     from 71px to 219px, pushing Email, Group and GitHub Account off-screen.
     Breaking inside it costs nothing - it is evidence to read, not a value to
     select - and it is the same reasoning as the grid track in DESIGN.md §7. */
  overflow-wrap: anywhere;
}

/* Where an address came from, when a person did not type it. Small and quiet:
   it qualifies the value beside it rather than competing with it. */
.email-source {
  display: inline-block;
  margin-left: 6px;
  font-size: 0.7rem;
  text-transform: lowercase;
}
.email-source-claim { color: var(--accent-green); }
.email-source-commit { color: var(--text-muted); }
</style>
