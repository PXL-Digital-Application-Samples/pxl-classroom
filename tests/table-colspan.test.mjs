// A hand-maintained count of a conditionally rendered thing drifts, and the
// drift is invisible.
//
// `AssignmentDetailView.vue` renders the student table's empty-state cell with
// `:colspan="tableColumnCount"`, and that computed is arithmetic: a literal for
// the always-present columns plus one term per optional one. It had already
// been wrong once - the comment above it says so, naming the two grading
// columns that disagreed - and when that was fixed the fix counted the grading
// columns and stopped looking. `isGroupAssignment` renders a Team column and
// was never a term, so every group assignment with no rows drew its empty cell
// one column narrow, for as long as the "fix" had been in place.
//
// The lesson is not about colspan. It is the shape this repo keeps paying for:
// TWO PLACES THAT MUST AGREE, WITH NO MECHANISM MAKING THEM AGREE. The remedy
// that works is not a more careful count, it is deriving one side from the
// other - so this test reads the columns out of the template and rebuilds the
// expression the computed should be.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = readFileSync(join(root, "frontend", "src", "views", "AssignmentDetailView.vue"), "utf8");

/**
 * The student table's header block, found by a cell only it has. Anchoring on
 * "the first <thead>" would silently follow a reorder into the wrong table -
 * and an absence assertion against the wrong table passes vacuously.
 */
function studentThead(src) {
  const anchor = src.indexOf("sortBy('github_login')");
  assert.ok(anchor > 0, "the student table must still sort by github_login - update this anchor with it");
  const open = src.lastIndexOf("<thead>", anchor);
  const close = src.indexOf("</thead>", anchor);
  assert.ok(open > 0 && close > open, "could not isolate the student table's <thead>");
  return src.slice(open, close);
}

/** Every `<th …>` in a block, with its `v-if` expression when it has one. */
function columns(block) {
  return [...block.matchAll(/<th\b([^>]*)>/g)].map((m) => ({
    conditional: /v-if="([^"]*)"/.exec(m[1])?.[1] ?? null,
  }));
}

