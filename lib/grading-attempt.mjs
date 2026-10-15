// PXL Classroom - which grading result at a commit a score may be read from.
//
// ISOMORPHIC: `request(method, path)` is passed in, as lib/grade-cohort.mjs
// takes one, because the SPA, the nightly and the CLI all read scores.
//
// A RE-RUN IS NOT A HAND-IN (review 2026-10-15, R6-6). GitHub's re-run of a
// workflow run keeps the run and adds an attempt; the attempt's check runs land
// in the SAME check suite with new ids, and the commit's check-run listing then
// shows only the newest unless asked for `filter=all` (measured on the
// testbed, tests/live/rerun-attempts.mjs). Anyone with write access can press
// it, a student included (201). So after the deadline a cloud exam's sandbox,
// still theirs, was graded again in whatever state they had left it, and under
// a hand-in cap a re-run graded again without using a place.
//
// The score is read from the attempt the push started (attempt 1, or a
// lecturer's "Grade this commit now" dispatch), or from a later attempt started
// by a PERSON who is not on the repository - a lecturer's "Run grading again".
// Never a bot: a workflow a student pushes to another branch can re-run the
// grading run with its own GITHUB_TOKEN, and the lock covers the submission
// branch only. Never a direct collaborator: a student who is admin can invite
// a friend to press it.

import { pickAutogradeCheckRun } from "./check-run-score.mjs";
import { normalizeLogin } from "./github-login.mjs";

const jobKey = (c) => `${c?.check_suite?.id ?? ""}\u0000${c?.name ?? ""}`;

/** How many pages of check runs one listing is read to before it is not a list. */
const CHECK_RUN_MAX_PAGES = 10;

/**
 * Every check run of a `check-runs` listing - a commit's or a check suite's -
 * page by page. ONE PAGE IS NOT THE LIST (review 2026-10-15, R6-43): every
 * re-run adds attempts, and on a commit with more check runs than one page
 * holds the grading check could be missed and a stored score replaced by "no
 * CI run". `path` already asks `per_page=100` and is the first page itself;
 * the next is asked only while a full page leaves some of `total_count` unread.
 * Answers like one response: a page that fails is returned as GitHub answered
 * it, and a walk that reached its cap is not `ok`.
 *
 * @param {(method: string, path: string) => Promise<any>} request
 * @param {string} path  `.../check-runs?filter=all&per_page=100`
 */
export async function getAllCheckRuns(request, path) {
  const first = await request("GET", path);
  if (!first?.ok || !Array.isArray(first.data?.check_runs)) return first;
  const runs = [...first.data.check_runs];
  const total = Number.isInteger(first.data.total_count) ? first.data.total_count : null;
  let pageSize = first.data.check_runs.length;
  for (let page = 2; pageSize === 100 && (total === null || runs.length < total); page++) {
    if (page > CHECK_RUN_MAX_PAGES) {
      return { ok: false, status: 0, data: { message: `more than ${CHECK_RUN_MAX_PAGES * 100} check runs, so not all of them could be read` } };
    }
    const res = await request("GET", `${path}&page=${page}`);
    if (!res?.ok || !Array.isArray(res.data?.check_runs)) return res;
    runs.push(...res.data.check_runs);
    pageSize = res.data.check_runs.length;
  }
  return { ...first, data: { ...first.data, check_runs: runs } };
}

/**
 * The newest check run of each job, in the listing's own order: what the
 * commit's listing shows without `filter=all`. Every attempt of one job is in
 * one check suite under one name, and a later attempt has the higher id.
 */
export function latestCheckRuns(checkRuns) {
  const runs = Array.isArray(checkRuns) ? checkRuns : [];
  const newest = new Map();
  for (const c of runs) {
    const n = newest.get(jobKey(c));
    if (!n || Number(c?.id) > Number(n?.id)) newest.set(jobKey(c), c);
  }
  return runs.filter((c) => newest.get(jobKey(c)) === c);
}

function isBot(actor) {
  return actor?.type === "Bot" || /\[bot\]$/i.test(String(actor?.login ?? ""));
}

