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
//
// Commit dates are set explicitly one minute apart, so the late case does not
// depend on how fast the pushes went.

import { resolveHandIn, readScoreAtCommit } from "../../lib/grade-cohort.mjs";
import { readSubmissionMarker } from "../../lib/submission-marker.mjs";
import { allowanceEntry } from "../../lib/hand-in-allowance.mjs";
import { validateAgainst } from "../../lib/validate.mjs";
import { api, die, loadEnv, reporter, sleep } from "./live-kit.mjs";

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
  const got = await api(`/repos/${FULL}`, { token });
  if (got.ok) return got.data;
  if (got.status !== 404) die(`could not read ${FULL}: HTTP ${got.status}`);
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

async function waitForRuns(shas) {
  const want = new Set(shas);
  for (let waited = 0; waited < 10 * 60_000; waited += 10_000) {
    await sleep(10_000);
    const runs = (await must(await api(`/repos/${FULL}/actions/runs?event=push&per_page=100`, { token }), "runs")).workflow_runs;
    const mine = runs.filter((x) => want.has(x.head_sha));
    if (mine.length >= want.size && mine.every((x) => x.status === "completed")) return mine;
  }
  die(`runs for ${shas.length} pushes did not all complete in 10 minutes`);
}

const row = (over = {}) => ({ github_login: LOGIN, repo_name: FULL, effective_deadline_at: null, ...over });
const overrideDoc = (entries) => {
  const doc = { schema_version: 1, assignment_id: "hand-in-probe", github_login: LOGIN, overrides: entries };
  const v = validateAgainst("override", doc);
  if (!v.valid) die(`override fixture fails its schema: ${JSON.stringify(v.errors)}`);
  return doc;
};
const grant = (extra, at) => allowanceEntry({ extra, reason: `live probe ${extra}`, by: "tomcoolpxl-lecturer1", at });

async function expectGraded(label, { cap, overrides = null, deadline = null, want, used, ignored, score }) {
  const assignment = { submission_marker: { type: "commit_message", value: MARKER, multiple: true, ...(cap ? { max_hand_ins: cap } : {}) } };
  const marker = readSubmissionMarker(assignment);
  const res = await resolveHandIn(get, { row: row({ effective_deadline_at: deadline }), marker, overrides });
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
  let files = { ".github/workflows/grading.yml": WORKFLOW, "score.txt": "0\n", "notes.md": `probe ${stamp}\n` };
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
  // 4 late: deadline between hand-in 2 (08:03) and 3 (08:04)
  await expectGraded("4 late + exception", {
    cap: 2, overrides: [overrideDoc([grant(5, at(11))])], deadline: at(3.5), want: h2, used: 2,
    ignored: [[h3, "late"], [h4, "late"]], score: 2,
  });
  // 5 force-push: the branch no longer carries any hand-in.
  await push(await commit({ ...files, "score.txt": "0\n" }, work, "start over", at(20)));
  const after = await expectGraded("5 force-push", { cap: 2, want: h2, used: 4, ignored: [[h3, "over-limit"], [h4, "over-limit"]], score: 2 });
  if (after.commit && after.commit.onBranch === false) r.ok("5 force-push: the graded hand-in is known from its run alone (not on the branch)");
  else r.bad(`5 force-push: graded hand-in onBranch ${after.commit?.onBranch}`);
  // 6 no cap: every hand-in counts and the last one is graded (the run
  // history is not read without a cap, so the rewritten branch has none).
  await push(H[3].sha);
  await expectGraded("6 no cap", { cap: null, want: h4, score: 4 });
  void h1;

  console.log(`\n${r.failures() ? `${r.failures()} FAILED` : "all good"}\n`);
  process.exit(r.failures() ? 1 : 0);
}

main().catch((e) => die(e.stack || String(e)));
