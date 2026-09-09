import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  EXISTING_REPO_POLICIES,
  REJECT_REPO_EXISTS,
  REJECT_REPO_FROZEN,
  existingRepoVerdict,
  normalizeExistingRepoPolicy,
} from "../lib/existing-repo.mjs";
import { rejectionReason } from "../lib/rejection-notice.mjs";
import {
  SUBMISSION_LOCK_NAME,
  isSubmissionLockName,
  orgSubmissionLockName,
} from "../lib/submission-lock.mjs";

// ------------------------------------------------------------------ the policy

test("absent means reuse on an individual assignment, because reuse is what already happened", () => {
  // Every assignment written before this field existed has been reusing since
  // the day it was published - provisioning is idempotent on repository
  // existence and always has been. Reading absence as `refuse` would start
  // turning students away on assignments nobody touched.
  assert.equal(normalizeExistingRepoPolicy(undefined), "reuse");
  assert.equal(normalizeExistingRepoPolicy(null), "reuse");
  assert.equal(normalizeExistingRepoPolicy(""), "reuse");
  assert.equal(normalizeExistingRepoPolicy(undefined, { assignmentType: "individual" }), "reuse");
});

test("absent means REFUSE on a group assignment, because the name proves nothing", () => {
  // `portfolio-PXL-AnnDeWit` can only be Ann's - the name embeds her login. A
  // group name embeds a TEAM SLUG, and `grp-team-a` from a previous run
  // belonged to a previous year's team-a: different people. Reuse there hands
  // this year's team another cohort's repository with their work in it.
  assert.equal(normalizeExistingRepoPolicy(undefined, { assignmentType: "group" }), "refuse");
  assert.equal(normalizeExistingRepoPolicy(null, { assignmentType: "group" }), "refuse");
  assert.equal(normalizeExistingRepoPolicy("", { assignmentType: "group" }), "refuse");
});

test("a lecturer who says reuse on a group assignment is still obeyed", () => {
  // Derived, never written: the default resolves at the moment it is needed and
  // an explicit answer outranks it. Otherwise this would be a stored value the
  // system quietly overrides, which is worse than not offering the option.
  assert.equal(normalizeExistingRepoPolicy("reuse", { assignmentType: "group" }), "reuse");
  assert.equal(normalizeExistingRepoPolicy("refuse", { assignmentType: "individual" }), "refuse");
});

test("a group refusal says why, and it is not the individual reason", () => {
  const group = existingRepoVerdict({ exists: true, frozen: false, assignmentType: "group" });
  assert.equal(group.outcome, "refuse");
  assert.match(group.note, /team name is not tied to particular students/);

  // An individual assignment that was TOLD to refuse is a different statement:
  // that repository really is the student's, the lecturer just does not want it
  // reused. Explaining it with the team reasoning would be a guess.
  const solo = existingRepoVerdict({ exists: true, frozen: false, policy: "refuse" });
  assert.equal(solo.outcome, "refuse");
  assert.doesNotMatch(solo.note, /team name/);
});

test("only the exact word refuses - anything else is reuse", () => {
  assert.equal(normalizeExistingRepoPolicy("refuse"), "refuse");
  assert.equal(normalizeExistingRepoPolicy("reuse"), "reuse");
  // Deliberately NOT fail-closed, and it is the one place in this system that
  // is not: the closed direction here is the one that stops a student getting a
  // repository at all.
  assert.equal(normalizeExistingRepoPolicy("REFUSE"), "reuse");
  assert.equal(normalizeExistingRepoPolicy(true), "reuse");
  assert.equal(normalizeExistingRepoPolicy({ policy: "refuse" }), "reuse");
});

test("the schema declares the same two answers, and NO default", () => {
  // Derived from the schema at test time rather than written twice. And the
  // absent default is the load-bearing half: lib/validate.mjs runs Ajv with
  // `useDefaults: true`, so a default here would write "reuse" into every
  // document it validated and turn "nobody was asked" into an explicit answer.
  const schema = JSON.parse(readFileSync(new URL("../schemas/assignment.schema.json", import.meta.url), "utf-8"));
  const field = schema.properties.existing_repo_policy;
  assert.ok(field, "the schema declares the field");
  assert.deepEqual(field.enum, EXISTING_REPO_POLICIES);
  assert.ok(!("default" in field), "a tri-state field may not carry a schema default");
});

// ----------------------------------------------------------------- the verdict

test("nothing at the name is the ordinary path", () => {
  const v = existingRepoVerdict({ exists: false, frozen: false });
  assert.equal(v.outcome, "free");
  assert.equal(v.reject, null);
});

