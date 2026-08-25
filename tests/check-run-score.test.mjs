// PXL Classroom - lib/check-run-score.mjs + lib/check-run-annotations.mjs
//
// The fixtures below are not invented. They are the shapes a live
// `classroom-resources/autograding-grading-reporter@v1` run returned on
// 2026-08-25, which is the whole point: every existing test in the repo fed
// the parser a `output.summary` full of markdown that GitHub Actions never
// produces, so all of them passed while the feature returned the wrong grade
// for every partially-correct submission.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parseCheckRunScore, pickAutogradeCheckRun } from "../lib/check-run-score.mjs";
import { fetchCheckRunAnnotations } from "../lib/check-run-annotations.mjs";

// What GitHub actually returns for an Actions-created check run.
const LIVE_RUN = {
  name: "run-autograding-tests",
  conclusion: "failure",
  html_url: "https://github.com/Org/repo/runs/71487050244",
  output: { title: null, summary: null, text: null, annotations_count: 4 },
};

const LIVE_ANNOTATIONS = [
  {
    annotation_level: "warning",
    title: "",
    message: "Node.js 20 actions are deprecated. …",
    path: ".github",
  },
  { annotation_level: "failure", title: "", message: "Some tests errored.", path: ".github" },
  {
    annotation_level: "notice",
    title: "Autograding report",
    message: '{"totalPoints":12,"maxPoints":20}',
    path: ".github",
  },
  {
    annotation_level: "notice",
    title: "Autograding complete",
    message: "Points 12/20",
    path: ".github",
  },
];

// -----------------------------------------------------------------------------
// The bug this module exists for
// -----------------------------------------------------------------------------

test("the score is read from the annotations, where GitHub Actions actually puts it", () => {
  const parsed = parseCheckRunScore(LIVE_RUN, LIVE_ANNOTATIONS, 20);
  assert.equal(parsed.earned, 12);
  assert.equal(parsed.total, 20);
  assert.equal(parsed.matched, true);
  assert.equal(parsed.passed, false);
  assert.equal(parsed.source, "annotation-json");
});

test("without the annotations the same run grades 0/20 - the bug, pinned", () => {
  // This is what shipped: output.* is empty, nothing matches, and the parser
  // falls back to "not green, therefore zero". A 12/20 was recorded as 0, and
  // a green 20/20 as full marks, so nobody noticed until a partial score
  // mattered. The assertion documents WHY the annotation fetch is not optional.
  const parsed = parseCheckRunScore(LIVE_RUN, [], 20);
  assert.equal(parsed.earned, 0);
  assert.equal(parsed.matched, false);
  assert.equal(parsed.source, "conclusion");
});

test("the runner's deprecation warning is not the student's grading summary", () => {
  // Live, the first annotation on every one of these runs is a multi-line Node
  // deprecation notice. With no output body to fall back on it became the whole
  // summaryText - which the CLI writes into the student's grading result as the
  // test's stdout. It is still parsed for a score, just not displayed as one.
  const parsed = parseCheckRunScore(LIVE_RUN, LIVE_ANNOTATIONS, 20);
  assert.doesNotMatch(parsed.summaryText, /Node\.js 20 is deprecated/);
  assert.match(parsed.summaryText, /Points 12\/20/);

  // A reporter that emits its score at `warning` level is still read.
  const warned = parseCheckRunScore(
    LIVE_RUN,
    [{ annotation_level: "warning", title: "", message: "Points 9/20" }],
    20,
  );
  assert.equal(warned.earned, 9);
  assert.equal(warned.matched, true);
});

test("a `Points X/Y` annotation is read when the JSON report one is absent", () => {
  const annotations = LIVE_ANNOTATIONS.filter((a) => a.title !== "Autograding report");
  const parsed = parseCheckRunScore(LIVE_RUN, annotations, 20);
  assert.equal(parsed.earned, 12);
  assert.equal(parsed.total, 20);
  assert.equal(parsed.source, "points");
});

test("a full-marks run is passed, a zero-total one is not", () => {
  const full = parseCheckRunScore(
    { ...LIVE_RUN, conclusion: "success" },
    [{ title: "Autograding complete", message: "Points 20/20" }],
    20,
  );
  assert.equal(full.passed, true);

  // `Points 0/0` is a grader that scored nothing out of nothing. Reporting it
  // as "passed" would put a green badge on an assignment nobody was graded on.
  const empty = parseCheckRunScore(LIVE_RUN, [{ message: "Points 0/0" }], 0);
  assert.equal(empty.passed, false);
  assert.equal(empty.matched, true);
});

