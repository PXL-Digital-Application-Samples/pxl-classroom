#!/usr/bin/env node
// Write the control repo scaffold (ARCHITECTURE.md §5.1) into a target directory.
//
//   node scripts/scaffold-control-repo.mjs <target-dir>
//
// Idempotent: existing files are never overwritten, so re-running against a
// live control repo backfills only what is missing. setup-org.yml calls this
// instead of hand-rolling `mkdir -p`, which is how the scaffold drifted out of
// sync with lib/audit.mjs in the first place.

import { mkdir, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
// Imports the dep-free layout module, not lib/audit.mjs: setup-org.yml runs
// this without `npm ci`, and audit.mjs pulls in the `yaml` package.
import { CONTROL_SCAFFOLD_DIRS } from "../lib/control-layout.mjs";

const README = `# PXL Classroom Control Repo

This is an automated data repository for PXL Classroom. Do not modify these
files manually unless you know what you are doing.

Layout is documented in ARCHITECTURE.md §5.1.
`;

const ROSTER = `# PXL Classroom — student roster (schema v2).
#
# Full schema: schemas/roster.schema.json
# Bulk-import from CSV with the CLI:
#   pxl-classroom roster import --org <org> roster.csv
#
# github_login is required and must match the student's real GitHub account:
# acceptance/accept.mjs rejects any login that is not listed here
# (rejected:not-on-roster), and rejects every student if this file is absent
# (rejected:no-roster). An empty roster means nobody can accept.

schema_version: 2
students: []
`;

const exists = (p) =>
  access(p).then(
    () => true,
    () => false
  );

async function writeIfAbsent(path, contents) {
  if (await exists(path)) return false;
  await writeFile(path, contents);
  return true;
}

async function main() {
  const target = process.argv[2];
  if (!target) {
    console.error("usage: scaffold-control-repo.mjs <target-dir>");
    process.exit(1);
  }

  const created = [];

  for (const dir of CONTROL_SCAFFOLD_DIRS) {
    await mkdir(join(target, dir), { recursive: true });
    if (await writeIfAbsent(join(target, dir, ".gitkeep"), "")) {
      created.push(`${dir}/.gitkeep`);
    }
  }

  if (await writeIfAbsent(join(target, "README.md"), README)) {
    created.push("README.md");
  }
  if (await writeIfAbsent(join(target, "students", "roster.yml"), ROSTER)) {
    created.push("students/roster.yml");
  }

  console.log(
    created.length
      ? `Scaffold: created ${created.length} path(s):\n  ${created.join("\n  ")}`
      : "Scaffold: already intact, nothing to create."
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
