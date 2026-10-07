// A cap on hand-ins, and the per-student exceptions that raise it.
//
// lib/submission-marker.mjs (`listHandIns`, `orderHandIns`, `selectHandIn`),
// lib/hand-in-allowance.mjs and lib/grade-cohort.mjs (`resolveHandIn`), driven
// over a fake GitHub that answers the three reads the cap makes: the branch's
// commits, the push run history and the check runs at the graded commit.
//
// Every hand-in in the fixtures scores its own number - hand-in 3 scores 3/100
// - so an assertion on `earned_points` says WHICH hand-in was graded, not just
// that one was.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  readSubmissionMarker,
  readMaxHandIns,
  findMarkedCommit,
  listHandIns,
  orderHandIns,
  selectHandIn,
  describeIgnoredHandIn,
  handInTime,
  handInShownTime,
  PUSH_TO_RUN_ALLOWANCE_MS,
} from "../lib/submission-marker.mjs";
import {
  HAND_IN_ALLOWANCE,
  MAX_EXTRA_HAND_INS,
  allowanceFrom,
  handInLimitFor,
  allowanceEntry,
  allowanceProblem,
} from "../lib/hand-in-allowance.mjs";
import { gradeCohort, gradeStudent, resolveHandIn, rowFromOutcome, teamOf } from "../lib/grade-cohort.mjs";
import { buildGradingSummary } from "../lib/grading-summary.mjs";
import { buildAssignmentDoc } from "../lib/assignment-doc.mjs";
import { validateAgainst } from "../lib/validate.mjs";
import { summariseGrading } from "../frontend/src/lib/autograde.js";
import { STARTER_PATH, buildStarterWorkflow } from "../lib/starter-workflow.mjs";

const MSG = "einde examen";
const DEADLINE = "2026-10-01T12:00:00Z";
const REPO = "Org/exam-ada";

const sha = (n) => `${String(n).padStart(2, "0")}`.padEnd(40, "a");
const at = (min) => new Date(Date.parse("2026-10-01T09:00:00Z") + min * 60_000).toISOString();

/** A commit row as GET /commits returns it. */
const commitRow = (s, message, date) => ({ sha: s, commit: { message, committer: { date } } });

/** A push run as GET /actions/runs returns it. */
const runRow = (s, message, createdAt, { branch = "main", timestamp = createdAt, id = 0 } = {}) => ({
  id,
  head_sha: s,
  head_branch: branch,
  event: "push",
  created_at: createdAt,
  head_commit: { id: s, message, timestamp },
});

const marker = (over = {}) => ({ type: "commit_message", value: MSG, multiple: true, maxHandIns: null, ...over });

/**
 * A fake GitHub for one repository.
 *
 * `handIns`: [{ n, min, onBranch = true, pushed = true, pushedMin = min }]
 * Hand-in n is a commit at minute `min` whose grading run scores n/100. Other
 * commits (`noise`) sit between them the way real work does.
 */
/** The push log a set of push runs implies: one entry per head on main, newest first. */
function pushLog(runs) {
  const seen = new Map();
  for (const r of runs) {
    if ((r.head_branch ?? "main") !== "main" || !r.head_sha) continue;
    if (!seen.has(r.head_sha)) seen.set(r.head_sha, { activity_type: "push", ref: "refs/heads/main", after: r.head_sha, timestamp: r.created_at });
  }
  return [...seen.values()];
}

function world({ handIns = [], noise = 3, repo = REPO, runsStatus = 200, commitsStatus = 200, activityStatus = 200, extraRuns = [] } = {}) {
  const calls = [];
  const branch = [];
  const runs = [...extraRuns];
  for (const h of handIns) {
    const s = sha(h.n);
    for (let i = 0; i < noise; i++) branch.push(commitRow(`${s.slice(0, 38)}n${i}`, `work ${h.n}.${i}`, at(h.min - 1)));
    if (h.onBranch !== false) branch.push(commitRow(s, `${MSG}\n`, h.date ?? at(h.min)));
    if (h.pushed !== false) {
      runs.push(runRow(s, MSG, at(h.pushedMin ?? h.min), { id: 1000 + h.n, timestamp: h.date ?? at(h.min) }));
      // A second workflow on the same push. One hand-in, not two.
      runs.push(runRow(s, MSG, at((h.pushedMin ?? h.min) + 0.1), { id: 2000 + h.n, timestamp: h.date ?? at(h.min) }));
    }
  }
  branch.reverse(); // newest first, as GitHub walks it
  runs.reverse();

  const byPage = (list, path) => {
    const u = new URL(`https://x${path}`);
    const page = Number(u.searchParams.get("page"));
    const per = Number(u.searchParams.get("per_page"));
    return list.slice((page - 1) * per, page * per);
  };

  const request = async (method, path) => {
    calls.push(path);
    if (path.startsWith(`/repos/${repo}/commits?`)) {
      if (commitsStatus !== 200) return { ok: false, status: commitsStatus, data: null };
      return { ok: true, status: 200, data: byPage(branch, path) };
    }
    if (path.startsWith(`/repos/${repo}/actions/runs?`)) {
      if (runsStatus !== 200) return { ok: false, status: runsStatus, data: null };
      return { ok: true, status: 200, data: { total_count: runs.length, workflow_runs: byPage(runs, path) } };
    }
    // The push log: every commit a push ended on - here, every head a push
    // run names on main (a push starts its runs for its last commit).
    if (path.startsWith(`/repos/${repo}/activity?`)) {
      if (activityStatus !== 200) return { ok: false, status: activityStatus, data: null };
      return { ok: true, status: 200, data: pushLog(runs) };
    }
    const cr = path.match(new RegExp(`^/repos/${repo}/commits/([0-9a-z]+)/check-runs$`));
    if (cr) {
      const h = handIns.find((x) => sha(x.n) === cr[1]);
      if (!h) return { ok: true, status: 200, data: { check_runs: [] } };
      return {
        ok: true,
        status: 200,
        data: {
          check_runs: [{
            id: h.n,
            name: "run-autograding-tests",
            conclusion: h.conclusion ?? "success",
            html_url: `https://github.com/${repo}/runs/${h.n}`,
            // A run that did not run carries no score - the live shape of a
            // `skipped` grading job (tests/grade-cohort.test.mjs).
            output: { summary: null, annotations_count: ["success", "failure", undefined].includes(h.conclusion) ? 1 : 0 },
          }],
        },
      };
    }
    const an = path.match(new RegExp(`^/repos/${repo}/check-runs/(\\d+)/annotations`));
    if (an) {
      return {
        ok: true,
        status: 200,
        data: [{ annotation_level: "notice", title: "Autograding report", message: `{"totalPoints":${an[1]},"maxPoints":100}` }],
      };
    }
    return { ok: false, status: 404, data: null };
  };
  const get = async (path) => {
    const r = await request("GET", path);
    return { status: r.status, data: r.data };
  };
  return { request, get, calls };
}

const row = (over = {}) => ({ github_login: "ada", repo_name: REPO, effective_deadline_at: DEADLINE, ...over });

const overrideDoc = (login, entries) => ({
  schema_version: 1,
  assignment_id: "exam",
  github_login: login,
  overrides: entries,
});
const grant = (extra, reason = "lab crashed", by = "lecturer1", when = "2026-10-01T13:00:00Z") =>
  allowanceEntry({ extra, reason, by, at: when });
const extension = (value) => ({
  type: "deadline_extension",
  value,
  reason: "medical",
  overridden_by: "lecturer1",
  overridden_at: "2026-10-01T13:00:00Z",
});

const FIVE = [1, 2, 3, 4, 5].map((n) => ({ n, min: n * 10 }));
const SIX = [...FIVE, { n: 6, min: 60 }];

// =============================================================================
// The field
// =============================================================================

test("the cap is read only as a whole number of at least one", () => {
  const read = (max_hand_ins, multiple = true) =>
    readSubmissionMarker({ submission_marker: { type: "commit_message", value: MSG, multiple, max_hand_ins } }).maxHandIns;
  assert.equal(read(5), 5);
  assert.equal(read(1), 1);
  assert.equal(read(undefined), null, "absent is unlimited");
  assert.equal(read(null), null);
  // Every one of these would refuse every hand-in or grade a string.
  for (const bad of [0, -1, 2.5, "5", NaN, Infinity, true, {}]) assert.equal(read(bad), null, String(bad));
});

