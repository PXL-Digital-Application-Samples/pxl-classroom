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
  "Acceptance attempt (rejected)",
]);

/** What a handled issue ends up titled, by what its link asked for. */
export const HANDLED_TITLE_BY_PURPOSE = Object.freeze({
  accept: "Acceptance (processed)",
  confirm: "Email confirmation (processed)",
});

/** What a REFUSED attempt ends up titled, whatever it asked for. */
export const REJECTED_ISSUE_TITLE = "Acceptance attempt (rejected)";

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
