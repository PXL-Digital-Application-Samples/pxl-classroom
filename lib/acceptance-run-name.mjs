// The name of the hub run that handles one acceptance attempt.
//
// acceptance-handler.yml sets `run-name:` from the dispatch, and the student's
// page looks for its own run by that name in the hub's public run list - which
// is how it tells "GitHub has not started your request yet" from "it ran and
// stopped" (frontend/src/lib/acceptance-progress.js). Spelled twice, once in
// YAML that cannot import this, so tests/acceptance-run-name.test.mjs rebuilds
// the workflow's expression from RUN_NAME_PREFIX and fails when they disagree.
// A name that drifted would not break anything loudly: the page would simply
// never find a run, and fall back to waiting.
//
// Isomorphic and dependency-free: the browser imports it.

export const RUN_NAME_PREFIX = "acceptance ";

/**
 * @param {string} brokerRepo `owner/name` of the broker the issue is on
 * @param {number|string} issueNumber
 * @returns {string}
 */
export function acceptanceRunName(brokerRepo, issueNumber) {
  return `${RUN_NAME_PREFIX}${brokerRepo}#${issueNumber}`;
}
