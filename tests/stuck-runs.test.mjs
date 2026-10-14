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

import { LONG_RUNNING_WORKFLOWS, listRunsInStatus, stuckAfterMinutes, stuckRuns } from "../frontend/src/lib/stuck-runs.js";

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

test("every workflow allowed 45 minutes or more is in the table, at its own limit - derived from the files", () => {
  // AT 45 too: the default limit with no margin called a starter sync stuck at
  // the minute its own timeout allowed it to end (review 2026-10-14).
  const timeouts = longestTimeouts();
  const long = Object.fromEntries(Object.entries(timeouts).filter(([, m]) => m >= 45));
  assert.deepEqual(LONG_RUNNING_WORKFLOWS, long);
  assert.ok(long[".github/workflows/deadline-sentinel.yml"] >= 240, "the sentinel waits hours, and this guard would pass vacuously without it");
  // Every limit in the table is more than its workflow's own timeout.
  for (const [path, minutes] of Object.entries(long)) {
    assert.ok(stuckAfterMinutes(path, "in_progress") > minutes, path);
  }
  // And a workflow under it gets the default, which is above its own timeout.
  for (const [path, minutes] of Object.entries(timeouts).filter(([, m]) => m > 0 && m < 45)) {
    assert.ok(stuckAfterMinutes(path, "in_progress") > minutes, path);
  }
});

test("the sentinel waiting for its deadline is not stuck; past its own limit it is", () => {
  const now = Date.parse("2026-10-12T19:48:00Z");
  const sentinel = { id: 1, name: "Deadline Sentinel", path: ".github/workflows/deadline-sentinel.yml", status: "in_progress", created_at: "2026-10-12T16:12:22Z" };
  assert.deepEqual(stuckRuns([sentinel], now), []);
  assert.equal(stuckRuns([{ ...sentinel, created_at: "2026-10-12T14:00:00Z" }], now).length, 1, "past 300 + 15 minutes it is stuck");
});

test("the Pipeline Watchdog and System Health ask the same table, never a limit of their own", () => {
  // The watchdog emailed "Requires manual cancellation or attention" about the
  // sentinel at 57 minutes, the same evening; System Health still offered to
  // cancel it two days later, from a third copy (review 2026-10-14).
  const watchdog = readFileSync(join(root, "scripts", "pipeline-watchdog.mjs"), "utf8");
  assert.match(watchdog, /stuckAfterMinutes\(r\.path, r\.status\)/);
  assert.doesNotMatch(watchdog, /ageMs > (15|45) \* 60/, "no flat limit beside the table");
  const diagnostics = readFileSync(join(root, "lib", "diagnostics.mjs"), "utf8");
  assert.match(diagnostics, /from "\.\/stuck-runs\.mjs"/);
  assert.doesNotMatch(diagnostics, /ageMs > (15|45) \* 60/);
});

test("a re-run is aged from its own start, not the run's first", () => {
  const now = Date.parse("2026-10-14T12:00:00Z");
  const rerun = { id: 3, path: ".github/workflows/regenerate-dashboard.yml", status: "in_progress", created_at: "2026-10-14T06:00:00Z", run_started_at: "2026-10-14T11:50:00Z" };
  assert.deepEqual(stuckRuns([rerun], now), [], "ten minutes into its re-run");
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

test("R1-11: a pending run waits as long as the run ahead of it may run; a pending sentinel is not stuck", () => {
  const now = Date.parse("2026-10-14T16:00:00Z");
  const ago = (m) => new Date(now - m * 60_000).toISOString();
  const sentinel = { id: 7, path: ".github/workflows/deadline-sentinel.yml", status: "pending", created_at: ago(200) };
  assert.equal(stuckRuns([sentinel], now).length, 0, "behind the first sentinel, by design");
  assert.equal(stuckRuns([{ ...sentinel, created_at: ago(400) }], now).length, 1);
  const deploy = { id: 8, path: ".github/workflows/deploy-frontend.yml", status: "pending", created_at: ago(30) };
  assert.equal(stuckRuns([deploy], now).length, 0);
  assert.equal(stuckRuns([{ ...deploy, created_at: ago(50) }], now).length, 1);
  // Every surface reads pending runs.
  const here = dirname(fileURLToPath(import.meta.url));
  for (const f of ["../scripts/pipeline-watchdog.mjs", "../lib/diagnostics.mjs", "../frontend/src/views/DashboardView.vue"]) {
    assert.match(readFileSync(join(here, f), "utf8"), /status=pending|'pending'/, f);
  }
});

test("G8b: every page is read, so the oldest run (the stuck one) on page 2 is found", async () => {
  const now = Date.parse("2026-10-14T16:00:00Z");
  const fresh = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, path: ".github/workflows/acceptance-handler.yml", status: "waiting", created_at: new Date(now - 60_000).toISOString() }));
  const old = { id: 999, name: "Accept assignment", path: ".github/workflows/acceptance-handler.yml", status: "waiting", created_at: new Date(now - 40 * 60_000).toISOString() };
  const asked = [];
  const request = async (method, path) => {
    asked.push(path);
    const page = Number(new URL(path, "http://x").searchParams.get("page"));
    return { ok: true, data: { workflow_runs: page === 1 ? fresh : [old] } };
  };
  const { runs, whole } = await listRunsInStatus(request, { owner: "O", repo: "hub", status: "waiting" });
  assert.equal(whole, true);
  assert.equal(runs.length, 101);
  assert.deepEqual(stuckRuns(runs, now).map((r) => r.id), [999]);
  assert.ok(asked.every((p) => p.includes("per_page=100")));
  // A page that fails: what was read, and not whole.
  const failing = async (method, path) => (path.includes("page=2") ? { ok: false, data: {} } : { ok: true, data: { workflow_runs: fresh } });
  assert.equal((await listRunsInStatus(failing, { owner: "O", repo: "hub", status: "waiting" })).whole, false);
  // The dashboard reads through it.
  const dash = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "frontend", "src", "views", "DashboardView.vue"), "utf8");
  assert.match(dash, /listRunsInStatus\(/);
  assert.doesNotMatch(dash, /actions\/runs\?status=waiting`\)/, "no single-page read left");
});
