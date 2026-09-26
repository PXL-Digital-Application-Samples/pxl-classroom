#!/usr/bin/env node
// PXL Classroom - LIVE: "Grade this commit now" against real GitHub
// (lib/grade-dispatch.mjs, RegradeCommitModal.vue). Not part of `npm test`.
//
//   node tests/live/grade-dispatch.mjs
//
// A repository on pxl-classroom-testbed carries the workflow PXL Classroom
// generates (buildStarterWorkflow, gated on "hand in"), its check replaced by
// one that passes only when verdict.txt says "pass". Two commits:
//
//   old  "work in progress", verdict pass  - the gate skipped it: no result
//   tip  "hand in",          verdict fail  - graded 0/10
//
//   1 dispatching the OLD commit scores 10/10 - so the hand-in gate let the
//     dispatch through, and the chosen commit (not the tip) was checked out
//   2 where the run lands: measured, not assumed - its head_sha, and whether
//     the old commit's own check runs gained the result (the reason the
//     decision stores the run id)
//   3 readRunScore refuses the run for any other commit
//   4 gradeStudent with a submission_sha + run_id decision reads 10/10
//   5 a workflow WITHOUT the entry (pxl-handin-probe, left by hand-in-cap.mjs)
//     is refused with the message that says to sync

import { parse, stringify } from "yaml";
import { buildStarterWorkflow } from "../../lib/starter-workflow.mjs";
import { dispatchGrading, findGradingWorkflow, readRunScore } from "../../lib/grade-dispatch.mjs";
import { gradeStudent, readScoreAtCommit } from "../../lib/grade-cohort.mjs";
import { CHOSEN_COMMIT, decisionEntry } from "../../lib/grade-override.mjs";
import { validateAgainst } from "../../lib/validate.mjs";
import { api, die, loadEnv, reporter, sleep } from "./live-kit.mjs";

const env = loadEnv();
const org = process.env.PROBE_ORG || "pxl-classroom-testbed";
const token = env.TEST_LECTURER_TOKEN;
if (!token) die("TEST_LECTURER_TOKEN is required (.env.test)");
const REPO = "pxl-grade-dispatch-probe";
const FULL = `${org}/${REPO}`;
const MARKER = "hand in";
const r = reporter();
const request = (method, path, body) => api(path, { token, method, body });

async function must(res, what) {
  if (!res.ok) die(`${what}: HTTP ${res.status} ${res.data?.message ?? ""}`);
  return res.data;
}

function workflow() {
  const doc = parse(buildStarterWorkflow({ handInMessage: MARKER }));
  const step = doc.jobs["run-autograding-tests"].steps.find((s) => s.id === "example");
  step.with.command = "grep -qx pass verdict.txt";
  return stringify(doc);
}

async function ensureRepo() {
  const got = await api(`/repos/${FULL}`, { token });
  if (got.ok) return;
  if (got.status !== 404) die(`could not read ${FULL}: HTTP ${got.status}`);
  await must(await api(`/orgs/${org}/repos`, { token, method: "POST", body: { name: REPO, private: true, auto_init: true, description: "tests/live/grade-dispatch.mjs" } }), `create ${FULL}`);
  r.note(`created ${FULL}`);
}

async function commit(files, parent, message) {
  const tree = await must(await api(`/repos/${FULL}/git/trees`, {
    token, method: "POST",
    body: { tree: Object.entries(files).map(([path, content]) => ({ path, mode: "100644", type: "blob", content })) },
  }), "tree");
  const who = { name: "Probe Student", email: "probe@example.invalid", date: new Date().toISOString() };
  return (await must(await api(`/repos/${FULL}/git/commits`, {
    token, method: "POST", body: { message, tree: tree.sha, parents: parent ? [parent] : [], author: who, committer: who },
  }), "commit")).sha;
}
const push = async (sha) =>
  must(await api(`/repos/${FULL}/git/refs/heads/main`, { token, method: "PATCH", body: { sha, force: true } }), `push ${sha.slice(0, 7)}`);

async function waitFor(what, fn, ms = 10 * 60_000) {
  for (let waited = 0; waited < ms; waited += 10_000) {
    await sleep(10_000);
    const v = await fn();
    if (v) return v;
  }
  die(`${what} did not happen in ${ms / 60_000} minutes`);
}

