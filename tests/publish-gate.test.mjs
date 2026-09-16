// Whether saving a published assignment also dispatches the publish workflow.
//
// The decision used to live inline in AdminView's click handler as
// `if (brokerExists.value === false)`, where nothing could run it. `brokerExists`
// has three states and that test read the third one - `null`, meaning nobody has
// looked yet - as "the broker is fine". The panel is in exactly that state from
// the moment it opens until verifyLiveInfrastructure() resolves, so a save
// inside that window dispatched nothing and reported nothing.
//
// Imported, not re-implemented: a test that restates `!== true` would pass
// against a component that had drifted away from it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  needsBrokerDispatch,
  publishedSaveWorkflow,
  writeReachesStudentPage,
} from "../frontend/src/lib/publish.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("a broker positively found is the only reason to skip the dispatch", () => {
  assert.equal(needsBrokerDispatch(true), false);
});

test("a broker looked for and missing dispatches", () => {
  assert.equal(needsBrokerDispatch(false), true);
});

test("NOT YET LOOKED is not the same answer as fine", () => {
  // The regression. `null` is the panel's opening state, and reading it as
  // "fine" is what let a published assignment exist with no broker behind it.
  assert.equal(needsBrokerDispatch(null), true);
  assert.equal(needsBrokerDispatch(undefined), true);
});

test("nothing truthy-but-not-true counts as a sighting", () => {
  // Fails toward doing the work. A stray string or object is not evidence that
  // a broker exists, and treating it as such is the same class of mistake.
  assert.equal(needsBrokerDispatch("true"), true);
  assert.equal(needsBrokerDispatch(1), true);
  assert.equal(needsBrokerDispatch({}), true);
});

// PXL-2TIN-NetAdv-26-27, 2026-09-16. The broker existed, so saving the edit that
// ticked require_claim dispatched NOTHING: the hub enforced the new document and
// the student page kept the old card, which never asked for an address.
test("a save with the broker found still rebuilds the student page", () => {
  assert.equal(publishedSaveWorkflow(true), "regenerate-dashboard.yml");
});

test("a save that publishes does not also regenerate - the publish does that itself", () => {
  for (const unknown of [false, null, undefined, "true"]) {
    assert.equal(publishedSaveWorkflow(unknown), "publish-assignment.yml");
  }
  const publish = readFileSync(join(ROOT, ".github", "workflows", "publish-assignment.yml"), "utf8");
  assert.match(
    publish,
    /gh workflow run regenerate-dashboard\.yml/,
    "publish-assignment.yml no longer regenerates the student pages, so a save that publishes must",
  );
});

test("both answers name a workflow that exists", () => {
  for (const brokerExists of [true, false]) {
    const file = join(ROOT, ".github", "workflows", publishedSaveWorkflow(brokerExists));
    assert.ok(existsSync(file), `${file} does not exist - the dispatch would 404`);
  }
});

// The generator's own filter, read rather than restated. A state added to it
// and not here is a card students read that no lecturer write refreshes.
function cardStates() {
  const source = readFileSync(join(ROOT, "pages", "generate.mjs"), "utf8");
  const line = source.match(/if \((def\.state !== "[a-z]+"(?: && def\.state !== "[a-z]+")*)\) continue;/);
  assert.ok(line, "pages/generate.mjs no longer filters cards by state in the shape this test reads");
  return [...line[1].matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
}

test("a write reaches the student page whenever either side has a card", () => {
  const withCard = cardStates();
  assert.deepEqual([...withCard].sort(), ["closed", "published"]);
  const states = ["draft", "published", "closed", "archived"];
  for (const before of states) {
    for (const after of states) {
      assert.equal(
        writeReachesStudentPage(before, after),
        withCard.includes(before) || withCard.includes(after),
        `${before} -> ${after}`,
      );
    }
  }
});

test("draft to draft and archived to archived touch nothing a student reads", () => {
  assert.equal(writeReachesStudentPage("draft", "draft"), false);
  assert.equal(writeReachesStudentPage("archived", "draft"), false);
});
