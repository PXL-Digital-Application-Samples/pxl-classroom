// What a saved assignment actually carries about its cohort.
//
// `buildAssignmentDoc` rebuilds the WHOLE document from the form, so anything
// it does not carry through is deleted on the next save - the failure this
// project has met more than once, and the reason a guard already checks the
// builder against every field the schema allows. These are the two new fields'
// own rules, which that guard cannot see: when they are written at all, and
// what they may not say.
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildAssignmentDoc } from "../lib/assignment-doc.mjs";
import { validateAgainst } from "../lib/validate.mjs";
import { assignmentCohort, assignmentAdmitsStudent } from "../lib/cohort.mjs";

// The FORM STATE, not the document. `buildAssignmentDoc` takes AdminView's
// `form.value` - `template` is one "owner/repo" string it splits, and the dates
// arrive as the datetime-local values with the stored UTC beside them.
const FORM = {
  id: "lab-3",
  title: "Lab 3",
  organization: "PXL-2TIN-CloudEssentials-2627",
  template: "PXL-2TIN-CloudEssentials-2627/starter-template",
  repository_name_pattern: "lab-3-{github_login}",
  opens_at_local: "2026-09-01T10:00",
  _opens_at_original: "2026-09-01T08:00:00.000Z",
  deadline_at_local: "2026-12-30T21:00",
  _deadline_at_original: "2026-12-30T20:00:00.000Z",
  timezone: "Europe/Brussels",
  state: "draft",
  assignment_type: "individual",
  roster_mode: "enforced",
  late_policy: "report",
};

const build = (over = {}) => buildAssignmentDoc({ ...FORM, ...over });

test("a cohort is written, and the document it produces is valid", () => {
  const doc = build({ cohort: ["num:0123456", "login:ella-dev"], cohort_groups: ["3A"] });
  assert.deepEqual(doc.cohort, ["num:0123456", "login:ella-dev"]);
  assert.deepEqual(doc.cohort_groups, ["3A"]);

  const { valid, errors } = validateAgainst("assignment", doc);
  assert.equal(valid, true, JSON.stringify(errors, null, 2));
});

test("an empty selection writes NO field, because absent already means everyone", () => {
  // An assignment that never narrowed anything must not gain a field saying so:
  // absent and `[]` mean the same thing to the gate, and a stored empty list
  // invites a reader to think a decision was made.
  for (const cohort of [[], undefined, null]) {
    const doc = build({ cohort, cohort_groups: ["3A"] });
    assert.equal("cohort" in doc, false, JSON.stringify(cohort));
    assert.equal("cohort_groups" in doc, false, "and no label over a cohort that does not exist");
    assert.equal(assignmentAdmitsStudent(doc, { student_number: "9999999" }), true);
  }
});

test("under open enrolment neither field is stored", () => {
  // The roster does not decide who may accept there, so a cohort would be a
  // value nothing reads - and a label over it would describe a restriction the
  // assignment does not have.
  const doc = build({ roster_mode: "open", max_acceptances: 50, cohort: ["num:0123456"], cohort_groups: ["3A"] });
  assert.equal("cohort" in doc, false);
  assert.equal("cohort_groups" in doc, false);
  assert.equal(validateAgainst("assignment", doc).valid, true);
});

test("the label never appears without the cohort it describes", () => {
  // A card reading "3A" over an assignment open to the whole roster is exactly
  // the kind of status line DESIGN.md 1.5 forbids: true of nothing on screen.
  const doc = build({ cohort: [], cohort_groups: ["3A", "3B"] });
  assert.equal("cohort_groups" in doc, false);
});

test("claim stores a cohort too - it is enforced with a way in", () => {
  const doc = build({ roster_mode: "claim", claim_domains: ["student.pxl.be"], cohort: ["num:0123456"] });
  assert.deepEqual(doc.cohort, ["num:0123456"]);
  assert.equal(validateAgainst("assignment", doc).valid, true);
});

test("the schema refuses an identity with no prefix", () => {
  // A bare "0123456" could be a student number or a login. Guessing would admit
  // or refuse the wrong person, so the document may not carry one.
  for (const bad of ["0123456", "alice-dev", "num:", "login:", "team:alpha"]) {
    const doc = build({ cohort: [bad] });
    assert.equal(
      validateAgainst("assignment", doc).valid,
      false,
      `${JSON.stringify(bad)} should not be a storable identity`,
    );
  }
});

test("what is stored is what the gate reads back", () => {
  // The two halves that must agree: the builder writes these strings and
  // lib/cohort.mjs matches roster rows against them. Asserted end to end rather
  // than assumed, because a form that showed one answer while the gate applied
  // another is the worst possible version of this feature.
  const doc = build({ cohort: ["num:0123456", "login:Ella-Dev"] });
  assert.equal(assignmentCohort(doc).size, 2);

  assert.equal(assignmentAdmitsStudent(doc, { student_number: "0123456", github_login: "alice" }), true);
  assert.equal(assignmentAdmitsStudent(doc, { github_login: "ella-dev" }), true, "logins are case-insensitive");
  assert.equal(assignmentAdmitsStudent(doc, { student_number: "0123457" }), false);
});
