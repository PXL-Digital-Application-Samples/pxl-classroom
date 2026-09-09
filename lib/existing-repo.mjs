// WHETHER A STUDENT IS ABOUT TO BE HANDED A REPOSITORY THIS ASSIGNMENT DID NOT
// MAKE.
//
// Provisioning is idempotent on repository EXISTENCE (provisioning/
// provision.mjs, `alreadyExists ? existing.data`): it finds the name taken,
// skips generate-from-template, grants the student access and reports
// `reused`. That is deliberate and load-bearing - a student who empties their
// own repository and re-accepts must not be broken by it - and it is also how
// a returning student gets last year's repository with none of this year's
// starter code, silently, green, with nothing on any screen.
//
// The refusal used to live at CREATION, in lib/assignment-collision.mjs, which
// is the one moment the question cannot be answered: the form knows the
// pattern and the organization's repository listing, and has no idea who will
// accept. `portfolio-{github_login}` over an organization holding 300
// portfolios from previous years refused the name over 300 repositories of
// which perhaps two belonged to a student in this cohort - measured on a real
// course, 2026-09-09.
//
// At acceptance both halves are known: this student, this name. So the
// judgement moved here, and creation keeps a note instead of a refusal.
//
// THE FROZEN CASE IS NOT THE SAME QUESTION AS THE REUSED ONE, and conflating
// them is what made the creation-time check unusable:
//
//   * A repository carrying one of this system's deadline rulesets is one the
//     student CANNOT PUSH TO. Handing it over is a repository that looks like
//     theirs and refuses their first commit, weeks before anyone looks. There
//     is no assignment for which that is the wanted outcome, so no policy
//     switches it off.
//   * A repository that merely exists is a judgement call the system cannot
//     make and the lecturer can. A portfolio carried across years SHOULD come
//     back; a lab or an exam should not. `existing_repo_policy` on the
//     assignment is that answer, given once by the person who knows which kind
//     of assignment this is.
//
// Absent means `reuse`, because reuse is what has happened since the system was
// written - every assignment predating the field was run under it, and reading
// absence as `refuse` would start refusing acceptances on assignments nobody
// touched. The schema therefore carries NO `default` for it: lib/validate.mjs
// runs Ajv with `useDefaults: true`, which writes defaults into the document
// being validated, and a field whose absence is already an answer must not have
// validation invent one (CLAUDE.md, `tests/schema-defaults-are-writers.test.mjs`).
//
// Isomorphic and dependency-free ON PURPOSE: the assignment form imports this
// for the policy vocabulary, so nothing here may reach for a token, a file or
// lib/submission-lock.mjs - that module carries lib/audit.mjs and #deployment
// behind it. Whether a ruleset is one of ours is answered where the ruleset's
// name is declared (`isSubmissionLockName`), and arrives here as evidence.

/** The two answers, in the order the form offers them. */
export const EXISTING_REPO_POLICIES = ["reuse", "refuse"];

/**
 * What an assignment says to do with a repository the student already owns.
 *
 * Anything unrecognised - and absence - reads as `reuse`. This is the one place
 * in the system where the fail-closed rule does not apply, and the reason is
 * that the closed direction is not the safe one here: refusing is what stops a
 * student getting a repository at all, and an assignment that never answered
 * the question has been reusing since the day it was published.
 *
 * @param {unknown} value
 * @returns {"reuse"|"refuse"}
 */
export function normalizeExistingRepoPolicy(value) {
  return value === "refuse" ? "refuse" : "reuse";
}

/** `rejected:*` outcomes this decision can produce. Spelled once, here. */
export const REJECT_REPO_FROZEN = "rejected:repo-frozen";
export const REJECT_REPO_EXISTS = "rejected:repo-exists";

/**
 * What to do about the repository this student is about to be given.
 *
 * Every input is EVIDENCE, and `null` is a third answer in both of them rather
 * than a falsy one - "we could not read it" is not "it is not there".
 * (CLAUDE.md: unreadable is not evidence, and a 200 can be unreadable.) An
 * unreadable answer yields `unknown`, which the caller turns into a refusal:
 * the read is one GET against an organization we hold a token for, so a failure
 * is transient and the student retries, where guessing `free` hands over a
 * frozen repository and guessing `reuse` does it silently.
 *
 * @param {object} args
 * @param {boolean|null} args.exists   repository is there / is not / unreadable
 * @param {string|false|null} args.frozen  the name of a deadline ruleset
 *   covering it, `false` for none, `null` for unreadable
 * @param {unknown} args.policy        the assignment's `existing_repo_policy`
 * @returns {{outcome: "free"|"frozen"|"reuse"|"refuse"|"unknown",
 *            reject: string|null, note: string}}
 */
export function existingRepoVerdict({ exists, frozen, policy } = {}) {
  if (exists === false) {
    return { outcome: "free", reject: null, note: "absent - a fresh repository" };
  }
  if (exists !== true) {
    return {
      outcome: "unknown",
      reject: REJECT_REPO_EXISTS,
      note: "could not be read - refusing rather than handing over a repository we did not look at",
    };
  }

  // Ordered before the policy on purpose: `reuse` is an answer about a
  // repository the student can work in, and a frozen one is not that.
  if (frozen === null) {
    return {
      outcome: "unknown",
      reject: REJECT_REPO_EXISTS,
      note: "exists, and its rulesets could not be read - refusing rather than guessing it is open",
    };
  }
  if (typeof frozen === "string" && frozen) {
    return {
      outcome: "frozen",
      reject: REJECT_REPO_FROZEN,
      note: `exists and is frozen by ${frozen} - they could not push to it`,
    };
  }

  if (normalizeExistingRepoPolicy(policy) === "refuse") {
    return {
      outcome: "refuse",
      reject: REJECT_REPO_EXISTS,
      note: "exists, and this assignment refuses a repository it did not create",
    };
  }
  return {
    outcome: "reuse",
    reject: null,
    note: "exists and is not frozen - handing back the existing repository, no starter code is copied",
  };
}
