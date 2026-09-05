// Two surfaces exported the same report and neither knew what the other wrote.
//
// `report.mjs` and the Assignment detail view each kept a 35-column header
// list, and they were not the same 35. The SPA dropped `claimed_email`,
// `claim_verified`, `claim_domain_allowed`, `archive_repo` and `archive_ref` -
// declared report-row fields, and ARCHITECTURE said the claim fields reach
// "the CSV export", which was true of the nightly file and false of the button
// a lecturer presses. Ten more row fields were in neither list, and nothing
// recorded that as a decision.
//
// The guard is EXHAUSTIVE rather than a comparison: every student-row field the
// schema declares must be either exported or listed as deliberately excluded,
// with a reason. A field added to the schema fails here until someone says
// which it is - the check two hand-maintained lists could never give.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  REPORT_ROW_COLUMNS,
  RENDER_JOIN_COLUMNS,
  EXCLUDED_ROW_COLUMNS,
} from "../lib/report-csv.mjs";

const root = new URL("..", import.meta.url);
const read = (rel) => readFileSync(new URL(rel, root), "utf8");

const SCHEMA = JSON.parse(read("schemas/report.schema.json"));
const ROW_FIELDS = Object.keys(SCHEMA.properties.students.items.properties);

test("every declared student-row field is either exported or explicitly excluded", () => {
  const excluded = Object.keys(EXCLUDED_ROW_COLUMNS);
  const accounted = new Set([...REPORT_ROW_COLUMNS, ...excluded]);

  const unclaimed = ROW_FIELDS.filter((f) => !accounted.has(f));
  assert.deepEqual(
    unclaimed,
    [],
    "these report-row fields are in neither the CSV nor the excluded list - " +
      "add them to REPORT_ROW_COLUMNS or say in EXCLUDED_ROW_COLUMNS why not:\n  " +
      unclaimed.join("\n  "),
  );
});

test("nothing is both exported and excluded, and neither list invents a field", () => {
  const excluded = Object.keys(EXCLUDED_ROW_COLUMNS);

  const both = REPORT_ROW_COLUMNS.filter((c) => excluded.includes(c));
  assert.deepEqual(both, [], "a column cannot be exported and excluded at once");

  const undeclared = REPORT_ROW_COLUMNS.filter((c) => !ROW_FIELDS.includes(c));
  assert.deepEqual(
    undeclared,
    [],
    "a column the report schema does not declare is empty on every row - " +
      "the same defect as a misspelled field name",
  );

  const staleExclusions = excluded.filter((c) => !ROW_FIELDS.includes(c));
  assert.deepEqual(staleExclusions, [], "excluding a field the schema no longer has explains nothing");
});

test("every exclusion carries a reason", () => {
  for (const [field, why] of Object.entries(EXCLUDED_ROW_COLUMNS)) {
    assert.equal(typeof why, "string");
    assert.ok(why.trim().length > 10, `${field} is excluded with no usable reason`);
  }
});

test("the join columns are NOT row fields, which is why only the SPA has them", () => {
  // If one of these ever became a report-row field, the nightly should write it
  // and this list is the wrong home. That is a real possibility - grades were
  // very nearly put on the row - so it is asserted rather than assumed.
  const onTheRow = RENDER_JOIN_COLUMNS.filter((c) => ROW_FIELDS.includes(c));
  assert.deepEqual(
    onTheRow,
    [],
    "these are joined at render but the schema now declares them on a row - " +
      "move them to REPORT_ROW_COLUMNS so the nightly exports them too",
  );
});

test("the SPA writes every column the nightly does", () => {
  // The defect itself, stated as an assertion. The detail view's export is
  // built as [...REPORT_ROW_COLUMNS, ...RENDER_JOIN_COLUMNS], so this holds by
  // construction - and the next test is what stops it being rebuilt by hand.
  const spa = [...REPORT_ROW_COLUMNS, ...RENDER_JOIN_COLUMNS];
  const missing = REPORT_ROW_COLUMNS.filter((c) => !spa.includes(c));
  assert.deepEqual(missing, []);
  assert.equal(new Set(spa).size, spa.length, "a duplicated column would be written twice");
});

test("neither surface spells a header list of its own", () => {
  // ONE SOURCE OF TRUTH. Both files held a literal list; the reason they
  // disagreed for months is that nothing could see both at once.
  for (const rel of ["report/report.mjs", "frontend/src/views/AssignmentDetailView.vue"]) {
    const src = read(rel);
    assert.match(src, /report-csv\.mjs/, `${rel} must import the shared columns`);
    assert.doesNotMatch(
      src,
      /["']last_on_time_observed_at["']/,
      `${rel} is spelling report columns again - import REPORT_ROW_COLUMNS instead`,
    );
  }
});

test("the three commit-evidence columns a dispute needs are exported", () => {
  // Gathered by collect.mjs on every scheduled run for months and in neither
  // export. `commit_date` especially: it is the commit's OWN timestamp, the one
  // deadline classification compares against, as opposed to when the collector
  // happened to look.
  for (const c of ["commit_date", "author_name", "author_email"]) {
    assert.ok(REPORT_ROW_COLUMNS.includes(c), `${c} should be in the CSV`);
  }
});
