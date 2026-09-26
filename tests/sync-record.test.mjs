// The starter sync record, built once for both writers: lib/sync-record.mjs.
//
// 2026-09-27: the CLI wrote no record, so a later sync could not tell what a
// CLI sync had delivered, and a file it delivered that the student had since
// edited came back as a pull request offering the version they already had.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { buildSyncRecord, generateSyncId, syncRow } from "../lib/sync-record.mjs";
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
