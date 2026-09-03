// What may cross from the private system onto a public issue, and how.
//
// A rejected student watched "Setting up your repository..." for two minutes and
// was then handed guesses - "the registration cap has been reached", "GitHub is
// experiencing high load" - while the real answer had been decided within a
// second. The page guessed because the outcome existed only in the private
// control repo. PXL-Automation-II/test-pe3, 2026-09-03.
//
// The first fix wrote a COMMENT to the student's broker issue. That was wrong
// three ways, and all three were found the same day:
//
//   * it EMAILS them. The student authored that issue, so GitHub subscribes
//     them; one reported "Re: Acceptance (processed) - Closed #1 has been
//     completed" arriving in their inbox - mail about internal plumbing.
//   * it can be FORGED. Anyone may comment on a public issue.
//   * it was returning 403 on the locked issue, while labelling the same issue
//     returned 200.
//
// So the channel is a LABEL. Metadata is silent, applying one needs triage or
// write access, and a locked conversation still accepts it.
//
// The boundary is the interesting part, because the broker repository is
// PUBLIC:
//
//   two labels cross          outcome:invited, outcome:rejected
//   nothing else does         not the reason, not the address, not the level
//
// "<email> has already been claimed by another GitHub account" is a real
// sentence this system produces. The claim is sealed precisely so that address
// reaches nobody but the hub.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { outcomeLabel } from "../scripts/publish-acceptance-outcome.mjs";
import { INVITED_LABEL, REJECTED_LABEL, OUTCOME_LABELS } from "../lib/acceptance-labels.mjs";
// Imported, not re-implemented: the reader decides what the student is shown,
// and a test that reproduces its logic proves only that it agrees with itself.
import { outcomeFromLabels } from "../frontend/src/lib/acceptance-outcome.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const SCRIPT = read("scripts/publish-acceptance-outcome.mjs");
const VIEW = read("frontend/src/views/AssignmentView.vue");
const GROUP = read("frontend/src/components/GroupAcceptanceCard.vue");
const HANDLER = read(".github/workflows/acceptance-handler.yml");

test("exactly two labels exist, and the rejection one is generic", () => {
  // The whole privacy decision, in one assertion. A per-reason label is
  // filterable in one click, so `outcome:rejected-not-on-roster` would be a
  // public, sortable list of which named students are not enrolled - enrolment
  // data about people who never chose to publish it, which is not the same as
  // their own acceptance being public.
  assert.deepEqual(OUTCOME_LABELS, [INVITED_LABEL, REJECTED_LABEL]);
  assert.equal(REJECTED_LABEL, "outcome:rejected");
  assert.ok(
    !/rejected[:-][a-z]/.test(REJECTED_LABEL),
    "a per-reason rejection label re-opens the enumeration it was chosen to avoid",
  );
});

test("every rejection earns the same generic label", () => {
  for (const outcome of [
    "rejected:no-claim",
    "rejected:not-on-roster",
    "rejected:claim-taken",
    "rejected:cap-reached",
    "rejected:some-slug-invented-later",
  ]) {
    assert.equal(outcomeLabel(outcome), REJECTED_LABEL, `${outcome} must not reach the public repo as itself`);
  }
});

test("the one success that IS published, and the one that is not", () => {
  // 201 from the collaborator grant means GitHub sent an invitation, and the
  // hub is the only party that knows: the student's own token gets `200 []`
  // from /user/repository_invitations and 403 from
  // /user/memberships/orgs/{org} (both measured 2026-09-03).
  assert.equal(outcomeLabel("provisioned:invited"), INVITED_LABEL);

  // A 204 grant is deliberately silent: the student is already a collaborator
  // or an org member, the repository is readable at once, and "this account is
  // an org member" is not ours to publish.
  assert.equal(outcomeLabel("provisioned:direct"), null);
  assert.equal(outcomeLabel("provisioned"), null);
});

test("nothing else is published", () => {
  for (const outcome of ["accepted", "already-accepted", "fail:provisioning", "", undefined, null]) {
    assert.equal(outcomeLabel(outcome), null, `${outcome} must earn no label`);
  }
});

