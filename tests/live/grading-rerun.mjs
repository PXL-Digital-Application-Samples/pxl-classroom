#!/usr/bin/env node
// PXL Classroom - LIVE: what GitHub's re-run actually does to a grading run,
// which is what the "Run grading again" button (RegradeCommitModal.vue) and
// lib/grading-rerun.mjs rely on. Not part of `npm test`.
//
//   node tests/live/grading-rerun.mjs
//
// Needs pxl-classroom-testbed/pxl-handin-probe as tests/live/hand-in-cap.mjs
// leaves it: a grading workflow gated on "hand in", a non-hand-in commit
// ("work in progress") whose job skipped, and hand-ins whose job ran.
//
//   1 a run whose gated job SKIPPED, re-run  -> skips again (so the button is
//     never offered for it: rerunAvailability says why)
//   2 a hand-in run, re-run                  -> runs again and scores again,
//     and the commit's check runs then show the new attempt
//
// Checks each against what rerunAvailability predicted from the same reads.

import { rerunAvailability } from "../../lib/grading-rerun.mjs";
import { messageMatchesMarker } from "../../lib/submission-marker.mjs";
import { api, die, loadEnv, reporter, sleep } from "./live-kit.mjs";

const env = loadEnv();
const org = process.env.PROBE_ORG || "pxl-classroom-testbed";
const token = env.TEST_LECTURER_TOKEN;
if (!token) die("TEST_LECTURER_TOKEN is required (.env.test)");
const FULL = `${org}/pxl-handin-probe`;
const marker = { value: "hand in" };
const r = reporter();

const get = async (p) => (await api(p, { token })).data;

async function jobConclusions(runId) {
  const jobs = await get(`/repos/${FULL}/actions/runs/${runId}/jobs?filter=latest`);
  return (jobs?.jobs || []).map((j) => j.conclusion);
}

async function rerunAndWait(run) {
  const before = run.run_attempt || 1;
  const res = await api(`/repos/${FULL}/actions/runs/${run.id}/rerun`, { token, method: "POST" });
  if (res.status !== 201) die(`rerun ${run.id}: HTTP ${res.status} ${res.data?.message ?? ""}`);
  for (let waited = 0; waited < 8 * 60_000; waited += 5_000) {
    await sleep(5_000);
    const now = await get(`/repos/${FULL}/actions/runs/${run.id}`);
    if (now?.run_attempt > before && now.status === "completed") return now;
  }
  die(`run ${run.id} did not finish its re-run in 8 minutes`);
}

async function main() {
  const all = (await get(`/repos/${FULL}/actions/runs?event=push&per_page=100`))?.workflow_runs || [];
  if (!all.length) die(`${FULL} has no runs - run tests/live/hand-in-cap.mjs first`);
  const skipped = all.find((x) => !messageMatchesMarker(x.head_commit?.message, marker) && x.status === "completed");
  const handIn = all.find((x) => messageMatchesMarker(x.head_commit?.message, marker) && x.status === "completed");
  if (!skipped || !handIn) die("need one non-hand-in run and one hand-in run");

  // 1 - the gate skips again
  const predictedSkip = rerunAvailability({ runs: [skipped], marker, isHandIn: false });
  if (!predictedSkip.can) r.ok(`1 prediction: not offered - "${predictedSkip.why}"`);
  else r.bad("1 prediction: offered a re-run for a skipped hand-in gate");
  const again = await rerunAndWait(skipped);
  const c1 = await jobConclusions(again.id);
  // NOT `c1.every(...)` alone: a re-run that lists no jobs makes that vacuously
  // true. The run's own conclusion is the evidence; the jobs, if listed, must agree.
  const skippedAgain = again.conclusion === "skipped" && c1.every((c) => c === "skipped");
  if (skippedAgain) r.ok(`1 measured: re-run ${again.id} (attempt ${again.run_attempt}) concluded "${again.conclusion}", jobs [${c1}]`);
  else r.bad(`1 measured: re-run of a skipped gate concluded "${again.conclusion}", jobs [${c1}] - the prediction is wrong`);

  // 2 - a hand-in re-run grades again
  const predicted = rerunAvailability({ runs: [handIn], marker, isHandIn: true });
  if (predicted.can && predicted.runId === handIn.id) r.ok(`2 prediction: re-run offered for run ${handIn.id}`);
  else r.bad(`2 prediction: ${JSON.stringify(predicted)}`);
  const graded = await rerunAndWait(handIn);
  const c2 = await jobConclusions(graded.id);
  if (c2.includes("success")) r.ok(`2 measured: re-run ${graded.id} (attempt ${graded.run_attempt}) graded again - [${c2}]`);
  else r.bad(`2 measured: re-run concluded [${c2}]`);
  const checks = (await get(`/repos/${FULL}/commits/${handIn.head_sha}/check-runs`))?.check_runs || [];
  const grading = checks.find((c) => /grad/i.test(c.name));
  if (grading && Date.parse(grading.completed_at) >= Date.parse(graded.run_started_at || graded.updated_at) - 60_000) {
    r.ok(`2 measured: the commit's latest check run is the new attempt (${grading.conclusion}, ${grading.completed_at})`);
  } else {
    r.bad(`2 measured: the commit's check run is not the new attempt: ${JSON.stringify(grading && { c: grading.conclusion, at: grading.completed_at })}`);
  }

  console.log(`\n${r.failures() ? `${r.failures()} FAILED` : "all good"}\n`);
  process.exit(r.failures() ? 1 : 0);
}

main().catch((e) => die(e.stack || String(e)));
