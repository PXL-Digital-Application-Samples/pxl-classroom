// reports/dashboard.json used to be append-only.
//
// report.mjs wrote the entry for the assignment it had just generated and never
// removed one whose YAML had been deleted. So deleting an assignment left its
// card on the lecturer's dashboard for ever, linking to a detail page whose
// assignment and report both 404.
//
// That is not hypothetical: `phasea-live-sysex` sat on PXL-Systems-Expert's
// dashboard after its files were deleted, and opening it took the page down -
// the detail view rendered its main block over a null report and threw. The
// view guards itself now, but the stale card was the reason anyone landed
// there.
//
// The reconciliation is deliberately one-directional and cautious: an entry is
// removed only when the assignments directory could actually be listed and does
// not contain it. An unreadable directory is not evidence, and dropping a live
// cohort's card because a read hiccuped is far worse than the stale card this
// fixes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SCAFFOLD_KEEPFILE } from "../lib/control-layout.mjs";
import { pruneMissingAssignments } from "../lib/dashboard-aggregate.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function makeControlDir({ withAssignments = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pxl-prune-"));
  for (const d of ["reports", "repositories/live", "observations", "overrides"]) {
    mkdirSync(join(dir, d), { recursive: true });
  }
  if (withAssignments) {
    mkdirSync(join(dir, "assignments"), { recursive: true });
    writeFileSync(join(dir, "assignments", "live.yml"), [
      "schema_version: 1",
      "id: live",
      "title: Live",
      "organization: TestOrg",
      "template:",
      "  owner: TestOrg",
      "  repository: tpl",
      "repository_name_pattern: live-{github_login}",
      "opens_at: 2026-08-01T08:00:00.000Z",
      "deadline_at: 2026-12-31T22:00:00.000Z",
      "state: published",
      "max_acceptances: 20",
      "",
    ].join("\n"));
  }
  return dir;
}

function writeDashboard(dir, assignments) {
  writeFileSync(
    join(dir, "reports", "dashboard.json"),
    JSON.stringify({ schema_version: 1, assignments }, null, 2) + "\n",
  );
}

function runReport(dir, assignmentId = "live") {
  return spawnSync("node", [join(root, "report", "report.mjs")], {
    env: { ...process.env, ORG: "TestOrg", ASSIGNMENT_ID: assignmentId, DATA_DIR: dir, GITHUB_SHA: "test" },
    encoding: "utf8",
  });
}

function dashboardOf(dir) {
  return JSON.parse(readFileSync(join(dir, "reports", "dashboard.json"), "utf8"));
}

