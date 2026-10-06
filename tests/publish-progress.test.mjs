// frontend/src/lib/publish-progress.js: the step a publish is at, read from
// the hub's workflow runs - for the line the editor shows while it waits.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GITHUB_STATUS_URL,
  SLOW_START_MINUTES,
  deployRunsPath,
  newestRun,
  publishRunsPath,
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

test("the paths ask for this lecturer's dispatched publishes, and deploys since it finished", () => {
  const p = publishRunsPath({ owner: "O", repo: "R", since: T("19:42"), actor: "WimBervoetsPXL" });
  assert.match(p, /^\/repos\/O\/R\/actions\/workflows\/publish-assignment\.yml\/runs\?/);
  assert.match(p, /event=workflow_dispatch/);
  assert.match(p, /actor=WimBervoetsPXL/);
  assert.match(decodeURIComponent(p), /created=>=2026-10-06T19:42:00Z/);
  assert.match(decodeURIComponent(deployRunsPath({ owner: "O", repo: "R", since: T("19:46") })), /deploy-frontend\.yml\/runs\?created=>=2026-10-06T19:46:00Z/);
});
