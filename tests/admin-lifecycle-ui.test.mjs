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
import { normalizeRosterMode, ROSTER_MODES } from "../lib/roster-mode.mjs";

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

  // WS5 split the flat row in two: repair above the rule, state transitions
  // below (ARCHITECTURE §10.1.1). An assignment that is out has something to repair;
  // a draft does not, and its Publish is a transition, so it sits with the
  // others.
  const isOut = formState === 'published' || formState === 'closed';

  // PUBLISHED only. publish-assignment.yml writes `state: published`
  // unconditionally, so the same dispatch from `closed` or `archived` reopens
  // acceptance - a transition, not a repair, and it must not sit under copy
  // promising nothing changes.
  const showRepairGroup = formState === 'published';
  const reopens = formState === 'closed' || formState === 'archived';

  const publishButtonLabel = publishing
    ? 'Publishing…'
    : formState === 'published'
    ? 'Republish broker'
    : reopens
    ? 'Reopen for acceptance'
    : 'Publish (create broker, enable nightly)';

  const publishButtonDisabled = publishing; // Never disabled by formState === 'published'
  const isRepublish = formState === 'published';
  const buttonVariant = formState === 'published' ? 'btn-secondary' : '';

  // Other lifecycle buttons
  const canClose = formState !== 'closed' && !saving;
  const canArchive = formState !== 'archived' && !saving;
  const showRevertToDraft = isOut;
  const showCopyLink = false; // WS2: copying is not a lifecycle transition
  const showDeleteDraft = formState === 'draft';
  // Per-student operations left for the tracking view (ARCHITECTURE §10.1.1); the
  // pointer stays for one release.
  const showMovedNote = isOut;

  return {
    showLifecycle: true,
    showRepairGroup,
    publishButtonLabel,
    publishButtonDisabled,
    isRepublish,
    buttonVariant,
    canClose,
    canArchive,
    showRevertToDraft,
    showCopyLink,
    showDeleteDraft,
    showMovedNote,
    reopens,
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
  assert.equal(state.showRepairGroup, false, "A draft has no broker to repair yet");
});

// -----------------------------------------------------------------------------
// 3. Initial Condition: Existing Assignment in Published (isNew = false, state = 'published')
// -----------------------------------------------------------------------------
test("Initial condition: Published assignment renders a Republish broker button under Repair", () => {
  const state = computeAdminLifecycleState({
    isNew: false,
    formState: 'published',
    publishing: false,
    saving: false,
    deleting: false,
  });

  assert.equal(state.showLifecycle, true);
  assert.equal(state.showRepairGroup, true, "Republish is a repair, not a state transition");
  assert.equal(state.publishButtonLabel, 'Republish broker');
  assert.equal(state.publishButtonDisabled, false, "Republish broker button must be clickable");
  assert.equal(state.isRepublish, true);
  // Not btn-warning: it is not one of DESIGN.md §3's four variants and is
  // declared nowhere, so it rendered as a plain .btn. This simulation asserted
  // it for months while the template check on line ~160 forbade it.
  assert.equal(state.buttonVariant, 'btn-secondary', "Republish uses the §3 secondary variant");
  assert.equal(state.showCopyLink, false);
  assert.equal(state.showRevertToDraft, true);
  assert.equal(state.showDeleteDraft, false);
  assert.equal(state.showMovedNote, true, "Extensions and retries moved; say where");
});

// A closed assignment has no repair, because the only mechanism available -
// re-dispatching publish-assignment.yml - reopens it. Calling that a repair is
// C4: the UI describing behaviour the system does not have.
test("Initial condition: Closed assignment has no repair group, and its publish says it reopens", () => {
  const state = computeAdminLifecycleState({
    isNew: false,
    formState: 'closed',
    publishing: false,
    saving: false,
    deleting: false,
  });

  assert.equal(state.showRepairGroup, false, "republishing a closed assignment is not a repair - it un-closes it");
  assert.equal(state.publishButtonLabel, 'Reopen for acceptance');
  assert.equal(state.reopens, true, "and it confirms before doing it");
  assert.equal(state.canClose, false, "Already closed");
  assert.equal(state.showRevertToDraft, true);
});

