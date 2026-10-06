#!/usr/bin/env node
// Refuse to publish an assignment that is finished (lib/finished-assignment.mjs),
// before publish-assignment.yml turns its acceptance back on.
//
// Env: DATA_DIR (the control checkout), ASSIGNMENT_ID.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadYaml } from "../lib/yaml.mjs";
import { assignmentPath, lockdownRecordPath } from "../lib/control-layout.mjs";
import { republishRefusal } from "../lib/finished-assignment.mjs";

const dataDir = process.env.DATA_DIR || "control";
const id = process.env.ASSIGNMENT_ID || "";
if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(id)) {
  console.log("::error::ASSIGNMENT_ID is not a valid assignment id");
  process.exit(1);
}

// Both shapes the workflow's own validation accepts. Reading only `<id>.yml`
// let a finished legacy JSON assignment be published again - acceptance back
// on, the key back on its public broker - which the nightly finalizes like any
// other. loadYaml reads JSON too.
const yml = join(dataDir, assignmentPath(id));
const json = yml.replace(/\.yml$/, ".json");
const file = existsSync(yml) ? yml : existsSync(json) ? json : null;
if (!file) {
  // The workflow's own validation decides whether it exists at all.
  console.log(`No ${assignmentPath(id)} or .json - not checked.`);
  process.exit(0);
}
const assignment = await loadYaml(file);
// An unparseable deadline is no deadline here: new Date("garbage").toISOString()
// throws, which would fail the publish over a field the schema already judges.
const deadline = assignment?.deadline_at ? new Date(assignment.deadline_at) : null;
const refusal = republishRefusal({
  assignmentId: id,
  deadlineAt: deadline && Number.isFinite(deadline.getTime()) ? deadline.toISOString() : null,
  lockRan: existsSync(join(dataDir, lockdownRecordPath(id))),
});
if (refusal) {
  console.log(`::error::${refusal}`);
  process.exit(1);
}
console.log(`${id} is not finished - publishing may turn acceptance on.`);
