// lib/sync-status.mjs - what the assignment page says about its starter syncs.
//
// On 2026-09-25 two syncs of .NET Advanced were cut off and nothing on screen
// said so. Every state below is one a lecturer can be in, and each sentence
// must come from what was read - including the reads that failed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { describeSyncStatus, newestSyncFile } from "../lib/sync-status.mjs";

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

test("RUNNING and its run is going: progress, and a manual check - never a timer", () => {
  const v = describeSyncStatus({
    record: record({ status: "running", remaining: undefined, total_students: 111, results: Array.from({ length: 40 }, (_, i) => res(`s${i}`, "auto-merged")) }),
    run: { status: "in_progress", html_url: "https://x/run" },
  });
  assert.equal(v.state, "running");
  assert.equal(v.tone, "neutral");
  assert.equal(v.action, "refresh");
  assert.equal(v.title, "Syncing aaaaaaa by @wesleyhendrikx");
  assert.equal(v.detail, "40 of 111 students done so far.");
  assert.equal(v.runUrl, "https://github.com/Hub/pxl-classroom/actions/runs/36152850724");
});

test("RUNNING in the record but the run is OVER: it died, and the lecturer is told to run it again", () => {
  // The exact state .NET Advanced was left in: cut off, nothing recorded after.
  for (const conclusion of ["cancelled", "failure", "timed_out"]) {
    const v = describeSyncStatus({
      record: record({ status: "running", total_students: 111, results: Array.from({ length: 31 }, (_, i) => res(`s${i}`, "auto-merged")) }),
      run: { status: "completed", conclusion },
    });
    assert.equal(v.state, "died", conclusion);
    assert.equal(v.tone, "warning");
    assert.equal(v.action, "sync-again");
    assert.equal(v.title, `The sync of aaaaaaa by @wesleyhendrikx ended (${conclusion}) before it finished`);
    assert.match(v.detail, /^31 of 111 students reached\. Run the sync again/);
  }
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
