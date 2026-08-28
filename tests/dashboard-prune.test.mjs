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
