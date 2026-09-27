#!/usr/bin/env node
// PXL Classroom - LIVE check of the hand-in cap against real GitHub: real
// pushes, real Actions runs, real check runs with scores. Not part of
// `npm test`.
//
//   node tests/live/hand-in-cap.mjs
//
// A student repository on pxl-classroom-testbed carries a grading workflow
// gated on the hand-in message, as a cloud exam's does, which writes
// `Points N/10` where N is the hand-in's number. Four hand-ins are pushed, one
// push each, plus an ordinary commit. Then the SHARED decision
// (`resolveHandIn`, lib/grade-cohort.mjs - what the Admin Panel, the nightly
// and the CLI all call) and the score read (`readScoreAtCommit`) are asked:
//
//   1 cap          max 2: 4 used of 2, hand-in 2 graded (2/10), 3 and 4 ignored
//   2 exception    +1: hand-in 3 graded (3/10); +5: hand-in 4, the last
//   3 revoked      +0 appended after the grants: back to hand-in 2
//   4 late         deadline between hand-ins 2 and 3, +5 granted: still 2 -
//                  an exception raises the count, never the deadline
//   5 force-push   the branch rewritten without any hand-in: the run history
//                  still counts 4, hand-in 2 is still graded and still scores
//   6 no cap       the same repository without a cap: the last hand-in (4)
//   7 runs deleted every run of hand-in 1 deleted: the push log still counts
//                  it, and hand-in 2 is still graded
//   8 no cap, late the case-4 deadline without a cap: hand-in 2, not 4 - the
//                  uncapped path times by the push too, not the commit date
//   9 log only     hand-in 5, deadline 40s before its logged push: on time
//                  with its runs (allowance), late once they are deleted
//  10 dispatches   student1 dispatches the grading workflow with
//                  grade_sha=main: counted, never graded; the lecturer's
//                  dispatch and the student's dispatch of a non-grading
//                  workflow titled like a PXL one are not counted
//
// Commit dates are set explicitly one minute apart, hours in the past. The
// late case does NOT use them: lateness is when GitHub recorded the push (the
// run's created_at, lib/submission-marker.mjs `handInTime`), so the deadline
// is placed between the runs of hand-ins 2 and 3 - which also proves that a
// commit DATED before the deadline but pushed after it is late.

import { resolveHandIn, readScoreAtCommit } from "../../lib/grade-cohort.mjs";
import { PUSH_TO_RUN_ALLOWANCE_MS, listHandIns, readSubmissionMarker } from "../../lib/submission-marker.mjs";
import { allowanceEntry } from "../../lib/hand-in-allowance.mjs";
import { validateAgainst } from "../../lib/validate.mjs";
import { acceptInvitation, accounts, api, die, loadEnv, reporter, sleep } from "./live-kit.mjs";

const env = loadEnv();
const org = process.env.PROBE_ORG || "pxl-classroom-testbed";
const token = env.TEST_LECTURER_TOKEN;
if (!token) die("TEST_LECTURER_TOKEN is required (.env.test)");
const REPO = "pxl-handin-probe";
const FULL = `${org}/${REPO}`;
const LOGIN = "handin-probe-student";
const MARKER = "hand in";
const r = reporter();
const stamp = new Date().toISOString();

// The grading workflow a cloud exam ships: gated on the hand-in message, job
// named like the autograder (lib/check-run-score.mjs picks /grad|classroom/),
// the score as a notice annotation. No `uses:` - it reads its score with gh.
const WORKFLOW = [
  "name: Grading",
  "on: push",
  "permissions:",
  "  contents: read",
  "jobs:",
  "  grading:",
  "    if: github.event.head_commit.message == 'hand in'",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - name: Score",
  "        env:",
  "          GH_TOKEN: ${{ github.token }}",
  "        run: |",
  "          n=$(gh api \"repos/$GITHUB_REPOSITORY/contents/score.txt?ref=$GITHUB_SHA\" -H 'Accept: application/vnd.github.raw')",
  "          echo \"::notice title=Autograding complete::Points $n/10\"",
  "",
].join("\n");