test("a cap beside `multiple: false` is a value nothing may act on", () => {
  const m = readSubmissionMarker({ submission_marker: { type: "commit_message", value: MSG, multiple: false, max_hand_ins: 3 } });
  assert.equal(m.maxHandIns, null);
  assert.equal(handInLimitFor(m, "ada", {}).limit, null);
});

test("the schema takes a cap and refuses what the reader would refuse", () => {
  const doc = (max) => ({
    schema_version: 1,
    id: "exam",
    title: "Exam",
    organization: "Org",
    template: { owner: "Org", repository: "tpl" },
    repository_name_pattern: "exam-{github_login}",
    opens_at: "2026-09-01T08:00:00Z",
    deadline_at: DEADLINE,
    submission_marker: { type: "commit_message", value: MSG, multiple: true, ...(max === undefined ? {} : { max_hand_ins: max }) },
  });
  assert.equal(validateAgainst("assignment", doc(5)).valid, true);
  assert.equal(validateAgainst("assignment", doc(1)).valid, true);
  for (const bad of [0, -2, 1.5, "5", 1001]) {
    assert.equal(validateAgainst("assignment", doc(bad)).valid, false, `max_hand_ins: ${JSON.stringify(bad)}`);
  }
});

test("validating does not WRITE a cap (a schema default would)", () => {
  const d = {
    schema_version: 1, id: "exam", title: "Exam", organization: "Org",
    template: { owner: "Org", repository: "tpl" }, repository_name_pattern: "exam-{github_login}",
    opens_at: "2026-09-01T08:00:00Z", deadline_at: DEADLINE,
    submission_marker: { type: "commit_message", value: MSG, multiple: true },
  };
  validateAgainst("assignment", d);
  assert.equal("max_hand_ins" in d.submission_marker, false);
});

test("the Admin Panel's save writes the cap, and only beside `multiple: true`", () => {
  const base = { id: "exam", title: "Exam", submission_marker_value: MSG };
  assert.equal(buildAssignmentDoc({ ...base, submission_marker_max_hand_ins: "5" }).submission_marker.max_hand_ins, 5);
  assert.equal(buildAssignmentDoc({ ...base, submission_marker_max_hand_ins: 3 }).submission_marker.max_hand_ins, 3);
  // Blank is unlimited, and unlimited is ABSENT, not 0 and not null.
  for (const blank of ["", "  ", null, undefined]) {
    assert.equal("max_hand_ins" in buildAssignmentDoc({ ...base, submission_marker_max_hand_ins: blank }).submission_marker, false);
  }
  // Nonsense never reaches the document; the modal refuses it before here.
  for (const bad of ["0", "-1", "2.5", "abc"]) {
    assert.equal("max_hand_ins" in buildAssignmentDoc({ ...base, submission_marker_max_hand_ins: bad }).submission_marker, false, bad);
  }
  // A cap left behind under "only the first counts" would come back to life
  // the day somebody ticks the box again.
  const once = buildAssignmentDoc({ ...base, submission_marker_multiple: false, submission_marker_max_hand_ins: "5" });
  assert.equal("max_hand_ins" in once.submission_marker, false);
});

test("a saved cap validates and reads back", () => {
  const doc = buildAssignmentDoc({
    id: "exam", title: "Exam", organization: "Org", template: "Org/tpl",
    repository_name_pattern: "exam-{github_login}", opens_at_local: "2026-09-02T09:37", deadline_at_local: "2027-02-28T09:37",
    student_permission: "admin", acceptance_mode: "self-service", roster_mode: "open", late_policy: "report", state: "published",
    max_acceptances: 150,
    submission_marker_value: MSG, submission_marker_max_hand_ins: "4",
  });
  const v = validateAgainst("assignment", doc);
  assert.equal(v.valid, true, JSON.stringify(v.errors));
  assert.equal(readSubmissionMarker(doc).maxHandIns, 4);
});

// =============================================================================
// Which hand-in counts - the pure rule
// =============================================================================

const h = (n, min, extra = {}) => ({ sha: sha(n), message: MSG, date: at(min), pushedAt: at(min), pushedFrom: "run", onBranch: true, ...extra });

test("under the cap, the last hand-in counts and nothing is ignored", () => {
  const r = selectHandIn([h(1, 10), h(2, 20), h(3, 30)], { until: DEADLINE, limit: 5 });
  assert.equal(r.commit.sha, sha(3));
  assert.equal(r.number, 3);
  assert.equal(r.used, 3);
  assert.equal(r.allowed, 5);
  assert.deepEqual(r.ignored, []);
});

test("exactly at the cap, the last one still counts", () => {
  const r = selectHandIn([h(1, 10), h(2, 20)], { until: DEADLINE, limit: 2 });
  assert.equal(r.commit.sha, sha(2));
  assert.deepEqual(r.ignored, []);
});

test("OVER THE CAP: the last VALID hand-in counts and every later one is named", () => {
  const r = selectHandIn([h(1, 10), h(2, 20), h(3, 30), h(4, 40), h(5, 50), h(6, 60), h(7, 70)], { until: DEADLINE, limit: 5 });
  assert.equal(r.commit.sha, sha(5));
  assert.equal(r.number, 5);
  assert.equal(r.used, 7, "used is not clamped - 7 of 5 is the fact");
  assert.deepEqual(r.ignored.map((i) => [i.sha, i.number, i.reason]), [
    [sha(6), 6, "over-limit"],
    [sha(7), 7, "over-limit"],
  ]);
  assert.equal(
    describeIgnoredHandIn(r.ignored[0], { allowed: 5 }),
    `hand-in 6 of 5 pushed ${at(60)} (${sha(6).slice(0, 7)}) ignored: over the limit`,
  );
});

test("a hand-in is SHOWN at the time it was judged by: the push, never the commit's own date", () => {
  // Committed at 11:58, pushed at 12:03 against a 12:00 deadline: late by the
  // rule. Shown at the commit's date it read "hand-in at 11:58 ... ignored:
  // after the deadline" - a sentence that contradicts itself.
  const late = h(2, 178, { pushedAt: at(183), pushedFrom: "log" });
  const r = selectHandIn([h(1, 10), late], { until: DEADLINE, limit: 2 });
  assert.deepEqual(r.ignored.map((i) => i.reason), ["late"]);
  assert.equal(
    describeIgnoredHandIn(r.ignored[0], { allowed: 2 }),
    `hand-in pushed ${at(183)} (${sha(2).slice(0, 7)}) ignored: after the deadline`,
  );
  // No push time recorded: the commit's date, and it says so.
  assert.match(describeIgnoredHandIn({ ...r.ignored[0], pushed_at: null }, { allowed: 2 }), new RegExp(`^hand-in committed ${at(178)} `));
  // Neither: said, not guessed.
  assert.match(describeIgnoredHandIn({ ...r.ignored[0], pushed_at: null, date: null }, { allowed: 2 }), /^hand-in at an unknown time /);
});

test("handInShownTime: the push where known, which kind it is, and the run's two-minute margin", () => {
  // A run started 45s after the deadline: the rule counts it on time.
  const inMargin = { pushedAt: "2026-10-01T12:00:45Z", pushedFrom: "run", date: "2026-10-01T11:59:00Z" };
  assert.ok(handInTime(inMargin) <= Date.parse(DEADLINE), "precondition: the rule counts it on time");
  assert.deepEqual(handInShownTime(inMargin, DEADLINE), { at: inMargin.pushedAt, kind: "pushed", allowance: true });
  // The push log's time is the push itself: no margin, so it is simply after.
  assert.equal(handInShownTime({ ...inMargin, pushedFrom: "log" }, DEADLINE).allowance, false);
  // A run started past the margin is late, and not "in the margin".
  assert.equal(handInShownTime({ ...inMargin, pushedAt: "2026-10-01T12:02:01Z" }, DEADLINE).allowance, false);
  // Before the deadline there is nothing to explain.
  assert.equal(handInShownTime({ ...inMargin, pushedAt: "2026-10-01T11:59:30Z" }, DEADLINE).allowance, false);
  // No deadline: no margin to be inside of.
  assert.equal(handInShownTime(inMargin, null).allowance, false);
  // The summary's spelling reads the same.
  assert.deepEqual(handInShownTime({ pushed_at: inMargin.pushedAt, pushed_from: "run" }, DEADLINE), { at: inMargin.pushedAt, kind: "pushed", allowance: true });
  // No push time: the commit's own date, named as such. Neither: null.
  assert.deepEqual(handInShownTime({ pushedAt: null, date: inMargin.date }, DEADLINE), { at: inMargin.date, kind: "committed", allowance: false });
  assert.equal(handInShownTime({ pushedAt: "not a date", date: null }, DEADLINE), null);
  assert.equal(handInShownTime(null, DEADLINE), null);
});

