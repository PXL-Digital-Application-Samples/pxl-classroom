// lib/sync-status.mjs - what the assignment page says about its starter syncs.
//
// On 2026-09-25 two syncs of .NET Advanced were cut off and nothing on screen
// said so. Every state below is one a lecturer can be in, and each sentence
// must come from what was read - including the reads that failed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { activeSyncRun, describeFollow, describeSyncStatus, newestSyncFile, syncRunTitle } from "../lib/sync-status.mjs";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

const HEAD = "a".repeat(40);
const res = (login, outcome, extra = {}) => ({ github_login: login, repo_name: `Org/r-${login}`, outcome, ...extra });

const record = (over = {}) => ({
  schema_version: 1,
  sync_id: "sync-20260925T151518Z-b1gcxj",
  assignment_id: "labs",
  synced_at: "2026-09-25T15:15:18Z",
  synced_by: "wesleyhendrikx",
  status: "completed",
  run_id: 36152850724,
  run_url: "https://github.com/Hub/pxl-classroom/actions/runs/36152850724",
  total_students: 3,
  remaining: 0,
  template_repo: "Org/tpl",
  template_sha: HEAD,
  selected_files: [],
  summary: {},
  results: [res("ada", "auto-merged"), res("bo", "skipped-up-to-date"), res("cy", "skipped-up-to-date")],
  ...over,
});

test("no record, no line", () => {
  assert.equal(describeSyncStatus({ record: null }), null);
});

test("the newest record file is found by its timestamped name, and nothing else is one", () => {
  const listing = [
    { type: "file", name: "sync-20260916T150230Z-f0yv6z.json", path: "syncs/x/sync-20260916T150230Z-f0yv6z.json" },
    { type: "file", name: "sync-20260925T151518Z-b1gcxj.json", path: "p2" },
    { type: "file", name: "sync-20260917T093756Z-c21c8x.json", path: "p3" },
    { type: "file", name: "README.md", path: "p4" },
    { type: "dir", name: "sync-20991231T000000Z-zzzzzz.json", path: "p5" },
  ];
  assert.equal(newestSyncFile(listing).path, "p2");
  assert.equal(newestSyncFile([]), null);
  assert.equal(newestSyncFile(null), null);
});

test("COMPLETED and the template unchanged: a quiet success", () => {
  const v = describeSyncStatus({ record: record(), templateHeadSha: HEAD });
  assert.equal(v.state, "completed");
  assert.equal(v.tone, "success");
  assert.equal(v.action, null);
  assert.equal(v.title, "Last sync by @wesleyhendrikx: aaaaaaa, all 3 students handled");
  assert.equal(v.detail, "1 updated, 2 already had it.");
});

test("COMPLETED but the template has moved on: says so, offers to sync", () => {
  const v = describeSyncStatus({ record: record(), templateHeadSha: "b".repeat(40) });
  assert.equal(v.state, "template-changed");
  assert.equal(v.tone, "warning");
  assert.equal(v.action, "sync-again");
  assert.match(v.detail, /The template has changed since - sync again to send it\.$/);
});

test("COMPLETED and the template could not be read: says THAT, not 'unchanged'", () => {
  const v = describeSyncStatus({ record: record(), templateHeadSha: null });
  assert.equal(v.state, "completed");
  assert.match(v.detail, /Could not read the template, so whether it has changed since is unknown\.$/);
});

test("COMPLETED with failures names every student and why", () => {
  const v = describeSyncStatus({
    record: record({ results: [res("ada", "failed", { error: "could not read main (HTTP 404)" }), res("bo", "auto-merged"), res("cy", "failed")] }),
    templateHeadSha: HEAD,
  });
  assert.equal(v.tone, "danger");
  assert.equal(v.action, "sync-again");
  assert.equal(v.title, "The last sync of aaaaaaa by @wesleyhendrikx could not update 2 students");
  // "The other", never "3 of 3 handled" under "could not update 2".
  assert.equal(v.detail, "The other 1 of 3 were handled. Sync again to retry these:");
  assert.deepEqual(v.failed, [{ login: "ada", error: "could not read main (HTTP 404)" }, { login: "cy", error: "failed" }]);
});

