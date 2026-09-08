// grading/<id>/summary.json has TWO writers, and the schema says so in its own
// description: `pxl-classroom grade` and the Admin Panel's read of check runs.
// That is the shape this repository has already paid for twice - two
// hand-written report-CSV column lists that were not the same list, and
// `diffRosters` forked into two implementations - so the file is worth a guard
// of its own.
//
// What is checked here is the pair, not one of them: that each writer commits
// only after validating, and that the document each builds is one the schema
// accepts. A test that asserted the fields one writer happens to emit would
// agree with that writer by construction, which is how the folded reporter env
// key survived (tests/provision-autograding.test.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validateAgainst } from "../lib/validate.mjs";
import { parseCheckRunScore } from "../lib/check-run-score.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

const SCHEMA = JSON.parse(read("schemas/grading-summary.schema.json"));

const envelope = (students, failed = []) => ({
  schema_version: 1,
  assignment_id: "autograde-drill",
  generated_at: "2026-09-08T11:20:00.000Z",
  graded_by: "tomcoolpxl",
  runner: "github_actions",
  students,
  failed,
});

test("both writers commit only after the schema accepts the document", () => {
  // The Admin Panel has validated since the schema existed; `pxl-classroom
  // grade` wrote it unchecked, so the schema's own "neither validated it" was
  // still true of one of them. A malformed summary fails quietly everywhere
  // else: the detail view joins it onto the report by login, so a bad row is a
  // blank Score column rather than an error.
  const spa = read("frontend/src/views/AssignmentDetailView.vue");
  const cli = read("cli/src/commands/grade.mjs");

  for (const [name, src] of [["the Admin Panel", spa], ["pxl-classroom grade", cli]]) {
    assert.match(
      src,
      /validateAgainst\(\s*['"]grading-summary['"]/,
      `${name} must validate the summary against its schema before committing it`,
    );
  }

  // And the check has to sit BEFORE the write, or it is decoration.
  const at = (src, needle) => src.indexOf(needle);
  assert.ok(
    at(cli, "validateAgainst(\"grading-summary\"") < at(cli, "grading/${opts.assignment}/summary.json"),
    "pxl-classroom grade validates before it commits, not after",
  );
});

test("a row carrying only what the local runners know is accepted", () => {
  // `pxl-classroom grade --runner docker` has no check run to describe, so its
  // rows carry no ci_* fields. That is a legitimately sparser row, not a
  // defect, and the schema has to keep accepting it.
  const res = validateAgainst("grading-summary", envelope([
    { login: "ada", earned_points: 5, total_points: 10, graded_at: "2026-09-08T11:20:00.000Z" },
  ]));
  assert.ok(res.valid, JSON.stringify(res.errors));
});

test("a row from a check run carries where the number came from", () => {
  const res = validateAgainst("grading-summary", envelope([
    {
      login: "ada",
      earned_points: 5,
      total_points: 10,
      graded_at: "2026-09-08T11:20:00.000Z",
      ci_status: "failure",
      ci_run_url: "https://github.com/o/r/actions/runs/1",
      score_source: "annotation-json",
    },
  ]));
  assert.ok(res.valid, JSON.stringify(res.errors));
});

test("every source a RECORDABLE parse can report is one the schema stores", () => {
  // Run the parser, do not grep it: a source read out of the source text
  // includes `not-run`, which arrives with `graded: false` and is refused by
  // both callers before it can reach this document. The invariant is about what
  // gets WRITTEN - a graded result whose source the schema does not accept is a
  // grade that cannot be recorded, and the write would fail at the lecturer.
  const annotation = (message) => [{ annotation_level: "notice", title: "", message }];
  const cases = [
    ["reporter JSON", { conclusion: "failure" }, annotation('{"totalPoints":5,"maxPoints":10}')],
    ["human-readable points", { conclusion: "success" }, annotation("Points 7/10")],
    ["green, no annotations", { conclusion: "success" }, []],
    ["red, no annotations", { conclusion: "failure" }, []],
    ["skipped", { conclusion: "skipped" }, []],
    ["still running", { conclusion: null }, []],
  ];

  const allowed = new Set(SCHEMA.properties.students.items.properties.score_source.enum);
  const seenGraded = new Set();
  for (const [label, run, annotations] of cases) {
    const parsed = parseCheckRunScore(run, annotations, 10);
    if (!parsed.graded) continue;          // both callers stop here - never written
    seenGraded.add(parsed.source);
    assert.ok(
      allowed.has(parsed.source),
      `${label}: parseCheckRunScore reports a recordable score_source "${parsed.source}" the schema refuses`,
    );
  }
  // The guard must not pass by having exercised nothing.
  assert.ok(seenGraded.size >= 2, `expected several recordable sources, saw ${[...seenGraded]}`);
});

test("a conclusion-sourced score is a DIFFERENT fact, and the schema keeps it", () => {
  // Measured on pxl-classroom-testbed 2026-09-08: a grading job killed at
  // Docker-build time - before `Checkout code` - concludes `failure` with no
  // score annotation, and parseCheckRunScore then reports earned 0 of the
  // fallback total with `source: "conclusion"`. The numbers are identical to a
  // real 0/10 that the reporter measured; `score_source` is the only thing that
  // separates them, which is why it is stored.
  const res = validateAgainst("grading-summary", envelope([
    { login: "ada", earned_points: 0, total_points: 10, score_source: "conclusion" },
    { login: "bo", earned_points: 0, total_points: 10, score_source: "annotation-json" },
  ]));
  assert.ok(res.valid, JSON.stringify(res.errors));
  assert.notEqual(res.valid && "conclusion", "annotation-json", "and they are not the same value");
});

test("an unknown field is refused rather than stored", () => {
  const res = validateAgainst("grading-summary", envelope([
    { login: "ada", earned_points: 5, total_points: 10, ci_conclusion: "failure" },
  ]));
  assert.equal(res.valid, false, "additionalProperties: false is what makes a typo visible");
});
