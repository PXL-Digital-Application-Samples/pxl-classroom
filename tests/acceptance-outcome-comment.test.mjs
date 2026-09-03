// What may cross from the private system onto a public issue.
//
// A rejected student watched "Setting up your repository..." for two minutes and
// was then handed guesses - "the registration cap has been reached", "GitHub is
// experiencing high load" - while the real answer, `rejected:no-claim`, had been
// decided within a second. The page guessed because the outcome existed only in
// the private control repo, which a student cannot read.
// PXL-Automation-II/test-pe3, 2026-09-03.
//
// The fix writes the outcome back to the student's own broker issue. That issue
// lives in a PUBLIC repository, which makes the boundary the interesting part:
//
//   the CATEGORY crosses      a closed set of slugs this system defines
//   the REASON TEXT does not  it carries the address the student typed
//
// "<email> has already been claimed by another GitHub account" is a real
// sentence this system produces. The claim is sealed precisely so that address
// reaches nobody but the hub; republishing it in a public comment would undo
// that on the student's behalf, and they would never know.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { publishableCategory } from "../scripts/comment-acceptance-outcome.mjs";
// Imported, not re-implemented: the reader is the half that decides what the
// student is shown, and a test that reproduces its logic proves only that the
// test agrees with itself.
import { outcomeFromComments } from "../frontend/src/lib/acceptance-outcome.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = readFileSync(join(ROOT, "scripts", "comment-acceptance-outcome.mjs"), "utf8");
const VIEW = readFileSync(join(ROOT, "frontend", "src", "views", "AssignmentView.vue"), "utf8");
const GROUP = readFileSync(join(ROOT, "frontend", "src", "components", "GroupAcceptanceCard.vue"), "utf8");
const HANDLER = readFileSync(join(ROOT, ".github", "workflows", "acceptance-handler.yml"), "utf8");

/** A hub comment carrying one marker, as the script writes it. */
const comment = (category) => ({ body: `<!-- pxl-acceptance-outcome:${category} -->\nText.` });

test("a known rejection is published as itself", () => {
  assert.equal(publishableCategory("rejected:no-claim"), "rejected:no-claim");
  assert.equal(publishableCategory("rejected:cap-reached"), "rejected:cap-reached");
});

test("an unknown rejection is flattened, not passed through", () => {
  // The boundary must not widen just because somebody added a slug elsewhere.
  // A category invented later reaches the public issue as the generic form
  // until it is deliberately listed here.
  assert.equal(publishableCategory("rejected:something-new"), "rejected");
  assert.equal(publishableCategory("rejected:<script>"), "rejected");
});

test("nothing else is published", () => {
  // "the repository appearing is the message" was true only for a student who
  // can SEE the repository. One who has been invited cannot - it is private and
  // they are not a collaborator until they accept - so `provisioned:invited`
  // was added below. Everything else still stays off a public issue: a failure
  // is the lecturer's business.
  assert.equal(publishableCategory("accepted"), null);
  assert.equal(publishableCategory("already-accepted"), null);
  assert.equal(publishableCategory("fail:provisioning"), null);
  assert.equal(publishableCategory(""), null);
  assert.equal(publishableCategory(undefined), null);
});

