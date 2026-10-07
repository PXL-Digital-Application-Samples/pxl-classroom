// frontend/src/lib/publish-progress.js: the step a publish is at, read from
// the hub's workflow runs - for the line the editor shows while it waits.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GITHUB_STATUS_URL,
  PAGE_MISSING_MINUTES,
  SLOW_START_MINUTES,
  deployRunsPath,
  newestRun,
  publishRunIdFrom,
  publishRunPath,
  publishStage,
  publishStageMessage,
} from "../frontend/src/lib/publish-progress.js";

const T = (hhmm) => Date.parse(`2026-10-06T${hhmm}:00Z`);
const run = (status, conclusion, created, updated = created) => ({
  status, conclusion, created_at: new Date(T(created)).toISOString(), updated_at: new Date(T(updated)).toISOString(),
  html_url: `https://github.com/o/r/actions/runs/${created}`,
});
const stage = (publishRun, deployRun, now) => publishStage({ publishRun, deployRun, now: T(now) });

test("2026-10-06: GitHub had not started the publish - and the line says so, with GitHub's status page", () => {
  // The lecturer's second publish was created 19:45 and started 19:55.
  const s = stage(run("queued", null, "19:45"), null, "19:52");
  assert.deepEqual(s, { step: "waiting-start", minutes: 7, url: "https://github.com/o/r/actions/runs/19:45" });
  const m = publishStageMessage(s);
  assert.equal(m.text, "Waiting for GitHub to start the publish (7 min).");
  assert.equal(m.slow, true, "past the threshold, GitHub's status page goes beside it");
  assert.equal(publishStageMessage(stage(run("queued", null, "19:45"), null, "19:46")).slow, false, "not after one minute");
  assert.equal(SLOW_START_MINUTES, 3);
  assert.match(GITHUB_STATUS_URL, /^https:\/\/www\.githubstatus\.com/);
});

test("every step the publish passes, in the order a lecturer sees them", () => {
  const steps = [
    [run("in_progress", null, "19:29"), null, "publishing", /setting up the assignment/],
    [run("completed", "success", "19:29", "19:30"), null, "waiting-deploy", /Waiting for GitHub to start putting the student page live/],
    [run("completed", "success", "19:29", "19:30"), run("queued", null, "19:30"), "waiting-deploy", /putting the student page live/],
    [run("completed", "success", "19:29", "19:30"), run("in_progress", null, "19:30"), "deploying", /Putting the student page live\./],
    [run("completed", "success", "19:29", "19:30"), run("completed", "failure", "19:40", "19:41"), "deploy-failed", /tried again automatically/],
    [run("completed", "success", "19:29", "19:30"), run("completed", "success", "19:56", "19:57"), "deployed", /can take a minute/],
  ];
  for (const [publishRun, deployRun, step, text] of steps) {
    const s = stage(publishRun, deployRun, "19:58");
    assert.equal(s.step, step);
    assert.match(publishStageMessage(s).text, text);
  }
});

test("a publish that failed says so and links its run; a cancelled deploy waits for the one that replaced it", () => {
  const failed = stage(run("completed", "failure", "19:29", "19:30"), null, "19:31");
  assert.equal(failed.step, "failed");
  assert.equal(failed.url, "https://github.com/o/r/actions/runs/19:29");
  // deploy-frontend.yml cancels the older run for a newer one - not a failure.
  assert.equal(stage(run("completed", "success", "19:29", "19:30"), run("completed", "cancelled", "19:30", "19:40"), "19:41").step, "waiting-deploy");
});

test("nothing read is nothing claimed", () => {
  assert.equal(publishStage({ publishRun: null, deployRun: null }).step, "unknown");
  assert.equal(publishStageMessage({ step: "unknown", minutes: 0 }).text, "Publishing: checking with GitHub.");
  assert.equal(newestRun({ ok: false, data: { message: "Bad credentials" } }), null);
  assert.equal(newestRun({ ok: true, data: {} }), null);
  // Newest by creation, whatever order the list came in.
  const a = run("queued", null, "19:29");
  const b = run("queued", null, "19:45");
  assert.equal(newestRun({ ok: true, data: { workflow_runs: [a, b] } }), b);
});

test("the line follows the run this publish started, by id, and the deploys since it finished", () => {
  // It was "this lecturer's newest publish run": another tab's, another
  // organization's or an earlier failed one could be reported as this one.
  assert.equal(publishRunPath({ owner: "O", repo: "R", runId: "18320775543" }), "/repos/O/R/actions/runs/18320775543");
  assert.match(decodeURIComponent(deployRunsPath({ owner: "O", repo: "R", since: T("19:46") })), /deploy-frontend\.yml\/runs\?created=>=2026-10-06T19:46:00Z/);
  // The id travels in the address after a new assignment's page moves.
  assert.equal(publishRunIdFrom("18320775543"), "18320775543");
  // `1` is the flag for "publishing, no run named" - never run 1.
  for (const nothing of ["1", "", "abc", "12; DROP", "0123456", undefined, ["18320775543"]]) {
    assert.equal(publishRunIdFrom(nothing), null, JSON.stringify(nothing));
  }
});

test("GitHub named no run: said, never a run guessed from a list", () => {
  const s = publishStage({ publishRun: null, deployRun: null, untracked: true });
  assert.equal(s.step, "untracked");
  assert.match(publishStageMessage(s).text, /did not say which run it started/);
});

test("the pages were updated without this assignment's page: said after the CDN's minute, not 'on its way' for half an hour", () => {
  // Called only while this page is not on the site. A deploy that could not
  // read this organization keeps its old pages and still succeeds.
  const published = run("completed", "success", "19:29", "19:30");
  const deployed = run("completed", "success", "19:31", "19:33");
  assert.equal(stage(published, deployed, "19:34").step, "deployed", "a minute: the CDN catching up");
  const late = stage(published, deployed, "19:41");
  assert.deepEqual(late, { step: "deployed-without-page", minutes: 8, url: deployed.html_url });
  assert.equal(publishStageMessage(late).text, "Published, but the student pages were updated 8 min ago without this assignment's page.");
  assert.equal(PAGE_MISSING_MINUTES, 3);
});
