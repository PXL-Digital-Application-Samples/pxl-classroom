// Acceptance attempts that got no answer at all.
//
// An attempt is an issue on the assignment's public broker. It is answered when
// the hub labels it (`outcome:invited` / `outcome:rejected`) or records a
// decision for it (the acceptance record's `issue_number`, which every decision
// stamps - lib/acceptance-reservation.mjs). When GitHub drops the event, a run
// never starts, or a run dies before it records anything, NOTHING is written
// anywhere: the student emails their lecturer, or gives up. This is the other
// side of that - the nightly lists them for the lecturer, from the issues
// themselves.
//
// REPORT ONLY. The nightly never accepts on a student's behalf.
//
// Pure, so the test runs it on fixtures.

import { OUTCOME_LABELS } from "./acceptance-labels.mjs";
import { issuePurpose, notDelivered } from "./broker-issue-titles.mjs";
import { purposeForTitle } from "./acceptance-signature.mjs";

/** How far back the nightly looks: a day, plus slack for when it ran yesterday. */
export const UNANSWERED_WINDOW_MS = 26 * 60 * 60 * 1000;

/** An attempt younger than this may still be running, and is not reported. */
export const UNANSWERED_SETTLE_MS = 30 * 60 * 1000;

/**
 * Where an unanswered attempt stopped, as far as its issue shows.
 *
 * - `not-started`: the title still carries the signed invitation, so the
 *   broker never ran on it (GitHub dropped the event, or invitations were off).
 * - `not-delivered`: the broker verified it and could not hand it to the hub.
 * - `no-answer`: handed to the hub, and the hub neither labelled it nor
 *   recorded a decision - its run never started, was cancelled, or failed.
 * - `not-finished`: the hub decided it and saved the decision, and the run
 *   stopped before provisioning finished.
 */
export const STAGES = Object.freeze(["not-started", "not-delivered", "no-answer", "not-finished"]);

function labelNames(issue) {
  return (Array.isArray(issue?.labels) ? issue.labels : [])
    .map((l) => (typeof l === "string" ? l : l?.name))
    .filter((n) => typeof n === "string");
}

/**
 * Is this an attempt to ACCEPT, by its title? Not an address confirmation, not
 * a link the broker refused (titled the same whatever it asked, and shown to
 * the student already), and not an issue somebody wrote by hand.
 */
function isAcceptAttempt(title) {
  return issuePurpose(title) === "accept";
}

/**
 * @param {object} args
 * @param {Array<{number: number, title?: string, created_at?: string, user?: {login?: string}, labels?: unknown[]}>} args.issues
 *   the broker's issues, any order
 * @param {(login: string) => ({issue_number?: unknown, status?: unknown}|null)} args.acceptanceOf
 *   this student's acceptance record for the assignment, or null
 * @param {Date} [args.now]
 * @returns {Array<{login: string, number: number, created_at: string, stage: string}>}
 */
export function unansweredAttempts({ issues, acceptanceOf, now = new Date() }) {
  const newest = Math.max(0, now.getTime() - UNANSWERED_SETTLE_MS);
  const oldest = now.getTime() - UNANSWERED_WINDOW_MS;

  // The newest attempt per student is the one that matters: an older one is
  // either superseded by it or answered through it. The newest ATTEMPT TO
  // ACCEPT - filtered first, not after: a later issue that is not one (an
  // address confirmation, a refused link, "I clicked accept and nothing
  // happened" written by hand) took the place of the unanswered attempt and
  // was then skipped, so the student who complained on the broker was exactly
  // the one the report dropped (review 2026-10-06).
  const latest = new Map();
  for (const issue of issues || []) {
    const login = issue?.user?.login;
    if (typeof login !== "string" || !login) continue;
    if (!Number.isInteger(issue?.number)) continue;
    if (!isAcceptAttempt(issue?.title)) continue;
    const key = login.toLowerCase();
    if (!latest.has(key) || latest.get(key).number < issue.number) latest.set(key, issue);
  }

  const out = [];
  for (const issue of latest.values()) {
    const created = Date.parse(issue.created_at ?? "");
    if (!Number.isFinite(created) || created < oldest || created > newest) continue;
    const title = String(issue.title ?? "").trim();
    if (labelNames(issue).some((n) => OUTCOME_LABELS.includes(n))) continue;

    const record = acceptanceOf(issue.user.login);
    let stage = purposeForTitle(title) ? "not-started" : notDelivered(title) ? "not-delivered" : "no-answer";
    if (record) {
      const decided = record.issue_number;
      // A record from before decisions were stamped answers nothing either
      // way; it is read as answered, so the first night after the change does
      // not report every returning student.
      if (!Number.isInteger(decided) || decided > issue.number) continue;
      if (decided === issue.number) {
        // DECIDED, AND THEN NOTHING. The decision is saved before anything is
        // provisioned (acceptance/reserve.mjs), so a run that died after it -
        // runner lost, cancelled, GitHub down - leaves a record still saying
        // `accepted` and no repository: the student is in their team on paper
        // and has nothing. A provisioning that ran to an end says
        // `provisioned` or `failed` (and `failed` is notified on its own).
        if (record.status !== "accepted" && record.status !== "provisioning") continue;
        stage = "not-finished";
      }
    }

    out.push({
      login: issue.user.login,
      number: issue.number,
      created_at: new Date(created).toISOString(),
      stage,
    });
  }
  return out.sort((a, b) => a.number - b.number);
}