async function main() {
  console.log(`\nGrade-dispatch probe - ${FULL}\n`);
  await ensureRepo();
  const files = { ".github/workflows/classroom.yml": workflow(), "notes.md": `probe ${new Date().toISOString()}\n` };
  const old = await commit({ ...files, "verdict.txt": "pass\n" }, null, "work in progress");
  await push(old);
  await sleep(8_000);
  const tip = await commit({ ...files, "verdict.txt": "fail\n" }, old, MARKER);
  await push(tip);
  r.ok(`pushed old ${old.slice(0, 7)} (work in progress, pass) and tip ${tip.slice(0, 7)} (hand in, fail)`);
  await waitFor("both push runs", async () => {
    const runs = (await must(await request("GET", `/repos/${FULL}/actions/runs?event=push&per_page=20`), "runs")).workflow_runs;
    const mine = runs.filter((x) => x.head_sha === old || x.head_sha === tip);
    return mine.length >= 2 && mine.every((x) => x.status === "completed");
  });
  const marker = { type: "commit_message", value: MARKER, multiple: true };
  const before = await readScoreAtCommit(request, { repoFullName: FULL, sha: old, marker, fallbackTotal: 10 });
  if (before.verdict !== "graded") r.ok(`the old commit has no result before: ${before.verdict} (${before.reason})`);
  else r.bad("the old commit already had a result - the setup is wrong");

  const found = await findGradingWorkflow(request, { repo: FULL });
  if (found.ok && found.available) r.ok(`found ${found.path} with the entry`);
  else die(`findGradingWorkflow: ${JSON.stringify(found)}`);

  // 1
  const started = await dispatchGrading(request, { repo: FULL, workflowId: found.workflowId, sha: old });
  if (!started.ok) die(`dispatch: ${started.reason}`);
  r.ok(`dispatched: GitHub named run ${started.runId}`);
  const run = await waitFor("the dispatched run", async () => {
    const x = await must(await request("GET", `/repos/${FULL}/actions/runs/${started.runId}`), "run");
    return x.status === "completed" ? x : null;
  });
  const read = await readRunScore(request, { repoFullName: FULL, runId: started.runId, sha: old, fallbackTotal: 10 });
  if (read.verdict === "graded" && read.parsed.earned === 10) r.ok(`1 the old commit scored ${read.parsed.earned}/${read.parsed.total} - gate passed, chosen commit checked out`);
  else r.bad(`1 readRunScore: ${read.verdict} ${read.reason ?? JSON.stringify(read.parsed)}`);

  // 2
  r.note(`2 run ${run.id}: event ${run.event}, title "${run.display_title}", head_sha ${run.head_sha.slice(0, 7)} (${run.head_sha === tip ? "the TIP" : run.head_sha === old ? "the chosen commit" : "other"})`);
  const after = await readScoreAtCommit(request, { repoFullName: FULL, sha: old, marker, fallbackTotal: 10 });
  r.note(`2 the old commit's own check runs afterwards: ${after.verdict}${after.parsed ? ` ${after.parsed.earned}/${after.parsed.total}` : ""}`);
  if (after.verdict === "graded") r.note("2 the result IS on the old commit too - run_id is belt and braces");
  else r.ok("2 the result is NOT on the old commit - which is why the decision stores the run");

  // 2b - measured: the dispatched run's check run is listed on the TIP, newest
  // first. Grading by the rules must still read the tip's own push result.
  const tipRuns = await must(await request("GET", `/repos/${FULL}/commits/${tip}/check-runs`), "tip check runs");
  r.note(`2b the tip's check runs: ${tipRuns.check_runs.map((c) => `${c.conclusion}@suite ${c.check_suite?.id}`).join(", ")}`);
  const byRules = await readScoreAtCommit(request, { repoFullName: FULL, sha: tip, marker, fallbackTotal: 10 });
  if (byRules.verdict === "graded" && byRules.parsed.earned === 0) r.ok("2b the tip, by the rules, still reads its own 0/10");
  else r.bad(`2b the tip by the rules read ${byRules.verdict} ${byRules.parsed ? `${byRules.parsed.earned}/${byRules.parsed.total}` : byRules.reason}`);

  // 3
  const wrong = await readRunScore(request, { repoFullName: FULL, runId: started.runId, sha: tip, fallbackTotal: 10 });
  if (wrong.verdict === "no-run") r.ok(`3 the run is refused for the tip: ${wrong.reason}`);
  else r.bad(`3 the run was accepted for another commit: ${wrong.verdict}`);

  // 4
  const doc = { schema_version: 1, assignment_id: "grade-dispatch-probe", github_login: "probe", overrides: [decisionEntry({ type: CHOSEN_COMMIT, value: old, reason: "live probe", by: "tomcoolpxl", runId: started.runId })] };
  const v = validateAgainst("override", doc);
  if (!v.valid) r.bad(`4 the decision fails its schema: ${JSON.stringify(v.errors)}`);
  const graded = await gradeStudent(request, { row: { github_login: "probe", repo_name: FULL, latest_observed_sha: tip }, marker, overrides: [doc], fallbackTotal: 10 });
  if (graded.verdict === "graded" && graded.parsed.earned === 10 && graded.sha === old) r.ok("4 gradeStudent read the decision's run: 10/10 on the old commit");
  else r.bad(`4 gradeStudent: ${graded.verdict} ${graded.reason ?? ""}`);

  // 5
  const legacy = `${org}/pxl-handin-probe`;
  const lf = await findGradingWorkflow(request, { repo: legacy });
  if (!lf.ok || !lf.workflowId) r.note(`5 skipped: ${legacy} has no grading workflow (${lf.reason})`);
  else {
    if (lf.available === false) r.ok(`5 ${legacy}: found, and correctly NOT available`);
    else r.bad(`5 ${legacy}: reported available`);
    const refused = await dispatchGrading(request, { repo: legacy, workflowId: lf.workflowId, sha: old });
    if (!refused.ok && /Sync Starter Code/.test(refused.reason)) r.ok(`5 dispatching it anyway: HTTP ${refused.status} - "${refused.reason}"`);
    else r.bad(`5 dispatching it anyway: ${JSON.stringify(refused)}`);
  }

  console.log(`\n${r.failures() ? `${r.failures()} FAILED` : "all good"}\n`);
  process.exit(r.failures() ? 1 : 0);
}

main().catch((e) => die(e.stack || String(e)));
