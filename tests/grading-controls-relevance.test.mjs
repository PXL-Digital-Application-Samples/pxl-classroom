// Which grading controls a lecturer should SEE.
//
// The Autograding controls read a check run. On an assignment that grades
// nothing there is no check run to read, so the control could only ever report
// one failure per student - and it was shown on every such assignment, because
// the gate was `!localRunnerDeclared`: a double negative asked of a tri-state,
// true whenever autograding was ABSENT.
//
// The root cause was in the document, not the gate. AutogradeModal saved
// `enabled: false, tests: []` for BOTH "the checks come with my template" and
// "remove all", so the lecturer's own answer was discarded at save and every
// surface downstream had to guess. `autograde.source` records it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { gradesInCi } from "../frontend/src/lib/autograde.js";
import { buildAssignmentDoc } from "../lib/assignment-doc.mjs";
import { validateAgainst } from "../lib/validate.mjs";

const NO_EVIDENCE = { hasGrades: false, anyCiStatus: false, hasSubmissionMarker: false };

test("AN ASSIGNMENT THAT GRADES NOTHING SHOWS NO CI GRADING CONTROL", () => {
  // The defect, stated directly. `autograde` absent entirely.
  assert.equal(gradesInCi({ id: "lab-1" }, NO_EVIDENCE), false);
  // And the shape "remove all" leaves behind.
  assert.equal(gradesInCi({ autograde: { enabled: false, tests: [] } }, NO_EVIDENCE), false);
});

test("checks defined here, in CI, show it", () => {
  assert.equal(
    gradesInCi({ autograde: { enabled: true, execution_environment: "github_actions", tests: [{}] } }, NO_EVIDENCE),
    true,
  );
});

test("checks the LECTURER runs never show a CI control", () => {
  // A definite no rather than an absence: no check run will ever exist to read,
  // so no amount of evidence should turn this on.
  const local = { autograde: { enabled: true, execution_environment: "lecturer_local", tests: [{}] } };
  assert.equal(gradesInCi(local, NO_EVIDENCE), false);
  assert.equal(gradesInCi(local, { hasGrades: true, anyCiStatus: true, hasSubmissionMarker: true }), false);
});

test("the lecturer's answer that the TEMPLATE grades it is enough on its own", () => {
  // The case the old gate got right by accident and a strict `enabled` check
  // would have got wrong: MANUAL.md calls this the common one.
  assert.equal(gradesInCi({ template_grades: true }, NO_EVIDENCE), true);
});

test("an older document is decided by POSITIVE evidence, never by absence", () => {
  const old = { autograde: { enabled: false, tests: [] } };
  assert.equal(gradesInCi(old, { ...NO_EVIDENCE, hasGrades: true }), true, "something produced grades");
  assert.equal(gradesInCi(old, { ...NO_EVIDENCE, hasSubmissionMarker: true }), true, "a hand-in message names a run to read");
  assert.equal(gradesInCi(old, { ...NO_EVIDENCE, anyCiStatus: true }), true, "a student's row carries a check conclusion");
  assert.equal(gradesInCi(old, NO_EVIDENCE), false, "and nothing at all stays hidden");
});

// ---------------------------------------------------------------------------
// The document has to be able to SAY which one it is, or none of the above can
// be asked. This is the half that was missing.
// ---------------------------------------------------------------------------

const FORM = {
  id: "lab-1",
  title: "Lab 1",
  organization: "TestOrg",
  template: "TestOrg/tpl",
  repository_name_pattern: "lab-1-{github_login}",
  opens_at_local: "2026-09-01T09:00",
  deadline_at_local: "2026-09-30T22:00",
};

test("TEMPLATE AND NONE ARE NO LONGER THE SAME DOCUMENT", () => {
  const template = buildAssignmentDoc({ ...FORM, autograde_enabled: false, template_grades: true });
  const none = buildAssignmentDoc({ ...FORM, autograde_enabled: false, template_grades: false });

  assert.equal(template.template_grades, true);
  assert.equal(template.autograde, undefined, "no checks are defined here");
  assert.equal(none.autograde, undefined, "nothing grades this, so there is no autograde block at all");
  assert.notDeepEqual(template, none, "the two answers are no longer the same document");

  // And each still validates - `source` is additive, and `additionalProperties`
  // on the autograde block is false, so a field the schema does not declare
  // would fail here rather than being stored.
  for (const doc of [template, none]) {
    const v = validateAgainst("assignment", doc);
    assert.equal(v.valid, true, JSON.stringify(v.errors));
  }
});

test("declaring the checks here records that too", () => {
  const doc = buildAssignmentDoc({
    ...FORM,
    autograde_enabled: true,
    autograde_execution_environment: "github_actions",
    autograde_tests: [{ id: "one", type: "run", points: 5, run: "make test" }],
  });
  assert.equal(doc.autograde.enabled, true);
  assert.equal(doc.template_grades, undefined, "the checks are here, not in the template");
  assert.equal(validateAgainst("assignment", doc).valid, true);
});

test("the two halves agree: what the form writes is what the gate reads", () => {
  // Same defect as spelling a name in two files. The doc builder and the gate
  // live in different modules and nothing else checks that one produces what
  // the other accepts, so the round trip is asserted rather than assumed.
  const template = buildAssignmentDoc({ ...FORM, autograde_enabled: false, template_grades: true });
  assert.equal(gradesInCi(template, NO_EVIDENCE), true);

  const none = buildAssignmentDoc({ ...FORM, autograde_enabled: false, template_grades: false });
  assert.equal(gradesInCi(none, NO_EVIDENCE), false);

  const local = buildAssignmentDoc({
    ...FORM,
    autograde_enabled: true,
    autograde_execution_environment: "lecturer_local",
    autograde_tests: [{ id: "one", type: "run", points: 5, run: "make test" }],
  });
  assert.equal(gradesInCi(local, NO_EVIDENCE), false);
});

test("AN EXPLICIT \"nothing grades this\" ENDS IT, evidence and all", () => {
  // The lecturer answered. An old grading summary left over from before they
  // turned it off is not a reason to put the control back.
  const said_no = { template_grades: false };
  assert.equal(gradesInCi(said_no, NO_EVIDENCE), false);
  assert.equal(gradesInCi(said_no, { hasGrades: true, anyCiStatus: true, hasSubmissionMarker: true }), false);
});

test("ABSENT IS NOT `false` - the three states stay three", () => {
  // Never asked falls through to evidence; answered-no does not. Collapsing
  // them would make every assignment predating the field answer "no" and take
  // the control away from the template-graded ones, which MANUAL.md calls the
  // common case.
  const never_asked = { autograde: { enabled: false, tests: [] } };
  assert.equal(gradesInCi(never_asked, { ...NO_EVIDENCE, hasGrades: true }), true);
  assert.equal(gradesInCi({ template_grades: false }, { ...NO_EVIDENCE, hasGrades: true }), false);

  // And the builder keeps them apart on the way out.
  const none = buildAssignmentDoc({ ...FORM, autograde_enabled: false, template_grades: false });
  const unasked = buildAssignmentDoc({ ...FORM, autograde_enabled: false, template_grades: null });
  assert.equal(none.template_grades, false, "an answer is written");
  assert.equal(unasked.template_grades, undefined, "a non-answer is not");
  for (const doc of [none, unasked]) {
    assert.equal(validateAgainst("assignment", doc).valid, true);
  }
});