test("a frozen repository is refused whatever the policy says", () => {
  // There is no assignment for which handing a student a repository they cannot
  // push to is the wanted outcome, so this one is not a policy question. It is
  // checked BEFORE the policy for exactly that reason.
  for (const policy of [undefined, "reuse", "refuse"]) {
    const v = existingRepoVerdict({ exists: true, frozen: "pxl-classroom-deadline-lab-3", policy });
    assert.equal(v.outcome, "frozen", `policy ${policy}`);
    assert.equal(v.reject, REJECT_REPO_FROZEN);
    assert.match(v.note, /pxl-classroom-deadline-lab-3/, "names the ruleset a lecturer has to go and find");
  }
});

test("an unfrozen repository follows the assignment", () => {
  const reuse = existingRepoVerdict({ exists: true, frozen: false, policy: "reuse" });
  assert.equal(reuse.outcome, "reuse");
  assert.equal(reuse.reject, null);
  assert.match(reuse.note, /no starter code is copied/, "says what the student does not get");

  const refuse = existingRepoVerdict({ exists: true, frozen: false, policy: "refuse" });
  assert.equal(refuse.outcome, "refuse");
  assert.equal(refuse.reject, REJECT_REPO_EXISTS);
});

test("an assignment that never answered reuses", () => {
  const v = existingRepoVerdict({ exists: true, frozen: false });
  assert.equal(v.outcome, "reuse");
  assert.equal(v.reject, null);
});

test("unreadable is not evidence, in either read", () => {
  // A 500 that survived six retries in lib/gh.mjs, or a rulesets list that came
  // back as something other than an array. Guessing `free` hands over a frozen
  // repository; guessing `reuse` does it silently. The read is one GET against
  // an org we hold a token for, so a refusal here is transient and the student
  // retries.
  const unread = existingRepoVerdict({ exists: null, frozen: false, policy: "reuse" });
  assert.equal(unread.outcome, "unknown");
  assert.equal(unread.reject, REJECT_REPO_EXISTS);

  const rulesUnread = existingRepoVerdict({ exists: true, frozen: null, policy: "reuse" });
  assert.equal(rulesUnread.outcome, "unknown");
  assert.equal(rulesUnread.reject, REJECT_REPO_EXISTS);
  assert.match(rulesUnread.note, /could not be read/);
});

test("junk in yields a refusal, never a silent handover", () => {
  assert.equal(existingRepoVerdict().outcome, "unknown");
  assert.equal(existingRepoVerdict({}).outcome, "unknown");
  assert.equal(existingRepoVerdict({ exists: "yes" }).outcome, "unknown");
});

// ------------------------------------------------ the names, spelled once each

test("both rejection outcomes have a human label", () => {
  // Derived from the constants the producer uses, not from two string literals:
  // an outcome spelled one way in accept.mjs and another in the label table is
  // the silent nothing lib/rejection-notice.mjs exists to have ended -
  // `rejectionReason` falls back to the raw slug rather than failing.
  for (const outcome of [REJECT_REPO_FROZEN, REJECT_REPO_EXISTS]) {
    const label = rejectionReason(outcome);
    assert.notEqual(label, outcome.replace(/^rejected:/, "").replace(/-/g, " "), `${outcome} fell back to its slug`);
    assert.match(label, /repository|repositories|own/, `${outcome} says what is in the way`);
  }
});

test("a lock is recognised at either scope, derived from its own constant", () => {
  assert.ok(isSubmissionLockName(SUBMISSION_LOCK_NAME), "the repository-scoped lock");
  assert.ok(isSubmissionLockName(orgSubmissionLockName("lab-3")), "the organization-scoped one");
  assert.ok(isSubmissionLockName(orgSubmissionLockName("portfolio-2627")), "an id containing a hyphen");
});

test("somebody else's ruleset is not ours", () => {
  // The prefix test must not swallow a ruleset a lecturer or an org owner put
  // on the repository themselves: refusing a student over one of those would be
  // this system blaming its own lock for a rule it did not write.
  assert.ok(!isSubmissionLockName("main-protection"));
  assert.ok(!isSubmissionLockName("pxl-classroom"));
  assert.ok(!isSubmissionLockName(`prefix-${SUBMISSION_LOCK_NAME}`));
  assert.ok(!isSubmissionLockName(`${SUBMISSION_LOCK_NAME}x`));
  assert.ok(!isSubmissionLockName(undefined));
  assert.ok(!isSubmissionLockName(null));
});
