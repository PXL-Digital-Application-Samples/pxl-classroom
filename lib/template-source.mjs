// PXL Classroom - may this assignment use this template repository?
//
// Provisioning creates each student repository with ONE call:
//
//     POST /repos/{template_owner}/{template_repo}/generate  { owner: <org> }
//
// which needs read on the template AND create-repo on the course org, served
// by one App installation token minted for the course org
// (`provisioning/action.yml`, `owner: ${{ inputs.org }}`). A token is minted
// per installation and cannot span two, so what the template's owner is
// decides whether that call can work at all.
//
// MEASURED on the live testbed, 2026-09-07, by running the real acceptance and
// provisioning chain:
//
//   public template, another org        -> WORKS. `contains-studio/agents`
//                                          generated into a private student
//                                          repository, invitation sent. The
//                                          owner being a stranger made no
//                                          difference: public is public, and
//                                          the token does not authenticate as
//                                          the lecturer.
//   private, another org, App INSTALLED -> HTTP 404.
//                                          `PXL-Automation-II/pxl-classroom-control`
//                                          is private, and the App IS installed
//                                          on that org - the token was simply
//                                          minted for a different installation.
//   private, another org, no App        -> strictly weaker than the above.
//
// So the rule is: a template outside the assignment's own organization must be
// PUBLIC. Inside it, private is the ordinary case and is untouched.
//
// WHY THIS IS A MODULE AND NOT AN `if` IN THE FORM. The form probes the
// template with the LECTURER'S token, which can see their own private
// repository in another org - so the badge goes green on the one configuration
// that cannot work, and the failure surfaces later, in provisioning, AFTER the
// student has accepted and consumed a slot of `max_acceptances`. What the
// lecturer then sees is `HTTP 404` naming a repository they are looking at in
// another tab. The publish workflow asks this same question with the App's own
// token, which is the credential that actually has to answer it, and both
// surfaces have to reach the same verdict or the earlier one is worthless.
//
// Pure, dependency-free and isomorphic - no fs, no fetch, no Node builtins.
import { normalizeLogin } from "./github-login.mjs";

/** A template outside the org must be public. Inside it, anything goes. */
export const FOREIGN_PRIVATE = "foreign-private";
/** GitHub refuses `generate` from a repository not ticked as a template. */
export const NOT_A_TEMPLATE = "not-a-template";
/** We were handed something other than an answer. */
export const UNKNOWN = "unknown";

/**
 * Is this template owned by someone other than the assignment's organization?
 *
 * Compared through `normalizeLogin`, never a raw `!==`: GitHub hands back
 * whichever casing the surface happened to store, and `Colleague-Org` and
 * `colleague-org` are one account. An empty owner is not "foreign" - it is a
 * missing field, and the form's own required-field check owns that.
 */
export function isForeignTemplate(templateOwner, org) {
  const owner = normalizeLogin(templateOwner);
  const home = normalizeLogin(org);
  if (!owner || !home) return false;
  return owner !== home;
}

/**
 * Can provisioning use this template for an assignment in this org?
 *
 * `isPrivate` and `isTemplate` are the facts a `GET /repos/{owner}/{repo}`
 * returns. They are REQUIRED booleans: a caller that could not read the
 * repository has no answer to give and must report the failed read itself -
 * unreadable is not evidence, and a missing field must not read as `false`
 * and quietly pass. Anything that is not a boolean is refused as UNKNOWN.
 *
 * @param {object} input
 * @param {string} input.templateOwner owner of the template repository
 * @param {string} input.org the assignment's organization
 * @param {boolean} input.isPrivate  is the template repository private?
 * @param {boolean} input.isTemplate is it ticked as a template repository?
 * @returns {{ok: true} | {ok: false, code: string, reason: string}}
 */
export function templateUsable({ templateOwner, org, isPrivate, isTemplate } = {}) {
  const foreign = isForeignTemplate(templateOwner, org);
  const name = `${templateOwner || "?"}/`;

  if (typeof isPrivate !== "boolean" || typeof isTemplate !== "boolean") {
    return {
      ok: false,
      code: UNKNOWN,
      reason:
        `Could not establish whether ${name.slice(0, -1)} is a public template repository. ` +
        `Refusing rather than assuming it is.`,
    };
  }

  // Order matters. A foreign private repository is refused on VISIBILITY even
  // when it is a perfectly good template, because that is the fact the lecturer
  // has to act on - and `is_template` on a repository the App cannot read is
  // something we only know from the lecturer's own token anyway.
  if (foreign && isPrivate) {
    return { ok: false, code: FOREIGN_PRIVATE, reason: "a template outside this organization must be public" };
  }
  if (!isTemplate) {
    return { ok: false, code: NOT_A_TEMPLATE, reason: "the repository is not marked as a template repository" };
  }
  return { ok: true };
}

/**
 * What to tell a lecturer, naming the repository and the organization.
 *
 * Sentences, not slugs, and never a pointer at this repository's own
 * documentation (DESIGN.md §1.6): whoever hits this is a lecturer looking at
 * a form, and the fix is theirs to make on GitHub.
 */
export function templateSourceMessage(finding, { templateOwner, templateRepo, org } = {}) {
  if (!finding || finding.ok) return "";
  const full = `${templateOwner}/${templateRepo}`;
  switch (finding.code) {
    case FOREIGN_PRIVATE:
      // Says what is wrong, why it cannot simply be permitted, and the two
      // ways out - because "you own it" is exactly what the lecturer is about
      // to object, and the answer is that PXL Classroom is not them.
      return (
        `${full} is private and belongs to another organization. PXL Classroom creates student ` +
        `repositories as an app installed on ${org}, so it cannot read a private repository ` +
        `elsewhere - even one you own. Make ${full} public, or copy it into ${org}.`
      );
    case NOT_A_TEMPLATE:
      return `${full} is not a template repository. Open its Settings on GitHub and tick Template repository.`;
    default:
      return finding.reason;
  }
}
