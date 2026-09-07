// PXL Classroom - drop dashboard cards whose assignment is gone.
//
// The Admin Panel's delete removes the entry in the same commit as everything
// else it deletes, so the supported path needs none of this. This is the net
// under the rest: a YAML deleted by hand, a cleanup that stopped halfway.
//
// That net already existed, inside report/report.mjs - which meant it only ran
// as a SIDE EFFECT of generating some other assignment's report.
// `generate-interim-reports.mjs` runs reports for `published` and `closed`
// assignments only, so an organization whose remaining assignments are all
// draft or archived generated no reports, reconciled nothing, and kept a stale
// card indefinitely. Found on pxl-classroom-testbed on 2026-09-07: its one
// surviving assignment is archived, a deleted assignment's card stayed on the
// dashboard through a full regenerate-dashboard run, and it had to be removed
// by hand.
//
// So the reconciliation runs on its own now, in the same workflow, whether or
// not any report was generated. It only reads the assignments directory and
// rewrites one file; the workflow's existing commit step carries it.
//
// Usage: node scripts/prune-dashboard.mjs [data-dir]
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pruneMissingAssignments } from "../lib/dashboard-aggregate.mjs";
import { DASHBOARD_PATH } from "../lib/control-layout.mjs";

async function main() {
  const dataDir = process.argv[2] || "control";
  const dashboardPath = join(dataDir, DASHBOARD_PATH);

  let dashboard;
  try {
    dashboard = JSON.parse(await readFile(dashboardPath, "utf8"));
  } catch (e) {
    // No dashboard yet is the ordinary state of a new org, and one we cannot
    // read is not ours to rewrite - the same call the Admin Panel makes.
    console.log(`[skip] ${dashboardPath}: ${e.code === "ENOENT" ? "not present" : e.message}`);
    return;
  }

  // UNREADABLE IS NOT EVIDENCE. A failed listing leaves every entry alone;
  // deleting a live cohort's card because a read hiccuped is far worse than the
  // stale card this exists to remove.
  let onDisk = null;
  try {
    onDisk = new Set(
      (await readdir(join(dataDir, "assignments")))
        .filter((f) => /\.ya?ml$/.test(f))
        .map((f) => f.replace(/\.ya?ml$/, "")),
    );
  } catch (e) {
    console.log(`[skip] could not list assignments/, leaving every entry alone: ${e.message}`);
    return;
  }

  const { dashboard: reconciled, pruned } = pruneMissingAssignments(dashboard, onDisk);
  if (pruned.length === 0) {
    console.log(`[ok] nothing to prune - ${Object.keys(dashboard.assignments || {}).length} entries, all present`);
    return;
  }

  // `generated_at` is NOT touched. It records when the numbers were computed,
  // and removing somebody else's card did not recompute them - restamping it
  // would claim a freshness this run did not produce.
  await writeFile(dashboardPath, `${JSON.stringify(reconciled, null, 2)}\n`, "utf8");
  for (const id of pruned) {
    console.log(`[ok] pruned dashboard entry for ${id} - assignments/${id}.yml no longer exists`);
  }
}

await main();