/**
 * The grading check run a score may be read from, among a commit's check runs
 * listed with `filter=all`.
 *
 * Costs nothing extra unless the grading job ran more than once in its check
 * suite; then the run, each later attempt's starter and the counted attempt's
 * jobs are read.
 *
 * @param {(method: string, path: string) => Promise<{ok: boolean, status: number, data: any}>} request
 * @param {{ repoFullName: string, checkRuns: any[], students?: string[] }} a
 *   students: the repository's own students (the row's login and the team's)
 * @returns {Promise<{ ok: boolean, run?: any, ignored?: Array<{attempt: number, by: string|null}>,
 *            status?: number, response?: any }>}
 *   `ok: false` is a failed read, with its `status` and `response`. Otherwise
 *   `ignored` names each later attempt that was not counted, and who started it;
 *   `run: null` with `ignored` non-empty means every result there is one of those.
 */
export async function countedGradingRun(request, { repoFullName, checkRuns, students = [] }) {
  const runs = Array.isArray(checkRuns) ? checkRuns : [];
  const candidate = pickAutogradeCheckRun(latestCheckRuns(runs));
  if (!candidate) return { ok: true, run: null, ignored: [] };
  const attempts = runs.filter((c) => jobKey(c) === jobKey(candidate));
  if (attempts.length < 2 || candidate?.check_suite?.id == null) return { ok: true, run: candidate, ignored: [] };

  const fail = (res) => ({ ok: false, status: res?.status ?? 0, response: res });
  const wfRes = await request("GET", `/repos/${repoFullName}/actions/runs?check_suite_id=${candidate.check_suite.id}&per_page=1`);
  if (!wfRes?.ok) return fail(wfRes);
  const wf = wfRes.data?.workflow_runs?.[0];
  // Not an Actions run: nothing GitHub's re-run made, and no attempt to ask about.
  if (!wf?.id) return { ok: true, run: candidate, ignored: [] };

  const own = new Set((students || []).map((s) => normalizeLogin(s)).filter(Boolean));
  let direct = null;
  let directFailed = null;
  /** True: started by someone on the repository, so not counted. Null: could not tell. */
  const onRepository = async (actor) => {
    const login = normalizeLogin(actor?.login);
    if (!login || isBot(actor) || own.has(login)) return true;
    if (!direct) {
      const res = await request("GET", `/repos/${repoFullName}/collaborators?affiliation=direct&per_page=100`);
      if (!res?.ok) {
        directFailed = res;
        return null;
      }
      direct = new Set((Array.isArray(res.data) ? res.data : []).map((c) => normalizeLogin(c?.login)).filter(Boolean));
    }
    return direct.has(login);
  };

  const ignored = [];
  for (let k = Number(wf.run_attempt) || 1; k >= 1; k--) {
    if (k > 1) {
      let actor = wf.triggering_actor;
      if (k !== Number(wf.run_attempt)) {
        const a = await request("GET", `/repos/${repoFullName}/actions/runs/${wf.id}/attempts/${k}`);
        if (!a?.ok) return fail(a);
        actor = a.data?.triggering_actor;
      }
      const theirs = await onRepository(actor);
      if (theirs === null) return fail(directFailed);
      if (theirs) {
        ignored.push({ attempt: k, by: actor?.login ?? null });
        continue;
      }
    }
    const jobs = await request("GET", `/repos/${repoFullName}/actions/runs/${wf.id}/attempts/${k}/jobs?per_page=100`);
    if (!jobs?.ok) return fail(jobs);
    const ids = new Set((jobs.data?.jobs || []).map((j) => Number(String(j?.check_run_url ?? "").split("/").pop()) || Number(j?.id)));
    const run = attempts.find((c) => ids.has(Number(c?.id)));
    if (run) return { ok: true, run, ignored };
    // This attempt did not run the grading job (a re-run of failed jobs only):
    // the result it kept is an older attempt's.
  }
  return { ok: true, run: null, ignored };
}

/** The sentence for a commit whose only grading results are attempts that do not count. */
export function rerunOnlyReason(short, ignored) {
  const by = [...new Set((ignored || []).map((i) => i.by).filter(Boolean))];
  return `the only grading result at commit ${short} is from its run started again${by.length ? ` by ${by.join(", ")}` : ""}, which does not count - only the run its push started, or one a lecturer starts again`;
}
