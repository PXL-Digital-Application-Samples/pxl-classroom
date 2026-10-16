#!/usr/bin/env node
// A publish switched a closed broker on again: say so, where the nightly looks
// (review 2026-10-16, R7-4).
//
// The finalize closed this assignment's broker - INVITE_ENABLED off, the broker
// App's key off a public repository (scripts/close-acceptance.mjs) - and wrote
// `broker-closed.json`. A lecturer who moves the deadline later publishes
// again, which switches both back on. Nothing ever closed it again: the record
// of the first close still said closed, so the queue owed nothing.
//
// A rule of times in the queue was tried first and reverted within the hour
// (`4ee1236`, LESSONS): a queued pass runs the WHOLE finalize, and it matched
// every assignment ever moved after its lock. So the publish marks it, and the
// queue owes that broker a close and nothing else (`close_only`,
// scripts/find-finalizable.mjs) once the deadline in force has passed.
//
// Writes `lockdowns/<id>/broker-reopened.json` into the checkout only when a
// close record is there; publish-assignment.yml commits it with the state.
//
// Env: ASSIGNMENT_ID, DATA_DIR (the control checkout).

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseYaml } from "../lib/yaml.mjs";
import { assignmentPathsRead, brokerClosedPath, brokerReopenedPath } from "../lib/control-layout.mjs";

export async function main({ assignmentId = process.env.ASSIGNMENT_ID, dataDir = process.env.DATA_DIR || ".", now = new Date() } = {}) {
  if (!assignmentId) {
    console.log("::error::ASSIGNMENT_ID is required");
    return 1;
  }
  if (!existsSync(join(dataDir, brokerClosedPath(assignmentId)))) {
    console.log(`[ok] ${assignmentId}: the broker was never closed - nothing to mark`);
    return 0;
  }
  let deadlineAt = null;
  for (const path of assignmentPathsRead(assignmentId)) {
    try {
      const text = await readFile(join(dataDir, path), "utf8");
      deadlineAt = (path.endsWith(".json") ? JSON.parse(text) : parseYaml(text))?.deadline_at ?? null;
      break;
    } catch { /* the next spelling */ }
  }
  const run = process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL || "https://github.com"}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : null;
  await writeFile(join(dataDir, brokerReopenedPath(assignmentId)), JSON.stringify({
    schema_version: 1,
    assignment_id: assignmentId,
    reopened_at: now.toISOString(),
    deadline_at: deadlineAt,
    observer_run: run,
  }, null, 2) + "\n");
  console.log(`[ok] ${assignmentId}: its closed broker is on again - the nightly closes it after ${deadlineAt ?? "the deadline"}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; });
}