// A grading workflow a STUDENT can start: dispatch only (so it adds no push
// runs), a `grade_sha` input, the PXL run name, and a checkout of the input in
// the job that grades - what `hasGradeDispatch` recognises.
const DISPATCH_WORKFLOW = [
  "name: Grade on demand",
  "run-name: ${{ format('Grade {0} (PXL Classroom)', inputs.grade_sha) }}",
  "on:",
  "  workflow_dispatch:",
  "    inputs:",
  "      grade_sha:",
  "        description: Commit to grade",
  "        required: true",
  "        type: string",
  "permissions:",
  "  contents: read",
  "jobs:",
  "  regrade:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1",
  "        with:",
  "          ref: ${{ inputs.grade_sha }}",
  "      - run: echo \"::notice title=Autograding complete::Points $(cat score.txt)/10\"",
  "",
].join("\n");

// NOT a grading workflow, though a student can dispatch it and its title is
// exactly the one a PXL dispatch of a full commit gets - so a count that went
// by the title (the code before 85436b9) counts it, and only reading the file
// tells it apart. Job name matches neither /grad|classroom/ nor a checkout of
// the input.
const LINT_WORKFLOW = [
  "name: Lint",
  "run-name: ${{ format('Grade {0} (PXL Classroom)', inputs.grade_sha) }}",
  "on:",
  "  workflow_dispatch:",
  "    inputs:",
  "      grade_sha:",
  "        required: true",
  "        type: string",
  "permissions:",
  "  contents: read",
  "jobs:",
  "  lint:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - run: echo linted",
  "",
].join("\n");

async function must(res, what) {
  if (!res.ok) die(`${what}: HTTP ${res.status} ${res.data?.message ?? ""}`);
  return res.data;
}

const get = async (path) => {
  const res = await api(path, { token });
  return { status: res.status, data: res.data };
};
const request = async (method, path) => api(path, { token, method });

async function ensureRepo() {
  // A FRESH repository every run. The cap counts the push RUN HISTORY as well
  // as the branch (so a force-push cannot reset it), and that history cannot
  // be rewritten: a second run in the same repository counted the first run's
  // four hand-ins too (used 8, measured 2026-09-26). Only this probe's own
  // fixture is deleted.
  const got = await api(`/repos/${FULL}`, { token });
  if (got.ok) {
    if (got.data?.description !== "tests/live/hand-in-cap.mjs") die(`${FULL} exists and is not this probe's fixture - not deleting it`);
    const del = await api(`/repos/${FULL}`, { token, method: "DELETE" });
    if (del.status !== 204) die(`could not delete the previous fixture ${FULL}: HTTP ${del.status} (the token needs delete_repo)`);
    r.note(`deleted the previous ${FULL}`);
  } else if (got.status !== 404) die(`could not read ${FULL}: HTTP ${got.status}`);
  const made = await must(
    await api(`/orgs/${org}/repos`, { token, method: "POST", body: { name: REPO, private: true, auto_init: true, description: "tests/live/hand-in-cap.mjs" } }),
    `create ${FULL}`,
  );
  r.note(`created ${FULL}`);
  return made;
}

async function commit(files, parent, message, date) {
  const tree = await must(
    await api(`/repos/${FULL}/git/trees`, {
      token, method: "POST",
      body: { tree: Object.entries(files).map(([path, content]) => ({ path, mode: "100644", type: "blob", content })) },
    }),
    "tree",
  );
  const who = { name: "Probe Student", email: "probe@example.invalid", date };
  return (await must(await api(`/repos/${FULL}/git/commits`, {
    token, method: "POST", body: { message, tree: tree.sha, parents: parent ? [parent] : [], author: who, committer: who },
  }), "commit")).sha;
}

