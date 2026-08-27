// Every field report.mjs writes onto a student row must be declared in
// schemas/report.schema.json.
//
// Nothing validates a report at runtime - report.mjs builds the document and
// writes it, and only pages/scan.mjs ever loads the schema. So the schema is a
// contract that drifts in silence, in both directions, and this repo has been
// bitten by both:
//
//   - a field the schema declares and nothing writes: `preserved_sha` was null
//     on every report ever generated, because report.mjs read
//     `preservation.preserved_sha` while preserve.mjs writes `source_sha`.
//     Four features hung off it and all were dead.
//   - a field written and never declared: `claimed_email` had been on the
//     acceptance record since the claim shipped while acceptance.schema.json,
//     which is additionalProperties:false, forbade it outright.
//
// Found by sweeping, 2026-08-27: `lockdown_delay_seconds` was the live
// instance - added the same day, emitted by report.mjs, declared nowhere.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const schema = JSON.parse(readFileSync(join(root, "schemas", "report.schema.json"), "utf8"));
const src = readFileSync(join(root, "report", "report.mjs"), "utf8");

/** The declared properties of one student row. */
function studentProperties() {
  const students = schema?.properties?.students;
  const props = students?.items?.properties;
  assert.ok(props, "report.schema.json must declare students[].properties");
  return new Set(Object.keys(props));
}

/**
 * The keys report.mjs assembles onto a student row.
 *
 * Scoped to the object literal it returns for each student, so this does not
 * sweep up every local variable in the file. String literals are stripped
 * first: a document's own field names appear inside quoted CSV column lists in
 * this file, and counting those would make the test agree with itself.
 */
function emittedStudentKeys() {
  // Strip comments and string literals BEFORE walking braces, not after.
  // report.mjs's comments are long and quote code, so they carry braces of
  // their own - counting those ends the walk early and silently, which is how
  // the first version of this test lost half the row.
  //
  // Replaced with same-length padding so the anchor's index still lines up.
  const clean = src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length))
    .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length))
    .replace(/"[^"\n]*"|'[^'\n]*'|`[^`]*`/g, (m) => " ".repeat(m.length));

  // Anchored on `students.push({`, not on a field name: an anchor that is
  // itself one of the values under test goes quiet the moment it is renamed.
  const marker = "students.push(";
  const at = clean.indexOf(marker + "{");
  assert.ok(at > -1, "report.mjs no longer builds rows with students.push({");
  const open = at + marker.length;

  let depth = 0;
  let end = open;
  for (let i = open; i < clean.length; i++) {
    if (clean[i] === "{") depth++;
    else if (clean[i] === "}") {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  assert.ok(end > open, "could not find the end of the student row literal");
  const body = clean.slice(open, end);

  const keys = new Set();
  for (const m of body.matchAll(/^\s{4,}([a-z_][a-z0-9_]*)\s*:/gm)) keys.add(m[1]);
  return keys;
}

test("every student field report.mjs emits is declared in the schema", () => {
  const declared = studentProperties();
  const emitted = emittedStudentKeys();

  // Floor: a walk that stops matching looks exactly like a clean repo.
  assert.ok(emitted.size >= 10, `expected many emitted keys, parsed ${emitted.size}`);
  for (const known of ["preserved_sha", "lock_down_at", "lockdown_delay_seconds"]) {
    assert.ok(emitted.has(known), `${known} should have been parsed out of report.mjs`);
  }

  const undeclared = [...emitted].filter((k) => !declared.has(k)).sort();
  assert.deepEqual(
    undeclared,
    [],
    "report.mjs writes these onto a student row and the schema does not declare them:\n" +
      undeclared.map((k) => `  ${k}`).join("\n"),
  );
});

test("the two uncertainty measures stay distinct in the schema", () => {
  // They are opposite sides of the deadline, and the banner showed the wrong
  // one for as long as they were conflated. If the schema ever describes them
  // identically, the next reader will pick whichever comes first.
  const props = schema.properties.students.items.properties;
  const a = props.uncertainty_interval_seconds?.description ?? "";
  const b = props.lockdown_delay_seconds?.description ?? "";
  assert.ok(a && b, "both measures must be declared");
  assert.notEqual(a, b, "two different measurements need two different descriptions");
  assert.match(b, /NOT the same measure/i);
});