test("STOPPED at its budget: how many are left, and that running it again continues", () => {
  const v = describeSyncStatus({
    record: record({ status: "stopped", total_students: 111, remaining: 43, results: Array.from({ length: 68 }, (_, i) => res(`s${i}`, "auto-merged")) }),
  });
  assert.equal(v.state, "stopped");
  assert.equal(v.tone, "warning");
  assert.equal(v.action, "sync-again");
  assert.equal(v.title, "The sync of aaaaaaa stopped with 43 students not reached");
});

test("RUNNING and its run is going: progress, and Follow - never a timer on the page", () => {
  const v = describeSyncStatus({
    record: record({ status: "running", remaining: undefined, total_students: 111, results: Array.from({ length: 40 }, (_, i) => res(`s${i}`, "auto-merged")) }),
    run: { status: "in_progress", html_url: "https://x/run" },
  });
  assert.equal(v.state, "running");
  assert.equal(v.tone, "neutral");
  assert.equal(v.action, "follow");
  assert.equal(v.runId, 36152850724);
  // A record with no run id cannot be followed: a manual re-read instead.
  const noRun = describeSyncStatus({ record: record({ status: "running", run_id: undefined }), run: { status: "in_progress" } });
  assert.equal(noRun.action, "refresh");
  assert.equal(noRun.runId, null);
  assert.equal(v.title, "Syncing aaaaaaa by @wesleyhendrikx");
  // As of the record's last write - every 20 students - not live.
  assert.equal(v.detail, "40 of 111 students done at the last count.");
  assert.equal(v.runUrl, "https://github.com/Hub/pxl-classroom/actions/runs/36152850724");
});

test("RUNNING in the record but the run is OVER: it died, and the lecturer is told to run it again", () => {
  // The exact state .NET Advanced was left in: cut off, nothing recorded after.
  // GitHub's conclusion is never printed as-is (DESIGN.md §1.7): `timed_out`
  // on screen is machine output. An unknown one falls back to itself.
  const said = {
    cancelled: "was cancelled before it finished",
    failure: "failed before it finished",
    timed_out: "timed out before it finished",
    success: "finished, but its record was not closed",
    stale: "ended (stale) before it finished",
  };
  for (const [conclusion, words] of Object.entries(said)) {
    const v = describeSyncStatus({
      record: record({ status: "running", total_students: 111, results: Array.from({ length: 31 }, (_, i) => res(`s${i}`, "auto-merged")) }),
      run: { status: "completed", conclusion },
    });
    assert.equal(v.state, "died", conclusion);
    assert.equal(v.tone, "warning");
    assert.equal(v.action, "sync-again");
    assert.equal(v.title, `The sync of aaaaaaa by @wesleyhendrikx ${words}`);
    assert.doesNotMatch(v.title, /_/, "no machine word reaches the screen");
    assert.match(v.detail, /^31 of 111 students reached\. Run the sync again/);
  }
});

test("the title names its commit so a surface can set it in monospace", () => {
  const v = describeSyncStatus({ record: record(), templateHeadSha: HEAD });
  assert.equal(v.commit, "aaaaaaa");
  assert.ok(v.title.includes(v.commit));
});

test("RUNNING and its run could not be read: unknown, never 'still going'", () => {
  const v = describeSyncStatus({ record: record({ status: "running" }), run: null });
  assert.equal(v.state, "running-unknown");
  assert.match(v.detail, /^Could not read its run, so whether it is still going is unknown\./);
  assert.equal(v.action, "refresh");
});

test("a record from before the status field reads as completed, with no invented totals", () => {
  const old = record({ status: undefined, total_students: undefined, remaining: undefined, run_id: undefined, run_url: undefined });
  const v = describeSyncStatus({ record: old, templateHeadSha: HEAD });
  assert.equal(v.state, "completed");
  assert.equal(v.title, "Last sync by @wesleyhendrikx: aaaaaaa, all 3 students handled");
  assert.equal(v.runUrl, null);
});

// -----------------------------------------------------------------------------
// Following one run from the sync dialog (`describeFollow`), and finding a sync
// that is already going (`activeSyncRun`)
// -----------------------------------------------------------------------------

