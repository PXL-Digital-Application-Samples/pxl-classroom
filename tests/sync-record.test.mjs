// The starter sync record, built once for both writers: lib/sync-record.mjs.
//
// 2026-09-27: the CLI wrote no record, so a later sync could not tell what a
// CLI sync had delivered, and a file it delivered that the student had since
// edited came back as a pull request offering the version they already had.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { appliedFilesFor, buildSyncRecord, failedRow, generateSyncId, syncRow } from "../lib/sync-record.mjs";
import { startingPointFor } from "../lib/starter-sync.mjs";
import { describeSyncStatus } from "../lib/sync-status.mjs";
import { validateAgainst } from "../lib/validate.mjs";

const TPL = "a".repeat(40);
const plan = { clean: [{ path: "A.cs", action: "write" }], conflicts: [], kept: [] };
const cliRecord = (status, results) => buildSyncRecord({
  syncId: generateSyncId(new Date("2026-09-27T10:00:00Z")), assignmentId: "labs", startedAt: "2026-09-27T10:00:00.000Z",
  syncedBy: "lecturer1", status, via: "cli", totalStudents: 1, templateRepo: "Org/tpl", templateSha: TPL,
  appliedPaths: ["A.cs"], allFiles: true, prTitle: "t", prBody: "b", createdIssues: false, results,
});
const row = syncRow({ login: "ada", repoName: "Org/labs-ada", outcome: "auto-merged", from: "b".repeat(40), source: "generated", at: TPL, plan });

test("a CLI record validates against the schema, running and completed", () => {
  for (const doc of [cliRecord("running", []), cliRecord("completed", [row])]) {
    const { valid, errors } = validateAgainst("sync-record", doc);
    assert.equal(valid, true, JSON.stringify(errors));
    assert.equal(doc.via, "cli");
  }
  assert.match(generateSyncId(), /^sync-[0-9]{8}T[0-9]{6}Z-[a-z0-9]{6}$/);
});

test("the next sync reads a CLI record as evidence of where the student is", () => {
  const start = startingPointFor({ login: "ADA", records: [cliRecord("completed", [row])] });
  assert.deepEqual(start, { sha: TPL, source: "synced", repo: "Org/tpl" });
});

test("a CLI record still 'running' is never 'Syncing' for ever - there is no run to ask", () => {
  const v = describeSyncStatus({ record: cliRecord("running", []) });
  assert.equal(v.state, "running-unknown");
  assert.match(v.title, /started from the command line by @lecturer1 and has not recorded an end/);
});

test("each row says what THIS student was sent; the record leaves it out only where it IS the union", () => {
  const mk = (clean, conflicts = []) => ({ clean: clean.map((path) => ({ path, action: "write" })), conflicts: conflicts.map((path) => ({ path, action: "write" })), kept: [] });
  const rows = [
    syncRow({ login: "all", repoName: "Org/a", outcome: "merged-and-pr", source: "generated", at: TPL, plan: mk(["B.cs"], ["A.cs"]) }),
    syncRow({ login: "some", repoName: "Org/s", outcome: "auto-merged", source: "unknown", at: TPL, plan: mk(["B.cs"]) }),
    syncRow({ login: "none", repoName: "Org/n", outcome: "skipped-up-to-date", source: "synced", at: TPL, plan: mk([]) }),
  ];
  assert.deepEqual(rows[0].applied_files, ["A.cs", "B.cs"], "clean and offered, sorted");
  const doc = buildSyncRecord({
    syncId: generateSyncId(), assignmentId: "labs", startedAt: "2026-09-27T10:00:00.000Z", syncedBy: "l", status: "completed",
    totalStudents: 4, templateRepo: "Org/tpl", templateSha: TPL, appliedPaths: new Set(["B.cs", "A.cs"]), allFiles: true,
    prTitle: "t", prBody: "b", createdIssues: false,
    results: [...rows, failedRow(rows[1], "boom")],
  });
  assert.equal(validateAgainst("sync-record", doc).valid, true);
  const [all, some, none, failed] = doc.results;
  assert.equal("applied_files" in all, false, "equal to selected_files: left out");
  assert.deepEqual(some.applied_files, ["B.cs"]);
  assert.deepEqual(none.applied_files, [], "empty is an answer: nothing was sent");
  assert.equal("applied_files" in failed, false, "a failed row says nothing about files");
  assert.equal(failed.outcome, "failed");
  // The in-memory rows are untouched: the next flush compacts against ITS union.
  assert.deepEqual(rows[0].applied_files, ["A.cs", "B.cs"]);

  assert.deepEqual(appliedFilesFor(doc, "ALL"), ["A.cs", "B.cs"], "absent reads as the union");
  assert.deepEqual(appliedFilesFor(doc, "some"), ["B.cs"]);
  assert.deepEqual(appliedFilesFor(doc, "none"), []);
  assert.deepEqual(appliedFilesFor(doc, "nobody"), [], "a record that did not reach them sent them nothing");
});

test("applied_files has no schema default - validating an old record writes nothing into it", () => {
  const schema = JSON.parse(readFileSync(join(process.cwd(), "schemas/sync-record.schema.json"), "utf8"));
  assert.equal("default" in schema.properties.results.items.properties.applied_files, false);
  const old = cliRecord("completed", [row]);
  delete old.results[0].applied_files;
  validateAgainst("sync-record", old);
  assert.equal("applied_files" in old.results[0], false);
});

test("both writers build it here, and neither by hand", () => {
  for (const file of ["scripts/sync-starter.mjs", "cli/src/commands/sync-starter.mjs"]) {
    const src = readFileSync(join(process.cwd(), file), "utf8");
    assert.match(src, /buildSyncRecord\(/, file);
    assert.match(src, /syncRow\(/, file);
    assert.doesNotMatch(src, /per_student_range: true/, `${file} builds its own record`);
  }
  // The CLI writes at the start and at the end, and never on a dry run.
  const cli = readFileSync(join(process.cwd(), "cli/src/commands/sync-starter.mjs"), "utf8");
  assert.match(cli, /if \(!opts\.dryRun\) \{[\s\S]*?recordOf\("running"/);
  assert.match(cli, /if \(!opts\.dryRun\) \{[\s\S]*?recordOf\("completed"/);
});
