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

const file = join(dataDir, assignmentPath(id));
if (!existsSync(file)) {
  // Not a YAML assignment (the workflow's own validation decides whether it
  // exists at all); nothing here to judge.
  console.log(`No ${assignmentPath(id)} - not checked.`);
  process.exit(0);
}
const assignment = await loadYaml(file);
const refusal = republishRefusal({
  assignmentId: id,
  deadlineAt: assignment?.deadline_at ? new Date(assignment.deadline_at).toISOString() : null,
  lockRan: existsSync(join(dataDir, lockdownRecordPath(id))),
});
if (refusal) {
  console.log(`::error::${refusal}`);
  process.exit(1);
}
console.log(`${id} is not finished - publishing may turn acceptance on.`);