test("a cap of one grades the first hand-in", () => {
  const r = selectHandIn([h(1, 10), h(2, 20)], { until: DEADLINE, limit: 1 });
  assert.equal(r.commit.sha, sha(1));
  assert.equal(r.ignored.length, 1);
});

test("a LATE hand-in is ignored as late and does not use up a slot", () => {
  const late = h(3, 60 * 5); // 14:00, after the 12:00 deadline
  const r = selectHandIn([h(1, 10), h(2, 20), late], { until: DEADLINE, limit: 2 });
  assert.equal(r.commit.sha, sha(2));
  assert.equal(r.used, 2);
  assert.deepEqual(r.ignored.map((i) => [i.sha, i.number, i.reason]), [[sha(3), null, "late"]]);
  assert.match(describeIgnoredHandIn(r.ignored[0], { allowed: 2 }), /ignored: after the deadline$/);
  assert.equal(r.lateCommit.sha, sha(3));
});

test("late AND over the cap are both named, each with its own reason", () => {
  const r = selectHandIn([h(1, 10), h(2, 20), h(3, 30), h(4, 60 * 5)], { until: DEADLINE, limit: 2 });
  assert.deepEqual(r.ignored.map((i) => i.reason), ["over-limit", "late"]);
});

test("only late hand-ins: nothing is graded and the newest late one is reported", () => {
  const r = selectHandIn([h(1, 60 * 4), h(2, 60 * 5)], { until: DEADLINE, limit: 2 });
  assert.equal(r.commit, null);
  assert.equal(r.number, null);
  assert.equal(r.used, 0);
  assert.equal(r.lateCommit.sha, sha(2));
  assert.equal(r.ignored.length, 2);
});

test("no hand-ins at all", () => {
  const r = selectHandIn([], { until: DEADLINE, limit: 2 });
  assert.equal(r.commit, null);
  assert.equal(r.used, 0);
  assert.deepEqual(r.ignored, []);
  assert.equal(r.lateCommit, null);
});

test("a hand-in with no readable date cannot be shown to be on time", () => {
  // No run recorded their push either: nothing says when they were made.
  const r = selectHandIn([h(1, 10), h(2, 20, { date: null, pushedAt: null }), h(3, 30, { date: "garbage", pushedAt: null })], { until: DEADLINE, limit: 5 });
  assert.equal(r.commit.sha, sha(1));
  assert.deepEqual(r.ignored.map((i) => i.reason), ["late", "late"]);
});

test("a hand-in AT the deadline instant is on time", () => {
  const exact = { sha: sha(1), date: DEADLINE, pushedAt: DEADLINE, onBranch: true };
  assert.equal(selectHandIn([exact], { until: DEADLINE, limit: 1 }).commit.sha, sha(1));
});

test("no deadline bounds nothing", () => {
  const r = selectHandIn([h(1, 10), h(2, 60 * 48)], { until: null, limit: 5 });
  assert.equal(r.commit.sha, sha(2));
});

test("`multiple: false` grades the first even when a cap is passed", () => {
  const r = selectHandIn([h(1, 10), h(2, 20), h(3, 30)], { until: DEADLINE, limit: 2, multiple: false });
  assert.equal(r.commit.sha, sha(1));
  // Hand-in 2 used a slot and is valid; only 3 is over the cap.
  assert.deepEqual(r.ignored.map((i) => i.sha), [sha(3)]);
});

test("an unreadable limit is no limit, not zero", () => {
  for (const limit of [null, undefined, 0, -3, "2"]) {
    const r = selectHandIn([h(1, 10), h(2, 20), h(3, 30)], { until: DEADLINE, limit });
    assert.equal(r.commit.sha, sha(3), String(limit));
    assert.equal(r.allowed, null);
  }
});

test("an ignored hand-in that exists only in the run history says so", () => {
  const r = selectHandIn([h(1, 10), h(2, 20, { onBranch: false })], { until: DEADLINE, limit: 1 });
  assert.equal(r.ignored[0].on_branch, false);
  assert.match(describeIgnoredHandIn(r.ignored[0], { allowed: 1 }), /no longer on the branch, still counted$/);
});

// -----------------------------------------------------------------------------
// Checked against something that does not share its logic
// -----------------------------------------------------------------------------

test("UNCAPPED, the new rule agrees with findMarkedCommit on 400 random histories", async () => {
  // findMarkedCommit is the long-standing walk with its own early return;
  // selectHandIn is new. They were written separately, and where both apply
  // they must name the same commit and the same late one.
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (let trial = 0; trial < 400; trial++) {
    const rows = [];
    const n = Math.floor(rnd() * 12);
    for (let i = 0; i < n; i++) {
      const isHandIn = rnd() < 0.5;
      const min = i * 25 + Math.floor(rnd() * 10); // some land after 12:00
      rows.push(commitRow(`${String(i).padStart(3, "0")}`.padEnd(40, "b"), isHandIn ? MSG : `work ${i}`, at(min)));
    }
    const newestFirst = [...rows].reverse();
    const request = async () => ({ status: 200, data: newestFirst });
    for (const multiple of [true, false]) {
      const m = marker({ multiple });
      const old = await findMarkedCommit(request, { repoFullName: REPO, branch: "main", marker: m, until: DEADLINE });
      const listed = await listHandIns(request, { repoFullName: REPO, branch: "main", marker: m, withRuns: false });
      const now = selectHandIn(listed.handIns, { until: DEADLINE, multiple, limit: null });
      assert.equal(now.commit?.sha ?? null, old.commit?.sha ?? null, `trial ${trial} multiple=${multiple}`);
      assert.equal(now.lateCommit?.sha ?? null, old.lateCommit?.sha ?? null, `trial ${trial} late`);
    }
  }
});

// =============================================================================
// Order
// =============================================================================

test("a forged commit date cannot move a branch hand-in ahead of its ancestor", () => {
  // Hand-in 3 claims 09:05 - before hand-ins 1 and 2 - and has no run to say
  // otherwise. Ancestry keeps it third.
  const ordered = orderHandIns(
    [h(1, 10, { pushedAt: null }), h(2, 20, { pushedAt: null }), h(3, 5, { pushedAt: null })],
    [],
  );
  assert.deepEqual(ordered.map((x) => x.sha), [sha(1), sha(2), sha(3)]);
});

test("GitHub's push time outranks the commit's own date", () => {
  // Committed at 09:10 and 09:20, pushed at 09:50 and 09:30: pushed order
  // cannot contradict branch order, so the floor holds it.
  const ordered = orderHandIns([h(1, 10, { pushedAt: at(50) }), h(2, 20, { pushedAt: at(30) })], []);
  assert.deepEqual(ordered.map((x) => x.sha), [sha(1), sha(2)]);
});

test("a hand-in known only from the run history is slotted in by when it was pushed", () => {
  const ordered = orderHandIns(
    [h(1, 10), h(3, 30)],
    [h(2, 20, { onBranch: false })],
  );
  assert.deepEqual(ordered.map((x) => x.sha), [sha(1), sha(2), sha(3)]);
});

test("a run-only hand-in with no time at all goes last, never ahead of one with a time", () => {
  const ordered = orderHandIns([h(1, 10)], [{ sha: sha(9), date: null, pushedAt: null, onBranch: false }]);
  assert.deepEqual(ordered.map((x) => x.sha), [sha(1), sha(9)]);
});

