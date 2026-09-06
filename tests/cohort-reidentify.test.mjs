// An address edit that would quietly remove a student from an assignment.
//
// The case only exists because a row can be identified by something a person
// TYPES. A number and a login arrive from elsewhere and do not get corrected in
// a cell; an address does, and a row carrying only an address is named by it.
import { test } from "node:test";
import assert from "node:assert/strict";

import { planCohortRename } from "../lib/cohort-reidentify.mjs";
import { assignmentAdmitsStudent, cohortIdentity } from "../lib/cohort.mjs";

const NINA = { full_name: "Nina Peeters", email: "nina@student.pxl.be" };
const NINA_FIXED = { full_name: "Nina Peeters", email: "nino@student.pxl.be" };

/** A published assignment naming Nina by the only thing she has. */
const LAB3 = {
  id: "lab-3", title: "Lab 3", state: "published",
  cohort: ["num:0123456", cohortIdentity(NINA)],
};

test("an address edit is reported as the removal it would otherwise be", () => {
  const plan = planCohortRename({ before: NINA, after: NINA_FIXED, assignments: [LAB3] });

  assert.deepEqual(plan.lost, ["email:nina@student.pxl.be"]);
  assert.equal(plan.replacement, "email:nino@student.pxl.be");
  assert.equal(plan.affected.length, 1);
  assert.equal(plan.affected[0].id, "lab-3");
  assert.equal(plan.affected[0].state, "published");
  assert.deepEqual(plan.affected[0].orphaned, ["email:nina@student.pxl.be"]);

  // And the rewritten cohort admits her, which is the whole point. Asked of
  // the real gate rather than by comparing strings - the failure this exists to
  // prevent was two files agreeing on a string and disagreeing about a person.
  const after = { ...LAB3, cohort: plan.affected[0].cohort };
  assert.equal(assignmentAdmitsStudent(after, NINA_FIXED), true, "she is still in it");
  assert.equal(assignmentAdmitsStudent(LAB3, NINA_FIXED), false, "and would not have been");
});

test("the other students in the cohort are left exactly as they were spelled", () => {
  const stored = { ...LAB3, cohort: ["num:0123456", "login:Ella-Dev", cohortIdentity(NINA)] };
  const plan = planCohortRename({ before: NINA, after: NINA_FIXED, assignments: [stored] });

  assert.deepEqual(
    plan.affected[0].cohort,
    ["num:0123456", "login:Ella-Dev", "email:nino@student.pxl.be"],
    "untouched entries keep their stored spelling; only the orphan is replaced",
  );
  assert.equal(new Set(plan.affected[0].cohort).size, 3, "uniqueItems survives");
});

test("a row that keeps an identity is not re-identified at all", () => {
  // The ordinary case, and by far the commonest: she has a student number, so
  // her key never was the address and no cohort ever named her by one.
  const before = { full_name: "Alice", student_number: "0123456", email: "old@x.be" };
  const after = { ...before, email: "new@x.be" };
  const a = { id: "lab-3", title: "Lab 3", state: "published", cohort: ["num:0123456"] };

  const plan = planCohortRename({ before, after, assignments: [a] });
  assert.deepEqual(plan.lost, ["email:old@x.be"], "the address identity did go");
  assert.deepEqual(plan.affected, [], "but nothing named her by it");
});

test("a cohort naming her BOTH ways needs no rewrite, and says so", () => {
  // Matching is any identity, so an entry she still carries keeps her in. The
  // stale address entry stays put and is reported by danglingCohortEntries,
  // which is a better surface for it than a confirmation dialog.
  const before = { full_name: "Alice", student_number: "0123456", email: "old@x.be" };
  const after = { ...before, email: "new@x.be" };
  const a = { id: "x", title: "X", state: "published", cohort: ["num:0123456", "email:old@x.be"] };

  assert.deepEqual(planCohortRename({ before, after, assignments: [a] }).affected, []);
  assert.equal(assignmentAdmitsStudent(a, after), true, "because she is still admitted");
});

test("an assignment with no cohort is left alone - empty means EVERYONE", () => {
  // Writing a cohort onto it would narrow an assignment that was open to the
  // whole course, which is the opposite of preserving what the lecturer chose.
  for (const cohort of [[], undefined, null]) {
    const a = { id: "open", title: "Open", state: "published", cohort };
    assert.deepEqual(planCohortRename({ before: NINA, after: NINA_FIXED, assignments: [a] }).affected, []);
  }
});

test("an edit that would leave the row unnameable yields no cohort to write", () => {
  // The roster schema refuses this, so it should be unreachable - and a plan
  // that invented an entry here would write a cohort naming nobody.
  const plan = planCohortRename({
    before: NINA, after: { full_name: "Nina Peeters" }, assignments: [LAB3],
  });
  assert.equal(plan.replacement, null);
  assert.equal(plan.affected[0].cohort, null, "the caller has to refuse rather than guess");
});

test("nothing to do is the common answer, cheaply", () => {
  for (const [what, before, after] of [
    ["an unchanged row", NINA, { ...NINA }],
    ["a name correction", NINA, { ...NINA, full_name: "Nina P." }],
    ["gaining a login", NINA, { ...NINA, github_login: "nina-p" }],
  ]) {
    const plan = planCohortRename({ before, after, assignments: [LAB3] });
    assert.deepEqual(plan.lost, [], what);
    assert.deepEqual(plan.affected, [], what);
  }
});

test("a row that gains a number keeps matching the cohort that named its address", () => {
  // Promotion and CSV import both do this, and it must not be a removal: the
  // address is still carried, so the stored entry still matches.
  const after = { ...NINA, student_number: "0123456" };
  assert.deepEqual(planCohortRename({ before: NINA, after, assignments: [LAB3] }).affected, []);
  assert.equal(assignmentAdmitsStudent(LAB3, after), true);
});
