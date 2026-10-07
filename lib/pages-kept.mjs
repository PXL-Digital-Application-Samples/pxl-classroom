// How a Pages deploy says it kept an organization's old pages.
//
// scripts/fetch-pages-data.mjs keeps an organization it cannot read as the
// previous deployment published it, and the deploy succeeds. So a deploy that
// kept one is NOT a deploy that brought every page up to date - and the
// watchdog, which redeploys when the pages are behind the data, read it as one:
// a single 502 for one organization left its new assignment off the student
// site until the next change anywhere (review 2026-10-07).
//
// The fetch step sets its `kept` output (held to the script by
// tests/workflow-output-contract.test.mjs), and the step named KEPT_STEP_NAME
// runs only when it is true. Whether that step ran is something the watchdog
// can read off the run (`GET /actions/runs/{id}/jobs`) without anything being
// published. tests/pages-kept.test.mjs holds deploy-frontend.yml to the name.

export const KEPT_STEP_NAME = "Tell an administrator about organizations kept as they were";

/** The job that puts the student pages live (deploy-frontend.yml `deploy`). */
export const DEPLOY_JOB = "deploy";

/**
 * Did this run keep an organization's old pages? From its jobs, as
 * `GET /repos/{o}/{r}/actions/runs/{id}/jobs` returns them.
 *
 * @param {Array<{steps?: Array<{name?: string, conclusion?: string|null}>}>} jobs
 */
export function keptAnOrganization(jobs) {
  return (jobs || []).some((job) =>
    (job?.steps || []).some((s) => s?.name === KEPT_STEP_NAME && s.conclusion && s.conclusion !== "skipped"),
  );
}

/**
 * What a deploy run did for the student pages: judged by the job that puts
 * them live, not by the run. The run also builds the beta channel, and a beta
 * that failed failed the run while the pages went out - so the watchdog
 * redeployed good pages and then, three "failures" on, stopped retrying real
 * ones (review 2026-10-07). With no such job in the list (renamed, or a run
 * from before it), the run's own conclusion.
 *
 * @param {{conclusion?: string|null}} run
 * @param {Array<{name?: string, conclusion?: string|null, steps?: object[]}>} jobs
 * @returns {{conclusion: string|null, kept: boolean}}
 */
export function pagesOutcome(run, jobs) {
  const publish = (jobs || []).find((j) => j?.name === DEPLOY_JOB);
  let conclusion = run?.conclusion ?? null;
  if (publish) {
    if (publish.conclusion === "success") conclusion = "success";
    else if (publish.conclusion === "cancelled" || run?.conclusion === "cancelled") conclusion = "cancelled";
    else conclusion = "failure";
  }
  return { conclusion, kept: keptAnOrganization(jobs) };
}