// =============================================================================
// The two reads
// =============================================================================

test("listHandIns reads the branch and the run history, and keeps each hand-in once", async () => {
  const w = world({ handIns: FIVE });
  const res = await listHandIns(w.get, { repoFullName: REPO, branch: "main", marker: marker() });
  assert.equal(res.ok, true);
  assert.equal(res.complete, true);
  assert.deepEqual(res.handIns.map((x) => x.sha), FIVE.map((x) => sha(x.n)));
  assert.ok(res.handIns.every((x) => x.onBranch && x.pushedAt), "every one is on the branch and was pushed");
  assert.ok(w.calls.some((c) => c.includes("/actions/runs?event=push&branch=main")));
});

test("a FORCE-PUSH that erased hand-ins does not reset the count", async () => {
  // Hand-ins 1-3 were pushed, then the branch was rewritten without them.
  const w = world({ handIns: [
    { n: 1, min: 10, onBranch: false }, { n: 2, min: 20, onBranch: false }, { n: 3, min: 30, onBranch: false },
    { n: 4, min: 40 },
  ] });
  const res = await listHandIns(w.get, { repoFullName: REPO, branch: "main", marker: marker() });
  assert.deepEqual(res.handIns.map((x) => [x.sha, x.onBranch]), [
    [sha(1), false], [sha(2), false], [sha(3), false], [sha(4), true],
  ]);
  const picked = selectHandIn(res.handIns, { until: DEADLINE, limit: 2 });
  assert.equal(picked.commit.sha, sha(2), "the second hand-in ever made counts, not the fourth");
  assert.equal(picked.used, 4);
});

test("a run on another branch, or for another message, is not a hand-in", async () => {
  const w = world({
    handIns: [{ n: 1, min: 10 }],
    extraRuns: [
      runRow(sha(8), MSG, at(20), { branch: "feature" }),
      runRow(sha(9), "einde examen!", at(30)),
      // A leading space is not the workflow's `==` (case is ignored, spaces are not).
      runRow(sha(7), " einde examen", at(30)),
    ],
  });
  const res = await listHandIns(w.get, { repoFullName: REPO, branch: "main", marker: marker() });
  assert.deepEqual(res.handIns.map((x) => x.sha), [sha(1)]);
});

test("a failed run-history read is named as such, never as 'no hand-in'", async () => {
  for (const status of [403, 404, 500, 0]) {
    const w = world({ handIns: FIVE, runsStatus: status });
    const res = await listHandIns(w.get, { repoFullName: REPO, branch: "main", marker: marker() });
    assert.equal(res.ok, false);
    assert.equal(res.failedRead, "runs");
    assert.deepEqual(res.handIns, []);
  }
});

test("a failed commits read is named as such", async () => {
  const w = world({ handIns: FIVE, commitsStatus: 502 });
  const res = await listHandIns(w.get, { repoFullName: REPO, branch: "main", marker: marker() });
  assert.equal(res.ok, false);
  assert.equal(res.failedRead, "commits");
  assert.equal(w.calls.some((c) => c.includes("/actions/runs")), false, "and it does not go on to read runs");
});

test("a count that stops at the page cap is not a count", async () => {
  // 1,000 commits of noise and one more: ten full pages and no short one.
  const full = Array.from({ length: 100 }, (_, i) => commitRow(`${i}`.padEnd(40, "c"), "work", at(i)));
  const request = async () => ({ status: 200, data: full });
  const res = await listHandIns(request, { repoFullName: REPO, branch: "main", marker: marker() });
  assert.equal(res.ok, true);
  assert.equal(res.complete, false);
});

test("a branch name is encoded in both reads", async () => {
  const calls = [];
  const request = async (p) => {
    calls.push(p);
    return { status: 200, data: p.includes("/actions/runs") ? { workflow_runs: [] } : [] };
  };
  await listHandIns(request, { repoFullName: REPO, branch: "exam/final", marker: marker() });
  assert.ok(calls.every((c) => c.includes("exam%2Ffinal")), calls.join("\n"));
});

// =============================================================================
// Allowances
// =============================================================================

test("the LAST allowance entry is in force, and zero is a revocation", () => {
  assert.equal(allowanceFrom(null), null);
  assert.equal(allowanceFrom(overrideDoc("ada", [extension(DEADLINE)])), null, "an extension is not an allowance");
  const granted = allowanceFrom(overrideDoc("ada", [grant(2)]));
  assert.deepEqual(
    { extra: granted.extra, reason: granted.reason, by: granted.by, at: granted.at, history: granted.history },
    { extra: 2, reason: "lab crashed", by: "lecturer1", at: "2026-10-01T13:00:00Z", history: 1 },
  );
  assert.equal(allowanceFrom(overrideDoc("ada", [grant(2), grant(0, "granted in error")])).extra, 0);
  assert.equal(allowanceFrom(overrideDoc("ada", [grant(2), grant(0), grant(1)])).extra, 1);
});

test("a malformed allowance entry is skipped, never trusted", () => {
  const bad = [
    { ...grant(2), value: "5" },
    { ...grant(2), value: -1 },
    { ...grant(2), value: 1.5 },
    { ...grant(2), value: MAX_EXTRA_HAND_INS + 1 },
    { ...grant(2), value: undefined },
  ];
  for (const e of bad) {
    assert.equal(allowanceFrom(overrideDoc("ada", [grant(2), e])).extra, 2, JSON.stringify(e.value));
  }
});

test("the limit is the cap plus the allowance, and nothing without a cap", () => {
  const m = marker({ maxHandIns: 5 });
  assert.deepEqual(
    (({ limit, base, extra }) => ({ limit, base, extra }))(handInLimitFor(m, "ada", {})),
    { limit: 5, base: 5, extra: 0 },
  );
  const withGrant = handInLimitFor(m, "ada", { overrides: [overrideDoc("ada", [grant(2)])] });
  assert.equal(withGrant.limit, 7);
  assert.equal(withGrant.grantedTo, "ada");
  // No cap: an allowance means nothing and must not invent one.
  assert.equal(handInLimitFor(marker(), "ada", { overrides: [overrideDoc("ada", [grant(2)])] }).limit, null);
  assert.equal(handInLimitFor(null, "ada", {}).limit, null);
});

test("a login is matched lowercased, from a Map keyed any old way", () => {
  const m = marker({ maxHandIns: 2 });
  const docs = new Map([["ADA-Lovelace", overrideDoc("ADA-Lovelace", [grant(3)])]]);
  assert.equal(handInLimitFor(m, "ada-lovelace", { overrides: docs }).limit, 5);
  assert.equal(handInLimitFor(m, "Ada-LOVELACE", { overrides: [...docs.values()] }).limit, 5);
});

test("a revoked allowance is reported as revoked, not as nothing", () => {
  const r = handInLimitFor(marker({ maxHandIns: 2 }), "ada", {
    overrides: [overrideDoc("ada", [grant(3), grant(0, "granted to the wrong student", "lecturer2")])],
  });
  assert.equal(r.limit, 2);
  assert.equal(r.allowance.extra, 0);
  assert.equal(r.allowance.by, "lecturer2");
});

test("a TEAM shares one count, and its most generous member's allowance", () => {
  const m = marker({ maxHandIns: 2 });
  const overrides = [overrideDoc("bo", [grant(1)]), overrideDoc("cy", [grant(4)])];
  const team = { members: ["ada", "bo", "cy"] };
  const r = handInLimitFor(m, "ada", { overrides, team });
  assert.equal(r.limit, 6);
  assert.equal(r.grantedTo, "cy");
  // A teammate's REVOKED grant does not lower anyone.
  const revoked = [overrideDoc("bo", [grant(1)]), overrideDoc("cy", [grant(4), grant(0)])];
  assert.equal(handInLimitFor(m, "ada", { overrides: revoked, team }).limit, 3);
});

test("teamOf pools the rows that share a team, and nobody for an individual", () => {
  const students = [
    { github_login: "Ada", team_slug: "t1" }, { github_login: "bo", team_slug: "t1" }, { github_login: "cy", team_slug: "t2" },
  ];
  assert.deepEqual(teamOf(students[0], students).members.sort(), ["ada", "bo"]);
  assert.equal(teamOf({ github_login: "x" }, students), null);
});

