// R6-6 (review 2026-10-15): a student's re-run of a grading run is not a score.
// The shapes are the measured ones (tests/live/rerun-attempts.mjs): a re-run's
// check run is in the SAME check suite with a higher id, `filter=all` lists
// every attempt, `/attempts/{k}` names who started it, `/attempts/{k}/jobs`
// carries each job's check run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { countedGradingRun, getAllCheckRuns, latestCheckRuns } from "../lib/grading-attempt.mjs";
import { readScoreAtCommit } from "../lib/grade-cohort.mjs";
import { readRunScore } from "../lib/grade-dispatch.mjs";
import { repoFiles } from "./repo-files.mjs";

const REPO = "Org/exam-ann";
const SHA = "a".repeat(40);
const SUITE = 500;
const RUN = 9000;
const user = (login) => ({ login, type: "User" });

const check = (id, points, extra = {}) => ({
  id, name: "grading", status: "completed", conclusion: "success", check_suite: { id: SUITE },
  output: { title: `Points ${points}/10`, annotations_count: 0 }, ...extra,
});

/**
 * A fake over attempts: `attempts` is [{ by, checkId }], oldest first; the
 * listing of the commit holds every attempt's check run, newest first.
 */
function fake({ attempts, collaborators = ["ann"], collaboratorsStatus = 200, extraChecks = [], points = {} }) {
  const calls = [];
  const checks = [...attempts].reverse().map((a) => check(a.checkId, points[a.checkId] ?? a.checkId % 10));
  const request = async (_m, path) => {
    calls.push(path);
    if (path === `/repos/${REPO}/commits/${SHA}/check-runs?filter=all&per_page=100`) {
      return { ok: true, status: 200, data: { check_runs: [...checks, ...extraChecks] } };
    }
    if (path.startsWith(`/repos/${REPO}/actions/runs?head_sha=`)) return { ok: true, status: 200, data: { workflow_runs: [] } };
    if (path === `/repos/${REPO}/actions/runs?check_suite_id=${SUITE}&per_page=1`) {
      const last = attempts.length;
      return { ok: true, status: 200, data: { workflow_runs: [{ id: RUN, run_attempt: last, triggering_actor: attempts[last - 1].by, check_suite_id: SUITE }] } };
    }
    const at = path.match(new RegExp(`^/repos/${REPO}/actions/runs/${RUN}/attempts/(\\d+)(/jobs\\?per_page=100)?$`));
    if (at) {
      const a = attempts[Number(at[1]) - 1];
      if (at[2]) {
        const jobs = a.checkId ? [{ id: a.checkId, check_run_url: `https://api.github.com/repos/${REPO}/check-runs/${a.checkId}` }] : [];
        return { ok: true, status: 200, data: { jobs } };
      }
      return { ok: true, status: 200, data: { triggering_actor: a.by } };
    }
    if (path === `/repos/${REPO}/collaborators?affiliation=direct&per_page=100`) {
      return collaboratorsStatus === 200
        ? { ok: true, status: 200, data: collaborators.map((login) => ({ login })) }
        : { ok: false, status: collaboratorsStatus, data: { message: "nope" } };
    }
    return { ok: false, status: 404, data: null };
  };
  return { request, calls, checks: [...checks, ...extraChecks] };
}

test("no re-run: the grading check run, and nothing else is read", async () => {
  const f = fake({ attempts: [{ by: user("ann"), checkId: 11 }] });
  const out = await countedGradingRun(f.request, { repoFullName: REPO, checkRuns: f.checks, students: ["ann"] });
  assert.equal(out.ok, true);
  assert.equal(out.run.id, 11);
  assert.deepEqual(out.ignored, []);
  assert.equal(f.calls.length, 0, "the ordinary case costs no request");
});

test("THE CASE: a student's re-run is not read - the run their push started is", async () => {
  const f = fake({ attempts: [{ by: user("ann"), checkId: 11 }, { by: user("Ann"), checkId: 22 }] });
  const out = await countedGradingRun(f.request, { repoFullName: REPO, checkRuns: f.checks, students: ["ann"] });
  assert.equal(out.run.id, 11);
  assert.deepEqual(out.ignored, [{ attempt: 2, by: "Ann" }]);
  assert.ok(!f.calls.some((c) => c.includes("/collaborators")), "the row's own student needs no collaborator read");
});

test("a lecturer's re-run counts: a person who is not on the repository", async () => {
  const f = fake({ attempts: [{ by: user("ann"), checkId: 11 }, { by: user("lecturer1"), checkId: 22 }] });
  const out = await countedGradingRun(f.request, { repoFullName: REPO, checkRuns: f.checks, students: ["ann"] });
  assert.equal(out.run.id, 22);
  assert.deepEqual(out.ignored, []);
});

