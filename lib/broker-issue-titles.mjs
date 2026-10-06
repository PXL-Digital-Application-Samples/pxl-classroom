// PXL Classroom - recognising an issue this system put on a broker.
//
// A broker's issues are acceptance attempts. The title one carries depends on
// WHEN you look at it, and every reader but the broker itself looks after the
// change:
//
//   pxl-accept:<signature>      what the student's browser opens
//   pxl-confirm:<signature>     the same link asking to confirm an address
//   Acceptance (processed)      seconds later, once the broker has dispatched
//   Email confirmation (processed)
//   Acceptance attempt (rejected)
//
// Redaction is what protects the signed invitation on a public repository
// (ARCHITECTURE 4.3.2), so it is not going away, and code that recognises only
// the first two recognises almost nothing. That mistake has now been made three
// times in three places - the group team list, the returning student's own
// issue, and the stray-issue sweep below - so the answer lives here once.
//
// THE HANDLED TITLES ARE A LIST, AND A LIST IS A LIABILITY. They are written by
// `acceptance/broker-workflow.yml` and spelled again here, which is exactly the
// shape this repository keeps getting wrong. `tests/broker-issue-titles.test.mjs`
// therefore DERIVES the set from that template and requires it to equal this
// one, in both directions, so a reworded redaction fails a test rather than
// quietly making every acceptance look like a stray issue.
//
// Pure: no fs, no fetch. The SPA and the diagnostics engine both import it.

import { purposeForTitle } from "./acceptance-signature.mjs";

/** Every title the broker leaves on an issue once it has handled it. */
export const HANDLED_ISSUE_TITLES = Object.freeze([
  "Acceptance (processed)",
  "Email confirmation (processed)",
  "Acceptance (not delivered)",
  "Email confirmation (not delivered)",
  "Acceptance attempt (rejected)",
]);

/**
 * What an issue is titled when the broker verified it but could NOT hand it to
 * the hub - every dispatch try failed, or no token could be minted. Nothing is
 * coming for it, and the student's page says so at once rather than waiting
 * (frontend/src/lib/acceptance-progress.js). Written only by a broker published
 * on or after 2026-10-02; an older one titles the same failure "(processed)".
 */
export const NOT_DELIVERED_TITLE_BY_PURPOSE = Object.freeze({
  accept: "Acceptance (not delivered)",
  confirm: "Email confirmation (not delivered)",
});

/** Was this issue verified by the broker and then never handed to the hub? */
export function notDelivered(title) {
  if (typeof title !== "string") return false;
  /** @type {readonly string[]} */
  const titles = Object.values(NOT_DELIVERED_TITLE_BY_PURPOSE);
  return titles.includes(title.trim());
}

/** What a handled issue ends up titled, by what its link asked for. */
export const HANDLED_TITLE_BY_PURPOSE = Object.freeze({
  accept: "Acceptance (processed)",
  confirm: "Email confirmation (processed)",
});

/** What a REFUSED attempt ends up titled, whatever it asked for. */
export const REJECTED_ISSUE_TITLE = "Acceptance attempt (rejected)";

/**
 * What an issue asked for - `accept` or `confirm` - from any title it carries,
 * before or after the broker handled it. Null for a refusal, which is titled
 * the same whatever it asked, and for a title that is not ours.
 *
 * One broker carries both, so a reader looking for a student's ACCEPTANCE has
 * to tell them apart: a confirmation leaves no repository, and the accept page
 * read one as a request that finished with nothing set up.
 *
 * @param {unknown} title
 * @returns {"accept"|"confirm"|null}
 */
export function issuePurpose(title) {
  const signed = purposeForTitle(title);
  if (signed === "accept" || signed === "confirm") return signed;
  if (typeof title !== "string") return null;
  const t = title.trim();
  for (const titles of [HANDLED_TITLE_BY_PURPOSE, NOT_DELIVERED_TITLE_BY_PURPOSE]) {
    if (titles.accept === t) return "accept";
    if (titles.confirm === t) return "confirm";
  }
  return null;
}

/**
 * The title this one would carry once the broker has handled it.
 *
 * Used by the e2e fixture so a mocked broker leaves what the real one leaves:
 * a test handed a title production never produces is a test that can pass over
 * a page that cannot work, which is exactly how the team list stayed broken
 * while the suite stayed green.
 *
 * @param {unknown} title
 * @param {{rejected?: boolean}} [opts]
 */
export function handledTitleFor(title, { rejected = false } = {}) {
  const purpose = purposeForTitle(title);
  if (!purpose) return typeof title === "string" ? title : "";
  return rejected ? REJECTED_ISSUE_TITLE : HANDLED_TITLE_BY_PURPOSE[purpose];
}

/**
 * Is this issue one of ours, whenever it is being looked at?
 *
 * True for a title the SPA opened and for every title the broker rewrites one
 * to. False is what "somebody opened an unrelated issue on this repository"
 * looks like.
 *
 * @param {unknown} title
 */
export function isAcceptanceIssueTitle(title) {
  if (typeof title !== "string") return false;
  if (purposeForTitle(title)) return true;
  return HANDLED_ISSUE_TITLES.includes(title.trim());
}