test("Initial condition: Archived reopens too, and says so", () => {
  const state = computeAdminLifecycleState({
    isNew: false,
    formState: 'archived',
    publishing: false,
    saving: false,
    deleting: false,
  });

  assert.equal(state.showRepairGroup, false);
  assert.equal(state.publishButtonLabel, 'Reopen for acceptance');
  assert.equal(state.reopens, true);
  assert.equal(state.canArchive, false, "Already archived");
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

  // Repair sits above the rule, state transitions below it (ARCHITECTURE §10.1.1).
  assert.ok(
    /class="lifecycle-group lifecycle-repair"/.test(template),
    "Republish belongs to the repair group, not the transition row"
  );
  assert.ok(
    template.indexOf('lifecycle-repair') < template.indexOf('lifecycle-transitions'),
    "Repair is rendered above the state transitions"
  );

  // A published assignment's Publish button becomes Republish, and carries the
  // secondary treatment to say so.
  //
  // This used to assert `btn-warning`, which is not one of DESIGN.md §3's four
  // variants and is not declared anywhere - not in style.css, not in any scoped
  // block. Seven buttons across two components carried it and rendered as a
  // plain `.btn`. The test passed because it read the template, not the CSS.
  assert.ok(
    !template.includes("btn-warning"),
    "btn-warning is not a DESIGN.md §3 variant and is declared nowhere - it renders as a plain .btn"
  );

  // Click handler check
  assert.ok(
    template.includes('@click="handlePublishClick"'),
    "Button must call handlePublishClick"
  );

  // Exactly one of the two publish entry points can render: Repair's
  // "Republish broker" once the assignment is out, the transition row's
  // "Publish" while it is not. Complementary conditions, so neither state can
  // show both or neither.
  assert.ok(
    template.includes(`<div v-if="form.state === 'published'" class="lifecycle-group lifecycle-repair">`),
    "Repair group renders for a published assignment only"
  );
  assert.ok(
    template.includes(`v-if="form.state !== 'published'"`),
    "The transition-row Publish renders for every other state"
  );
  assert.match(
    template,
    /Reopen for acceptance/,
    "and from closed or archived it is named after what it does"
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
// The builder moved out of the view into lib/assignment-doc.mjs, so the SPA and
// tests/contract-form-diagnostics.test.mjs build ONE document - that test used
// to carry a hand-maintained copy which had already stopped emitting the
// signed-acceptance keypair. These guards follow it: an anchor left pointing at
// AdminView.vue would have gone on passing against a file that no longer
// contains the thing it asserts about.
const buildDocSrc = () => readFileSync(join(root, "lib", "assignment-doc.mjs"), "utf8");

test("saving an edited assignment preserves its invitation", () => {
  const src = buildDocSrc();
  for (const field of ["invite_token", "invite_nonce", "invite_expires_at"]) {
    assert.ok(
      src.includes(`...(form.${field} ? { ${field}: form.${field} } : {})`),
      `buildAssignmentDoc must carry ${field} through, or saving an edit deletes it from the YAML`
    );
  }
});

// The whole class, rather than one field at a time.
//
// buildDoc rebuilds the assignment field by field, so ANY field the schema
// allows but buildDoc omits is deleted the next time a lecturer saves - and the
// document still validates, because the omitted field was optional. It has
// happened twice: invite_token (silently retiring every student's link) and
// claim_domains (silently reverting a narrowed domain list to the deployment
// default). Both were fields a lecturer never edits in the form, which is
// exactly what makes them easy to drop.
//
// Reading the schema rather than a hand-kept list means a new optional field
// arrives here as a failure instead of as a silent deletion nobody notices.
test("buildDoc carries every field the assignment schema allows", () => {
  const schema = JSON.parse(
    readFileSync(join(root, "schemas", "assignment.schema.json"), "utf8"),
  );
  const declared = Object.keys(schema.properties ?? {});
  assert.ok(declared.length >= 20, `expected a substantial schema, saw ${declared.length}`);

  const src = buildDocSrc();
  // Anchored on the function, then its `return {`. An anchor that misses must
  // FAIL, never fall back to scanning the whole file - a first draft of this
  // check did exactly that and reported a confident all-clear.
  const fn = src.indexOf("export function buildAssignmentDoc");
  assert.ok(fn > -1, "buildAssignmentDoc no longer exists under that name");
  const at = src.indexOf("return {", fn);
  assert.ok(at > -1, "buildDoc no longer returns an object literal");
  const open = src.indexOf("{", at);
  let depth = 0;
  let end = open;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (!depth) { end = i; break; } }
  }
  const body = src.slice(open, end);

  const dropped = declared.filter((f) => !new RegExp(`\\b${f}\\s*:`).test(body));
  assert.deepEqual(
    dropped,
    [],
    "the schema allows these and buildAssignmentDoc does not carry them, so saving an edit deletes them:\n" +
      dropped.map((f) => `  ${f}`).join("\n"),
  );
});

test("the Admin Panel does not rebuild the document itself", () => {
  // The point of the extraction: one implementation. A second object literal
  // growing back inside the view is how the contract test's copy drifted in the
  // first place, and every guard above this line reads the module, not the view.
  const view = readFileSync(join(root, "frontend", "src", "views", "AdminView.vue"), "utf8");
  assert.match(
    view,
    /buildAssignmentDoc\(form\.value, \{ state \}\)/,
    "AdminView must delegate to lib/assignment-doc.mjs",
  );
  // Anchored on what only the DOCUMENT has and the form state does not: a
  // split `template: { owner, repository }` and the UTC `opens_at`/`deadline_at`
  // (the form carries `opens_at_local`). `emptyForm()` legitimately declares
  // schema_version and repository_name_pattern, so those cannot be the anchor.
  for (const marker of ["template: { owner:", "opens_at: preserveOrLocal("]) {
    assert.ok(
      !view.includes(marker),
      `AdminView.vue is building an assignment document of its own again (${marker})`,
    );
  }
});

// Same shape, different field, and the same consequence. There is no control
// for claim_domains, so a lecturer who narrows the allowed addresses does it by
// hand - which is precisely what makes it easy for buildDoc to drop. Losing it
// reverts the cohort to the deployment default, and students accepted under the
// narrowed list start being refused at the button.
test("saving an edited assignment preserves claim_domains, including an empty one", () => {
  const src = buildDocSrc();
  const view = readFileSync(join(root, "frontend", "src", "views", "AdminView.vue"), "utf8");

  assert.ok(
    src.includes("...(Array.isArray(form.claim_domains) ? { claim_domains: form.claim_domains } : {})"),
    "buildAssignmentDoc must carry claim_domains through, or saving an edit deletes it from the YAML",
  );
  assert.ok(
    view.includes("claim_domains: Array.isArray(a.claim_domains) ? a.claim_domains : undefined"),
    "the edit form must load claim_domains, or buildAssignmentDoc has nothing to preserve",
  );

  // Array.isArray rather than a truthy check, in BOTH directions: `[]` is the
  // deliberate opt-out from any domain restriction, and a truthy test would
  // silently drop it and re-impose the deployment default.
  assert.ok(
    !/form\.value\.claim_domains \?\s*\{/.test(src),
    "a truthy check would discard an explicit [] - the opt-out - on every save",
  );
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
// 6. The form's own defaults (ARCHITECTURE §5.4)
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

test("a new assignment defaults to open enrolment, with the cap that makes it valid", () => {
  // Reversed on 2026-08-24, on Tom's call. WS1 chose `enforced` because the
  // broker is public and the roster was the only thing between any GitHub
  // account and a provisioned repo - which stopped being true once signed
  // invitations gated the broker (ARCHITECTURE §4.3.2). Requiring a CSV import
  // before anyone could accept was buying nothing.
  const body = emptyFormSource();
  assert.match(body, /roster_mode: 'open'/, "new assignments accept anyone holding the link");
  assert.ok(!/roster_mode: 'enforced'/.test(body), "'enforced' is the opt-in now");

  // `open` without a cap is unsaveable (schema allOf/if/then), so the default
  // has to carry one or every new assignment opens on a validation error.
  assert.match(body, /max_acceptances: \d+/, "open enrolment requires a cap, so emptyForm must set one");
});

test("a new assignment does not take admin away at the deadline", () => {
  // Demoting to `pull` removes Actions, secrets, environments and runners - the
  // subject these courses teach - and it was the form default, so every new
  // assignment confiscated it unless the lecturer spotted the checkbox. It is
  // opt-in now. Preservation does not depend on it: the snapshot reaches the
  // archive repo whatever this says.
  //
  // The FORM default only. `lockdown.mjs` still reads an absent field as `true`
  // (the test below), because every assignment written before the field existed
  // relies on that - see ARCHITECTURE §11.2.1.
  const body = emptyFormSource();
  assert.match(body, /lock_down_enabled: false/, "the demotion is opt-in for a new assignment");
  assert.ok(!/lock_down_enabled: true/.test(body), "emptyForm must not tick the demotion");
});

test("the backend still fails CLOSED for an unrecognised roster_mode", () => {
  // The form default and the parser's fallback are different decisions. A
  // typo'd or absent value must still be treated as `enforced` - that is a
  // rule about garbage, not about what a lecturer gets by default, and
  // flipping the default must not have relaxed it.
  //
  // Asserted as BEHAVIOUR, not as source text. This used to grep accept.mjs for
  // the literal ternary `roster_mode === "open" ? "open" : "enforced"`, which
  // pinned one spelling rather than the rule: the moment the rule moved into
  // lib/roster-mode.mjs - shared so the gate, the Pages generator and the Admin
  // Panel could not disagree - the test went red while the behaviour was
  // identical. Worse, it would have stayed green for any other file that kept
  // the ternary while the gate itself changed.
  for (const junk of ["Open", "OPEN", "openn", "", " ", null, undefined, 0, false, true, {}, ["open"]]) {
    assert.equal(
      normalizeRosterMode(junk),
      "enforced",
      `roster_mode ${JSON.stringify(junk)} must fall back to enforced`,
    );
  }
  // ...and every mode the system actually implements survives normalisation.
  for (const mode of ROSTER_MODES) assert.equal(normalizeRosterMode(mode), mode);

  // The gate must be the thing applying that rule.
  const src = readFileSync(join(root, "acceptance", "accept.mjs"), "utf8");
  assert.match(src, /normalizeRosterMode\(assignment\.roster_mode\)/);
  assert.doesNotMatch(
    src,
    /roster_mode === "open" \? "open" : "enforced"/,
    "accept.mjs must not carry its own copy of the rule",
  );
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
  assert.match(
    buildDocSrc(),
    /acceptance_mode: form\.acceptance_mode/,
    "buildAssignmentDoc still writes the field",
  );
  assert.match(src, /acceptance_mode: 'self-service'/, "and the form still carries a value for it");
});

// -----------------------------------------------------------------------------
// WS5 - a published assignment opens on the cohort (ARCHITECTURE §10.1.1)
// -----------------------------------------------------------------------------

const adminSrc = () => readFileSync(join(root, "frontend", "src", "views", "AdminView.vue"), "utf8");

test("only a published or closed assignment leads with the cohort", () => {
  // A draft opens on the form, because defining it IS the job. An archived
  // one keeps the form too - it is out of day-to-day tracking, so what is left
  // to look at is what it was configured to be.
  const src = adminSrc();
  const start = src.indexOf("const cohortFirst = computed(");
  assert.ok(start > 0, "cohortFirst must exist");
  const body = src.slice(start, src.indexOf(")\n", start));
  assert.match(body, /!isNew\.value/, "a new assignment is not a cohort");
  assert.match(body, /form\.value\.state === 'published'/);
  assert.match(body, /form\.value\.state === 'closed'/);
  assert.ok(!/'draft'/.test(body), "a draft opens on the form");
  assert.ok(!/'archived'/.test(body), "an archived assignment opens on the form");
});

test("the settings disclosure cannot leave a draft collapsed and uncloseable", () => {
  // `settingsOpen` is seeded per assignment and then owned by the lecturer, so
  // reverting a published assignment to draft would otherwise leave a shut
  // <details> whose summary is display:none - a form with no way to open it.
  const src = adminSrc();
  const start = src.indexOf("const settingsExpanded = computed(");
  assert.ok(start > 0, "settingsExpanded must exist");
  const body = src.slice(start, src.indexOf(")\n", start));
  assert.match(body, /settingsOpen\.value \|\| !cohortFirst\.value/);
  assert.match(src, /:open="settingsExpanded"/, "the <details> must bind the computed, not the raw ref");
});

test("a field error is counted on the summary, and opens the settings on load", () => {
  // A validation problem must never hide behind a disclosure. Every field
  // that can carry one is INSIDE it, so the only entry point that can produce
  // a problem behind a shut disclosure is loading an assignment - which opens
  // it. After that the count on the summary, which is outside, is what keeps
  // the problem stated while the lecturer has it shut.
  const src = adminSrc();
  assert.match(src, /v-if="fieldErrorCount"/, "the summary carries the count");
  assert.match(
    src,
    /settingsOpen\.value = !cohortFirst\.value \|\| fieldErrorCount\.value > 0/,
    "an assignment that loads with a problem opens expanded"
  );
});

test("the editor no longer runs per-student operations", () => {
  // Both needed a student login and made you type one from memory. Their home
  // is the student's own row on the tracking view (ARCHITECTURE §10.1.1 / C2), which
  // already had the more capable copies.
  const src = adminSrc();
  for (const gone of [
    "grantExtension",
    "retryAcceptance",
    "validateStudentLogin",
    "startRetryWatch",
    "extForm",
    "retryForm",
  ]) {
    assert.ok(!src.includes(gone), `${gone} moved to AssignmentDetailView - no copy may stay here`);
  }
  assert.match(
    src,
    /Per-student extensions and retries are on the/,
    "and the lecturer who knew the accordions is told where they went"
  );
});

test("the form's actions are not repeated top and bottom", () => {
  // DESIGN.md §1.2 counts primaries across the view, and the form rendered
  // Cancel / Save as draft / Save & publish twice - two solid buttons on
  // screen at once, which is why the conformity test was scoped away from the
  // editor until this workstream.
  const src = adminSrc();
  const template = src.slice(0, src.indexOf("<script setup>"));
  const saves = template.match(/@click="saveAndPublish"/g) || [];
  assert.equal(saves.length, 1, "exactly one Save & publish button in the editor");
  assert.ok(
    !/<div class="actions">/.test(template),
    "the duplicated bottom action row is gone; the header bar is the form's action bar"
  );
  // And the list pane's own CTA yields while an assignment is open.
  assert.match(
    template,
    /editing \? '' : 'btn-primary'/,
    "New assignment is only solid when there is no assignment on screen"
  );
});

test("the cohort card never invents a number", () => {
  // Two rules the WS3 wall established, one module over: an absent report is
  // not a cohort of zero, and an assignment with no cap has no cap.
  const src = adminSrc();
  const start = src.indexOf("const cohort = computed(");
  assert.ok(start > 0, "cohort must exist");
  const body = src.slice(start, src.indexOf("\n})", start));
  assert.match(body, /typeof entry\.accepted !== 'number'/, "no entry, no figure");
  assert.match(body, /return null/, "and the card renders the reason instead");
  assert.match(body, /Number\(form\.value\.max_acceptances\) \|\| null/, "no cap means no cap");
  assert.ok(!/\?\? 150/.test(src) && !/\?\? 50/.test(body), "never substitute a cap the assignment does not have");
});
