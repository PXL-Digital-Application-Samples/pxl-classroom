#!/usr/bin/env node
// A publish switches the broker on: say so, where the nightly looks (review
// 2026-10-16, R7-4).
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
// EVERY PUBLISH, not only one over a close record (review 2026-10-16, R7-21).
// The close record is committed by the finalize after its close step, minutes
// later: a lecturer who moved the deadline in those minutes published over a
// checkout with no close record, so nothing was marked, and the commit that
// landed after said closed while the broker was on - for good. A mark the
// close then outdates (`at` after `reopened_at`) owes nothing.
//
// Writes `lockdowns/<id>/broker-reopened.json` into the checkout;
// publish-assignment.yml commits it with the state.
//
// Env: ASSIGNMENT_ID, DATA_DIR (the control checkout).

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseYaml } from "../lib/yaml.mjs";
import { assignmentPathsRead, brokerReopenedPath } from "../lib/control-layout.mjs";

export async function main({ assignmentId = process.env.ASSIGNMENT_ID, dataDir = process.env.DATA_DIR || ".", now = new Date() } = {}) {
  if (!assignmentId) {
    console.log("::error::ASSIGNMENT_ID is required");
    return 1;
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
  await mkdir(dirname(join(dataDir, brokerReopenedPath(assignmentId))), { recursive: true });
  await writeFile(join(dataDir, brokerReopenedPath(assignmentId)), JSON.stringify({
    schema_version: 1,
    assignment_id: assignmentId,
    reopened_at: now.toISOString(),
    deadline_at: deadlineAt,
    observer_run: run,
  }, null, 2) + "\n");
  console.log(`[ok] ${assignmentId}: its broker is on - the nightly closes it after ${deadlineAt ?? "the deadline"}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; });
}