/** A PUSH: moving the ref is what starts a push run. */
const push = async (sha) =>
  must(await api(`/repos/${FULL}/git/refs/heads/main`, { token, method: "PATCH", body: { sha, force: true } }), `push ${sha.slice(0, 7)}`);

async function waitForRuns(shas, atLeast = shas.length) {
  const want = new Set(shas);
  for (let waited = 0; waited < 10 * 60_000; waited += 10_000) {
    await sleep(10_000);
    const runs = (await must(await api(`/repos/${FULL}/actions/runs?event=push&per_page=100`, { token }), "runs")).workflow_runs;
    const mine = runs.filter((x) => want.has(x.head_sha));
    if (mine.length >= atLeast && mine.every((x) => x.status === "completed")) return mine;
  }
  die(`runs for ${shas.length} pushes did not all complete in 10 minutes`);
}

/** When the push log recorded a push ending on `sha` - polled, the log is not instant. */
async function loggedPushAt(sha) {
  for (let waited = 0; waited < 3 * 60_000; waited += 10_000) {
    const rows = await must(await api(`/repos/${FULL}/activity?ref=refs/heads/main&per_page=100`, { token }), "activity");
    const times = rows.filter((a) => a.after === sha).map((a) => Date.parse(a.timestamp));
    if (times.length) return Math.min(...times);
    await sleep(10_000);
  }
  die(`the push log never named ${sha.slice(0, 7)}`);
}

/**
 * Dispatch `file` as `who` and wait for its run to complete. The run is found
 * by what only it can be: this workflow, this actor, an id not seen before.
 */
async function dispatch(who, file, gradeSha) {
  const listRuns = async () =>
    (await must(await api(`/repos/${FULL}/actions/runs?event=workflow_dispatch&per_page=100`, { token }), "dispatch runs")).workflow_runs;
  const seen = new Set((await listRuns()).map((x) => x.id));
  const res = await api(`/repos/${FULL}/actions/workflows/${file}/dispatches`, {
    token: who.token, method: "POST", body: { ref: "main", inputs: { grade_sha: gradeSha } },
  });
  if (res.status !== 204 && res.status !== 200) die(`${who.login} could not dispatch ${file}: HTTP ${res.status} ${res.data?.message ?? ""}`);
  for (let waited = 0; waited < 10 * 60_000; waited += 10_000) {
    await sleep(10_000);
    const run = (await listRuns()).find((x) =>
      !seen.has(x.id) && String(x.path).endsWith(`/${file}`) && x.triggering_actor?.login?.toLowerCase() === who.login.toLowerCase());
    if (run?.status === "completed") return run;
  }
  die(`${who.login}'s dispatch of ${file} did not complete in 10 minutes`);
}

const row = (over = {}) => ({ github_login: LOGIN, repo_name: FULL, effective_deadline_at: null, ...over });
const overrideDoc = (entries) => {
  const doc = { schema_version: 1, assignment_id: "hand-in-probe", github_login: LOGIN, overrides: entries };
  const v = validateAgainst("override", doc);
  if (!v.valid) die(`override fixture fails its schema: ${JSON.stringify(v.errors)}`);
  return doc;
};
const grant = (extra, at) => allowanceEntry({ extra, reason: `live probe ${extra}`, by: "tomcoolpxl-lecturer1", at });

const markerFor = (cap) =>
  readSubmissionMarker({ submission_marker: { type: "commit_message", value: MARKER, multiple: true, ...(cap ? { max_hand_ins: cap } : {}) } });