test("the empty-state colspan matches the columns the table actually renders", () => {
  const cols = columns(studentThead(SRC));

  // A floor, so a regex that stopped matching cannot pass as a clean table.
  assert.ok(cols.length >= 8, `only ${cols.length} <th> found - the parse has broken, not the table`);

  const always = cols.filter((c) => !c.conditional).length;
  const conditionals = [...new Set(cols.map((c) => c.conditional).filter(Boolean))];
  assert.ok(conditionals.length >= 3, "the optional columns are gone - update this guard with them");

  const from = SRC.indexOf("const tableColumnCount = computed(");
  assert.ok(from > 0, "tableColumnCount must still exist");
  const expr = SRC.slice(from, SRC.indexOf("\n\n", from));

  // The literal for the unconditional columns.
  const base = Number(/computed\(\(\) =>\s*(\d+)\s*\+/.exec(expr)?.[1]);
  assert.equal(
    base,
    always,
    `tableColumnCount starts at ${base} but the table renders ${always} unconditional columns`,
  );

  // One term per optional column, and no term without a column.
  for (const cond of conditionals) {
    assert.ok(
      expr.includes(`(${cond}.value ? 1 : 0)`),
      `the "${cond}" column is rendered but not counted - the empty-state cell is short by one`,
    );
  }
  const terms = (expr.match(/\?\s*1\s*:\s*0/g) || []).length;
  assert.equal(
    terms,
    conditionals.length,
    `tableColumnCount has ${terms} optional terms for ${conditionals.length} optional columns`,
  );
});

test("every column the table renders has a matching body cell", () => {
  // The other half of the same disagreement: a `<th v-if="x">` whose `<td>` is
  // gated on something else, or on nothing, shifts every cell after it on the
  // rows where the two conditions differ - and it renders perfectly, just
  // wrong, which is why nobody sees it.
  const conditionals = [...new Set(columns(studentThead(SRC)).map((c) => c.conditional).filter(Boolean))];
  const bodyFrom = SRC.indexOf('<tr v-for="s in filteredStudents"');
  assert.ok(bodyFrom > 0, "the student rows must still be v-for'd over filteredStudents");
  const body = SRC.slice(bodyFrom, SRC.indexOf("</tbody>", bodyFrom));

  for (const cond of conditionals) {
    assert.ok(
      new RegExp(`<td[^>]*v-if="${cond.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`).test(body),
      `the "${cond}" header has no <td> gated on the same condition`,
    );
  }
});

test("an uncorroborated claim is reported as unknown, never as a failure", () => {
  // `claim_verified` is false for every student who has not verified an
  // institutional address on their GitHub account - honest ones included - and
  // it is the BROWSER's own assertion either way, so `true` is corroboration
  // rather than proof. DESIGN.md §4 gives the exact word for the rest:
  // `.dot-neutral` is "unknown. NOT an error: an empty population is not a
  // failure." A danger dot there would turn absence of evidence into a finding,
  // which is the mistake that produced "no invitation waiting".
  const src = readFileSync(join(root, "frontend", "src", "views", "AssignmentDetailView.vue"), "utf8");
  const from = src.indexOf("function claimNote(");
  assert.ok(from > 0, "claimNote must still decide this - update this guard with it");
  const fn = src.slice(from, src.indexOf("\n}", from));

  assert.match(fn, /dot-neutral/, "the uncorroborated case needs DESIGN.md's word for unknown");
  assert.ok(
    !/dot-danger|text-danger/.test(fn),
    "an uncorroborated address is not an error state, and DESIGN.md reserves danger for 'something did not happen'",
  );

  // The domain miss IS a positive finding - recorded rather than refused under
  // `open` - and must outrank the corroboration note, because it is the one
  // thing in the cell a lecturer has to act on.
  assert.match(fn, /dot-warning/);
  const offDomain = fn.indexOf("claim_domain_allowed === false");
  const verified = fn.indexOf("claim_verified === true");
  assert.ok(offDomain > 0 && verified > 0, "both states must still be decided here");
  assert.ok(offDomain < verified, "an off-domain address must be reported ahead of the corroboration note");

  // Every dot it can return has to be one DESIGN.md §4 actually declares.
  const declared = new Set(["dot-success", "dot-warning", "dot-danger", "dot-neutral", "dot-info"]);
  for (const dot of [...fn.matchAll(/dot: '([a-z-]+)'/g)].map((m) => m[1])) {
    assert.ok(declared.has(dot), `${dot} is not in the DESIGN.md §4 status-dot set`);
  }
});

test("the claimed-address cell uses the data-table status vocabulary", () => {
  // DESIGN.md §1 asks for `.status-indicator` with a `.status-dot` in data
  // tables rather than ad-hoc coloured text, and one indicator per row rather
  // than a stack of notes.
  const src = readFileSync(join(root, "frontend", "src", "views", "AssignmentDetailView.vue"), "utf8");
  const at = src.indexOf('<td v-if="hasClaimedEmails"');
  const cell = src.slice(at, src.indexOf("</td>", at));
  assert.ok(cell.length > 100, "the claimed-address cell must still exist");
  assert.match(cell, /class="status-indicator"/);
  assert.match(cell, /class="status-dot"/);
  assert.equal(
    (cell.match(/status-indicator/g) || []).length,
    1,
    "one indicator per row - a stack of notes is the pill-badge noise DESIGN.md §1 rules out",
  );
});

test("the column only appears where a claim was collected", () => {
  // An always-present column that is empty for most assignments teaches a
  // lecturer to skip it, which costs more than not having it.
  assert.match(
    SRC,
    /const hasClaimedEmails = computed\(\(\) =>\s*\(report\.value\?\.students \|\| \[\]\)\.some\(s => !!s\.claimed_email\)\)/,
    "gate the column on a claim actually having been recorded",
  );
});
