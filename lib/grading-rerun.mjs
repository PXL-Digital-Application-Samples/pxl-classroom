// Can a commit's grading be run again - and if not, why not? PURE.
//
// The only way this system can start grading for a PAST commit is GitHub's
// re-run of a workflow run that already exists for it
// (`POST /repos/{o}/{r}/actions/runs/{id}/rerun`). A re-run replays the
// original push, so:
//
//   * a commit that was not the newest of its push has NO run - GitHub runs a
//     push workflow for the pushed head only - and cannot be re-run;
//   * a job gated on the hand-in message (`if: head_commit.message == ...`)
//     that skipped at a non-hand-in commit skips again - offering it would be a
//     button that does nothing;
//   * GitHub re-runs only within 30 days of the original run;
//   * it runs the tests AS THEY WERE at that commit, not the template's current
//     ones - the caller says so beside the button.
//
// Anything this cannot establish is "cannot", with the reason - never a button
// that fails after it is pressed.

export const RERUN_WINDOW_DAYS = 30;

/**
 * @param {object} a
 * @param {Array<{id: number, event?: string, name?: string, status?: string, created_at?: string}>|null} a.runs
 *   `GET /actions/runs?head_sha=...` workflow_runs, or null if unreadable
 * @param {{value: string}|null} a.marker
 * @param {boolean|null} a.isHandIn     whether this commit's message is the hand-in message (null without a marker)
 * @param {Date} [a.now]
 * @param {string|null} [a.workflowPath]  the grading workflow's file; its runs only
 * @returns {{ can: boolean, runId: number|null, why: string|null }}
 */
export function rerunAvailability({ runs, marker = null, isHandIn = null, now = new Date(), workflowPath = null }) {
  const no = (why) => ({ can: false, runId: null, why });
  if (!Array.isArray(runs)) return no("Could not read this commit's runs, so it is not known whether its grading can run again.");
  // THE GRADING WORKFLOW'S run, by its file when the caller knows it: every
  // workflow in the repository starts a run on the same push, and "the first
  // one" re-ran a lint workflow and reported grading had started (third
  // review, 2026-09-26). No run of that file is "cannot", never another file's.
  const ofFile = (r) => !workflowPath || r?.path === workflowPath || String(r?.path || "").startsWith(`${workflowPath}@`);
  const push = runs.filter((r) => r?.event === "push" && ofFile(r));
  if (!push.length) {
    return no(
      "No grading run exists for this commit: it was not the newest commit of its push, and GitHub only runs the workflow for that one, so there is nothing to run again.",
    );
  }
  if (marker && isHandIn === false) {
    return no(`Its grading only runs for a "${marker.value}" commit, so running it again would skip again.`);
  }
  // Without the file, a name that says grading - and nothing else: guessing
  // push[0] is how another workflow was re-run.
  const run = workflowPath ? push[0] : push.find((r) => /grad|classroom/i.test(r?.name || ""));
  if (!run) return no("No grading run exists for this commit, so there is nothing to run again.");
  if (run.status && run.status !== "completed") return no("Its grading run is still going - wait for it to finish.");
  const age = (now.getTime() - Date.parse(run.created_at)) / 86_400_000;
  if (Number.isFinite(age) && age > RERUN_WINDOW_DAYS) {
    return no(`GitHub only runs a workflow again within ${RERUN_WINDOW_DAYS} days of the original run, and this one is ${Math.floor(age)} days old.`);
  }
  return { can: true, runId: run.id, why: null };
}