test("a friend the student invited, and a bot, do not count", async () => {
  const friend = fake({ attempts: [{ by: user("ann"), checkId: 11 }, { by: user("friend"), checkId: 22 }], collaborators: ["ann", "friend"] });
  assert.equal((await countedGradingRun(friend.request, { repoFullName: REPO, checkRuns: friend.checks, students: ["ann"] })).run.id, 11);
  // A workflow pushed to another branch can re-run grading with GITHUB_TOKEN.
  const bot = fake({ attempts: [{ by: user("ann"), checkId: 11 }, { by: { login: "github-actions[bot]", type: "Bot" }, checkId: 22 }] });
  assert.equal((await countedGradingRun(bot.request, { repoFullName: REPO, checkRuns: bot.checks, students: ["ann"] })).run.id, 11);
  // ...and no actor at all is nobody known.
  const none = fake({ attempts: [{ by: user("ann"), checkId: 11 }, { by: null, checkId: 22 }] });
  assert.equal((await countedGradingRun(none.request, { repoFullName: REPO, checkRuns: none.checks, students: ["ann"] })).run.id, 11);
});

test("three attempts: the newest that counts wins, older ones are not walked past it", async () => {
  const f = fake({ attempts: [
    { by: user("ann"), checkId: 11 },
    { by: user("lecturer1"), checkId: 22 },
    { by: user("ann"), checkId: 33 },
  ] });
  const out = await countedGradingRun(f.request, { repoFullName: REPO, checkRuns: f.checks, students: ["ann"] });
  assert.equal(out.run.id, 22);
  assert.deepEqual(out.ignored, [{ attempt: 3, by: "ann" }]);
});

test("an attempt that did not run the grading job again leaves an older one's result", async () => {
  // "Re-run failed jobs" by a lecturer, the grading job not among them.
  const f = fake({ attempts: [{ by: user("ann"), checkId: 11 }, { by: user("ann"), checkId: 22 }, { by: user("lecturer1"), checkId: null }] });
  const checks = f.checks.filter((c) => c.id);
  const out = await countedGradingRun(f.request, { repoFullName: REPO, checkRuns: checks, students: ["ann"] });
  assert.equal(out.run.id, 11, "attempt 3 has no grading job, attempt 2 is the student's");
});

test("who started it could not be read: a failed read, never a guess either way", async () => {
  const f = fake({ attempts: [{ by: user("ann"), checkId: 11 }, { by: user("someone"), checkId: 22 }], collaboratorsStatus: 502 });
  const out = await countedGradingRun(f.request, { repoFullName: REPO, checkRuns: f.checks, students: ["ann"] });
  assert.equal(out.ok, false);
  assert.equal(out.status, 502);
});

test("latestCheckRuns keeps the newest per job, in the listing's order", () => {
  const runs = [
    { id: 30, name: "grading", check_suite: { id: 1 } },
    { id: 5, name: "lint", check_suite: { id: 2 } },
    { id: 10, name: "grading", check_suite: { id: 1 } },
    { id: 7, name: "grading", check_suite: { id: 3 } },
  ];
  assert.deepEqual(latestCheckRuns(runs).map((r) => r.id), [30, 5, 7]);
});

test("readScoreAtCommit scores the push's run under a student's re-run, and names one that left nothing else", async () => {
  const f = fake({ attempts: [{ by: user("ann"), checkId: 11 }, { by: user("ann"), checkId: 22 }], points: { 11: 3, 22: 10 } });
  const out = await readScoreAtCommit(f.request, { repoFullName: REPO, sha: SHA, fallbackTotal: 10, students: ["ann"] });
  assert.equal(out.verdict, "graded");
  assert.equal(out.parsed.earned, 3, "the run the push started, not the re-run's 10");

  // Attempt 1 holds no grading result (its job is gone): the re-run's is the
  // only one, and it still does not count.
  const g = fake({ attempts: [{ by: user("ann"), checkId: null }, { by: user("ann"), checkId: 22 }] });
  const only = await readScoreAtCommit(g.request, { repoFullName: REPO, sha: SHA, fallbackTotal: 10, students: ["ann"] });
  assert.equal(only.verdict, "no-run");
  assert.match(only.reason, /started again by ann, which does not count/);
});

