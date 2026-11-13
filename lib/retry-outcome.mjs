// PXL Classroom - how a lecturer's Retry ended, said by the run and read by
// the page.
//
// WHY IT EXISTS (2026-11-13). The page printed "Retry started. @student is on
// the assignment's list in a minute or two" the moment the dispatch was
// accepted, whatever the hub then decided. For a student whose Retry the hub
// refused two seconds later (`rejected:no-claim`) that sentence was false, the
// run was green because a refusal is an outcome, and the lecturer marked the
// notice dealt with on the strength of it. A message no branch computed is a
// guess (CLAUDE.md).
//
// A refusal on a Retry is written nowhere a lecturer's page can read: it is
// not persisted and posts no notice. So the run says it itself, as ONE notice
// annotation on its own job, which GitHub serves for a public repository's
// check run. `retryOutcomeLine` writes it (scripts/say-retry-outcome.mjs) and
// `parseRetryOutcome` reads it back - one pair, one file, round-tripped by
// tests/retry-outcome.test.mjs.
//
// Pure and isomorphic.

import { rejectionReason } from "./rejection-notice.mjs";

/** The annotation's title: how the page finds this run's own word among others. */
export const RETRY_OUTCOME_TITLE = "pxl-retry-outcome";

const FIELDS = ["accept", "provision", "record"];
// An outcome is `word` or `word:word-word`; a step outcome is a bare word.
const VALUE_RE = /^[a-z][a-z0-9:-]{0,80}$/;

/**
 * The annotation's message. Unknown or malformed values are left out rather
 * than written: an absent field reads as "did not happen".
 *
 * @param {{accept?: string, provision?: string, record?: string}} p
 *   `accept`: accept.mjs's outcome; `provision`: provisioning's; `record`: the
 *   record step's own outcome (`success`, `failure`, `skipped`)
 */
export function retryOutcomeLine(p = {}) {
  return FIELDS.filter((f) => VALUE_RE.test(String(p[f] ?? ""))).map((f) => `${f}=${p[f]}`).join(" ");
}

/**
 * This run's outcome from its job's annotations, or null when it said none.
 *
 * @param {Array<{title?: string, message?: string, annotation_level?: string}>|null|undefined} annotations
 * @returns {{accept: string, provision: string, record: string}|null}
 */
export function parseRetryOutcome(annotations) {
  const mine = (Array.isArray(annotations) ? annotations : []).find((a) => a?.title === RETRY_OUTCOME_TITLE);
  if (!mine) return null;
  const out = { accept: "", provision: "", record: "" };
  for (const part of String(mine.message || "").trim().split(/\s+/)) {
    const eq = part.indexOf("=");
    const key = eq > 0 ? part.slice(0, eq) : "";
    const value = eq > 0 ? part.slice(eq + 1) : "";
    if (FIELDS.includes(key) && VALUE_RE.test(value)) out[key] = value;
  }
  return out;
}

const RUNNING = new Set(["queued", "in_progress", "waiting", "pending", "requested"]);
const ADMITTED = new Set(["accepted", "already-accepted"]);

/**
 * What to do about a refusal, where there is something a lecturer can do.
 * Keyed by the outcome; absent means the reason alone is the message.
 */
const ADVICE = Object.freeze({
  "rejected:no-claim": (login) =>
    `This assignment asks every student to confirm their email address, and none is stored for @${login}. Ask them to open the invitation link and accept again with their address; they keep their repository and the work in it.`,
  "rejected:past-deadline": () => "The deadline has passed and this repository is locked. Reopen the student on the assignment page first.",
  "rejected:not-published": () => "Publish the assignment first.",
  "rejected:not-in-cohort": (login) => `Add @${login} to this assignment's students first.`,
  "rejected:not-on-roster": (login) => `Add @${login} to the roster first.`,
});

/**
 * @typedef {{state: "waiting"|"added"|"refused"|"failed"|"unknown",
 *           tone: "neutral"|"success"|"warning"|"danger", text: string, done: boolean}} RetryView
 */

/**
 * The line under the Retry button.
 *
 * @param {object} p
 * @param {string} p.login
 * @param {{status?: string, conclusion?: string|null}|null|undefined} p.run
 *        the run, `null` when it could not be read this time, `undefined` before the first read
 * @param {ReturnType<typeof parseRetryOutcome>} [p.outcome]  only once the run is over
 * @param {boolean} [p.outcomeRead]  false when the annotations could not be READ (not: there were none)
 * @returns {RetryView}
 */
export function describeRetry({ login, run, outcome = null, outcomeRead = true }) {
  const who = `@${login}`;
  if (run === undefined || (run && RUNNING.has(String(run.status)))) {
    return { state: "waiting", tone: "neutral", done: false, text: "Retry started. Waiting for the answer…" };
  }
  if (run === null) {
    return { state: "unknown", tone: "neutral", done: false, text: "Retry started, but its run could not be read just now. Checking again…" };
  }
  // Over. What it decided is its own annotation, never its colour: a refusal
  // is green.
  if (!outcome) {
    if (!outcomeRead) {
      return { state: "unknown", tone: "neutral", done: true, text: `The retry has ended, but its answer could not be read. Open the assignment page to see whether ${who} is on its list.` };
    }
    return run.conclusion === "success"
      ? { state: "unknown", tone: "neutral", done: true, text: `The retry has ended without saying what it decided. Open the assignment page to see whether ${who} is on its list.` }
      : { state: "failed", tone: "danger", done: true, text: `The retry failed before it decided anything, so nothing was changed for ${who}. Open its run to see why.` };
  }
  if (outcome.accept.startsWith("rejected:")) {
    const advice = ADVICE[outcome.accept]?.(login);
    return {
      state: "refused", tone: "warning", done: true,
      text: `Not added: ${rejectionReason(outcome.accept)}.${advice ? ` ${advice}` : ""}`,
    };
  }
  if (ADMITTED.has(outcome.accept)) {
    if (outcome.provision.startsWith("fail")) {
      return { state: "failed", tone: "danger", done: true, text: `${who} was admitted, but their repository could not be set up. Open the run to see why, then retry.` };
    }
    if (outcome.record === "success") {
      return { state: "added", tone: "success", done: true, text: `${who} is on the assignment's list.` };
    }
    return { state: "failed", tone: "danger", done: true, text: `${who} was admitted, but their record could not be saved, so they are not on the list yet. Retry once more.` };
  }
  return { state: "failed", tone: "danger", done: true, text: `The retry failed (${outcome.accept || "no decision"}), so nothing was changed for ${who}. Open its run to see why.` };
}