async function expectGraded(label, { cap, overrides = null, deadline = null, login = LOGIN, want, used, ignored, score }) {
  const marker = markerFor(cap);
  const res = await resolveHandIn(get, { row: row({ effective_deadline_at: deadline, github_login: login }), marker, overrides });
  const got = res.commit?.sha;
  const problems = [];
  if (res.verdict !== "found") problems.push(`verdict ${res.verdict} (${res.reason})`);
  if (got !== want.sha) problems.push(`graded ${got?.slice(0, 7)}, wanted hand-in ${want.n} ${want.sha.slice(0, 7)}`);
  if (used !== undefined && res.handIns?.used !== used) problems.push(`used ${res.handIns?.used}, wanted ${used}`);
  if (ignored !== undefined) {
    const said = (res.handIns?.ignored || []).map((i) => `${i.sha.slice(0, 7)}:${i.reason}`).sort().join(",");
    const exp = ignored.map(([h, why]) => `${h.sha.slice(0, 7)}:${why}`).sort().join(",");
    if (said !== exp) problems.push(`ignored [${said}], wanted [${exp}]`);
  }
  if (!cap && res.handIns !== null) problems.push("an uncapped assignment reported a hand-in count");
  if (score !== undefined && got) {
    const read = await readScoreAtCommit(request, { repoFullName: FULL, sha: got, marker });
    if (read.verdict !== "graded") problems.push(`score read ${read.verdict}: ${read.reason}`);
    else if (read.parsed.earned !== score || read.parsed.total !== 10) problems.push(`scored ${read.parsed.earned}/${read.parsed.total}, wanted ${score}/10`);
  }
  if (problems.length) r.bad(`${label}: ${problems.join("; ")}`);
  else {
    const c = res.handIns;
    r.ok(`${label}: hand-in ${want.n} graded${score !== undefined ? ` (${score}/10)` : ""}${c ? `, ${c.used} of ${c.allowed} used${c.extra ? ` (+${c.extra})` : ""}, ${c.ignored.length} ignored` : ""}`);
  }
  return res;
}