test("a malformed report annotation falls through to the human-readable line", () => {
  const annotations = [
    { title: "Autograding report", message: '{"totalPoints":oops,"maxPoints":20}' },
    { title: "Autograding complete", message: "Points 7/20" },
  ];
  const parsed = parseCheckRunScore(LIVE_RUN, annotations, 20);
  assert.equal(parsed.earned, 7);
  assert.equal(parsed.source, "points");
});

test("annotations must be an array - a stale positional call fails loudly", () => {
  // The old signature was (run, defaultTotal). A caller left un-updated would
  // otherwise grade a whole cohort against no annotations and silently record
  // conclusion-based marks.
  assert.throws(() => parseCheckRunScore(LIVE_RUN, 20), TypeError);
});

// -----------------------------------------------------------------------------
// Picking the right check run
// -----------------------------------------------------------------------------

test("pickAutogradeCheckRun finds the grading run among unrelated checks", () => {
  const runs = [
    { name: "CodeQL Analysis", conclusion: "success" },
    { name: "run-autograding-tests", conclusion: "failure" },
  ];
  assert.equal(pickAutogradeCheckRun(runs).name, "run-autograding-tests");

  // GitHub Classroom names the job differently again.
  assert.equal(
    pickAutogradeCheckRun([{ name: "build" }, { name: "GitHub Classroom Workflow" }]).name,
    "GitHub Classroom Workflow",
  );

  // Nothing matches - first run rather than nothing, so a single-job repo with
  // an oddly named workflow still gets read.
  assert.equal(pickAutogradeCheckRun([{ name: "build" }]).name, "build");
  assert.equal(pickAutogradeCheckRun([]), null);
  assert.equal(pickAutogradeCheckRun(undefined), null);
});

// -----------------------------------------------------------------------------
// One page is not the list
// -----------------------------------------------------------------------------

test("fetchCheckRunAnnotations walks pages until a short one", async () => {
  const paths = [];
  const page1 = Array.from({ length: 100 }, (_, i) => ({ message: `filler ${i}` }));
  const request = async (path) => {
    paths.push(path);
    // `&page=`, not `page=` - `per_page=100` contains "page=1" too.
    if (path.includes("&page=1")) return { status: 200, data: page1 };
    return { status: 200, data: [{ title: "Autograding complete", message: "Points 5/5" }] };
  };

  const res = await fetchCheckRunAnnotations(request, {
    repoFullName: "Org/repo",
    checkRunId: 42,
  });

  assert.equal(res.complete, true);
  assert.equal(res.annotations.length, 101);
  assert.equal(paths.length, 2);
  assert.match(paths[0], /^\/repos\/Org\/repo\/check-runs\/42\/annotations\?per_page=100&page=1$/);

  // And the score on page two is found, which is the reason for the walk.
  const parsed = parseCheckRunScore(LIVE_RUN, res.annotations, 5);
  assert.equal(parsed.earned, 5);
});

test("a failed page is reported incomplete, never as an empty answer", async () => {
  const request = async () => ({ status: 403, data: { message: "Forbidden" } });
  const res = await fetchCheckRunAnnotations(request, { repoFullName: "Org/repo", checkRunId: 1 });
  assert.equal(res.complete, false);
  assert.equal(res.annotations.length, 0);
  assert.equal(res.status, 403);
});

// -----------------------------------------------------------------------------
// No second implementation
// -----------------------------------------------------------------------------

test("nothing outside the module parses a points string of its own", () => {
  // Same guard tests/effective-deadline.test.mjs puts on the extension rule and
  // tests/deadline-countdown.test.mjs puts on the duration string. Two
  // byte-identical copies of this parser existed - AssignmentDetailView.vue and
  // cli/src/commands/grade.mjs - and both were wrong in the same way, which is
  // exactly what a fork costs.
  const root = process.cwd();
  const allowed = new Set([
    join(root, "lib", "check-run-score.mjs"),
    join(root, "tests", "check-run-score.test.mjs"),
  ]);
  // `.claude` holds git worktrees - a full second checkout, whose copy of the
  // module under test would read as somebody re-implementing it.
  const skipDirs = new Set(["node_modules", ".git", "dist", ".tools", "test-results", ".claude"]);
  const offenders = [];

  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (skipDirs.has(entry)) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(mjs|js|vue)$/.test(entry)) continue;
      if (allowed.has(full)) continue;
      const src = readFileSync(full, "utf8");
      // The literal `Points` followed by a capture of two numbers is the shape
      // of the parse; a test fixture that merely CONTAINS "Points 12/20" is not.
      if (/\/[^\n]*Points\\s\*[^\n]*\//.test(src) || /match\([^)]*Points\\s/.test(src)) {
        offenders.push(relative(root, full));
      }
    }
  };
  walk(root);

  assert.deepEqual(
    offenders,
    [],
    `import parseCheckRunScore from lib/check-run-score.mjs instead of re-implementing it: ${offenders.join(", ")}`,
  );
});
