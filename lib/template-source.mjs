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

/** The repository behind the name is not the one this assignment was built from. */
export const TEMPLATE_REPLACED = "template-replaced";

/**
 * The template's immutable repository id, and whether it still matches.
 *
 * WHAT A PIN CATCHES, AND WHAT IT DELIBERATELY DOES NOT. `owner/repo` is a
 * name, and a name can come to mean a different repository. GitHub REDIRECTS a
 * renamed repository, so `owner/old-name` keeps resolving to it with the same
 * id - a rename is invisible here and must stay that way, or every rename
 * would break a live assignment for no reason. What the id catches is the case
 * a name cannot: the template deleted and a new one created under the same
 * name, or transferred away and the name taken. Then students who accepted
 * yesterday and students who accept today start from different code, and
 * nothing anywhere says so.
 *
 * It matters most for the case this module was written for - a template
 * maintained in someone else's organization, where the lecturer is not the
 * person who would be deleting it.
 *
 * THE PIN BELONGS TO THE NAME. It is stored inside `template`, beside the
 * owner and repository it was taken from, so pointing the assignment at a
 * DIFFERENT template is not a mismatch - it is a new pin. Only an unchanged
 * name whose id moved is the alarm. Getting this backwards would refuse every
 * lecturer who edits the template field.
 *
 * @param {object} input
 * @param {object} [input.storedTemplate] the assignment's stored `template`
 * @param {string} input.owner  owner named on the form/document now
 * @param {string} input.repo   repository named now
 * @param {unknown} input.probedId `id` from GET /repos/{owner}/{repo}
 * @returns {{ok: true, repositoryId: number|null, pinned: boolean}
 *          |{ok: false, code: string, reason: string, storedId: number, probedId: number}}
 */
export function resolveTemplatePin({ storedTemplate, owner, repo, probedId } = {}) {
  const id = Number.isInteger(probedId) ? probedId : null;

  const sameName =
    !!storedTemplate &&
    isForeignTemplate(storedTemplate.owner, owner) === false &&
    normalizeLogin(storedTemplate.owner) !== "" &&
    String(storedTemplate.repository || "").toLowerCase() === String(repo || "").toLowerCase();

  const stored = storedTemplate?.repository_id;

  // A different template entirely: the old pin describes a repository this
  // assignment no longer names, so it is discarded rather than compared.
  if (!sameName) return { ok: true, repositoryId: id, pinned: false };

  // Never pinned before, or we could not read an id just now. Absent stays
  // absent - a pin invented from nothing would be a fact nobody established.
  if (!Number.isInteger(stored)) return { ok: true, repositoryId: id, pinned: false };
  if (id === null) return { ok: true, repositoryId: stored, pinned: true };

  if (stored !== id) {
    return {
      ok: false,
      code: TEMPLATE_REPLACED,
      reason: "the repository behind this name is not the one the assignment was created from",
      storedId: stored,
      probedId: id,
    };
  }
  return { ok: true, repositoryId: stored, pinned: true };
}

/** What to tell a lecturer about a pin that no longer matches. */
export function templatePinMessage(finding, { templateOwner, templateRepo } = {}) {
  if (!finding || finding.ok) return "";
  const full = `${templateOwner}/${templateRepo}`;
  // Says what changed and what it means for students, then leaves the decision
  // where it belongs: only the lecturer knows whether the new repository is
  // the starter code they meant.
  return (
    `${full} is not the repository this assignment was created from - it was deleted and recreated, ` +
    `or transferred and the name reused (repository ${finding.storedId} then, ${finding.probedId} now). ` +
    `Students who accepted earlier started from the old one. Check it is the starter code you meant, ` +
    `then save this assignment to accept it.`
    // "Save", not "re-select the template": re-typing the same name probes the
    // same repository and reaches the same mismatch, so pointing the lecturer
    // at the field would be a loop with no exit. Saving is the deliberate act
    // that adopts the new id, and it is the same remedy whichever surface
    // reported this - the form, the publish preflight, or provisioning.
  );
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
