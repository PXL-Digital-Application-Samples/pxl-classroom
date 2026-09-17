// A planned drill delete has to still be true when it commits -
// tests/live/cleanup-plan.mjs.
//
// The cleanup reads the assignment, then the control tree, then commits through
// `commitWithRebase`, which rebases onto whatever head it finds. On 2026-09-17
// another cleanup deleted the same assignment between those two reads, and the
// commit landed anyway: `retired/<id>/manifest.json` was rewritten to say the
// broker was not deleted and no paths were removed, over a manifest that had
// recorded both. Nothing regenerates that record.
import { test } from "node:test";
import assert from "node:assert/strict";
import { deletePlanStale } from "./live/cleanup-plan.mjs";
import { assignmentPath, retiredManifestPath, reportPath } from "../lib/control-layout.mjs";

const ID = "drill-20260917-1519";
const live = (id = ID) => [assignmentPath(id), reportPath(id), `repositories/${id}/student1.json`];

test("a plan whose assignment is still there stands", () => {
  assert.equal(deletePlanStale({ paths: live(), assignmentId: ID }), null);
});

test("THE COLLISION: the assignment is gone and its retired record is there", () => {
  // What the other cleanup left behind. Committing on top of this is what
  // rewrote the manifest.
  const stale = deletePlanStale({
    paths: [retiredManifestPath(ID), `retired/${ID}/report.json`],
    assignmentId: ID,
  });
  assert.equal(stale.reason, "retired");
  assert.match(stale.message, /another delete/);
  assert.match(stale.message, new RegExp(ID));
});

test("gone with no retired record says that instead of guessing", () => {
  // Say what was established. Something removed the document and left no
  // deletion record, which is not the same event.
  const stale = deletePlanStale({ paths: ["students/roster.yml"], assignmentId: ID });
  assert.equal(stale.reason, "gone");
  assert.doesNotMatch(stale.message, /another delete/);
});

test("A RETIRED RECORD BESIDE A LIVE DOCUMENT IS NOT STALE", () => {
  // `retired/<id>/` is written by EVERY delete, so it is never the gate: a
  // lecturer may delete an assignment nobody joined and start again under the
  // same id, and the Admin Panel's collision check reads that manifest for
  // exactly this case. Blocking on its existence would refuse the second one
  // for ever.
  const paths = [...live(), retiredManifestPath(ID)];
  assert.equal(deletePlanStale({ paths, assignmentId: ID }), null);
});

test("another assignment's paths do not answer for this one", () => {
  // Exact paths, not prefixes: `drill-1519-vervolg` shares a prefix with
  // `drill-1519` and is a different assignment.
  const other = `${ID}-vervolg`;
  const stale = deletePlanStale({ paths: [...live(other), retiredManifestPath(other)], assignmentId: ID });
  assert.equal(stale.reason, "gone");
  assert.equal(deletePlanStale({ paths: live(other), assignmentId: other }), null);
});

test("an unreadable or empty tree is stale, never a licence to commit", () => {
  for (const paths of [[], null, undefined, "not a list"]) {
    assert.equal(deletePlanStale({ paths, assignmentId: ID })?.reason, "gone", JSON.stringify(paths));
  }
});
