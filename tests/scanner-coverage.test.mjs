// Every field in the data model that carries a person must be something the
// privacy scanner can recognise.
//
// pages/scan.mjs is the publish gate: it refuses to ship a generated Pages
// artefact containing personal data. It has two kinds of rule - field-NAME
// rules that match a JSON key, and PUBLIC_TEXT_RULES that match CONTENT
// anywhere. Between them they have to cover the model, and the failure mode is
// silent in both directions:
//
//   - a rule naming a field that does not exist can never fire. `claim_token`
//     was one for months, vestigial from a design that was never built.
//   - a field that exists and no rule names is simply not checked. Found by
//     sweeping, 2026-08-27: `author_name` is a student's REAL NAME, lifted
//     from the git author of their commits and propagated into reports, and it
//     was guarded by nothing. Unlike an address, no content rule can recognise
//     an arbitrary human name, so it had no value guard either.
//
// This test walks the schemas rather than a hand-kept list, so a new personal
// field arrives here as a failure rather than as a gap nobody noticed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { PUBLIC_TEXT_RULES } from "../lib/public-text.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

/** Field names that identify or describe a PERSON, wherever they appear. */
const PERSONAL = [
  "email",
  "claimed_email",
  "author_email",
  "author_name",
  "full_name",
  "display_name",
  "student_number",
  "student_id",
  "class_group",
  "institutional_id",
];

const scanSrc = readFileSync(join(root, "pages", "scan.mjs"), "utf8");

/** Every field name any field-name rule in scan.mjs matches. */
function guardedFieldNames() {
  const names = new Set();
  // Rules are written as /"(a|b|c)"\s*:/g
  for (const m of scanSrc.matchAll(/re:\s*\/"\(([^)]+)\)"/g)) {
    for (const n of m[1].split("|")) names.add(n.trim());
  }
  return names;
}

test("every personal field that exists in the schemas is guarded by name", () => {
  const schemaDir = join(root, "schemas");
  const allSchemas = readdirSync(schemaDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => readFileSync(join(schemaDir, f), "utf8"))
    .join("\n");

  const guarded = guardedFieldNames();
  const unguarded = PERSONAL.filter(
    (f) => allSchemas.includes(`"${f}"`) && !guarded.has(f),
  );

  assert.deepEqual(
    unguarded,
    [],
    "these carry a person, exist in the data model, and no scan.mjs rule names them:\n" +
      unguarded.map((f) => `  ${f}`).join("\n"),
  );
});

test("author_name specifically - the one a content rule can never catch", () => {
  // An address has a shape, so `email-address` in PUBLIC_TEXT_RULES catches
  // any address that reaches a public artefact whatever field it sits in. A
  // human name has no shape at all, so the field guard is the only guard there
  // will ever be for it.
  assert.ok(guardedFieldNames().has("author_name"));

  const emailRule = PUBLIC_TEXT_RULES.find((r) => r.name === "email-address");
  assert.ok(emailRule, "the email-address content rule must still exist");
  // And it really does catch a value, not just a field name.
  const re = new RegExp(emailRule.re.source, emailRule.re.flags.replace("g", ""));
  assert.ok(re.test("contact alice@student.pxl.be please"));
  assert.ok(!re.test("Tom Cool"), "which is exactly why a name needs its own rule");
});

test("the scanner's rules are readable by this test at all", () => {
  // A floor, because a walk that silently stops matching looks exactly like a
  // clean repo - the trap tests/fixture-options.test.mjs names.
  const guarded = guardedFieldNames();
  assert.ok(
    guarded.size >= 8,
    `expected the scanner to name several fields, parsed ${guarded.size}`,
  );
  for (const known of ["full_name", "student_number", "claim_verified"]) {
    assert.ok(guarded.has(known), `${known} should have been parsed out of scan.mjs`);
  }
});
