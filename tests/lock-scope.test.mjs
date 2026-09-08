// Where a deadline's lock is placed, and the one reinterpretation this codebase
// makes of documents already written.
//
// ORGANIZATION SCOPE IS THE DEFAULT UNDER `block` since 2026-09-09, so ABSENT
// changed meaning. That runs against the standing rule that absent and empty are
// different answers, and it was chosen with the blast radius measured rather
// than assumed: three published assignments used `late_policy: block` and none
// carried the field, one of them in another lecturer's Team organization.
//
// Which makes the `false` case the one that matters most here. It is the only
// way back, the form offers no control for it, and `buildAssignmentDoc` rebuilds
// the whole document - so a save that dropped it would move a cohort to
// organization scope with nobody asking and no way to undo it from the app.
import { test } from "node:test";
import assert from "node:assert/strict";
import { usesOrgScope, lockScopeNote } from "../lib/lock-scope.mjs";
import { buildAssignmentDoc } from "../lib/assignment-doc.mjs";
import { validateAgainst } from "../lib/validate.mjs";
import { readFileSync } from "node:fs";

test("ABSENT IS ORGANIZATION SCOPE - the reinterpretation, stated", () => {
  assert.equal(usesOrgScope({ id: "lab-1" }, true), true);
  assert.equal(usesOrgScope({ autograde: { enabled: false, tests: [] } }, true), true);
});

test("`false` OPTS OUT, and is the only way back", () => {
  assert.equal(usesOrgScope({ org_scoped_lock: false }, true), false);
});

test("`true` is organization scope, as it always was", () => {
  assert.equal(usesOrgScope({ org_scoped_lock: true }, true), true);
});

test("NOTHING IS LOCKED UNDER `report`, whatever the field says", () => {
  // `late_policy: report` means late work counts, so there is no lock to place.
  // All three answers collapse, and a true here would have created an
  // organization ruleset over a cohort whose deadline blocks nothing.
  for (const doc of [{}, { org_scoped_lock: true }, { org_scoped_lock: false }]) {
    assert.equal(usesOrgScope(doc, false), false, JSON.stringify(doc));
  }
});

test("the run log says WHICH of the three cases applied", () => {
  // A default that reinterprets documents has to be legible afterwards:
  // `lock_method: org-ruleset` alone cannot tell a lecturer's choice from ours.
  assert.match(lockScopeNote({}, true), /default/);
  assert.match(lockScopeNote({ org_scoped_lock: true }, true), /set on the assignment/);
  assert.match(lockScopeNote({ org_scoped_lock: false }, true), /opts out/);
  assert.match(lockScopeNote({}, false), /nothing is locked/);
  // Three different sentences, or the log distinguishes nothing.
  const said = new Set([
    lockScopeNote({}, true),
    lockScopeNote({ org_scoped_lock: true }, true),
    lockScopeNote({ org_scoped_lock: false }, true),
  ]);
  assert.equal(said.size, 3);
});

// ---------------------------------------------------------------------------
// The opt-out has to survive an edit made for another reason entirely.
// ---------------------------------------------------------------------------

const FORM = {
  id: "lab-1",
  title: "Lab 1",
  organization: "TestOrg",
  template: "TestOrg/tpl",
  repository_name_pattern: "lab-1-{github_login}",
  opens_at_local: "2026-09-01T09:00",
  deadline_at_local: "2026-09-30T22:00",
  late_policy: "block",
};

test("AN OPT-OUT SURVIVES A SAVE, or there is no way back from the app", () => {
  const doc = buildAssignmentDoc({ ...FORM, org_scoped_lock: false });
  assert.equal(doc.org_scoped_lock, false);
  assert.equal(validateAgainst("assignment", doc).valid, true);
  // And it still reads as an opt-out on the other side.
  assert.equal(usesOrgScope(doc, true), false);
});

test("an explicit `true` survives too", () => {
  const doc = buildAssignmentDoc({ ...FORM, org_scoped_lock: true });
  assert.equal(doc.org_scoped_lock, true);
  assert.equal(validateAgainst("assignment", doc).valid, true);
});

test("ABSENT STAYS ABSENT - an unset form field is not an answer", () => {
  // Coercing here would write `false` for every assignment the editor touches,
  // which is the opposite default from the one just chosen, applied silently.
  for (const v of [undefined, null, "", 0]) {
    const doc = buildAssignmentDoc({ ...FORM, org_scoped_lock: v });
    assert.equal("org_scoped_lock" in doc, false, `org_scoped_lock: ${JSON.stringify(v)} became a field`);
    assert.equal(usesOrgScope(doc, true), true, "and absent still reads as the default");
  }
});

test("lockdown.mjs asks lib/lock-scope.mjs rather than re-deciding", () => {
  // The expression it replaced was `assignment.org_scoped_lock === true`, which
  // nothing could import and no test could reach. A second copy of this decision
  // is how the workflow and the tests come to disagree about a live cohort.
  const src = readFileSync(new URL("../lockdown/lockdown.mjs", import.meta.url), "utf8");
  assert.match(src, /usesOrgScope\(assignment, blockLate\)/);
  assert.doesNotMatch(src, /org_scoped_lock\s*===/, "the decision must not be re-inlined here");
});