test("the one success that IS published, and the one that is not", () => {
  // 201 from the collaborator grant means GitHub sent an invitation, and the
  // hub is the only party that knows: the student's own token gets `200 []`
  // from /user/repository_invitations and 403 from
  // /user/memberships/orgs/{org} (both measured 2026-09-03).
  assert.equal(publishableCategory("provisioned:invited"), "provisioned:invited");

  // A 204 grant is deliberately silent. It means the student is already a
  // collaborator or an org member, and this comment lands on a PUBLIC
  // repository - "this account is an org member" is not ours to publish, and a
  // directly granted repository is visible at once anyway.
  assert.equal(publishableCategory("provisioned:direct"), null);
  assert.equal(publishableCategory("provisioned"), null);
  assert.equal(publishableCategory("provisioned:anything-else"), null);
  assert.equal(
    /provisioned:direct/.test(SCRIPT.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")),
    false,
    "no code path may publish the direct-grant case",
  );
});

test("the invitation notice carries no URL and no invitation id", () => {
  // The injection boundary. This comment is on a public repository and the
  // issue lock is `|| true`, so a forged copy is possible; the page must never
  // render or dereference anything out of it. It builds the invitation URL
  // itself from the assignment's naming pattern, and there is no in-app accept
  // to feed an id to.
  const body = SCRIPT.slice(SCRIPT.indexOf("function bodyFor"), SCRIPT.indexOf("async function main"));
  assert.ok(body.length > 100, "bodyFor must still exist - update this guard with it");
  assert.equal(/https?:\/\//.test(body), false, "no URL in the published body");
  assert.equal(/invitation_id|invitationId|\bid\b\s*[:=]/.test(body), false, "no id in the published body");
});

test("the workflow publishes the invitation notice only on a 201 grant", () => {
  const step = HANDLER.slice(
    HANDLER.indexOf("Tell the student their repository is waiting on an invitation"),
    HANDLER.indexOf("Tell the student why they were turned away"),
  );
  assert.ok(step.length > 0, "the step that announces the invitation is gone - update this guard with it");
  assert.match(step, /if:\s*steps\.prov\.outputs\.invited == 'true'/, "gated on the grant, not on success");
  assert.match(step, /OUTCOME: provisioned:invited/);
  assert.match(step, /continue-on-error: true/, "a courtesy comment must not redden a good provisioning");
  assert.equal(/reject_reason/.test(step), false);
});

test("the reason text never reaches the comment", () => {
  // The property the whole design turns on. reject_reason is what carries the
  // address; the script must not read it, and the workflow must not pass it.
  assert.equal(/reject_reason/.test(SCRIPT), false, "the script reads reject_reason - it must publish the category only");
  const step = HANDLER.slice(HANDLER.indexOf("Tell the student why they were turned away"), HANDLER.indexOf("Notify on failure"));
  assert.ok(step.length > 0, "the step that tells the student is gone - update this guard with it");
  assert.equal(/reject_reason/.test(step), false, "the workflow passes reject_reason to a public comment");
});

test("the page and the script agree on the marker", () => {
  // Two files, one contract. A marker written one way and matched another means
  // the page silently falls back to guessing, which is the bug being fixed -
  // and it would look exactly like it working.
  assert.match(SCRIPT, /pxl-acceptance-outcome/, "the writer names the marker");
  assert.match(
    readFileSync(join(ROOT, "frontend", "src", "lib", "acceptance-outcome.js"), "utf8"),
    /pxl-acceptance-outcome/,
    "and so does the one reader both surfaces use",
  );

  // Both prefixes. The regex was `rejected[a-z:-]*` while `provisioned:` was
  // being added, and a marker that does not match is indistinguishable from a
  // marker that was never posted - the hub writing into a void looks exactly
  // like the feature not existing.
  assert.equal(outcomeFromComments([comment("rejected:no-claim")]), "rejected:no-claim");
  assert.equal(outcomeFromComments([comment("provisioned:invited")]), "provisioned:invited");
});

test("a rejection outranks a provisioned marker, wherever it sits", () => {
  // The forgery that would matter. The broker locks the issue with `|| true`,
  // so the lock is not a guarantee and the repository is public: if the last
  // marker always won, posting `provisioned:invited` under someone's rejection
  // would replace "you were turned away, here is why" with a link that 404s,
  // and the real answer would sit two comments above where nobody looks. The
  // hub never posts both for one attempt, so nothing real is lost.
  const rej = comment("rejected:no-claim");
  const inv = comment("provisioned:invited");
  assert.equal(outcomeFromComments([rej, inv]), "rejected:no-claim");
  assert.equal(outcomeFromComments([inv, rej]), "rejected:no-claim");
});

test("among the rest, the last one wins", () => {
  // A student who accepted, was refused, fixed the problem and accepted again
  // should see the latest answer - subject to the rule above.
  assert.equal(
    outcomeFromComments([{ body: "an ordinary comment" }, comment("provisioned:invited")]),
    "provisioned:invited",
  );
});

test("silence and unreadability are both null, never a category", () => {
  for (const input of [[], null, undefined, "nope", [{ body: "hello" }], [{}], [null]]) {
    assert.equal(outcomeFromComments(input), null, `${JSON.stringify(input ?? null)} must yield null`);
  }
});

test("ONE parser: neither student surface declares its own marker", () => {
  // This was two implementations for about an hour, and the one that would
  // have been left behind is the group card - group students simply would not
  // have been told, and it would have looked like the feature not existing.
  for (const [src, label] of [[VIEW, "AssignmentView"], [GROUP, "GroupAcceptanceCard"]]) {
    assert.ok(
      !/OUTCOME_MARKER\s*=\s*\//.test(src),
      `${label}: the marker regex belongs in lib/acceptance-outcome.js`,
    );
    assert.match(src, /outcomeFromComments/, `${label}: must read markers through the shared parser`);
  }
});

test("every publishable category has student-facing wording", () => {
  // A slug with no sentence renders the generic fallback, which is a worse
  // answer than the one the system already has.
  const published = [...SCRIPT.matchAll(/"(rejected:[a-z-]+)"/g)].map((m) => m[1]);
  assert.ok(published.length >= 15, `only ${published.length} categories found - has the list moved?`);
  const missing = published.filter((c) => !VIEW.includes(`'${c}':`));
  assert.deepEqual(missing, [], "these are published to the student but the page has no sentence for them");
});
