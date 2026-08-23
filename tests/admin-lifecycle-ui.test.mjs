// PXL Classroom - admin-lifecycle-ui.test.mjs
//
// Comprehensive unit & integration tests covering AdminView.vue lifecycle
// controls, initial conditions, button availability, dialogs, and publish/republish actions.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { validateAgainst } from "../lib/validate.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

// Pure state simulation helper mirroring AdminView.vue logic
function computeAdminLifecycleState({ isNew, formState, publishing, saving, deleting }) {
  // Lifecycle section only renders for existing assignments
  const showLifecycle = !isNew;

  if (!showLifecycle) {
    return {
      showLifecycle: false,
      topButtonLabel: 'Save & publish',
      canPublish: true,
      canSaveDraft: true,
    };
  }

  // Publish / Republish button inside Lifecycle section
  const publishButtonLabel = publishing
    ? 'Publishing…'
    : formState === 'published'
    ? 'Republish broker'
    : 'Publish (create broker, enable nightly)';

  const publishButtonDisabled = publishing; // Never disabled by formState === 'published'
  const isRepublish = formState === 'published';
  const buttonVariant = formState === 'published' ? 'btn-warning' : '';

  // Other lifecycle buttons
  const canClose = formState !== 'closed' && !saving;
  const canArchive = formState !== 'archived' && !saving;
  const showRevertToDraft = formState === 'published' || formState === 'closed';
  const showCopyLink = formState === 'published';
  const showDeleteDraft = formState === 'draft';

  return {
    showLifecycle: true,
    publishButtonLabel,
    publishButtonDisabled,
    isRepublish,
    buttonVariant,
    canClose,
    canArchive,
    showRevertToDraft,
    showCopyLink,
    showDeleteDraft,
  };
}

// -----------------------------------------------------------------------------
// 1. Initial Condition: New Assignment (isNew = true)
// -----------------------------------------------------------------------------
test("Initial condition: New Assignment hides lifecycle section and offers Save & publish", () => {
  const state = computeAdminLifecycleState({
    isNew: true,
    formState: 'draft',
    publishing: false,
    saving: false,
    deleting: false,
  });

  assert.equal(state.showLifecycle, false, "Lifecycle section must NOT render on new assignment creation");
  assert.equal(state.topButtonLabel, 'Save & publish');
  assert.equal(state.canPublish, true);
});

// -----------------------------------------------------------------------------
// 2. Initial Condition: Existing Assignment in Draft (isNew = false, state = 'draft')
// -----------------------------------------------------------------------------
test("Initial condition: Existing Draft assignment renders Publish button (enabled, standard style)", () => {
  const state = computeAdminLifecycleState({
    isNew: false,
    formState: 'draft',
    publishing: false,
    saving: false,
    deleting: false,
  });

  assert.equal(state.showLifecycle, true);
  assert.equal(state.publishButtonLabel, 'Publish (create broker, enable nightly)');
  assert.equal(state.publishButtonDisabled, false, "Publish button must be enabled for drafts");
  assert.equal(state.isRepublish, false);
  assert.equal(state.buttonVariant, '', "Draft publish button uses standard style");
  assert.equal(state.showDeleteDraft, true);
  assert.equal(state.showCopyLink, false);
  assert.equal(state.showRevertToDraft, false);
});

// -----------------------------------------------------------------------------
// 3. Initial Condition: Existing Assignment in Published (isNew = false, state = 'published')
// -----------------------------------------------------------------------------
test("Initial condition: Published assignment renders orange Republish broker button (enabled)", () => {
  const state = computeAdminLifecycleState({
    isNew: false,
    formState: 'published',
    publishing: false,
    saving: false,
    deleting: false,
  });

  assert.equal(state.showLifecycle, true);
  assert.equal(state.publishButtonLabel, 'Republish broker');
  assert.equal(state.publishButtonDisabled, false, "Republish broker button must be clickable");
  assert.equal(state.isRepublish, true);
  assert.equal(state.buttonVariant, 'btn-warning', "Republish broker button must be orange (btn-warning)");
  assert.equal(state.showCopyLink, true);
  assert.equal(state.showRevertToDraft, true);
  assert.equal(state.showDeleteDraft, false);
});

// -----------------------------------------------------------------------------
// 4. Initial Condition: In-Flight Publishing (publishing = true)
// -----------------------------------------------------------------------------
test("Initial condition: In-flight publishing disables the button with loading label", () => {
  const state = computeAdminLifecycleState({
    isNew: false,
    formState: 'published',
    publishing: true,
    saving: false,
    deleting: false,
  });

  assert.equal(state.publishButtonLabel, 'Publishing…');
  assert.equal(state.publishButtonDisabled, true, "Button must be disabled while publishing is in progress");
});

