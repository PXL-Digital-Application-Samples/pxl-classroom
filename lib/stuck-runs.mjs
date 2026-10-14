// Which hub workflow runs count as stuck - for the dashboard's warning (with a
// Cancel button) and the Pipeline Watchdog's alert, which both used a blanket
// 15 minutes waiting / 45 in progress.
//
// On 2026-10-12 that put "Deadline Sentinel has been in_progress for 216m" and
// **Cancel Run** in front of a lecturer eleven minutes before two exam
// deadlines, and emailed "[ALERT] Pipeline Run Stuck ... Requires manual
// cancellation or attention" - over the one run that waits for hours by
// design, to lock the repositories at the instant. Cancelling it would have
// locked nothing at 22:00.
//
// A workflow built to run long is stuck only past its own limit: its longest
// job's `timeout-minutes`, plus a margin for the jobs before it.
// `tests/stuck-runs.test.mjs` derives the table from the workflow files, so a
// new long job, or a changed limit, fails there rather than here.
//
// Isomorphic and dependency-free: the watchdog imports it, and the SPA
// re-exports it (frontend/src/lib/stuck-runs.js).

/**
 * Workflow path -> its longest job's `timeout-minutes`, where that reaches the
 * default. AT the default too (review 2026-10-14): a starter sync allowed its
 * full 45 minutes was "stuck" at the minute it was allowed to end, with no
 * margin for its runner's queue or its final record, and offered for cancelling.
 */
export const LONG_RUNNING_WORKFLOWS = Object.freeze({
  ".github/workflows/deadline-sentinel.yml": 300,
  ".github/workflows/sync-starter-code.yml": 45,
});

const WAITING_MINUTES = 15;
const RUNNING_MINUTES = 45;
const MARGIN_MINUTES = 15;

/**
 * How long a run of this workflow may be in this state before it is stuck.
 * `pending` (review 2026-10-14, R1-11) is a run waiting on its concurrency
 * group behind a running one, so it may wait as long as that one may run: a
 * second Deadline Sentinel pends for hours behind the first by design, and a
 * 15-minute limit there would repeat the 2026-10-12 false alarm.
 */
export function stuckAfterMinutes(path, status) {
  if (status !== "in_progress" && status !== "pending") return WAITING_MINUTES;
  const own = LONG_RUNNING_WORKFLOWS[path];
  return own ? own + MARGIN_MINUTES : RUNNING_MINUTES;
}

/**
 * How long a run has been at it: from its latest start. A re-run keeps the
 * run's `created_at` and moves `run_started_at`, so a sentinel re-run hours
 * later was "stuck" the moment it began (review 2026-10-14).
 */
export function runAgeMs(r, now = Date.now()) {
  return now - new Date(r?.run_started_at || r?.created_at).getTime();
}

/**
 * The runs to warn about, in the order given.
 *
 * @param {Array<{id: number, name?: string, path?: string, status: string, created_at: string, run_started_at?: string}>} runs
 * @param {number} now
 */
export function stuckRuns(runs, now = Date.now()) {
  const out = [];
  for (const r of runs || []) {
    const ageMs = runAgeMs(r, now);
    if (!Number.isFinite(ageMs)) continue;
    if (ageMs > stuckAfterMinutes(r.path, r.status) * 60_000) {
      out.push({ id: r.id, name: r.name || "Workflow", status: r.status, durationMin: Math.max(1, Math.round(ageMs / 60_000)) });
    }
  }
  return out;
}

/**
 * A repository's runs in one status, EVERY PAGE (up to `maxPages` of 100).
 * GitHub lists newest first, so the stuck runs - the oldest - are the ones one
 * page drops during an acceptance burst: the dashboard read a page of 30 and
 * showed nothing (review 2026-10-14, G8b). `whole` is false when a page failed
 * or the walk ran out of pages; what was read is still returned.
 *
 * @param {(method: string, path: string) => Promise<{ ok: boolean, data: any }>} request
 * @param {{ owner: string, repo: string, status: string, maxPages?: number }} a
 * @returns {Promise<{ runs: any[], whole: boolean }>}
 */
export async function listRunsInStatus(request, { owner, repo, status, maxPages = 10 }) {
  const runs = [];
  for (let page = 1; page <= maxPages; page++) {
    const res = await request("GET", `/repos/${owner}/${repo}/actions/runs?status=${status}&per_page=100&page=${page}`);
    const batch = res?.ok && Array.isArray(res.data?.workflow_runs) ? res.data.workflow_runs : null;
    if (!batch) return { runs, whole: false };
    runs.push(...batch);
    if (batch.length < 100) return { runs, whole: true };
  }
  return { runs, whole: false };
}