test("a grant needs a reason and a whole number from 1 to the maximum", () => {
  assert.equal(allowanceProblem({ extra: 2, reason: "crash" }), null);
  assert.equal(allowanceProblem({ extra: "2", reason: "crash" }), null);
  assert.match(allowanceProblem({ extra: 2, reason: "  " }), /reason/);
  for (const bad of [0, -1, 1.5, "", "abc", null]) assert.match(allowanceProblem({ extra: bad, reason: "x" }), /whole number/, String(bad));
  assert.match(allowanceProblem({ extra: MAX_EXTRA_HAND_INS + 1, reason: "x" }), /At most/);
});

test("the entries a grant and a revocation write validate, and a bad one does not", () => {
  const ok = (entries) => validateAgainst("override", overrideDoc("ada", entries));
  assert.equal(ok([grant(2)]).valid, true);
  assert.equal(ok([grant(2), grant(0, "revoked")]).valid, true);
  assert.equal(ok([grant(2), extension("2026-10-02T12:00:00Z")]).valid, true, "beside an extension, in one document");
  assert.equal(ok([{ ...grant(2), value: -1 }]).valid, false);
  assert.equal(ok([{ ...grant(2), value: 51 }]).valid, false);
  assert.equal(ok([{ ...grant(2), value: "2" }]).valid, false);
  const noValue = grant(2);
  delete noValue.value;
  assert.equal(ok([noValue]).valid, false);
  assert.equal(ok([{ ...grant(2), reason: "" }]).valid, false, "the reason is required");
  // The conditional must not leak onto the other types.
  assert.equal(ok([extension("2026-10-02T12:00:00Z")]).valid, true);
  assert.equal(allowanceEntry({ extra: 1, reason: " x ", by: "l" }).reason, "x");
  assert.equal(allowanceEntry({ extra: 1, reason: "x", by: "l" }).type, HAND_IN_ALLOWANCE);
});

// =============================================================================
// Grading, end to end over the fake - the four named scenarios and their edges
// =============================================================================

const capped = (n) => marker({ maxHandIns: n });

test("SCENARIO 1 - exceeding the limit: hand-in 5 is graded, hand-in 6 is named", async () => {
  const w = world({ handIns: SIX });
  const res = await gradeStudent(w.request, { row: row(), marker: capped(5) });
  assert.equal(res.verdict, "graded");
  assert.equal(res.parsed.earned, 5);
  assert.equal(res.handIns.used, 6);
  assert.equal(res.handIns.allowed, 5);
  assert.equal(res.handIns.graded_number, 5);
  assert.equal(res.handIns.graded_sha, sha(5));
  assert.deepEqual(res.handIns.ignored.map((i) => [i.number, i.reason]), [[6, "over-limit"]]);
});

test("the summary row keeps when GitHub recorded the graded hand-in's push, and the schema accepts it", async () => {
  const res = await gradeStudent(world({ handIns: SIX }).request, { row: row(), marker: capped(5) });
  assert.equal(res.handIn.sha, sha(5));
  assert.ok(res.handIn.pushedAt, "precondition: the fake records a push time");
  const { graded } = rowFromOutcome("ada", res, 100);
  assert.equal(graded.graded_sha, sha(5));
  assert.equal(graded.graded_pushed_at, res.handIn.pushedAt);
  assert.equal(graded.graded_pushed_from, res.handIn.pushedFrom);
  const doc = buildGradingSummary({ assignmentId: "exam", gradedBy: "tomcoolpxl", runner: "github_actions", students: [graded] });
  assert.equal(validateAgainst("grading-summary", doc).valid, true);

  // Uncapped, a hand-in message still decides the commit - and its push.
  const open = await gradeStudent(world({ handIns: SIX }).request, { row: row(), marker: marker() });
  assert.equal(open.handIns ?? null, null);
  assert.equal(rowFromOutcome("ada", open, 100).graded.graded_pushed_at, open.handIn.pushedAt);

  // A push time belongs to the commit it was read for, never to another.
  assert.equal(rowFromOutcome("ada", { ...res, sha: sha(6) }, 100).graded.graded_pushed_at, undefined);
});

test("SCENARIO 2 - an exception makes the ignored hand-in count", async () => {
  const w = world({ handIns: SIX });
  const res = await gradeStudent(w.request, {
    row: row(), marker: capped(5), overrides: [overrideDoc("ada", [grant(2)])],
  });
  assert.equal(res.parsed.earned, 6);
  assert.equal(res.handIns.allowed, 7);
  assert.equal(res.handIns.extra, 2);
  assert.deepEqual(res.handIns.ignored, []);
});

test("SCENARIO 3 - a revoked exception puts hand-in 6 back over the limit", async () => {
  const w = world({ handIns: SIX });
  const res = await gradeStudent(w.request, {
    row: row(), marker: capped(5), overrides: [overrideDoc("ada", [grant(2), grant(0, "granted in error")])],
  });
  assert.equal(res.parsed.earned, 5);
  assert.equal(res.handIns.allowed, 5);
  assert.equal(res.handIns.extra, 0);
  assert.deepEqual(res.handIns.ignored.map((i) => i.number), [6]);
});

test("SCENARIO 4 - an exception plus a deadline extension, with a late hand-in", async () => {
  // Deadline 12:00, extended to 14:00. Hand-ins at 11:00 and 11:30 (on time),
  // 13:00 (late on the base deadline, on time on the extension) and 15:00
  // (late either way). Cap 2, +1.
  const handIns = [{ n: 1, min: 120 }, { n: 2, min: 150 }, { n: 3, min: 240 }, { n: 4, min: 360 }];
  const extended = "2026-10-01T14:00:00Z";
  const overrides = [overrideDoc("ada", [grant(1), extension(extended)])];

  const withExt = await gradeStudent(world({ handIns }).request, {
    row: row({ effective_deadline_at: extended }), marker: capped(2), overrides,
  });
  assert.equal(withExt.parsed.earned, 3, "the 13:00 hand-in counts: inside the extension and the raised cap");
  assert.equal(withExt.handIns.used, 3);
  assert.deepEqual(withExt.handIns.ignored.map((i) => [i.sha, i.reason]), [[sha(4), "late"]]);

  // The same allowance WITHOUT the extension: 13:00 is late, so the raise has
  // nothing to admit and hand-in 2 counts.
  const noExt = await gradeStudent(world({ handIns }).request, {
    row: row(), marker: capped(2), overrides: [overrideDoc("ada", [grant(1)])],
  });
  assert.equal(noExt.parsed.earned, 2);
  assert.deepEqual(noExt.handIns.ignored.map((i) => i.reason), ["late", "late"]);

  // The extension WITHOUT the allowance: 13:00 is on time but hand-in 3 of 2.
  const noGrant = await gradeStudent(world({ handIns }).request, {
    row: row({ effective_deadline_at: extended }), marker: capped(2),
  });
  assert.equal(noGrant.parsed.earned, 2);
  assert.deepEqual(noGrant.handIns.ignored.map((i) => [i.number, i.reason]), [[3, "over-limit"], [null, "late"]]);
});

test("the graded hand-in's run being skipped is a failure that still carries the count", async () => {
  const handIns = [{ n: 1, min: 10 }, { n: 2, min: 20, conclusion: "skipped" }, { n: 3, min: 30 }];
  const res = await gradeStudent(world({ handIns }).request, { row: row(), marker: capped(2) });
  assert.equal(res.verdict, "not-run");
  assert.equal(res.handIns.used, 3);
  assert.deepEqual(res.handIns.ignored.map((i) => i.number), [3]);
});

test("the run history being unreadable refuses the student, by name, with why", async () => {
  const res = await gradeStudent(world({ handIns: SIX, runsStatus: 403 }).request, { row: row(), marker: capped(5) });
  assert.equal(res.verdict, "lookup-failed");
  assert.match(res.reason, /Actions run history \(HTTP 403\)/);
});