async function main() {
  console.log(`\nHand-in cap probe - ${FULL}\n`);
  await ensureRepo();

  // Setup, an ordinary commit, then four hand-ins - one push each, a few
  // seconds apart so each run starts after the one before.
  const base = Date.parse("2026-09-26T08:00:00Z");
  const at = (min) => new Date(base + min * 60_000).toISOString();
  let files = {
    ".github/workflows/grading.yml": WORKFLOW,
    ".github/workflows/regrade.yml": DISPATCH_WORKFLOW,
    ".github/workflows/lint.yml": LINT_WORKFLOW,
    "score.txt": "0\n", "notes.md": `probe ${stamp}\n`,
  };
  const setup = await commit(files, null, "setup", at(0));
  await push(setup);
  files = { ...files, "work.md": "work\n" };
  const work = await commit(files, setup, "work in progress", at(1));
  await push(work);
  const H = [];
  let parent = work;
  for (let n = 1; n <= 4; n++) {
    await sleep(8_000);
    files = { ...files, "score.txt": `${n}\n` };
    parent = await commit(files, parent, MARKER, at(1 + n));
    await push(parent);
    H.push({ n, sha: parent, date: at(1 + n) });
  }
  r.ok(`pushed setup, work, and hand-ins ${H.map((h) => h.sha.slice(0, 7)).join(" ")}`);
  const runs = await waitForRuns([setup, work, ...H.map((h) => h.sha)]);
  const graded = runs.filter((x) => H.some((h) => h.sha === x.head_sha) && x.conclusion === "success").length;
  if (graded === 4) r.ok("all four hand-in runs succeeded; the setup and work runs skipped their job");
  else r.bad(`${graded} of 4 hand-in runs succeeded: ${runs.map((x) => `${x.head_sha.slice(0, 7)}:${x.conclusion}`).join(" ")}`);

  const [h1, h2, h3, h4] = H;
  // 1 cap
  await expectGraded("1 cap", { cap: 2, want: h2, used: 4, ignored: [[h3, "over-limit"], [h4, "over-limit"]], score: 2 });
  // 2 exception
  await expectGraded("2 exception +1", { cap: 2, overrides: [overrideDoc([grant(1, at(10))])], want: h3, used: 4, ignored: [[h4, "over-limit"]], score: 3 });
  await expectGraded("2 exception +5", { cap: 2, overrides: [overrideDoc([grant(1, at(10)), grant(5, at(11))])], want: h4, used: 4, ignored: [], score: 4 });
  // 3 revoked
  await expectGraded("3 revoked", { cap: 2, overrides: [overrideDoc([grant(1, at(10)), grant(5, at(11)), grant(0, at(12))])], want: h2, used: 4, ignored: [[h3, "over-limit"], [h4, "over-limit"]], score: 2 });
  // 4 late: deadline between hand-in 2's push and hand-in 3's, as GitHub
  // recorded them (the earliest run of each), less the allowance for a run
  // starting after its push.
  const pushedAt = (h) => Math.min(...runs.filter((x) => x.head_sha === h.sha).map((x) => Date.parse(x.created_at)));
  const between = (pushedAt(h2) + pushedAt(h3)) / 2 - PUSH_TO_RUN_ALLOWANCE_MS;
  if (!(pushedAt(h3) > pushedAt(h2))) r.bad(`4 late: hand-in 3's run did not start after hand-in 2's - cannot place a deadline between them`);
  await expectGraded("4 late + exception", {
    cap: 2, overrides: [overrideDoc([grant(5, at(11))])], deadline: new Date(between).toISOString(), want: h2, used: 2,
    ignored: [[h3, "late"], [h4, "late"]], score: 2,
  });
  // 5 force-push: the branch no longer carries any hand-in.
  await push(await commit({ ...files, "score.txt": "0\n" }, work, "start over", at(20)));
  const after = await expectGraded("5 force-push", { cap: 2, want: h2, used: 4, ignored: [[h3, "over-limit"], [h4, "over-limit"]], score: 2 });
  if (after.commit && after.commit.onBranch === false) r.ok("5 force-push: the graded hand-in is known from its run alone (not on the branch)");
  else r.bad(`5 force-push: graded hand-in onBranch ${after.commit?.onBranch}`);
  // 6 no cap: every hand-in counts and the last one is graded. The run
  // history and the push log are read without a cap too, for the push time
  // lateness is judged by; hand-in 4 is the newest push-ended hand-in either way.
  await push(H[3].sha);
  // Moving the branch back to hand-in 4 is a push and starts a NEW run there,
  // and the score is read from the newest run at a commit: wait for it, or the
  // read finds it in progress (measured 2026-09-27).
  await waitForRuns([H[3].sha], 2);
  await expectGraded("6 no cap", { cap: null, want: h4, score: 4 });
  // 8 no cap, late by push: the same deadline as case 4, between the pushes of
  // hand-ins 2 and 3, while every commit is DATED a day before it. Uncapped
  // grading judged by the commit's own date until ee857b1 and graded hand-in
  // 4; by the push it is hand-in 2. And a deadline before every push but after
  // every commit date is no hand-in at all, with the late one named.
  await expectGraded("8 no cap, late by push", { cap: null, deadline: new Date(between).toISOString(), want: h2, score: 2 });
  {
    const before = new Date(pushedAt(h1) - PUSH_TO_RUN_ALLOWANCE_MS - 60_000).toISOString();
    if (!(Date.parse(h4.date) < Date.parse(before))) r.bad("8 no cap: the commit dates are not before the deadline - the case proves nothing");
    const res = await resolveHandIn(get, { row: row({ effective_deadline_at: before }), marker: markerFor(null) });
    if (res.verdict === "no-commit" && /after the deadline/.test(res.reason)) r.ok(`8 no cap, all pushed late: no hand-in (${res.reason})`);
    else r.bad(`8 no cap, all pushed late: verdict ${res.verdict}, graded ${res.commit?.sha?.slice(0, 7)} (${res.reason ?? ""})`);
  }

  // 7 runs deleted: a repository admin deletes every run of hand-in 1. The
  // push log still says a push ended on it, so it still uses its place and
  // hand-in 2 is still the one graded (2026-09-27).
  const h1Runs = runs.filter((x) => x.head_sha === h1.sha);
  for (const run of h1Runs) {
    const del = await api(`/repos/${FULL}/actions/runs/${run.id}`, { token, method: "DELETE" });
    if (del.status !== 204) r.bad(`7 runs deleted: could not delete run ${run.id} (HTTP ${del.status})`);
  }
  const left = (await must(await api(`/repos/${FULL}/actions/runs?event=push&per_page=100`, { token }), "runs")).workflow_runs;
  if (left.some((x) => x.head_sha === h1.sha)) r.bad("7 runs deleted: hand-in 1 still has a run");
  else r.ok(`7 runs deleted: ${h1Runs.length} run(s) of hand-in 1 are gone`);
  await expectGraded("7 runs deleted", { cap: 2, want: h2, used: 4, ignored: [[h3, "over-limit"], [h4, "over-limit"]], score: 2 });

  // 9 timed by the push log alone: hand-in 5 is pushed, the deadline set 40s
  // BEFORE the log's record of that push. With its runs it is on time - a run
  // is a push plus GitHub's latency, so it gets PUSH_TO_RUN_ALLOWANCE_MS. Its
  // runs deleted, only the log times it, and the log's time is the push: late.
  // Before ba970d4 the allowance came off the log's time too, on time again.
  files = { ...files, "score.txt": "5\n" };
  const h5 = { n: 5, sha: await commit(files, h4.sha, MARKER, at(30)), date: at(30) };
  await push(h5.sha);
  const h5Runs = (await waitForRuns([h5.sha])).filter((x) => x.head_sha === h5.sha);
  const logAt = await loggedPushAt(h5.sha);
  const runAt = Math.min(...h5Runs.map((x) => Date.parse(x.created_at)));
  const justAfter = new Date(logAt - 40_000).toISOString();
  r.note(`9: push log ${new Date(logAt).toISOString()}, first run ${new Date(runAt).toISOString()} (+${(runAt - logAt) / 1000}s), deadline ${justAfter}`);
  if (!(runAt - PUSH_TO_RUN_ALLOWANCE_MS <= logAt - 40_000)) r.bad("9: the run started over 80s after the push - the control below cannot pass");
  await expectGraded("9 log only, control with runs", { cap: null, deadline: justAfter, want: h5, score: 5 });
  for (const run of h5Runs) {
    const del = await api(`/repos/${FULL}/actions/runs/${run.id}`, { token, method: "DELETE" });
    if (del.status !== 204) r.bad(`9: could not delete run ${run.id} (HTTP ${del.status})`);
  }
  {
    const listed = await listHandIns(get, { repoFullName: FULL, branch: "main", marker: markerFor(null), withRuns: true });
    const mine = listed.handIns.find((h) => h.sha === h5.sha);
    if (mine?.pushedFrom === "log" && Date.parse(mine.pushedAt) === logAt) r.ok(`9: hand-in 5 is now timed by the push log alone (${mine.pushedAt})`);
    else r.bad(`9: hand-in 5 is timed ${JSON.stringify({ pushedAt: mine?.pushedAt, pushedFrom: mine?.pushedFrom })}, wanted the log's ${new Date(logAt).toISOString()}`);
  }
  await expectGraded("9 log only, no allowance", { cap: null, deadline: justAfter, want: h4, score: 4 });
  await expectGraded("9 log only, capped", { cap: 10, deadline: justAfter, want: h4, used: 4, ignored: [[h5, "late"]], score: 4 });

  // 10 dispatches. A student who is a collaborator starts the grading
  // workflow with grade_sha=main: titled `Grade main (PXL Classroom)`, which
  // the title-only count before 85436b9 did not recognise. It uses a place and
  // is never the one graded. A lecturer's dispatch is not a hand-in; the
  // student's dispatch of a workflow that does not grade is not one either,
  // even titled exactly like a PXL dispatch of a full commit.
  const { LECTURER, STUDENT_A } = accounts(env);
  if (!STUDENT_A.token || !STUDENT_A.login) die("TEST_STUDENT1_LOGIN / TEST_STUDENT1_TOKEN are required (.env.test)");
  const added = await api(`/repos/${FULL}/collaborators/${STUDENT_A.login}`, { token, method: "PUT", body: { permission: "push" } });
  if (added.status !== 201 && added.status !== 204) die(`could not add ${STUDENT_A.login}: HTTP ${added.status} ${added.data?.message ?? ""}`);
  await acceptInvitation({ student: STUDENT_A, repoName: REPO }, r);
  const S = STUDENT_A.login;
  const dispatchedRunIds = async (students) =>
    (await listHandIns(get, { repoFullName: FULL, branch: "main", marker: markerFor(10), withRuns: true, students }))
      .handIns.filter((h) => h.dispatched).map((h) => h.run_id);
  // Hand-in 5's own runs were deleted in case 9, so no score is read at it here.
  await expectGraded("10 before any dispatch", { cap: 10, login: S, want: h5, used: 5, ignored: [] });

  const byStudent = await dispatch(STUDENT_A, "regrade.yml", "main");
  if (byStudent.display_title === "Grade main (PXL Classroom)" && byStudent.head_sha === h5.sha) {
    r.ok(`10 student dispatch: run ${byStudent.id} "${byStudent.display_title}" on ${h5.sha.slice(0, 7)} - a title no full-commit match reads`);
  } else r.bad(`10 student dispatch: title "${byStudent.display_title}", head ${byStudent.head_sha?.slice(0, 7)}`);
  // Hand-in 5 is late by nothing here (no deadline), so it is the last pushed
  // one and graded... except that selectHandIn never grades a dispatch, and
  // the dispatch names hand-in 5's commit: graded stays hand-in 5.
  await expectGraded("10 student dispatch counts", { cap: 10, login: S, want: h5, used: 6, ignored: [[h5, "self-dispatched"]] });

  const byLecturer = await dispatch(LECTURER, "regrade.yml", "main");
  await expectGraded("10 lecturer dispatch does not count", { cap: 10, login: S, want: h5, used: 6, ignored: [[h5, "self-dispatched"]] });
  const asLecturer = await dispatchedRunIds([LECTURER.login]);
  if (asLecturer.length === 1 && asLecturer[0] === byLecturer.id) r.ok(`10 control: listed as the student, the lecturer's run ${byLecturer.id} IS counted - it was visible and grading`);
  else r.bad(`10 control: with the lecturer listed, dispatched runs ${JSON.stringify(asLecturer)}, wanted [${byLecturer.id}]`);

  const lint = await dispatch(STUDENT_A, "lint.yml", h5.sha);
  if (lint.display_title !== `Grade ${h5.sha} (PXL Classroom)`) r.bad(`10 lint: title "${lint.display_title}" - the case needs the full-commit title`);
  const asStudent = await dispatchedRunIds([S]);
  if (asStudent.length === 1 && asStudent[0] === byStudent.id) r.ok(`10 student's lint dispatch "${lint.display_title.slice(0, 20)}..." is not counted; only run ${byStudent.id} is`);
  else r.bad(`10 lint: the student's dispatched runs counted ${JSON.stringify(asStudent)}, wanted [${byStudent.id}] (lint run ${lint.id})`);
  await expectGraded("10 after the lint dispatch", { cap: 10, login: S, want: h5, used: 6, ignored: [[h5, "self-dispatched"]] });

  console.log(`\n${r.failures() ? `${r.failures()} FAILED` : "all good"}\n`);
  process.exit(r.failures() ? 1 : 0);
}

main().catch((e) => die(e.stack || String(e)));
