// PXL Classroom — public-data-contract.test.mjs
//
// Verifies that the Pages public data generator outputs the contract shape
// expected by the SPA (an object keyed by assignment ID instead of an array).

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const generator = join(here, "..", "pages", "generate.mjs");
const fix = (n) => join(here, "fixtures", n);

test("public-clean.json fixture has assignments as an object", () => {
  const content = readFileSync(fix("public-clean.json"), "utf8");
  const data = JSON.parse(content);
  assert.equal(data.schema_version, 1);
  assert.ok(data.assignments && typeof data.assignments === "object" && !Array.isArray(data.assignments), "assignments must be a non-array object");
  assert.ok(data.assignments["automation-pe-1"], "should have automation-pe-1 key");
  const a = data.assignments["automation-pe-1"];
  assert.equal(a.id, "automation-pe-1");
  assert.equal(a.title, "Automation Practice 1");
  assert.equal(a.state, "published");
});

test("generate.mjs outputs assignments as an object keyed by ID", () => {
  const dir = mkdtempSync(join(tmpdir(), "pxl-gen-test-"));
  const assignmentsDir = join(dir, "assignments");
  mkdirSync(assignmentsDir);
  copyFileSync(fix("valid-assignment.yml"), join(assignmentsDir, "test-valid.yml"));

  const outDir = join(dir, "public");

  const res = spawnSync("node", [generator], {
    env: {
      ...process.env,
      DATA_DIR: dir,
      OUTPUT_DIR: outDir,
    },
    encoding: "utf8",
  });

  assert.equal(res.status, 0, `generator failed: ${res.stderr}`);

  const outputContent = readFileSync(join(outDir, "assignments.json"), "utf8");
  const output = JSON.parse(outputContent);

  assert.equal(output.schema_version, 1);
  assert.ok(output.assignments && typeof output.assignments === "object" && !Array.isArray(output.assignments), "assignments output must be a non-array object");
  assert.ok(output.assignments["test-valid"], "should have test-valid key");
  const a = output.assignments["test-valid"];
  assert.equal(a.id, "test-valid");
  assert.equal(a.title, "Test Valid Assignment"); // from valid-assignment.yml title
  assert.equal(a.state, "published"); // from valid-assignment.yml state
});