test("an entry whose assignment YAML is gone is pruned", () => {
  const dir = makeControlDir();
  try {
    writeDashboard(dir, {
      live: { title: "Live", state: "published", total_students: 1 },
      "deleted-one": { title: "Ghost", state: "published", total_students: 3 },
      "deleted-two": { title: "Ghost 2", state: "closed", total_students: 9 },
    });
    runReport(dir);
    const keys = Object.keys(dashboardOf(dir).assignments);
    assert.deepEqual(keys.sort(), ["live"], "only the assignment that still exists should remain");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the assignment being generated is never pruned", () => {
  const dir = makeControlDir();
  try {
    writeDashboard(dir, {});
    runReport(dir);
    assert.ok(dashboardOf(dir).assignments.live, "the run must write its own entry and keep it");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unreadable assignments directory prunes NOTHING", () => {
  // Unreadable is not evidence. Removing a live cohort's card because a
  // directory read failed would be far worse than the stale card this fixes.
  const dir = makeControlDir({ withAssignments: false });
  try {
    writeDashboard(dir, {
      live: { title: "Live", state: "published" },
      ghost: { title: "Ghost", state: "published" },
    });
    runReport(dir);
    const keys = Object.keys(dashboardOf(dir).assignments).sort();
    assert.deepEqual(keys, ["ghost", "live"], "with no listing available, every entry must survive");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pruning is reported, not silent", () => {
  const dir = makeControlDir();
  try {
    writeDashboard(dir, { live: {}, "deleted-one": { title: "Ghost" } });
    const res = runReport(dir);
    assert.match(
      (res.stderr || "") + (res.stdout || ""),
      /pruned dashboard entry for deleted-one/,
      "a removal a lecturer would notice must appear in the run log",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------------------
// THE HOLE IN THE NET
//
// All of the above runs report.mjs - which is the point. The reconciliation
// lived inside it, so it happened only as a SIDE EFFECT of generating some
// other assignment's report, and generate-interim-reports.mjs generates
// reports for `published` and `closed` assignments only. An organization whose
// remaining assignments are all draft or archived therefore reconciled
// NOTHING, and a deleted assignment's card sat on the dashboard indefinitely.
//
// Found on pxl-classroom-testbed on 2026-09-07: its one surviving assignment
// is archived, a deleted assignment's card survived a full
// regenerate-dashboard run, and it had to be removed by hand.
// --------------------------------------------------------------------------

function makeArchivedOnlyDir() {
  const dir = mkdtempSync(join(tmpdir(), "pxl-prune-archived-"));
  mkdirSync(join(dir, "reports"), { recursive: true });
  mkdirSync(join(dir, "assignments"), { recursive: true });
  writeFileSync(join(dir, "assignments", "archived-one.yml"), [
    "schema_version: 1",
    "id: archived-one",
    "title: Archived",
    "organization: TestOrg",
    "template:",
    "  owner: TestOrg",
    "  repository: tpl",
    "repository_name_pattern: archived-one-{github_login}",
    "opens_at: 2026-08-01T08:00:00.000Z",
    "deadline_at: 2026-12-31T22:00:00.000Z",
    "state: archived",
    "",
  ].join("\n"));
  return dir;
}

const runPrune = (dir) =>
  spawnSync("node", [join(root, "scripts", "prune-dashboard.mjs"), dir], { encoding: "utf8" });

test("THE HOLE: an org with only archived assignments still reconciles", () => {
  // No report can be generated here - nothing is published or closed - so
  // before the standalone script this entry was unreachable by any prune.
  const dir = makeArchivedOnlyDir();
  try {
    writeDashboard(dir, {
      "archived-one": { title: "Archived", state: "archived" },
      "deleted-one": { title: "Ghost", state: "published" },
    });
    const res = runPrune(dir);
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(Object.keys(dashboardOf(dir).assignments).sort(), ["archived-one"]);
    assert.match(res.stdout || "", /pruned dashboard entry for deleted-one/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the standalone prune leaves everything alone when it cannot list", () => {
  // Same rule as report.mjs's: a failed listing is not evidence that every
  // assignment is gone, and deleting a live cohort's card over a read hiccup
  // is far worse than the stale card this removes.
  const dir = mkdtempSync(join(tmpdir(), "pxl-prune-nolist-"));
  try {
    mkdirSync(join(dir, "reports"), { recursive: true });
    writeDashboard(dir, { live: {}, ghost: {} });
    const res = runPrune(dir); // no assignments/ directory at all
    assert.equal(res.status, 0);
    assert.deepEqual(Object.keys(dashboardOf(dir).assignments).sort(), ["ghost", "live"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing dashboard is the ordinary state of a new org, not a failure", () => {
  const dir = makeArchivedOnlyDir();
  try {
    const res = runPrune(dir);
    assert.equal(res.status, 0, "a new organization has no dashboard yet");
    assert.match(res.stdout || "", /not present/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("it does not restamp generated_at - it computed nothing", () => {
  // The field records when the NUMBERS were computed. Removing somebody else's
  // card did not recompute them, and restamping would claim a freshness this
  // run did not produce.
  const dir = makeArchivedOnlyDir();
  try {
    const stamp = "2020-01-01T00:00:00.000Z";
    writeFileSync(
      join(dir, "reports", "dashboard.json"),
      JSON.stringify(
        { schema_version: 1, generated_at: stamp, assignments: { "archived-one": {}, ghost: {} } },
        null,
        2,
      ) + "\n",
    );
    runPrune(dir);
    const after = dashboardOf(dir);
    assert.deepEqual(Object.keys(after.assignments), ["archived-one"], "it did prune");
    assert.equal(after.generated_at, stamp);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------------------
// ZERO IS A NUMBER
//
// The guard above refused an EMPTY listing exactly as it refuses an unreadable
// one, so an organization that deleted its LAST assignment kept that card for
// ever: one left and it reconciled fine, zero and nothing would ever remove it.
// That is the case where the net is all there is - no other assignment's run
// can carry the reconciliation.
//
// `.gitkeep` is what separates the two answers. scaffold-control-repo.mjs
// writes one into every scaffold directory, so a control repo that can be read
// at all has one in `assignments/`; a listing with neither ids nor a marker is
// a read that established nothing and still prunes nothing.
// --------------------------------------------------------------------------

function makeEmptyAssignmentsDir({ keepfile = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pxl-prune-empty-"));
  mkdirSync(join(dir, "reports"), { recursive: true });
  mkdirSync(join(dir, "assignments"), { recursive: true });
  if (keepfile) writeFileSync(join(dir, "assignments", SCAFFOLD_KEEPFILE), "");
  return dir;
}

test("the organization that deleted its LAST assignment loses the card too", () => {
  const dir = makeEmptyAssignmentsDir();
  try {
    writeDashboard(dir, { "deleted-one": { title: "Ghost", state: "closed" } });
    const res = runPrune(dir);
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(Object.keys(dashboardOf(dir).assignments), [], "zero on disk means zero cards");
    assert.match(res.stdout || "", /pruned dashboard entry for deleted-one/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an empty listing with no scaffold marker still prunes NOTHING", () => {
  // The fail-safe direction. Whatever produces a listing with neither an
  // assignment nor the marker in it told us nothing, and the worst it may cost
  // is the stale card this file exists to remove - never a live cohort's.
  const dir = makeEmptyAssignmentsDir({ keepfile: false });
  try {
    writeDashboard(dir, { live: { title: "Live" }, ghost: { title: "Ghost" } });
    const res = runPrune(dir);
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(Object.keys(dashboardOf(dir).assignments).sort(), ["ghost", "live"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the decision itself reads the listing, marker and all", () => {
  // Straight at the function, because the two answers differ by one filename
  // and a subprocess test cannot say which half of the rule fired.
  const dash = () => ({ schema_version: 1, assignments: { a: {}, b: {} } });

  assert.deepEqual(
    pruneMissingAssignments(dash(), [SCAFFOLD_KEEPFILE]).pruned.sort(),
    ["a", "b"],
    "present-and-empty is evidence that both are gone",
  );
  assert.deepEqual(
    pruneMissingAssignments(dash(), []).pruned,
    [],
    "an empty listing with no marker establishes nothing",
  );
  assert.deepEqual(
    pruneMissingAssignments(dash(), null).pruned,
    [],
    "unreadable is not evidence",
  );
  assert.deepEqual(
    pruneMissingAssignments(dash(), [SCAFFOLD_KEEPFILE, "a.yml"]).pruned,
    ["b"],
    "the marker does not stop the ordinary case",
  );
  assert.deepEqual(
    pruneMissingAssignments(dash(), ["a.yaml", "b.yml"]).pruned,
    [],
    "both spellings of the extension name an assignment",
  );
  assert.deepEqual(
    pruneMissingAssignments(dash(), ["a", "b"]).pruned,
    [],
    "ids where names belong name no assignment, and fail safe rather than deleting both",
  );
});

test("the workflow actually runs it, or the script is dead code", () => {
  // The prune only closes the hole if regenerate-dashboard.yml calls it, and
  // an unreferenced script in scripts/ looks exactly like a working fix.
  const wf = readFileSync(join(root, ".github", "workflows", "regenerate-dashboard.yml"), "utf8");
  assert.match(wf, /node scripts\/prune-dashboard\.mjs/, "regenerate-dashboard must run the prune");
  // `always()`, so a failed report generation does not also skip the
  // reconciliation - the two are independent, which is the whole point.
  const step = wf.slice(wf.indexOf("Prune dashboard entries"));
  assert.match(step.slice(0, 200), /if: always\(\)/);
});
