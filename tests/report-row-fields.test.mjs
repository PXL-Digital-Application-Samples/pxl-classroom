// A report row field that does not exist compares as a constant.
//
// `reports/<id>.json` student rows are `additionalProperties: false`, so the
// schema is the complete list of what a row can carry. The SPA read one that is
// not on it:
//
//     s.repo_name || s.acceptance_state === 'accepted' || s.status !== 'no-submission'
//
// The field is `submission_status`. `s.status` was therefore `undefined` on
// every row, `undefined !== 'no-submission'` is ALWAYS TRUE, and the `||` chain
// short-circuited for the whole cohort - so `acceptedStudentsCount` counted
// every student on the roster, including the ones with
// `acceptance_state: 'not-accepted'`. The capacity alert fired on cohorts
// nowhere near their cap and the invitation share block reported "cap reached"
// over an empty one, while the SAME FILE wrote the correct number to
// reports/dashboard.json through buildDashboardEntry.
//
// Only COMPARISONS are swept, not every property read. `s.name || s.full_name`
// is a dead fallback and harmless; `s.name === x` is a branch that can never be
// taken. The first is a tidy-up, the second is a bug, and a guard that reported
// both would be argued with until it was switched off.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(root, "frontend", "src");

const reportSchema = JSON.parse(readFileSync(join(root, "schemas", "report.schema.json"), "utf8"));
const ROW_PROPS = new Set(Object.keys(reportSchema.properties.students.items.properties));

/**
 * Fields the SPA joins onto a row for DISPLAY and strips before storing. The
 * view names them in DISPLAY_ONLY_ROW_FIELDS for exactly this reason, and they
 * are read from the same `s`.
 */
const DISPLAY_ONLY = ["earned_points", "total_points", "ci_status", "ci_run_url", "graded_at"];

/** Live-read feedback PR state, joined the same way. */
const FEEDBACK_PR = [
  "feedback_pr_number", "feedback_pr_url", "feedback_pr_state",
  "feedback_pr_draft", "feedback_pr_merged", "feedback_pr_review_comments",
];

const ALLOWED = new Set([...ROW_PROPS, ...DISPLAY_ONLY, ...FEEDBACK_PR]);

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (e.endsWith(".vue") || e.endsWith(".js")) out.push(p);
  }
  return out;
}

test("the schema still declares the fields this sweep rests on", () => {
  // If report.schema.json ever stops being a closed list, this test proves
  // nothing and should be reconsidered rather than left passing.
  assert.equal(
    reportSchema.properties.students.items.additionalProperties,
    false,
    "report student rows must stay additionalProperties: false for this to be decidable",
  );
  for (const must of ["submission_status", "acceptance_state", "github_login", "repo_name"]) {
    assert.ok(ROW_PROPS.has(must), `${must} must be a declared row field`);
  }
  assert.ok(!ROW_PROPS.has("status"), "`status` is not a row field - that is the whole point");
});

test("no report row is compared on a field the schema does not declare", () => {
  const offenders = [];
  // `s.<field> === '…'` / `!== '…'`, either way round. `s` is the row variable
  // throughout these files; anything else named `s` is a string or a slug, and
  // a comparison against a quoted literal on a property of it is the shape.
  const re = /\bs\.([a-z][a-z0-9_]*)\s*[=!]==\s*['"]|['"]\s*[=!]==\s*\bs\.([a-z][a-z0-9_]*)/g;

  for (const file of walk(SRC)) {
    const rel = relative(root, file).replace(/\\/g, "/");
    const src = readFileSync(file, "utf8");
    src.split("\n").forEach((line, i) => {
      if (/^\s*(\/\/|\*|<!--)/.test(line.trim())) return; // a comment quoting the bug
      for (const m of line.matchAll(re)) {
        const field = m[1] ?? m[2];
        if (ALLOWED.has(field)) continue;
        offenders.push(`${rel}:${i + 1} compares s.${field}, which report.schema.json does not declare`);
      }
    });
  }

  assert.deepEqual(
    offenders,
    [],
    "A row field that does not exist is `undefined`, so a comparison against it " +
      "is a constant - always false for ===, always TRUE for !==. Check the " +
      "spelling against schemas/report.schema.json:\n  " + offenders.join("\n  "),
  );
});

test("the accepted count is the shared one, not a second predicate", () => {
  // The view imports lib/dashboard-aggregate.mjs and used it to WRITE the
  // dashboard's accepted count while showing a different, broken one on screen.
  const view = readFileSync(join(SRC, "views", "AssignmentDetailView.vue"), "utf8");
  assert.match(view, /countAccepted\(report\.value\?\.students\)/, "the view must use the shared count");
  const lib = readFileSync(join(root, "lib", "dashboard-aggregate.mjs"), "utf8");
  assert.match(lib, /export function countAccepted/, "and the shared count must be exported");
  assert.match(lib, /accepted: countAccepted\(students\)/, "and buildDashboardEntry must use it too, or they can diverge again");
});

test("clipboard copying goes through lib/clipboard.js", () => {
  // The helper exists because navigator.clipboard REJECTS on an unfocused
  // document - the failure that made the sign-in button report "Copied" over an
  // empty clipboard. Six call sites called the API directly; they reported
  // failure honestly and simply failed where the helper succeeds.
  const offenders = [];
  for (const file of walk(SRC)) {
    const rel = relative(root, file).replace(/\\/g, "/");
    if (rel.endsWith("lib/clipboard.js")) continue;
    readFileSync(file, "utf8").split("\n").forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line.trim())) return;
      if (/navigator\.clipboard/.test(line)) {
        offenders.push(`${rel}:${i + 1} calls navigator.clipboard directly - use copyText from lib/clipboard.js`);
      }
    });
  }
  assert.deepEqual(offenders, [], offenders.join("\n"));
});