test("no reason text and no address ever reaches the publisher", () => {
  // The property the whole design turns on. reject_reason carries the address
  // the student typed; the script must not read it and the workflow must not
  // pass it.
  assert.equal(/reject_reason/.test(SCRIPT), false, "the script must publish a label only");
  assert.equal(
    /body/.test(SCRIPT.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")),
    false,
    "a request body of prose is the thing labels replaced",
  );
  for (const name of ["Tell the student their repository is waiting on an invitation", "Tell the student they were turned away"]) {
    const at = HANDLER.indexOf(name);
    assert.ok(at > 0, `the step "${name}" is gone - update this guard with it`);
    const step = HANDLER.slice(at, at + 700);
    assert.equal(/reject_reason/.test(step), false, `${name} passes reject_reason to a public repo`);
    assert.match(step, /continue-on-error: true/, `${name} must never redden the run`);
  }
});

test("the reader takes both spellings GitHub can hand it", () => {
  // `issue.labels` is objects from the API; strings let a fixture be written
  // the obvious way.
  assert.equal(outcomeFromLabels([{ name: INVITED_LABEL }]), INVITED_LABEL);
  assert.equal(outcomeFromLabels([INVITED_LABEL]), INVITED_LABEL);
  assert.equal(outcomeFromLabels([{ name: "other" }, { name: REJECTED_LABEL }]), REJECTED_LABEL);
});

test("a rejection outranks a success, wherever it sits", () => {
  // Not for forgery any more - a student cannot apply either label - but the
  // two must never both be set, and if a bug ever set them, "you were refused"
  // is the answer that sends a student to their lecturer rather than to a link
  // that cannot work.
  assert.equal(outcomeFromLabels([{ name: INVITED_LABEL }, { name: REJECTED_LABEL }]), REJECTED_LABEL);
  assert.equal(outcomeFromLabels([{ name: REJECTED_LABEL }, { name: INVITED_LABEL }]), REJECTED_LABEL);
});

test("silence and unreadability are both null, never an outcome", () => {
  for (const input of [[], null, undefined, "nope", [{ name: "bug" }], [{}], [null]]) {
    assert.equal(outcomeFromLabels(input), null, `${JSON.stringify(input ?? null)} must yield null`);
  }
});

test("ONE reader: neither student surface parses labels itself", () => {
  // It was two implementations for about an hour under the comment design, and
  // the copy that would have been left behind is the group card - group
  // students simply not told, looking exactly like the feature not existing.
  for (const [src, label] of [[VIEW, "AssignmentView"], [GROUP, "GroupAcceptanceCard"]]) {
    assert.match(src, /outcomeFromLabels/, `${label}: must read through the shared parser`);
    assert.ok(
      !new RegExp(`['"]${REJECTED_LABEL}['"]`).test(src),
      `${label}: the label name belongs in lib/acceptance-labels.mjs`,
    );
  }
});

test("the page reads the issue, not its comments", () => {
  // One request either way, and the labels arrive on an object the page needs
  // anyway - but the real reason is that a comment would email a student who is
  // subscribed to their own issue.
  for (const [src, label] of [[VIEW, "AssignmentView"], [GROUP, "GroupAcceptanceCard"]]) {
    assert.ok(
      !/issues\/\$\{[^}]+\}\/comments/.test(src),
      `${label}: still fetching comments - the channel is labels now`,
    );
  }
});

test("the student-facing rejection sentence promises no detail it cannot have", () => {
  // Nineteen per-slug sentences lived here and are gone with the per-reason
  // labels. What replaced them must not pretend to know which one applies.
  const at = VIEW.indexOf("const REJECTION_MESSAGE");
  assert.ok(at > 0, "there must be one rejection sentence");
  const line = VIEW.slice(at, VIEW.indexOf("\n\n", at));
  assert.match(line, /lecturer can see the reason/, "point them at who does know");
  assert.ok(!/rejected:/.test(line), "no slug may reach the student");
});
