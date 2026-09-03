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

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = readFileSync(join(ROOT, "scripts", "comment-acceptance-outcome.mjs"), "utf8");
const VIEW = readFileSync(join(ROOT, "frontend", "src", "views", "AssignmentView.vue"), "utf8");
const HANDLER = readFileSync(join(ROOT, ".github", "workflows", "acceptance-handler.yml"), "utf8");

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

test("only rejections are published at all", () => {
  // An acceptance needs no comment - the repository appearing is the message -
  // and a failure is the lecturer's business, not a note on a public issue.
  assert.equal(publishableCategory("accepted"), null);
  assert.equal(publishableCategory("already-accepted"), null);
  assert.equal(publishableCategory("fail:provisioning"), null);
  assert.equal(publishableCategory(""), null);
  assert.equal(publishableCategory(undefined), null);
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
  assert.match(SCRIPT, /pxl-acceptance-outcome/);
  assert.match(VIEW, /pxl-acceptance-outcome/);
});

test("every publishable category has student-facing wording", () => {
  // A slug with no sentence renders the generic fallback, which is a worse
  // answer than the one the system already has.
  const published = [...SCRIPT.matchAll(/"(rejected:[a-z-]+)"/g)].map((m) => m[1]);
  assert.ok(published.length >= 15, `only ${published.length} categories found - has the list moved?`);
  const missing = published.filter((c) => !VIEW.includes(`'${c}':`));
  assert.deepEqual(missing, [], "these are published to the student but the page has no sentence for them");
});
