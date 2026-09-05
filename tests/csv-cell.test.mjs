// Export CSV and the importer had never been introduced.
//
// `csvCell` prefixes an apostrophe onto anything a spreadsheet would execute.
// `coerceCell` did not strip it, so export -> edit -> import silently changed
// the value - on the round trip the Roster tab's own empty state now tells a
// lecturer to use when they want to add class groups.
//
// The pair is asserted here as INVERSES over a table, not described. The
// interesting half is what must NOT be undone: this system runs on rosters of
// Flemish students, and stripping every leading apostrophe would rename them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { csvCell, stripFormulaGuard } from "../lib/csv-cell.mjs";
import { coerceCell, rowsToRoster } from "../lib/roster-csv.mjs";

/** What Papa.parse hands the importer: quoting already resolved into the value. */
function unquote(cell) {
  if (!cell.startsWith('"')) return cell;
  return cell.slice(1, -1).replace(/""/g, '"');
}

const VALUES = [
  "3A",
  "Alice Example",
  "0123456",
  // The names the naive fix breaks. Not hypothetical: this is Limburg.
  "'t Hooft",
  "'s Jongers",
  "'t Seyen",
  // Genuinely dangerous leads, which is why the guard exists at all.
  "=SUM(A1:A9)",
  "+1 11 26 00 00",
  "-3B",
  "@student",
  // Things that exercise the quoting half rather than the guard.
  'Say "hello"',
  "Doe, John",
  "line\nbreak",
  // An apostrophe that is not a guard because what follows is ordinary.
  "'quoted'",
];

test("every value survives a write and a read back", () => {
  for (const value of VALUES) {
    const roundTripped = stripFormulaGuard(unquote(csvCell(value)));
    assert.equal(roundTripped, value, `lost on the round trip: ${JSON.stringify(value)}`);
  }
});

test("a Flemish surname is not renamed on the way in", () => {
  // THE MECHANISM, demonstrated. The exporter never guards these - `t` and `s`
  // are not formula leads - so an importer that stripped every leading
  // apostrophe would be deleting a character nobody added.
  for (const name of ["'t Hooft", "'s Jongers", "'t Seyen"]) {
    assert.equal(csvCell(name), name, "the exporter must leave it alone");
    assert.equal(stripFormulaGuard(name), name, "so the importer must too");
  }
});

test("a formula lead is guarded on the way out and unguarded on the way in", () => {
  for (const dangerous of ["=SUM(A1)", "+1", "-3B", "@x"]) {
    const written = csvCell(dangerous);
    assert.equal(written[0], "'", `${dangerous} must not reach a spreadsheet unguarded`);
    assert.equal(stripFormulaGuard(written), dangerous);
  }
});

test("the guard is re-applied on the next export, so protection is not spent", () => {
  // Round-tripping must not launder a dangerous value into an unguarded one.
  const once = csvCell("=cmd|'/c calc'!A1");
  const back = stripFormulaGuard(unquote(once));
  assert.equal(csvCell(back), once, "a second export guards it exactly as the first did");
});

test("coerceCell is the importer's half, on real columns", () => {
  assert.equal(coerceCell("class_group", "'-3B"), "-3B");
  assert.equal(coerceCell("full_name", "'t Hooft"), "'t Hooft");
  assert.equal(coerceCell("student_number", "'=0123"), "=0123");
  // Non-strings pass through untouched - Papa.parse hands numbers for some cells.
  assert.equal(coerceCell("github_id", 42), 42);
  assert.equal(coerceCell("active", "true"), true);
  // An empty cell is still absent, not an empty string.
  assert.equal(coerceCell("email", ""), undefined);
});

test("a whole import carries a guarded value through to the document", () => {
  const doc = rowsToRoster(
    [{ student_number: "0001", full_name: "'t Hooft", class_group: "'-3B" }],
    ["student_number", "full_name", "class_group"],
  );
  assert.deepEqual(doc.students[0], {
    student_number: "0001",
    full_name: "'t Hooft",
    class_group: "-3B",
  });
});

test("nothing re-implements the cell", () => {
  // One source of truth per cross-surface concern. Three byte-identical copies
  // existed - RosterTab.vue, AssignmentDetailView.vue, report.mjs - and the
  // reason the round trip was lossy is that no one of them owned the inverse.
  const files = [
    "frontend/src/components/RosterTab.vue",
    "frontend/src/views/AssignmentDetailView.vue",
    "report/report.mjs",
  ];
  for (const rel of files) {
    const src = readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
    assert.match(src, /csv-cell\.mjs/, `${rel} must import the shared cell`);
    assert.doesNotMatch(
      src,
      /\/\^\[=\+\\?-@\]\//,
      `${rel} spells the formula-lead rule itself again - import csvCell instead`,
    );
  }
});
