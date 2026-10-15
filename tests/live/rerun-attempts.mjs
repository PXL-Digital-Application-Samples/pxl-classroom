#!/usr/bin/env node
// PXL Classroom - LIVE: a re-run of a grading run is not a hand-in (R6-6,
// review 2026-10-15). What lib/grading-attempt.mjs relies on, measured against
// real GitHub, then its decision on the same data. Not part of `npm test`.
//
//   node tests/live/rerun-attempts.mjs
//
// Needs pxl-classroom-testbed/pxl-handin-probe as tests/live/hand-in-cap.mjs
// leaves it (a completed "hand in" run whose grading job succeeded), with
// student1 a collaborator on it.
//
//   1 student1 re-runs it        -> 201: a student CAN start grading again
//   2 the commit's listing       -> the default shows only the new attempt,
//                                   `filter=all` both, in ONE check suite
//   3 /attempts/{k}              -> names who started each attempt, and its
//                                   jobs carry the check run ids
//   4 countedGradingRun          -> the earlier attempt's check run, the
//                                   student's named as not counted - with the
//                                   student passed in, and with nobody passed
//                                   in (a direct collaborator is caught too)
//   5 lecturer1 re-runs it       -> counted: a person not on the repository
//   6 readScoreAtCommit          -> graded from the lecturer's attempt

import { countedGradingRun } from "../../lib/grading-attempt.mjs";
import { readScoreAtCommit } from "../../lib/grade-cohort.mjs";
import { accounts, api, die, loadEnv, reporter, sleep } from "./live-kit.mjs";

const env = loadEnv();
const { LECTURER, STUDENT_A } = accounts(env);
if (!LECTURER.token || !STUDENT_A.token) die("TEST_LECTURER_TOKEN and TEST_STUDENT1_TOKEN are required (.env.test)");
const org = process.env.PROBE_ORG || "pxl-classroom-testbed";
const FULL = `${org}/pxl-handin-probe`;
const r = reporter();
const done = () => {
  console.log(`\n${r.failures() ? `${r.failures()} FAILED` : "all good"}\n`);
  process.exit(r.failures() ? 1 : 0);
};

const request = async (method, path) => api(path, { token: LECTURER.token, method });
const get = async (path) => (await request("GET", path)).data;

async function rerunAndWait(runId, token, who) {
  const before = (await get(`/repos/${FULL}/actions/runs/${runId}`))?.run_attempt ?? 1;
  const res = await api(`/repos/${FULL}/actions/runs/${runId}/rerun`, { token, method: "POST" });
  if (res.status !== 201) {
    r.bad(`${who} re-run: HTTP ${res.status} ${res.data?.message ?? ""}`);
    return null;
  }
  r.ok(`${who} re-run: 201`);
  for (let waited = 0; waited < 8 * 60_000; waited += 5_000) {
    await sleep(5_000);
    const now = await get(`/repos/${FULL}/actions/runs/${runId}`);
    if (now?.run_attempt > before && now.status === "completed") return now;
  }
  die(`run ${runId} did not finish its re-run in 8 minutes`);
}

async function main() {
  const runs = (await get(`/repos/${FULL}/actions/runs?event=push&per_page=100`))?.workflow_runs || [];
  const run = runs.find((x) => x.display_title === "hand in" && x.status === "completed" && x.conclusion === "success");
  if (!run) die(`${FULL} has no completed hand-in run - run tests/live/hand-in-cap.mjs first`);
  const sha = run.head_sha;
  const listAll = async () => (await get(`/repos/${FULL}/commits/${sha}/check-runs?filter=all&per_page=100`))?.check_runs || [];
  const grading = (list) => list.filter((c) => c.name === "grading" && c.check_suite?.id === run.check_suite_id);
  const before = grading(await listAll());

  // 1
  const afterStudent = await rerunAndWait(run.id, STUDENT_A.token, `1 student (${STUDENT_A.login})`);
  if (!afterStudent) return done();
  const attempt = afterStudent.run_attempt;

  // 2
  const def = grading((await get(`/repos/${FULL}/commits/${sha}/check-runs`))?.check_runs || []);
  const all = grading(await listAll());
  const studentCheck = all.find((c) => !before.some((b) => b.id === c.id));
  if (def.length === 1 && def[0].id === studentCheck?.id) r.ok(`2 the default listing shows only the new attempt (${def[0].id})`);
  else r.bad(`2 default listing: ${def.map((c) => c.id)} (new ${studentCheck?.id})`);
  if (all.length === before.length + 1 && all.every((c) => c.check_suite?.id === run.check_suite_id)) r.ok(`2 filter=all lists every attempt, one check suite (${all.length})`);
  else r.bad(`2 filter=all: ${all.map((c) => `${c.id}@${c.check_suite?.id}`)}`);

  // 3
  const a = await get(`/repos/${FULL}/actions/runs/${run.id}/attempts/${attempt}`);
  const jobs = (await get(`/repos/${FULL}/actions/runs/${run.id}/attempts/${attempt}/jobs?per_page=100`))?.jobs || [];
  if (a?.triggering_actor?.login === STUDENT_A.login) r.ok(`3 attempt ${attempt} was started by ${a.triggering_actor.login}`);
  else r.bad(`3 attempt ${attempt} started by ${a?.triggering_actor?.login}`);
  if (jobs.some((j) => String(j.check_run_url).endsWith(`/${studentCheck?.id}`))) r.ok(`3 attempt ${attempt}'s jobs carry its check run`);
  else r.bad(`3 attempt ${attempt}'s jobs: ${jobs.map((j) => j.check_run_url)}`);

  // 4
  for (const students of [[STUDENT_A.login], []]) {
    const out = await countedGradingRun(request, { repoFullName: FULL, checkRuns: all, students });
    const label = students.length ? "with the student named" : "with nobody named";
    if (out.ok && out.run && out.run.id !== studentCheck?.id && out.ignored.some((i) => i.by === STUDENT_A.login)) {
      r.ok(`4 ${label}: check run ${out.run.id} counts, the student's ${studentCheck?.id} does not`);
    } else r.bad(`4 ${label}: ${JSON.stringify(out)}`);
  }

  // 5
  const afterLecturer = await rerunAndWait(run.id, LECTURER.token, `5 lecturer (${LECTURER.login})`);
  if (!afterLecturer) return done();
  const all2 = grading(await listAll());
  const lecturerCheck = all2.find((c) => !all.some((b) => b.id === c.id));
  const out5 = await countedGradingRun(request, { repoFullName: FULL, checkRuns: all2, students: [STUDENT_A.login] });
  if (out5.ok && out5.run?.id === lecturerCheck?.id) r.ok(`5 the lecturer's attempt counts (${lecturerCheck.id})`);
  else r.bad(`5 ${JSON.stringify(out5)} (lecturer's ${lecturerCheck?.id})`);

  // 6
  const score = await readScoreAtCommit(request, { repoFullName: FULL, sha, fallbackTotal: 10, students: [STUDENT_A.login] });
  if (score.verdict === "graded" && score.run?.id === lecturerCheck?.id) r.ok(`6 readScoreAtCommit graded ${score.parsed.earned}/${score.parsed.total} from the lecturer's attempt`);
  else r.bad(`6 readScoreAtCommit: ${score.verdict} ${score.reason ?? ""} run ${score.run?.id}`);

  done();
}

main().catch((e) => die(e.stack || String(e)));
