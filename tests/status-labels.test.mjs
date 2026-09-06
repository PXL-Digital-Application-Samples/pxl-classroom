// Every stored value a lecturer can see has a word written for it.
//
// The assignment table printed `acceptance_state` and `submission_status`
// straight into the cell, so the screen read `provisioned` and `no-submission`
// - the model's own strings, lowercase and hyphenated. The labels fix that; the
// risk they introduce is the opposite one, a value nobody wrote a label for.
//
// So the enums are read from the SCHEMAS rather than listed here. A new state
// added upstream fails this file, which is the moment somebody has to decide
// what a lecturer should read - rather than the moment a lecturer reads a word
// only the code uses.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  ACCEPTANCE_LABELS,
  SUBMISSION_LABELS,
  acceptanceLabel,
  submissionLabel,
} from "../frontend/src/lib/status-labels.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const schema = (name) => JSON.parse(readFileSync(join(root, "schemas", name), "utf8"));

/** Walk a schema for the first `enum` under a property of this name. */
function enumFor(node, property) {
  if (!node || typeof node !== "object") return null;
  if (node.properties?.[property]?.enum) return node.properties[property].enum;
  for (const value of Object.values(node)) {
    const found = enumFor(value, property);
    if (found) return found;
  }
  return null;
}

test("every submission_status the schema declares has a label", () => {
  const values = enumFor(schema("report.schema.json"), "submission_status");
  assert.ok(values?.length, "the enum was not found - this guard would pass vacuously");
  const missing = values.filter((v) => !SUBMISSION_LABELS[v]);
  assert.deepEqual(missing, [], "submission states with no label");
});

test("every acceptance status the schema declares has a label", () => {
  // `acceptance_state` on a report row is an acceptance record's `status`, or
  // `not-accepted` where report.mjs found no record at all - the report schema
  // types it as a bare string, so the enum has to come from the acceptance one.
  const values = enumFor(schema("acceptance.schema.json"), "status");
  assert.ok(values?.length, "the enum was not found - this guard would pass vacuously");
  const missing = values.filter((v) => !ACCEPTANCE_LABELS[v]);
  assert.deepEqual(missing, [], "acceptance states with no label");
  assert.ok(ACCEPTANCE_LABELS["not-accepted"], "report.mjs writes this one itself");
});

test("no label is left as the raw value by accident", () => {
  // A label identical to its key means somebody added the key and never wrote
  // the word - which reads exactly like the defect this file exists to stop.
  for (const [map, name] of [[SUBMISSION_LABELS, "submission"], [ACCEPTANCE_LABELS, "acceptance"]]) {
    for (const [value, text] of Object.entries(map)) {
      assert.notEqual(text, value, `${name} label for ${value} is still the raw value`);
      assert.match(text, /^[A-Z]/, `${name} label for ${value} should read as a sentence`);
      assert.ok(!text.includes("-") || /[a-z]-[a-z]/.test(text) === false, `${name} label for ${value} keeps a hyphen`);
    }
  }
});

test("AN UNKNOWN VALUE FALLS BACK TO ITSELF, never to a blank", () => {
  // A state added upstream before anyone writes a label must not render an
  // empty cell: that reads as "nothing to report" about a student the system
  // has something to say about. An unlovely word is the better failure.
  assert.equal(acceptanceLabel("some-new-state"), "some-new-state");
  assert.equal(submissionLabel("some-new-state"), "some-new-state");
});

test("an absent value is empty, because there is nothing to say", () => {
  for (const empty of [null, undefined, "", 0, false]) {
    assert.equal(acceptanceLabel(empty), "");
    assert.equal(submissionLabel(empty), "");
  }
});

test("the labels a lecturer reported are gone", () => {
  // `provisioned` and `no-submission` are the two that were on screen.
  assert.equal(acceptanceLabel("provisioned"), "Repository ready");
  assert.equal(submissionLabel("no-submission"), "No submission");
  assert.equal(submissionLabel("on-time"), "On time");
});