test("the run-name the workflow declares is the one the dialog looks for", () => {
  // Derived, never re-spelled: the dialog matches runs by this title, and a
  // workflow that named its runs differently would make every running sync
  // invisible to it.
  const wf = parseYaml(readFileSync(new URL("../.github/workflows/sync-starter-code.yml", import.meta.url), "utf8"));
  const expr = wf["run-name"];
  const rendered = expr.replace("${{ inputs.assignment_id }}", "labs").replace("${{ inputs.org }}", "Org");
  assert.equal(rendered, syncRunTitle("Org", "labs"));
});

test("activeSyncRun finds THIS assignment's queued or running sync, and nothing else", () => {
  const t = syncRunTitle("Org", "labs");
  const runs = [
    { id: 1, display_title: t, status: "completed" },
    { id: 2, display_title: syncRunTitle("Org", "other"), status: "in_progress" },
    { id: 3, display_title: syncRunTitle("OtherOrg", "labs"), status: "queued" },
    { id: 4, display_title: t, status: "queued" },
  ];
  assert.equal(activeSyncRun(runs, "Org", "labs").id, 4);
  assert.equal(activeSyncRun(runs.slice(0, 3), "Org", "labs"), null);
  assert.equal(activeSyncRun(null, "Org", "labs"), null);
});

test("FOLLOW: queued, or started and not yet recorded - waiting, keep checking", () => {
  for (const status of ["queued", "in_progress", "waiting", "pending"]) {
    const v = describeFollow({ run: { status }, record: null });
    assert.equal(v.state, "waiting", status);
    assert.equal(v.done, false);
    assert.equal(v.title, "Waiting for GitHub to start the sync");
  }
});

test("FOLLOW: the run ended before recording anything - nothing was sent, stop checking", () => {
  const v = describeFollow({ run: { status: "completed", conclusion: "failure", html_url: "https://x/run" }, record: null });
  assert.equal(v.state, "ended-before-start");
  assert.equal(v.tone, "danger");
  assert.equal(v.done, true);
  assert.equal(v.title, "The run failed before it started syncing");
  assert.match(v.detail, /^Nothing was sent to any student/);
  assert.equal(v.runUrl, "https://x/run");
  assert.equal(describeFollow({ run: { status: "completed", conclusion: "cancelled" } }).title, "The run was cancelled before it started syncing");
});

test("FOLLOW: an unreadable run is unknown and keeps checking - never 'done'", () => {
  const v = describeFollow({ run: null, record: null });
  assert.equal(v.state, "unknown");
  assert.equal(v.done, false);
});

test("FOLLOW: progress while running, and done when the record closes", () => {
  const running = describeFollow({
    run: { status: "in_progress" },
    record: record({ status: "running", total_students: 111, results: Array.from({ length: 40 }, (_, i) => res(`s${i}`, "auto-merged")) }),
  });
  assert.equal(running.state, "running");
  assert.equal(running.done, false);
  assert.deepEqual(running.progress, { reached: 40, total: 111 });

  const closed = describeFollow({ run: { status: "completed", conclusion: "success" }, record: record() });
  assert.equal(closed.state, "completed");
  assert.equal(closed.done, true);
  assert.deepEqual(closed.progress, { reached: 3, total: 3 });

  const stopped = describeFollow({ run: { status: "completed", conclusion: "success" }, record: record({ status: "stopped", remaining: 2, results: [res("ada", "auto-merged")] }) });
  assert.equal(stopped.state, "stopped");
  assert.equal(stopped.done, true);
});

test("FOLLOW: the run ended while its record still says running - the NetAdv case, done", () => {
  const v = describeFollow({
    run: { status: "completed", conclusion: "cancelled" },
    record: record({ status: "running", total_students: 111, results: Array.from({ length: 31 }, (_, i) => res(`s${i}`, "auto-merged")) }),
  });
  assert.equal(v.state, "died");
  assert.equal(v.done, true);
  assert.equal(v.title, "The sync of aaaaaaa by @wesleyhendrikx was cancelled before it finished");
});