test("UNCAPPED grading reads when each hand-in was pushed, and not the student's dispatches", async () => {
  const w = world({ handIns: SIX });
  const res = await gradeStudent(w.request, { row: row(), marker: marker() });
  assert.equal(res.parsed.earned, 6);
  assert.equal(res.handIns, null, "no cap, no count to report");
  assert.ok(w.calls.some((c) => c.includes("/actions/runs?event=push")), w.calls.join("\n"));
  assert.ok(w.calls.some((c) => c.includes("/activity?")), w.calls.join("\n"));
  // Without a cap a dispatch uses no slot and is never graded: nothing to read.
  assert.equal(w.calls.some((c) => c.includes("event=workflow_dispatch")), false, w.calls.join("\n"));
});

test("UNCAPPED, a BACKDATED hand-in pushed after the deadline is late (review of v1.5.0)", async () => {
  // Hand-in 2's commit claims 10:00; GitHub saw it pushed at 13:00, an hour
  // after the 12:00 deadline. The uncapped path judged the commit date.
  const handIns = [{ n: 1, min: 30 }, { n: 2, min: 240, date: at(60) }];
  for (const multiple of [true, false]) {
    const res = await gradeStudent(world({ handIns }).request, { row: row(), marker: marker({ multiple }) });
    assert.equal(res.verdict, "graded");
    assert.equal(res.sha, sha(1), "the last ON-TIME hand-in, by push time");
  }
  const only = await resolveHandIn(world({ handIns: [{ n: 2, min: 240, date: at(60) }] }).get, { row: row(), marker: marker() });
  assert.equal(only.verdict, "no-commit");
  assert.match(only.reason, /after the deadline .*pushed 2026-10-01T13:00:00/);
  // And the grader and the Regrade dialog's rule agree: the same list, the same choice.
  const listed = await listHandIns(world({ handIns }).get, { repoFullName: REPO, branch: "main", marker: marker() });
  assert.equal(selectHandIn(listed.handIns, { until: DEADLINE, multiple: true }).commit.sha, sha(1));
});

test("UNCAPPED, an unreadable run history or push log refuses the student - never a guess from the commit dates", async () => {
  for (const [bad, pattern] of [[{ runsStatus: 502 }, /Actions run history \(HTTP 502\)/], [{ activityStatus: 500 }, /push history \(HTTP 500\)/]]) {
    for (const multiple of [true, false]) {
      const res = await gradeStudent(world({ handIns: SIX, ...bad }).request, { row: row(), marker: marker({ multiple }) });
      assert.equal(res.verdict, "lookup-failed", `${JSON.stringify(bad)} multiple=${multiple}`);
      assert.match(res.reason, pattern);
    }
  }
});

test("resolveHandIn names no hand-in and a late one differently under a cap", async () => {
  const none = await resolveHandIn(world({ handIns: [] }).get, { row: row(), marker: capped(2) });
  assert.equal(none.verdict, "no-commit");
  assert.match(none.reason, /nothing was handed in/);
  const late = await resolveHandIn(world({ handIns: [{ n: 1, min: 400 }] }).get, { row: row(), marker: capped(2) });
  assert.equal(late.verdict, "no-commit");
  assert.match(late.reason, /after the deadline/);
  assert.equal(late.handIns.ignored.length, 1, "and the late one is still listed");
});

test("a whole cohort: the summary carries every count and validates", async () => {
  const ada = world({ handIns: SIX, repo: "Org/exam-ada" });
  const bo = world({ handIns: [{ n: 1, min: 10 }], repo: "Org/exam-bo" });
  const cy = world({ handIns: [{ n: 1, min: 10 }, { n: 2, min: 20, conclusion: "cancelled" }], repo: "Org/exam-cy" });
  const request = (method, path) =>
    (path.includes("exam-ada") ? ada : path.includes("exam-bo") ? bo : cy).request(method, path);
  const students = [
    row({ github_login: "ada", repo_name: "Org/exam-ada" }),
    row({ github_login: "bo", repo_name: "Org/exam-bo" }),
    row({ github_login: "cy", repo_name: "Org/exam-cy" }),
  ];
  const res = await gradeCohort(request, { students, marker: capped(5), overrides: [] });
  assert.equal(res.ok, true);
  const byLogin = Object.fromEntries(res.graded.map((g) => [g.login, g]));
  assert.equal(byLogin.ada.earned_points, 5);
  assert.equal(byLogin.ada.hand_ins.ignored.length, 1);
  assert.equal(byLogin.bo.hand_ins.used, 1);
  assert.equal(res.failed.length, 1);
  assert.equal(res.failed[0].login, "cy");
  assert.equal(res.failed[0].hand_ins.used, 2);

  const doc = buildGradingSummary({ assignmentId: "exam", gradedBy: "lecturer1", runner: "github_actions", students: res.graded, failed: res.failed });
  const v = validateAgainst("grading-summary", doc);
  assert.equal(v.valid, true, JSON.stringify(v.errors));
});

test("a team's repository is graded under the pooled allowance", async () => {
  const w = world({ handIns: SIX, repo: "Org/exam-t1" });
  const students = [
    row({ github_login: "ada", repo_name: "Org/exam-t1", team_slug: "t1" }),
    row({ github_login: "bo", repo_name: "Org/exam-t1", team_slug: "t1" }),
  ];
  const res = await gradeCohort(w.request, {
    students, marker: capped(5), overrides: [overrideDoc("bo", [grant(1)])],
  });
  assert.deepEqual(res.graded.map((g) => [g.login, g.earned_points, g.hand_ins.allowed]), [
    ["ada", 6, 6],
    ["bo", 6, 6],
  ]);
});

test("the grading summary refuses a hand-in count it does not know the shape of", () => {
  const base = { login: "ada", earned_points: 1, total_points: 2 };
  const doc = (hand_ins) => buildGradingSummary({ assignmentId: "x", gradedBy: null, runner: "github_actions", students: [{ ...base, hand_ins }] });
  const good = { used: 2, allowed: 1, extra: 0, graded_sha: sha(1), graded_number: 1, ignored: [{ sha: sha(2), date: at(1), pushed_at: null, on_branch: true, number: 2, reason: "over-limit" }] };
  assert.equal(validateAgainst("grading-summary", doc(good)).valid, true);
  assert.equal(validateAgainst("grading-summary", doc({ ...good, allowed: 0 })).valid, false);
  assert.equal(validateAgainst("grading-summary", doc({ ...good, ignored: [{ ...good.ignored[0], reason: "whatever" }] })).valid, false);
  assert.equal(validateAgainst("grading-summary", doc({ ...good, surprise: 1 })).valid, false);
  const { used, ...noUsed } = good;
  assert.ok(used);
  assert.equal(validateAgainst("grading-summary", doc(noUsed)).valid, false);
});

test("the form's summary line names the cap, and only when there is one", () => {
  assert.equal(summariseGrading({ submissionMarker: MSG }), `From your template · graded on "${MSG}"`);
  assert.equal(summariseGrading({ submissionMarker: MSG, maxHandIns: 5 }), `From your template · graded on "${MSG}" · at most 5 hand-ins`);
  assert.equal(summariseGrading({ submissionMarker: MSG, maxHandIns: 1 }), `From your template · graded on "${MSG}" · at most 1 hand-in`);
  assert.equal(summariseGrading({ submissionMarker: "", maxHandIns: 5 }), "Off", "a cap without a marker caps nothing");
});

test("readMaxHandIns is the one judge the others use", () => {
  assert.equal(readMaxHandIns(3), 3);
  assert.equal(readMaxHandIns(0), null);
});

// =============================================================================
// Third review, 2026-09-26
// =============================================================================

// The workflow files a dispatch can have run: the grading workflow PXL
// Classroom writes (the real builder, so the judge is asked of the real file),
// and a student's own workflow that grades nothing.
const GRADING_PATH = STARTER_PATH;
const LINT_PATH = ".github/workflows/lint.yml";
const WORKFLOW_FILES = {
  [GRADING_PATH]: buildStarterWorkflow({ handInMessage: MSG }),
  [LINT_PATH]: "name: Lint\non: [push, workflow_dispatch]\njobs:\n  lint:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo lint\n",
};
const DISPATCH_HEAD = "f".repeat(40);

