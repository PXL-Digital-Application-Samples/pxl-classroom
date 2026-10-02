// The hub run's name is how the student's page finds its own run
// (lib/acceptance-run-name.mjs). Spelled in YAML that cannot import the lib,
// so the workflow's expression is rebuilt from the lib and compared.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { RUN_NAME_PREFIX, acceptanceRunName } from "../lib/acceptance-run-name.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const handler = parse(readFileSync(join(root, ".github", "workflows", "acceptance-handler.yml"), "utf8"));

test("the workflow names its run exactly as the page will look for it", () => {
  const expected = acceptanceRunName(
    "${{ github.event.client_payload.broker_repo }}",
    "${{ github.event.client_payload.issue_number }}",
  );
  assert.equal(handler["run-name"], expected);
  assert.ok(expected.startsWith(RUN_NAME_PREFIX));
});

test("the name is built from public values only", () => {
  // The hub's run list is public. The broker repository and the issue number
  // are already public on the student's own issue; nothing else may go here.
  const refs = [...String(handler["run-name"]).matchAll(/\$\{\{\s*([^}]+?)\s*\}\}/g)].map((m) => m[1]);
  assert.deepEqual(refs.sort(), ["github.event.client_payload.broker_repo", "github.event.client_payload.issue_number"]);
});

test("a run name is what the page will match", () => {
  assert.equal(acceptanceRunName("PXL-2TIN-DevOps-2627/broker-groepsindeling", 66), "acceptance PXL-2TIN-DevOps-2627/broker-groepsindeling#66");
});
