// PXL Classroom — yaml.test.mjs
//
// Verifies the shared YAML loader handles:
//   - nested objects (the assignment `template:` block — the case the
//     replaced minimal parsers got wrong)
//   - arrays (the roster file shape — the other case they got wrong)
//   - type coercion (numbers, booleans, nulls, ISO dates as strings)

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadYaml } from "../lib/yaml.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fix = (n) => join(here, "fixtures", n);

test("loadYaml parses a valid assignment with a nested template block", async () => {
  const doc = await loadYaml(fix("valid-assignment.yml"));
  assert.equal(doc.id, "test-valid");
  assert.equal(doc.organization, "PXLAutomation");
  // The nested template block — minimal parsers misparsed this
  assert.equal(typeof doc.template, "object");
  assert.equal(doc.template.owner, "PXLAutomation");
  assert.equal(doc.template.repository, "template-automation-pe-1");
  assert.equal(doc.max_acceptances, 50);
  assert.equal(doc.lock_down_enabled, true);
});

test("loadYaml parses an array-shaped roster", async () => {
  const doc = await loadYaml(fix("roster-array.yml"));
  assert.ok(Array.isArray(doc.students), "students must be an array");
  assert.equal(doc.students.length, 3);
  assert.equal(doc.students[0].github_login, "alice-test");
  assert.equal(doc.students[1].github_login, null);
  assert.equal(doc.students[2].active, false);
});