/**
 * A repository where the branch, the push runs and the dispatch runs are separate answers.
 * A dispatch is `{ n, min, by }`, graded commit `n` named in its title; `input: "main"` or
 * a short commit id is one whose title names no full commit, and `path` is the workflow it ran.
 */
function dispatchWorld({ branchHandIns = [], dispatches = [], pushRuns = true, contentsStatus = 200, files = WORKFLOW_FILES } = {}) {
  const branch = branchHandIns.map((b) => commitRow(sha(b.n), MSG, at(b.min))).reverse();
  const push = pushRuns ? branchHandIns.map((b) => runRow(sha(b.n), MSG, at(b.min), { id: 100 + b.n })).reverse() : [];
  const dispatch = dispatches.map((d, i) => ({
    id: 500 + i,
    event: "workflow_dispatch",
    path: d.path ?? GRADING_PATH,
    // What `run-name` makes of the input - measured 2026-09-27: `grade_sha=main`
    // is titled `Grade main (PXL Classroom)`, with head_sha main's tip.
    display_title: `Grade ${d.input ?? sha(d.n)} (PXL Classroom)`,
    created_at: at(d.min),
    triggering_actor: { login: d.by },
    head_sha: d.head ?? DISPATCH_HEAD,
  }));
  const log = pushLog(push);
  const reads = [];
  const get = async (path) => {
    if (path.includes("/commits?")) return { status: 200, data: branch };
    if (path.includes("event=workflow_dispatch")) return { status: 200, data: { workflow_runs: dispatch } };
    if (path.includes("event=push")) return { status: 200, data: { workflow_runs: push } };
    if (path.includes("/activity?")) return { status: 200, data: log };
    const file = path.match(new RegExp(`^/repos/${REPO}/contents/(.+)\\?ref=([0-9a-f]{40})$`));
    if (file) {
      reads.push(path);
      if (contentsStatus !== 200) return { status: contentsStatus, data: null };
      const text = files[decodeURIComponent(file[1])];
      return text == null ? { status: 404, data: null } : { status: 200, data: { content: Buffer.from(text).toString("base64") } };
    }
    return { status: 404, data: null };
  };
  get.reads = reads;
  return get;
}

test("A GRADING RUN THE STUDENT STARTED counts as a hand-in: it uses a slot and is never graded", async () => {
  // The user's decision: a student could otherwise have commits graded as
  // often as they liked under a cap, by pressing Run workflow themselves.
  const get = dispatchWorld({
    branchHandIns: [{ n: 1, min: 10 }, { n: 3, min: 40 }],
    dispatches: [{ n: 2, min: 20, by: "Ada" }, { n: 2, min: 25, by: "tomcoolpxl" }],
  });
  const listed = await listHandIns(get, { repoFullName: REPO, branch: "main", marker: marker(), students: ["ada"] });
  assert.equal(listed.handIns.length, 3, "the lecturer's dispatch is a grading decision, not a hand-in");
  const r = selectHandIn(listed.handIns, { until: DEADLINE, limit: 2 });
  assert.equal(r.used, 3);
  assert.equal(r.commit.sha, sha(1), "the dispatch took slot 2, so hand-in 3 is over the limit");
  assert.deepEqual(r.ignored.map((i) => i.reason), ["self-dispatched", "over-limit"]);
  assert.match(describeIgnoredHandIn(r.ignored[0], { allowed: 2 }), /grading run the student started .* counted as hand-in 2 of 2, never graded/);
  // No students named: nothing to attribute, nothing counted (and no read).
  const none = await listHandIns(get, { repoFullName: REPO, branch: "main", marker: marker() });
  assert.equal(none.handIns.length, 2);
});

/** Hand-ins 1 and 3 pushed, one dispatch between them: what does a limit of 2 grade? */
async function capOfTwoWith(dispatch, opts = {}) {
  const get = dispatchWorld({ branchHandIns: [{ n: 1, min: 10 }, { n: 3, min: 40 }], dispatches: [dispatch], ...opts });
  const listed = await listHandIns(get, { repoFullName: REPO, branch: "main", marker: marker(), students: ["ada"] });
  return { listed, get, picked: listed.ok ? selectHandIn(listed.handIns, { until: DEADLINE, limit: 2 }) : null };
}

test("A DISPATCH OF `main` counts: it graded the branch tip, and the title names no commit (review of v1.5.0)", async () => {
  // Measured 2026-09-27: `grade_sha=main` is accepted, titled
  // `Grade main (PXL Classroom)`, and checks out main's tip - the run's head_sha.
  const { listed, picked } = await capOfTwoWith({ n: 2, min: 20, by: "Ada", input: "main" });
  const d = listed.handIns.find((x) => x.dispatched);
  assert.equal(d?.sha, DISPATCH_HEAD, "the commit it graded is best known as the run's head");
  assert.equal(picked.used, 3);
  assert.equal(picked.commit.sha, sha(1), "the dispatch took slot 2");
  assert.deepEqual(picked.ignored.map((i) => i.reason), ["self-dispatched", "over-limit"]);
});

test("A DISPATCH OF A SHORT COMMIT ID counts too", async () => {
  const { listed, picked } = await capOfTwoWith({ n: 2, min: 20, by: "ada", input: sha(2).slice(0, 7) });
  assert.equal(listed.handIns.filter((x) => x.dispatched).length, 1);
  assert.equal(picked.commit.sha, sha(1));
});

test("a dispatch by a lecturer or the App is a grading decision, whatever its title", async () => {
  for (const by of ["tomcoolpxl", "pxl-classroom[bot]"]) {
    for (const input of [undefined, "main"]) {
      const { listed, picked } = await capOfTwoWith({ n: 2, min: 20, by, input });
      assert.equal(listed.handIns.some((x) => x.dispatched), false, `${by} ${input}`);
      assert.equal(picked.commit.sha, sha(3), `${by} ${input}`);
    }
  }
});

test("a student's dispatch of ANOTHER workflow is not a hand-in, and each file is read once", async () => {
  const get = dispatchWorld({
    branchHandIns: [{ n: 1, min: 10 }, { n: 3, min: 40 }],
    dispatches: [
      { n: 2, min: 20, by: "ada", path: LINT_PATH },
      { n: 2, min: 21, by: "ada", input: "main", path: LINT_PATH },
    ],
  });
  const listed = await listHandIns(get, { repoFullName: REPO, branch: "main", marker: marker(), students: ["ada"] });
  assert.equal(listed.handIns.some((x) => x.dispatched), false);
  assert.equal(selectHandIn(listed.handIns, { until: DEADLINE, limit: 2 }).commit.sha, sha(3));
  assert.deepEqual(get.reads, [`/repos/${REPO}/contents/.github/workflows/lint.yml?ref=${DISPATCH_HEAD}`]);
});

test("the grading workflow is judged by what it does, not its file name", async () => {
  // A template's own file, grading its own way: a job the grader would read.
  const own = ".github/workflows/exam.yml";
  const files = { ...WORKFLOW_FILES, [own]: "on: workflow_dispatch\njobs:\n  grading:\n    runs-on: ubuntu-latest\n    steps:\n      - run: ./test.sh\n" };
  const { listed } = await capOfTwoWith({ n: 2, min: 20, by: "ada", input: "main", path: own }, { files });
  assert.equal(listed.handIns.filter((x) => x.dispatched).length, 1);
});

test("a dispatched workflow file that could not be read is a failed read; one GitHub no longer has counts", async () => {
  for (const status of [403, 500, 0]) {
    const { listed } = await capOfTwoWith({ n: 2, min: 20, by: "ada", input: "main" }, { contentsStatus: status });
    assert.equal(listed.ok, false, String(status));
    assert.equal(listed.failedRead, "runs");
  }
  // The commit it ran was force-pushed away: nothing can show it did NOT grade.
  const { listed } = await capOfTwoWith({ n: 2, min: 20, by: "ada", input: "main" }, { contentsStatus: 404 });
  assert.equal(listed.ok, true);
  assert.equal(listed.handIns.filter((x) => x.dispatched).length, 1);
});

