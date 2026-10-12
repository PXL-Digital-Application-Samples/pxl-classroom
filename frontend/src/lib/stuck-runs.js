// Which hub workflow runs the dashboard calls stuck, with a Cancel button.
//
// A run waiting for a runner over 15 minutes, or in progress over 45, was
// flagged whatever it was. On 2026-10-12 that put "Pipeline Warning: Deadline
// Sentinel has been in_progress for 216m" and **Cancel Run** in front of a
// lecturer eleven minutes before two exam deadlines - over the one run that
// waits for hours by design, to lock the repositories at the instant.
// Cancelling it would have locked nothing at 22:00.
//
// A workflow built to run long is flagged only past its own limit: its
// longest job's `timeout-minutes`, plus a margin for the jobs before it.
// `tests/stuck-runs.test.mjs` derives this table from the workflow files, so
// a new long job, or a changed limit, fails there rather than here.

/** Workflow path -> its longest job's `timeout-minutes`, where that exceeds the default. */
export const LONG_RUNNING_WORKFLOWS = Object.freeze({
  '.github/workflows/deadline-sentinel.yml': 300,
})

const WAITING_MINUTES = 15
const RUNNING_MINUTES = 45
const MARGIN_MINUTES = 15

/** How long a run of this workflow may be in this state before it is stuck. */
export function stuckAfterMinutes(path, status) {
  if (status !== 'in_progress') return WAITING_MINUTES
  const own = LONG_RUNNING_WORKFLOWS[path]
  return own ? own + MARGIN_MINUTES : RUNNING_MINUTES
}

/**
 * The runs to warn about, oldest first in the order given.
 *
 * @param {Array<{id: number, name?: string, path?: string, status: string, created_at: string}>} runs
 * @param {number} now
 */
export function stuckRuns(runs, now = Date.now()) {
  const out = []
  for (const r of runs || []) {
    const ageMs = now - new Date(r.created_at).getTime()
    if (!Number.isFinite(ageMs)) continue
    if (ageMs > stuckAfterMinutes(r.path, r.status) * 60_000) {
      out.push({ id: r.id, name: r.name || 'Workflow', status: r.status, durationMin: Math.max(1, Math.round(ageMs / 60_000)) })
    }
  }
  return out
}
