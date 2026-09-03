// A field acceptance ENFORCES must reach the page that has to obey it.
//
// THE FAILURE THIS EXISTS FOR: PXL-Automation-II/test-pe3, 2026-09-03.
//
// `require_claim` was added so an OPEN assignment could still demand a
// confirmed institutional address. lib/assignment-doc.mjs wrote it,
// acceptance/accept.mjs enforced it - and pages/generate.mjs never published
// it. The student's browser therefore computed `needsClaim` as false, NEVER
// SHOWED THE ADDRESS FIELD, and sent an acceptance with no claim. The hub
// refused it with `rejected:no-claim`.
//
// The student was refused for not doing something they were never asked to do.
// Then the waiting page, which hides its claim-related causes behind the same
// missing field, offered "the assignment registration cap has been reached"
// instead - a confidently wrong diagnosis of a state the system knew exactly.
//
// The shape of the bug is what makes it worth a guard: the writer and the
// enforcer agreed, and the PUBLISHER was the odd one out. Nothing tied the
// three together, so the feature was unusable on every open assignment from the
// moment it shipped and no test noticed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GENERATE = readFileSync(join(ROOT, "pages", "generate.mjs"), "utf8");
const ACCEPT = readFileSync(join(ROOT, "acceptance", "accept.mjs"), "utf8");
const VIEW = readFileSync(join(ROOT, "frontend", "src", "views", "AssignmentView.vue"), "utf8");

/**
 * Assignment fields the STUDENT PAGE reads to decide what to ask for, which the
 * hub also enforces. Each must be published, or the page and the hub disagree
 * about what a valid acceptance looks like.
 *
 * Deliberately a short, explicit list rather than a derived one: the property
 * that matters is not "every field is published" - most must NOT be, the card
 * is public - but "these specific ones are, because a student is judged on
 * them".
 */
const MUST_PUBLISH = [
  ["require_claim", "whether an open assignment demands a confirmed address"],
  ["roster_mode", "which gate applies at all"],
  ["claim_domains", "which addresses the browser will seal"],
  ["max_acceptances", "the cap the page reports against"],
];

test("every field the student page is judged on is published to it", () => {
  const missing = MUST_PUBLISH.filter(([field]) => !new RegExp(`^\\s*${field}:`, "m").test(GENERATE));
  assert.deepEqual(
    missing.map(([f, why]) => `${f} - ${why}`),
    [],
    "pages/generate.mjs does not publish these, so the student page cannot obey them",
  );
});

test("require_claim is enforced by the hub, read by the page, and published", () => {
  // The three parties that disagreed. Named individually because the general
  // test above would still pass if one of them stopped using the field.
  // Matched as CODE, not as a mention. The first version of this assertion used
  // /require_claim/ and passed against the comment block explaining the bug -
  // it would have reported all three parties in agreement while the field was
  // unpublished, which is precisely the state it exists to detect.
  assert.match(ACCEPT, /\?\.require_claim|assignment\?\.require_claim|\brequire_claim\s*===/, "accept.mjs no longer READS require_claim");
  assert.match(VIEW, /\brequire_claim\s*===/, "AssignmentView no longer READS require_claim");
  assert.match(GENERATE, /^\s*require_claim:/m, "generate.mjs no longer PUBLISHES require_claim");
});

test("require_claim is published as a boolean, not omitted when false", () => {
  // Absent would be indistinguishable from an assignment written before the
  // field existed, and the page would fall back to "no claim needed" - the
  // exact direction that produced the incident.
  assert.match(
    GENERATE,
    /require_claim:\s*def\.roster_mode === "open" \? def\.require_claim === true : undefined/,
    "require_claim must be an explicit boolean under open",
  );
});