/** `get` with hand-in 2's push runs gone, and optionally its push-log entry too. */
const withoutTwo = (get, { fromLog = false } = {}) => async (path) => {
  const res = await get(path);
  if (path.includes("event=push")) return { ...res, data: { workflow_runs: res.data.workflow_runs.filter((r) => r.head_sha !== sha(2)) } };
  if (fromLog && path.includes("/activity?")) return { ...res, data: res.data.filter((a) => a.after !== sha(2)) };
  return res;
};

test("A HAND-IN IS A COMMIT A PUSH ENDED ON: one that was not the last of its push uses no place (2026-09-27)", async () => {
  // Hand-in 2 carries the message but was pushed together with a later
  // commit: no run, and no push ended on it.
  const get = withoutTwo(dispatchWorld({ branchHandIns: [{ n: 1, min: 10 }, { n: 2, min: 20 }, { n: 3, min: 30 }] }), { fromLog: true });
  const listed = await listHandIns(get, { repoFullName: REPO, branch: "main", marker: marker() });
  assert.deepEqual(listed.handIns.map((h) => h.sha), [sha(1), sha(3)]);
  const r = selectHandIn(listed.handIns, { until: DEADLINE, limit: 2 });
  assert.equal(r.commit.sha, sha(3), "hand-in 3 is the second that was pushed, so it is inside a limit of 2");
  // Without the run history the branch is all there is, as before.
  assert.equal((await listHandIns(get, { repoFullName: REPO, branch: "main", marker: marker(), withRuns: false })).handIns.length, 3);
});

test("DELETING A HAND-IN'S RUNS DOES NOT HIDE IT: the push log still names it (2026-09-27)", async () => {
  // The loophole the user refused: runs can be deleted by a repository admin,
  // the push log cannot.
  const get = withoutTwo(dispatchWorld({ branchHandIns: [{ n: 1, min: 10 }, { n: 2, min: 20 }, { n: 3, min: 30 }] }));
  const listed = await listHandIns(get, { repoFullName: REPO, branch: "main", marker: marker() });
  assert.deepEqual(listed.handIns.map((h) => h.sha), [sha(1), sha(2), sha(3)]);
  assert.equal(listed.handIns[1].pushedAt, at(20), "timed by the push log");
  assert.equal(selectHandIn(listed.handIns, { until: DEADLINE, limit: 2 }).commit.sha, sha(2));
});

test("ERASED FROM THE BRANCH AND ITS RUNS DELETED: still counted, from the push log and the commit itself", async () => {
  const base = dispatchWorld({ branchHandIns: [{ n: 1, min: 10 }, { n: 2, min: 20 }] });
  const get = async (path) => {
    // Hand-in 1 force-pushed away, its runs deleted; GitHub still has the commit.
    if (path.includes("/commits?")) return { status: 200, data: [commitRow(sha(2), MSG, at(20))] };
    if (path.includes("event=push")) return { status: 200, data: { workflow_runs: [runRow(sha(2), MSG, at(20), { id: 2 })] } };
    if (path.endsWith(`/commits/${sha(1)}`)) return { status: 200, data: { sha: sha(1), commit: { message: MSG, committer: { date: at(10) } } } };
    return base(path);
  };
  const listed = await listHandIns(get, { repoFullName: REPO, branch: "main", marker: marker() });
  assert.deepEqual(listed.handIns.map((h) => [h.sha, h.onBranch]), [[sha(1), false], [sha(2), true]]);
  // An unreadable push log is a failed read, named - never a count from the runs alone.
  const down = await listHandIns(async (p) => (p.includes("/activity?") ? { status: 502, data: null } : get(p)), { repoFullName: REPO, branch: "main", marker: marker() });
  assert.equal(down.ok, false);
  assert.equal(down.failedRead, "activity");
});

test("a dispatch is never the graded hand-in, even when it is the last valid one", () => {
  const r = selectHandIn([h(1, 10), { ...h(2, 20), dispatched: true, onBranch: false }], { until: DEADLINE, limit: 5 });
  assert.equal(r.commit.sha, sha(1));
  assert.equal(r.number, 1);
});

test("LATENESS is when GitHub saw the push, not the date the student's machine wrote", () => {
  // Committed with a backdated clock at 11:00, pushed at 12:30: late.
  const backdated = h(1, 120, { pushedAt: at(210) });
  assert.equal(selectHandIn([backdated], { until: DEADLINE, limit: 1 }).commit, null);
  // A push at 11:59:30 whose run started 12:00:40 is on time: the allowance.
  const edge = { ...h(2, 179.5), pushedAt: new Date(Date.parse(DEADLINE) + 40_000).toISOString() };
  assert.equal(selectHandIn([edge], { until: DEADLINE, limit: 1 }).commit.sha, sha(2));
  // No run: the commit date is all there is.
  assert.equal(selectHandIn([h(3, 100, { pushedAt: null })], { until: DEADLINE, limit: 1 }).commit.sha, sha(3));
});

test("the push log's time IS the push: no allowance for GitHub's latency is taken off it", () => {
  const fortySecondsLate = new Date(Date.parse(DEADLINE) + 40_000).toISOString();
  // The same instant from a run is on time (the run started after the push)...
  assert.equal(handInTime({ pushedAt: fortySecondsLate, pushedFrom: "run" }), Date.parse(fortySecondsLate) - PUSH_TO_RUN_ALLOWANCE_MS);
  // ...and from the push log, or from nowhere named, it is the time as it stands.
  assert.equal(handInTime({ pushedAt: fortySecondsLate, pushedFrom: "log" }), Date.parse(fortySecondsLate));
  assert.equal(handInTime({ pushedAt: fortySecondsLate }), Date.parse(fortySecondsLate));
  assert.equal(selectHandIn([h(1, 0, { pushedAt: fortySecondsLate, pushedFrom: "log" })], { until: DEADLINE, limit: 1 }).commit, null);
  assert.equal(selectHandIn([h(1, 0, { pushedAt: fortySecondsLate, pushedFrom: "run" })], { until: DEADLINE, limit: 1 }).commit.sha, sha(1));
});

test("listHandIns says where each push time came from, and a log-timed hand-in pushed after the deadline is late", async () => {
  // Hand-in 2's runs were deleted, so only the push log times it - 40s late.
  const late = new Date(Date.parse(DEADLINE) + 40_000).toISOString();
  const base = dispatchWorld({ branchHandIns: [{ n: 1, min: 10 }, { n: 2, min: 20 }] });
  const get = async (path) => {
    const res = await base(path);
    if (path.includes("event=push")) return { ...res, data: { workflow_runs: res.data.workflow_runs.filter((r) => r.head_sha !== sha(2)) } };
    if (path.includes("/activity?")) return { ...res, data: res.data.map((a) => (a.after === sha(2) ? { ...a, timestamp: late } : a)) };
    return res;
  };
  const listed = await listHandIns(get, { repoFullName: REPO, branch: "main", marker: marker() });
  assert.deepEqual(listed.handIns.map((x) => [x.sha, x.pushedFrom]), [[sha(1), "run"], [sha(2), "log"]]);
  const r = selectHandIn(listed.handIns, { until: DEADLINE, limit: 5 });
  assert.equal(r.commit.sha, sha(1));
  assert.deepEqual(r.ignored.map((i) => [i.sha, i.reason]), [[sha(2), "late"]]);
});

test("UNCAPPED `multiple: false` takes the FIRST hand-in from the run history too, so a force-push cannot move it", async () => {
  // Hand-in 1 was pushed, then erased from the branch; hand-in 2 is what the
  // branch shows. The first is still 1.
  const branch = [commitRow(sha(2), MSG, at(20))];
  const push = [runRow(sha(2), MSG, at(20), { id: 2 }), runRow(sha(1), MSG, at(10), { id: 1 })];
  const get = async (path) => path.includes("/commits?")
    ? { status: 200, data: branch }
    : { status: 200, data: { workflow_runs: path.includes("event=push") ? push : [] } };
  const found = await resolveHandIn(get, { row: { github_login: "ada", repo_name: REPO, effective_deadline_at: DEADLINE }, marker: marker({ multiple: false }) });
  assert.equal(found.verdict, "found");
  assert.equal(found.commit.sha, sha(1));
  assert.equal(found.handIns, null, "no cap, no count to report");
});
