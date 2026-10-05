// The instructor notifications of one organization, read for the
// Organization page.
//
// Every workflow that needs a lecturer posts a comment on the control
// repository's "[NOTICE] PXL Classroom - Instructor Notifications" issue
// (notify/notify.mjs): a hidden dedup key, `### <marker> <event-type>`, the
// assignment, the time, and plain-language details. A repeat of the same event
// rewrites its comment, so the issue holds one comment per thing, at the time it
// last happened. Lecturers rarely look there; the Organization page shows them
// (BETA-UX.md, 2026-10-02).
//
// NOTHING MARKS A NOTICE DONE. A comment is rewritten when its event repeats and
// otherwise stays for ever, so "needs you" can only honestly mean RECENT: the
// page lists the notices of the last NEEDS_YOU_DAYS days that ask for an action,
// and says that is what it lists. Refusals (`acceptance-rejected`) are the
// assignment working as configured and are counted elsewhere, never listed as
// something to do.
//
// Pure and isomorphic: the SPA parses what the API returned, the test runs it.

/** Must equal notify/notify.mjs. Checked by tests/org-notices.test.mjs. */
export const DEDUP_MARKER = "<!-- pxl-dedup:";

/** How far back the "needs you" list looks. */
export const NEEDS_YOU_DAYS = 14;

/** Event types that ask a lecturer to do something. */
export const ACTION_EVENTS = Object.freeze([
  "provisioning-failed",
  "collection-failed",
  "missing-access",
  "unexpected-deletion",
  "preservation-failed",
  "run-failed",
]);

/** Event types that inform and ask nothing. */
export const INFO_EVENTS = Object.freeze(["deadline-gap", "late-activity"]);

/**
 * One comment, parsed. Null for a comment this system did not write.
 *
 * @param {{body?: unknown, html_url?: string, updated_at?: string}} comment
 * @returns {{key: string, eventType: string, assignmentId: string, at: string|null,
 *            details: string, url: string|null, kind: "action"|"info"|"refusal"|"other"}|null}
 */
export function parseNotice(comment) {
  const body = typeof comment?.body === "string" ? comment.body : "";
  const at = body.indexOf(DEDUP_MARKER);
  const heading = /^###\s+\S+\s+([a-z-]+)\s*$/m.exec(body);
  if (!heading) return null;
  let key = "";
  if (at >= 0) {
    const end = body.indexOf("-->", at);
    if (end > at) key = body.slice(at + DEDUP_MARKER.length, end).trim();
  }
  const eventType = heading[1];
  const assignmentId = (/^\*\*Assignment:\*\*\s*(.+)$/m.exec(body)?.[1] || "").trim();
  const time = (/^\*\*Time:\*\*\s*(\S+)/m.exec(body)?.[1] || "").trim();
  const when = Number.isFinite(Date.parse(time)) ? new Date(time).toISOString() : comment?.updated_at || null;
  const timeLine = /^\*\*Time:\*\*.*$/m.exec(body);
  const details = timeLine ? body.slice(timeLine.index + timeLine[0].length).trim() : "";
  const kind = eventType === "acceptance-rejected"
    ? "refusal"
    : ACTION_EVENTS.includes(eventType)
      ? "action"
      : INFO_EVENTS.includes(eventType)
        ? "info"
        : "other";
  return { key, eventType, assignmentId, at: when, details, url: comment?.html_url || null, kind };
}

/**
 * What needs the lecturer: action notices of the last NEEDS_YOU_DAYS days,
 * newest first.
 *
 * @param {Array<object>} comments the tracking issue's comments, any order
 * @param {{now?: Date, days?: number}} [opts]
 */
export function noticesNeedingYou(comments, { now = new Date(), days = NEEDS_YOU_DAYS } = {}) {
  const since = now.getTime() - days * 24 * 60 * 60 * 1000;
  return (Array.isArray(comments) ? comments : [])
    .map(parseNotice)
    .filter((n) => n && n.kind === "action" && n.at && Date.parse(n.at) >= since)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

/**
 * The details of a notice as plain text: markdown emphasis and code marks
 * dropped, links reduced to their text. The page shows words, not markdown.
 *
 * @param {string} details
 */
export function plainDetails(details) {
  return String(details || "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}
