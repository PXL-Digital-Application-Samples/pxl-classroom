// A JSON Schema `default` is a WRITER here, not documentation.
//
// `lib/validate.mjs` runs Ajv with `useDefaults: true`, which MUTATES the object
// being validated and fills in every `default` the schema declares. So a field
// with a default is written into any document that passes through a validator,
// whether or not anybody chose it.
//
// That is harmless where the default is the same answer the readers already
// assume for an absent field - `assignment_type: individual`, `feedback_pr:
// false`. It is a defect where ABSENT AND THE DEFAULT ARE DIFFERENT ANSWERS,
// which is every tri-state:
//
//   * `org_scoped_lock` - absent means "the default under block", `false` means
//     "opt out". `default: true` wrote the opt-out's opposite into documents.
//     Caught within a minute of a live drill, by an assignment printing
//     org_scoped_lock=true from a file not containing the string.
//   * `template_grades` - absent means "nobody has been asked", `false` means
//     "they answered no". `default: false` collapsed the two, which ends the
//     question and takes the grading controls away from exactly the
//     template-graded assignments the evidence fallback exists for.
//
// Both were added within two days of each other, so this pins the invented set
// rather than the two names: a new default has to be justified here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildAssignmentDoc } from "../lib/assignment-doc.mjs";
import { validateAgainst } from "../lib/validate.mjs";

const FORM = {
  id: "lab-1",
  title: "Lab 1",
  organization: "TestOrg",
  template: "TestOrg/tpl",
  repository_name_pattern: "lab-1-{github_login}",
  opens_at_local: "2026-09-01T09:00",
  deadline_at_local: "2026-09-30T22:00",
};

/**
 * The fields validation may invent, each with the reason it is safe: the value
 * it writes is the same answer every reader already gives an absent field.
 */
const ALLOWED = {
  assignment_type: "individual is what an absent type has always meant",
  require_claim: "false is what an absent flag means to the acceptance gate",
  feedback_pr: "false is what an absent flag means to the feedback-PR path",
  feedback_pr_baseline_branch: "the branch name is a constant, not a decision",
};

test("VALIDATION INVENTS ONLY FIELDS WHOSE ABSENCE MEANS THE SAME THING", () => {
  const doc = buildAssignmentDoc({ ...FORM });
  const before = new Set(Object.keys(doc));
  const res = validateAgainst("assignment", doc);
  assert.equal(res.valid, true, JSON.stringify(res.errors));

  const invented = Object.keys(doc).filter((k) => !before.has(k)).sort();
  const unexplained = invented.filter((k) => !(k in ALLOWED));
  assert.deepEqual(
    unexplained,
    [],
    `validation invented ${unexplained.join(", ")} - if absent and the default are the same answer, ` +
      `add it to ALLOWED with the reason; if they are different answers, remove the schema default`,
  );

  // And the reasons cannot outlive their entries.
  const stale = Object.keys(ALLOWED).filter((k) => !invented.includes(k));
  assert.deepEqual(stale, [], `ALLOWED explains ${stale.join(", ")}, which validation no longer writes`);
});

test("the two tri-states carry no schema default", () => {
  // Named as well as swept: the sweep above only fails once a document happens
  // to reach a validator, and the reason these two must stay absent is not
  // visible from the mutation.
  const schema = JSON.parse(
    readFileSync(new URL("../schemas/assignment.schema.json", import.meta.url), "utf8"),
  );
  for (const field of ["org_scoped_lock", "template_grades"]) {
    assert.equal(
      "default" in schema.properties[field],
      false,
      `${field} has a schema default, which useDefaults writes into every validated document`,
    );
  }
});
