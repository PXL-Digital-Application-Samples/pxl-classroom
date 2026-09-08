// `org_scoped_lock` has no control in the assignment form - it is set by hand
// or by the migration - and `buildAssignmentDoc` rebuilds the whole document
// from what the form holds. That combination is exactly how the invitation
// token was once deleted by an unrelated edit, and how the template pin would
// have been: a field nobody listed is a field the next save removes.
//
// So the round trip is the test, not the presence of a line in buildDoc.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildAssignmentDoc } from "../lib/assignment-doc.mjs";
import { validateAgainst } from "../lib/validate.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The minimum a saveable assignment form holds. */
const form = (over = {}) => ({
  id: "lab-1",
  title: "Lab 1",
  description: "",
  organization: "PXLAutomation",
  // The form holds `owner/repo` in one field and the dates as datetime-local
  // strings, which buildAssignmentDoc converts. Using the DOCUMENT's field
  // names here would build an invalid document and prove nothing.
  template: "PXLAutomation/tpl",
  repository_name_pattern: "lab-1-{github_login}",
  opens_at_local: "2026-09-01T08:00",
  deadline_at_local: "2026-12-31T23:59",
  timezone: "Europe/Brussels",
  submission_ref: "refs/heads/main",
  student_permission: "admin",
  acceptance_mode: "self-service",
  roster_mode: "open",
  max_acceptances: 30,
  late_policy: "block",
  lock_down_enabled: false,
  state: "draft",
  assignment_type: "individual",
  ...over,
});

test("a hand-set org_scoped_lock survives an unrelated edit", () => {
  // The failure this exists for: a lecturer changes the title, buildDoc rebuilds
  // the document, the flag is not carried, and the cohort silently moves back to
  // repository-scoped rulesets a student can delete.
  const doc = buildAssignmentDoc(form({ org_scoped_lock: true, title: "Lab 1, renamed" }));
  assert.equal(doc.org_scoped_lock, true);
  assert.equal(doc.title, "Lab 1, renamed");
  const res = validateAgainst("assignment", doc);
  assert.ok(res.valid, JSON.stringify(res.errors));
});

test("absent stays ABSENT, and is never coerced to false", () => {
  // `!!form.org_scoped_lock` would write `false` into every assignment that has
  // never heard of the field. Absent is what every existing assignment means and
  // the schema's default already says what it means.
  const doc = buildAssignmentDoc(form());
  assert.ok(!("org_scoped_lock" in doc), `it wrote ${JSON.stringify(doc.org_scoped_lock)}`);
  assert.ok(validateAgainst("assignment", doc).valid);
});

test("AN EXPLICIT FALSE IS CARRIED - it is the only way back", () => {
  // This asserted the opposite until 2026-09-09, and correctly: `false` was the
  // default then, so writing it was noise. Now it is the OPT-OUT, the form has
  // no control that can set it again, and a save that dropped it would move a
  // cohort to organization scope with nobody asking.
  const doc = buildAssignmentDoc(form({ org_scoped_lock: false }));
  assert.equal(doc.org_scoped_lock, false);
  assert.ok(validateAgainst("assignment", doc).valid);
});

test("the editor reads it back in, or the round trip cannot start", () => {
  // buildDoc can only carry what the form holds, and the form is filled by the
  // editor from the stored document. A missing read there is the same deletion
  // one step earlier, and no unit test of buildDoc would see it.
  //
  // BOTH booleans, since `false` became the answer that matters.
  const view = readFileSync(join(root, "frontend/src/views/AdminView.vue"), "utf8");
  assert.match(
    view,
    /typeof a\.org_scoped_lock === 'boolean' \? \{ org_scoped_lock: a\.org_scoped_lock \}/,
    "AdminView must read BOTH booleans off the stored assignment into the form",
  );
});