test("readRunScore: a student's re-run of a lecturer's dispatch is not read, and does not hold it as running", async () => {
  const calls = [];
  const request = async (_m, path) => {
    calls.push(path);
    if (path === `/repos/${REPO}/actions/runs/${RUN}`) {
      return { ok: true, status: 200, data: { id: RUN, event: "workflow_dispatch", display_title: `Grade ${SHA} (PXL Classroom)`, status: "in_progress", run_attempt: 2, check_suite_id: SUITE, triggering_actor: user("ann"), html_url: "https://x/run" } };
    }
    if (path === `/repos/${REPO}/check-suites/${SUITE}/check-runs?filter=all&per_page=100`) {
      return { ok: true, status: 200, data: { check_runs: [
        { ...check(22, 10), status: "in_progress", conclusion: null },
        check(11, 4),
      ] } };
    }
    if (path === `/repos/${REPO}/actions/runs?check_suite_id=${SUITE}&per_page=1`) {
      return { ok: true, status: 200, data: { workflow_runs: [{ id: RUN, run_attempt: 2, triggering_actor: user("ann") }] } };
    }
    if (path === `/repos/${REPO}/actions/runs/${RUN}/attempts/1/jobs?per_page=100`) return { ok: true, status: 200, data: { jobs: [{ id: 11 }] } };
    return { ok: false, status: 404, data: null };
  };
  const out = await readRunScore(request, { repoFullName: REPO, runId: RUN, sha: SHA, fallbackTotal: 10, students: ["ann"] });
  assert.equal(out.verdict, "graded", JSON.stringify(out));
  assert.equal(out.parsed.earned, 4);
});

test("R6-43: one page is not the list - the grading check on page 2 of a commit's check runs is read", async () => {
  // 100 other checks first (a busy commit, re-run often), the grading one after.
  const other = Array.from({ length: 100 }, (_, i) => ({ id: 1000 + i, name: `lint-${i}`, status: "completed", conclusion: "success", check_suite: { id: 7 }, output: {} }));
  const base = `/repos/${REPO}/commits/${SHA}/check-runs?filter=all&per_page=100`;
  const calls = [];
  const request = async (_m, path) => {
    calls.push(path);
    if (path === base) return { ok: true, status: 200, data: { total_count: 101, check_runs: other } };
    if (path === `${base}&page=2`) return { ok: true, status: 200, data: { total_count: 101, check_runs: [check(11, 6)] } };
    if (path.startsWith(`/repos/${REPO}/actions/runs?head_sha=`)) return { ok: true, status: 200, data: { workflow_runs: [] } };
    if (path === `/repos/${REPO}/actions/runs?check_suite_id=${SUITE}&per_page=1`) {
      return { ok: true, status: 200, data: { workflow_runs: [{ id: RUN, run_attempt: 1, triggering_actor: user("ann") }] } };
    }
    return { ok: false, status: 404, data: null };
  };
  const out = await readScoreAtCommit(request, { repoFullName: REPO, sha: SHA, fallbackTotal: 10, students: ["ann"] });
  assert.equal(out.verdict, "graded", JSON.stringify(out));
  assert.equal(out.parsed.earned, 6);
  assert.ok(calls.includes(`${base}&page=2`));

  // A page that fails is the read's failure, never "no CI run".
  const broken = async (m, path) => (path === `${base}&page=2` ? { ok: false, status: 502, data: { message: "Bad Gateway" } } : request(m, path));
  const failed = await readScoreAtCommit(broken, { repoFullName: REPO, sha: SHA, fallbackTotal: 10, students: ["ann"] });
  assert.equal(failed.verdict, "api-failed");
  assert.match(failed.reason, /HTTP 502/);
});

test("getAllCheckRuns: a short first page is the whole list, asked once; past its cap it is not a list", async () => {
  let asked = 0;
  const one = await getAllCheckRuns(async () => { asked++; return { ok: true, status: 200, data: { check_runs: [check(1, 1)] } }; }, "/x?per_page=100");
  assert.deepEqual([one.ok, one.data.check_runs.length, asked], [true, 1, 1]);
  const full = Array.from({ length: 100 }, (_, i) => check(i, 1));
  const endless = await getAllCheckRuns(async () => ({ ok: true, status: 200, data: { check_runs: full } }), "/x?per_page=100");
  assert.equal(endless.ok, false);
  assert.match(endless.data.message, /not all of them could be read/);
});

test("every read of a commit's or a suite's check runs lists every attempt", () => {
  // A read without `filter=all` sees only the newest attempt, which is how a
  // student's re-run became the score. Asked of the code, not of a list.
  const offenders = [];
  let reads = 0;
  for (const file of repoFiles({ under: ["lib", "frontend/src", "scripts", "cli/src", "report", "lockdown"], exts: [".mjs", ".js", ".vue"] })) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/\/(?:commits|check-suites)\/\$\{[^}]+\}\/check-runs[^`'"]*/g)) {
      reads++;
      if (!m[0].includes("filter=all")) offenders.push(`${relative(process.cwd(), file)}: ${m[0]}`);
    }
  }
  // readScoreAtCommit, countedRunAtCommit and readRunScore at least: a sweep
  // that matches nothing passes over anything.
  assert.ok(reads >= 3, `found ${reads} reads`);
  assert.deepEqual(offenders, []);
});
