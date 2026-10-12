// frontend/src/lib/stuck-runs.js - which hub runs the dashboard calls stuck.
//
// 2026-10-12: "Pipeline Warning: Deadline Sentinel has been in_progress for
// 216m" with Cancel Run, eleven minutes before two exam deadlines, over the run
// that waits for hours by design to lock them at the instant.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse } from "yaml";

import { LONG_RUNNING_WORKFLOWS, stuckAfterMinutes, stuckRuns } from "../frontend/src/lib/stuck-runs.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const workflowsDir = join(root, ".github", "workflows");

/** Each workflow's longest job `timeout-minutes`, read from the files. */
function longestTimeouts() {
  const out = {};
  for (const f of readdirSync(workflowsDir).filter((n) => /\.ya?ml$/.test(n))) {
    const doc = parse(readFileSync(join(workflowsDir, f), "utf8"));
    const max = Math.max(0, ...Object.values(doc?.jobs || {}).map((j) => Number(j?.["timeout-minutes"]) || 0));
    out[`.github/workflows/${f}`] = max;
  }
  return out;
}

test("every workflow built to run past 45 minutes is in the table, at its own limit - derived from the files", () => {
  const timeouts = longestTimeouts();
  const long = Object.fromEntries(Object.entries(timeouts).filter(([, m]) => m > 45));
  assert.deepEqual(LONG_RUNNING_WORKFLOWS, long);
  assert.ok(long[".github/workflows/deadline-sentinel.yml"] >= 240, "the sentinel waits hours, and this guard would pass vacuously without it");
});

test("the sentinel waiting for its deadline is not stuck; past its own limit it is", () => {
  const now = Date.parse("2026-10-12T19:48:00Z");
  const sentinel = { id: 1, name: "Deadline Sentinel", path: ".github/workflows/deadline-sentinel.yml", status: "in_progress", created_at: "2026-10-12T16:12:22Z" };
  assert.deepEqual(stuckRuns([sentinel], now), []);
  assert.equal(stuckRuns([{ ...sentinel, created_at: "2026-10-12T14:00:00Z" }], now).length, 1, "past 300 + 15 minutes it is stuck");
});

test("everything else keeps the old limits: 15 minutes waiting, 45 in progress", () => {
  const now = Date.parse("2026-10-12T19:48:00Z");
  const ago = (m) => new Date(now - m * 60_000).toISOString();
  const deploy = { id: 2, path: ".github/workflows/deploy-frontend.yml" };
  assert.equal(stuckRuns([{ ...deploy, status: "in_progress", created_at: ago(44) }], now).length, 0);
  assert.equal(stuckRuns([{ ...deploy, status: "in_progress", created_at: ago(46) }], now).length, 1);
  assert.equal(stuckRuns([{ ...deploy, status: "waiting", created_at: ago(16) }], now).length, 1);
  // Waiting is not running: even the sentinel waiting for a runner is stuck after 15.
  assert.equal(stuckAfterMinutes(".github/workflows/deadline-sentinel.yml", "waiting"), 15);
});
