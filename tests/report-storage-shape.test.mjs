// The report on screen is not the report on disk.
//
// `reports/<id>.json` is written by report.mjs on the hub. The SPA also writes
// it, from the Live Refresh button - and the object it holds has been augmented
// for display: grades from grading/<id>/summary.json are JOINED ONTO the
// student rows at load time (earned_points, total_points, ci_status, ci_run_url,
// graded_at), and a live refresh sets ci_status on rows itself.
//
// report.schema.json's student items are `additionalProperties: false` and
// permit none of those five. So the live refresh was committing a report that
// fails its own schema - and, worse than the schema violation, it put
// `earned_points` into real control repos while nothing in the backend writes
// it. That is exactly how earned_points, preserved_sha and lockdown_at each
// became a field the fixtures believed in and no backend emitted; the next
// nightly report.mjs run overwrites the file and the values vanish.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { validateAgainst } from "../lib/validate.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const VIEW = join(root, "frontend", "src", "views", "AssignmentDetailView.vue");

/** The five fields grading joins onto a row. */
const JOINED = ["earned_points", "total_points", "ci_status", "ci_run_url", "graded_at"];

function baseReport() {
  return {
    schema_version: 1,
    assignment_id: "2627-netadv",
    generated_at: "2026-08-27T10:00:00.000Z",
    teams: [{ team_slug: "alpha", team_name: "Alpha", members: ["s1"] }],
    students: [
      { github_login: "s1", submission_status: "on-time", team_slug: "alpha" },
      { github_login: "s2", submission_status: "no-submission" },
    ],
  };
}

test("a report carrying the display join is INVALID - the bug, stated", () => {
  const doc = baseReport();
  Object.assign(doc.students[0], {
    earned_points: 15,
    total_points: 20,
    ci_status: "success",
    ci_run_url: "https://github.com/o/r/actions/runs/1",
    graded_at: "2026-08-27T10:00:00.000Z",
  });

  const { valid, errors } = validateAgainst("report", doc);
  assert.ok(!valid, "if this ever passes, report.schema.json stopped being strict about student rows");
  const rejected = errors
    .filter((e) => e.keyword === "additionalProperties")
    .map((e) => e.params.additionalProperty);
  for (const f of JOINED) {
    assert.ok(rejected.includes(f), `${f} must be rejected by the schema`);
  }
});

test("the same report is valid once the join is stripped", () => {
  const doc = baseReport();
  Object.assign(doc.students[0], { earned_points: 15, total_points: 20, ci_status: "success" });
  Object.assign(doc.teams[0], { earned_points: 15, ci_status: "success" });

  for (const row of doc.students) for (const f of JOINED) delete row[f];
  for (const t of doc.teams) for (const f of JOINED) delete t[f];

  const { valid, errors } = validateAgainst("report", doc);
  assert.ok(valid, JSON.stringify(errors));
});

test("stripping heals a report an earlier live refresh already polluted", () => {
  // The fields are removed whether this session added them or a previous one
  // did, so a control repo carrying the old damage repairs itself on the next
  // refresh rather than being refused for ever.
  const stored = baseReport();
  stored.students[1].earned_points = 0;
  stored.students[1].ci_status = "failure";
  assert.ok(!validateAgainst("report", stored).valid, "the polluted document starts invalid");

  for (const row of stored.students) for (const f of JOINED) delete row[f];
  assert.ok(validateAgainst("report", stored).valid, "and is storable after stripping");
});

test("the view strips and validates before it commits the report", () => {
  const src = readFileSync(VIEW, "utf8");

  // One list of display-only fields, and it covers every field the join sets.
  const listMatch = src.match(/const DISPLAY_ONLY_ROW_FIELDS = \[([\s\S]*?)\]/);
  assert.ok(listMatch, "DISPLAY_ONLY_ROW_FIELDS must exist");
  for (const f of JOINED) {
    assert.ok(listMatch[1].includes(`'${f}'`), `DISPLAY_ONLY_ROW_FIELDS must list ${f}`);
  }

  // The live-refresh write must go through the stripper, and validate first.
  const at = src.indexOf("`Live refresh: ${props.assignmentId}`");
  assert.ok(at > 0, "the live refresh commit should still be there");
  const window = src.slice(Math.max(0, at - 1400), at);

  assert.match(window, /reportForStorage\(/, "the live refresh must strip before storing");
  assert.match(window, /validateAgainst\('report'/, "and validate what it is about to write");
  assert.ok(
    !/JSON\.stringify\(report\.value, null, 2\)/.test(window),
    "committing report.value verbatim is the bug this test exists for",
  );
});

test("every field the grade join assigns is in the strip list", () => {
  // The guard that keeps this from rotting: if mergeGradesIntoReport learns to
  // set a sixth field, it must be declared display-only too, or the report goes
  // back to failing its schema.
  const src = readFileSync(VIEW, "utf8");
  const fn = src.slice(src.indexOf("function mergeGradesIntoReport"));
  const body = fn.slice(0, fn.indexOf("\nasync function "));

  const assigned = new Set(
    [...body.matchAll(/^\s*(?:s|team)\.(\w+)\s*=/gm)].map((m) => m[1]),
  );
  assert.ok(assigned.size > 0, "expected the join to assign fields");

  const listMatch = src.match(/const DISPLAY_ONLY_ROW_FIELDS = \[([\s\S]*?)\]/);
  for (const f of assigned) {
    assert.ok(
      listMatch[1].includes(`'${f}'`),
      `mergeGradesIntoReport assigns "${f}" but it is not in DISPLAY_ONLY_ROW_FIELDS - it would be stored`,
    );
  }
});
