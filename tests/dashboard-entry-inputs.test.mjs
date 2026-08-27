// A synthetic object handed to a shared builder loses whatever the builder
// learns next.
//
// buildDashboardEntry(assignment, students) has two callers. report.mjs passes
// the REAL assignment YAML, so it gains every field automatically. The SPA's
// live refresh cannot: it only wants to update one entry, so it synthesises a
// `pseudoAssignment` from the entry already stored, field by field.
//
// That means any field the builder starts reading, and the pseudo object does
// not supply, comes out as null - and the refresh silently BLANKS it on the
// entry it was refreshing. It happened immediately: max_acceptances was added
// to the builder so the dashboard's share block could tell "live" from "cap
// reached", and the next live refresh would have erased it.
//
// Same family as DISPLAY_ONLY_ROW_FIELDS and the team-manifest rebuild - a
// document assembled field by field drops whatever nobody remembered to list.
// This pins the pair so the builder and its synthetic caller cannot drift.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildDashboardEntry } from "../lib/dashboard-aggregate.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

/** Fields buildDashboardEntry reads off its `assignment` argument. */
function fieldsBuilderReads() {
  const src = read("lib/dashboard-aggregate.mjs").replace(/^\s*\/\/.*$/gm, "");
  return [...new Set([...src.matchAll(/\bassignment\.([A-Za-z_][\w]*)/g)].map((m) => m[1]))].sort();
}

/** Fields the SPA's synthesised pseudoAssignment supplies. */
function fieldsPseudoSupplies() {
  const src = read("frontend/src/views/AssignmentDetailView.vue");
  const at = src.indexOf("const pseudoAssignment = {");
  assert.ok(at > 0, "syncDashboardAggregate must still build a pseudoAssignment");
  const body = src.slice(at, src.indexOf("}", at));
  return [...new Set([...body.matchAll(/^\s*([A-Za-z_][\w]*)\s*:/gm)].map((m) => m[1]))].sort();
}

test("the live refresh supplies every field the shared builder reads", () => {
  const reads = fieldsBuilderReads();
  const supplies = fieldsPseudoSupplies();

  assert.ok(reads.length >= 5, `expected the builder to read several fields, found ${reads.join(", ")}`);

  const missing = reads.filter((f) => !supplies.includes(f));
  assert.deepEqual(
    missing,
    [],
    "buildDashboardEntry reads these, and syncDashboardAggregate's pseudoAssignment does not supply them - " +
      "a live refresh would write them as null and blank them on the stored entry:\n  " +
      missing.join("\n  "),
  );
});

test("a field the pseudo object omits really would be blanked", () => {
  // The mechanism, demonstrated rather than asserted about. This is why the
  // test above is a coverage check and not a style preference.
  const full = buildDashboardEntry(
    { title: "T", state: "published", opens_at: null, deadline_at: null, timezone: "Europe/Brussels", max_acceptances: 50 },
    [],
  );
  assert.equal(full.max_acceptances, 50);

  const synthesisedWithoutIt = buildDashboardEntry(
    { title: full.title, state: full.state, opens_at: full.opens_at, deadline_at: full.deadline_at, timezone: full.timezone },
    [],
  );
  assert.equal(
    synthesisedWithoutIt.max_acceptances,
    null,
    "a caller that forgets the field writes null over a real value",
  );
});

test("the loaded assignment wins over the stored entry, and both are tried", () => {
  const src = read("frontend/src/views/AssignmentDetailView.vue");
  const at = src.indexOf("const pseudoAssignment = {");
  const body = src.slice(at, src.indexOf("}", at));
  assert.match(
    body,
    /max_acceptances:\s*assignment\.value\?\.max_acceptances\s*\?\?\s*existingEntry\.max_acceptances/,
    "the authoritative YAML should be preferred, with the stored entry as fallback",
  );
});
