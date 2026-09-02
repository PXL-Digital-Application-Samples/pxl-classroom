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

import { needsBrokerDispatch } from "../frontend/src/lib/publish.js";

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
