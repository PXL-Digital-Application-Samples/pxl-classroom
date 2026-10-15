// scripts/build-manual.mjs fills what deployment.yml decides into the manual.
// The form's answer reads "confirm their PXL email address" (lib/claim.js,
// from deployment.yml); the manual quoted it as "institutional", sending a
// lecturer looking for a control that is not there (help audit, 2026-10-15).
// Writing "PXL" into MANUAL.md instead would put an institution in a file a
// fork does not edit.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { fillPlaceholders } from "../scripts/build-manual.mjs";
import { INSTITUTION_SHORT } from "../lib/deployment.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("the institution comes from deployment.yml, and an unknown placeholder fails the build", () => {
  assert.equal(fillPlaceholders("confirm their {{institution_short}} email address"), `confirm their ${INSTITUTION_SHORT} email address`);
  assert.throws(() => fillPlaceholders("{{nope}}"), /names \{\{nope\}\}/);
});

test("MANUAL.md names only placeholders the build knows, and quotes the form's own answer", () => {
  const filled = fillPlaceholders(readFileSync(join(root, "MANUAL.md"), "utf8"));
  assert.doesNotMatch(filled, /\{\{/);
  assert.match(filled, new RegExp(`confirm their ${INSTITUTION_SHORT} email address`));
  assert.doesNotMatch(filled, /institutional email address/, "the form never says that");
});