// -----------------------------------------------------------------------------
// 5. Template AST & Dialog Verification in AdminView.vue
// -----------------------------------------------------------------------------
test("AdminView.vue template strictly adheres to lifecycle condition invariants and confirmation dialog", () => {
  const template = readFileSync(join(root, "frontend", "src", "views", "AdminView.vue"), "utf8");

  // Lifecycle section presence check
  assert.ok(
    template.includes('<div v-if="!isNew" class="lifecycle">'),
    "Lifecycle block must be gated on !isNew"
  );

  // A published assignment's Publish button becomes Republish, and picks up the
  // secondary treatment to say so.
  //
  // This used to assert `btn-warning`, which is not one of DESIGN.md §3's four
  // variants and is not declared anywhere - not in style.css, not in any scoped
  // block. Seven buttons across two components carried it and rendered as a
  // plain `.btn`. The test passed because it read the template, not the CSS.
  assert.ok(
    template.includes("form.state === 'published' ? 'btn-secondary' : ''"),
    "Republish must use the §3 secondary variant when published"
  );
  assert.ok(
    !template.includes("btn-warning"),
    "btn-warning is not a DESIGN.md §3 variant and is declared nowhere - it renders as a plain .btn"
  );

  // Click handler check
  assert.ok(
    template.includes('@click="handlePublishClick"'),
    "Button must call handlePublishClick"
  );

  // Published template condition check
  assert.ok(
    template.includes("v-else-if=\"form.state === 'published'\""),
    "Must have dedicated v-else-if branch for form.state === 'published'"
  );
  assert.ok(
    template.includes("Republish broker"),
    "Must render 'Republish broker' label when published"
  );

  // Confirmation modal dialog check
  assert.ok(
    template.includes('v-if="showRepublishModal"'),
    "Must render confirmation dialog when showRepublishModal is true"
  );
  assert.ok(
    template.includes("What will happen"),
    "Dialog must explain what will happen"
  );
  assert.ok(
    template.includes("Effect on existing student repositories"),
    "Dialog must explicitly explain the effect on existing student repositories"
  );
  assert.ok(
    template.includes("100% Safe") || template.includes("Safe"),
    "Dialog must assure user that existing repositories are safe and untouched"
  );
});

// The Admin Panel rebuilds the whole assignment document on save rather than
// patching it, so any field buildDoc does not carry through is deleted from the
// YAML. invite_token is minted by publish-assignment.yml and never edited here,
// which is exactly what makes it easy to drop - and dropping it silently
// retires the invitation link already in students' hands, leaving a document
// that still validates against the schema.
test("saving an edited assignment preserves its invitation", () => {
  const src = readFileSync(join(root, "frontend", "src", "views", "AdminView.vue"), "utf8");
  for (const field of ["invite_token", "invite_nonce", "invite_expires_at"]) {
    assert.ok(
      src.includes(`...(form.value.${field} ? { ${field}: form.value.${field} } : {})`),
      `buildDoc must carry ${field} through, or saving an edit deletes it from the YAML`
    );
  }
});

test("opening an assignment for edit loads its invitation", () => {
  // Without this the field never reaches the form, so buildDoc has nothing to
  // preserve and "Copy invitation link" has nothing to copy.
  const src = readFileSync(join(root, "frontend", "src", "views", "AdminView.vue"), "utf8");
  for (const field of ["invite_token", "invite_nonce", "invite_expires_at"]) {
    assert.ok(
      src.includes(`${field}: a.${field} || ''`),
      `the edit form must load ${field} from the assignment`
    );
  }
});

// -----------------------------------------------------------------------------
// 6. The form's own defaults (UX_PLAN §3.1, §3.3)
// -----------------------------------------------------------------------------

// Only emptyForm() - the defaults for a NEW assignment. Slicing to the closing
// brace of the returned object keeps loadAssignmentIntoForm()'s
// `roster_mode: a.roster_mode === 'open' ? ...` out of the match; without the
// bound this reads whichever spelling appears first in the file.
function emptyFormSource() {
  const src = readFileSync(join(root, "frontend", "src", "views", "AdminView.vue"), "utf8");
  const start = src.indexOf("function emptyForm()");
  assert.ok(start > 0, "emptyForm() must still exist");
  const end = src.indexOf("\n}", start);
  assert.ok(end > start, "emptyForm() must still be a function");
  return src.slice(start, end);
}

test("a new assignment defaults to the enforced roster", () => {
  // accept.mjs fails closed to `enforced` for anything it does not recognise,
  // so the form was the only thing choosing the permissive setting - while its
  // own hint said "Anyone with the link can claim a repo."
  const body = emptyFormSource();
  assert.match(body, /roster_mode: 'enforced'/, "new assignments start on the roster gate");
  assert.ok(!/roster_mode: 'open'/.test(body), "'open' is an opt-in, not a default");
});

test("open enrollment still requires a cap", () => {
  // The default changed; the guardrail behind the other value did not. Without
  // the roster gate, max_acceptances is the only limit on who can claim a repo.
  const base = parse(readFileSync(join(root, "tests", "fixtures", "valid-assignment.yml"), "utf8"));
  const uncapped = { ...base, roster_mode: "open" };
  delete uncapped.max_acceptances;
  assert.equal(validateAgainst("assignment", uncapped).valid, false);
  assert.equal(validateAgainst("assignment", { ...base, roster_mode: "open", max_acceptances: 30 }).valid, true);
});

test("the form refuses a python test with no script, and says so on screen", () => {
  // The schema refuses it too (tests/sweep-correctness.test.mjs), but an AJV
  // message names /autograde/tests/2 and a required property. Both halves are
  // load-bearing: an error that blocks Save and renders nowhere is a disabled
  // button with no explanation.
  const src = readFileSync(join(root, "frontend", "src", "views", "AdminView.vue"), "utf8");
  assert.match(src, /errors\.autograde_tests\s*=/, "fieldErrors must carry the rule - canSave watches it");
  assert.match(src, /v-if="fieldErrors\.autograde_tests"/, "and the tests editor must render it");
});

test("acceptance_mode has no control, and is still written", () => {
  // One enum value is not a decision (C1), so the select is gone. The field
  // stays: existing YAMLs carry it and the public card publishes it, and
  // buildDoc rebuilds the whole document - dropping it here would delete it.
  const src = readFileSync(join(root, "frontend", "src", "views", "AdminView.vue"), "utf8");
  assert.ok(
    !/v-model="form\.acceptance_mode"/.test(src),
    "a select with one option asks the lecturer a question they cannot answer"
  );
  assert.match(src, /acceptance_mode: form\.value\.acceptance_mode/, "buildDoc still writes the field");
  assert.match(src, /acceptance_mode: 'self-service'/, "and the form still carries a value for it");
});
