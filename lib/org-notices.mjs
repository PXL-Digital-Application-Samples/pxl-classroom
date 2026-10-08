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
// "Needs you" means RECENT: the page lists the notices of the last
// NEEDS_YOU_DAYS days that ask for an action, and says that is what it lists.
// Refusals (`acceptance-rejected`) are the assignment working as configured and
// are counted elsewhere, never listed as something to do.
//
// A LECTURER MARKS ONE DEALT WITH: a 👍 on its comment (DEALT_WITH_REACTION),
// which survives the comment being rewritten when its event repeats - and a
// nightly check rewrites its notice every night, so without it a notice about
// a lecturer's own leftover test stayed on the list for good (2026-10-08). A
// reaction is GitHub's own mark on the comment: it is seen by every lecturer,
// survives a refresh, and needs nothing stored anywhere else.
//
// Pure and isomorphic: the SPA parses what the API returned, the test runs it.

import { normalizeLogin } from "./github-login.mjs";
import { parseUnrecordedLines } from "./unrecorded-repos.mjs";

/** Must equal notify/notify.mjs. Checked by tests/org-notices.test.mjs. */
export const DEDUP_MARKER = "<!-- pxl-dedup:";

/** The reaction that marks a notice dealt with (GitHub's `+1`, a 👍). */
export const DEALT_WITH_REACTION = "+1";

/** The organization-wide notice that lists repositories with no record. */
export const UNRECORDED_NOTICE = "unrecorded-repositories";

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
 * @param {{id?: number, body?: unknown, html_url?: string, updated_at?: string, reactions?: object}} comment
 * @returns {{id: number|null, key: string, eventType: string, assignmentId: string, at: string|null,
 *            details: string, url: string|null, kind: "action"|"info"|"refusal"|"other", dealtWith: boolean}|null}
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
  // The issue-comments list carries each comment's reaction counts.
  const dealtWith = Number(comment?.reactions?.[DEALT_WITH_REACTION] || 0) > 0;
  return { id: comment?.id ?? null, key, eventType, assignmentId, at: when, details, url: comment?.html_url || null, kind, dealtWith };
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
 * Notices filed under a name that is NOT an assignment: the nightly's
 * organization-wide checks (`assignment-id:` in daily-activity.yml), and the
 * empty name. Each with what the lecturer sees instead of the name.
 * tests/org-notices.test.mjs reads every literal `assignment-id:` the
 * workflows pass and requires it here, so a new organization-wide notice
 * cannot be mistaken for one about a deleted assignment and hidden.
 */
export const ORG_NOTICE_LABELS = Object.freeze({
  "": "This organization",
  "unrecorded-repositories": "Repositories nobody recorded",
  "unanswered-attempts": "Acceptances that got no answer",
  "nightly-collect": "Nightly check",
  "nightly-finalizable-scan": "Nightly check",
});

/** Is this notice about the organization rather than one assignment? */
export function isOrgNotice(notice) {
  return Object.prototype.hasOwnProperty.call(ORG_NOTICE_LABELS, notice?.assignmentId ?? "");
}

/**
 * What the lecturer is shown: the notices that need them, without those about
 * an assignment that no longer exists - nothing can be done about it, and on a
 * course that cleans up its test assignments they were most of the list.
 * Organization-wide notices always stay. `assignmentIds` null means the list
 * of assignments is not known (or not known whole), and then nothing is hidden:
 * a guess that hides a real notice is worse than a stale one shown.
 * `provisioned` is who has a repository in each assignment (`provisionedLogins`);
 * an assignment absent from it settles nothing.
 *
 * A notice a lecturer marked dealt with is not shown (`dealt: true` asks for
 * exactly those instead, for "Show dealt with"); a repositories-nobody-recorded
 * notice whose every student has since been added is settled like a student's.
 *
 * @param {Array<object>} comments the tracking issue's comments
 * @param {{assignmentIds?: Set<string>|null, provisioned?: Map<string, Set<string>>|null, now?: Date, days?: number, dealt?: boolean}} [opts]
 */
export function noticesForLecturer(
  comments,
  { assignmentIds = null, provisioned = null, now = new Date(), days = NEEDS_YOU_DAYS, dealt = false } = {},
) {
  const all = noticesNeedingYou(comments, { now, days });
  return all.filter((n) => {
    if (n.dealtWith !== dealt) return false;
    if (assignmentIds && !isOrgNotice(n) && !assignmentIds.has(n.assignmentId)) return false;
    if (n.assignmentId === UNRECORDED_NOTICE) {
      const lines = parseUnrecordedLines(n.details);
      return !(lines.length && lines.every((l) => unrecordedLineSettled(l, provisioned)));
    }
    // FIXED SINCE. A notice is never marked done, so "Failed to provision repo
    // for arnobarzan" stayed for fourteen days after Retry had given that student
    // a repository - 25 of them on PXL-Java-Essentials, every one resolved the
    // same day (2026-10-06). One about a student whose acceptance has since
    // gone through is no longer something to do.
    const login = noticeStudent(n);
    const done = provisioned?.get(n.assignmentId);
    return !(login && done && done.has(normalizeLogin(login)));
  });
}

/**
 * The dedup-key prefixes of notices about ONE student's acceptance, keyed
 * `<prefix><assignment>-<login>` (acceptance-handler.yml, retry-acceptance.yml;
 * tests/org-notices.test.mjs reads them from there). Both are settled by that
 * student's acceptance going through: provisioning that failed, and a record
 * that could not be written.
 */
export const STUDENT_NOTICE_PREFIXES = Object.freeze(["prov-fail-", "record-fail-"]);

/**
 * A repository nobody recorded whose student has since been added - Retry went
 * through, and the report shows them with their repository. Unknown (that
 * assignment's report not read) settles nothing.
 */
export function unrecordedLineSettled(line, provisioned) {
  const done = provisioned?.get(line?.assignmentId);
  return !!(line?.login && done && done.has(normalizeLogin(line.login)));
}

/** The student a notice is about, from its key, or null when it is not about one. */
export function noticeStudent(notice) {
  const key = String(notice?.key || "");
  const id = String(notice?.assignmentId || "");
  if (!id) return null;
  for (const prefix of STUDENT_NOTICE_PREFIXES) {
    const head = `${prefix}${id}-`;
    if (key.startsWith(head) && key.length > head.length) return key.slice(head.length);
  }
  return null;
}

/**
 * The assignments whose report has to be read to settle the notices that need
 * the lecturer: those with a notice about one student.
 *
 * @param {Array<object>} comments
 * @param {{now?: Date, days?: number}} [opts]
 * @returns {string[]}
 */
export function assignmentsToSettle(comments, { now = new Date(), days = NEEDS_YOU_DAYS } = {}) {
  const notices = noticesNeedingYou(comments, { now, days });
  return [...new Set([
    ...notices.filter((n) => noticeStudent(n)).map((n) => n.assignmentId),
    // Each repository nobody recorded is settled by its own assignment's report.
    ...notices.filter((n) => n.assignmentId === UNRECORDED_NOTICE).flatMap((n) => parseUnrecordedLines(n.details).map((l) => l.assignmentId)),
  ])];
}

/**
 * Who has a repository, from an assignment's report rows: lowercased logins
 * whose acceptance went through. The report is what the lecturer's own pages
 * show, so a notice disappears when the student does show as provisioned.
 *
 * @param {Array<{github_login?: unknown, acceptance_state?: unknown}>} rows
 * @returns {Set<string>}
 */
export function provisionedLogins(rows) {
  return new Set(
    (Array.isArray(rows) ? rows : [])
      .filter((r) => r?.acceptance_state === "provisioned" && typeof r?.github_login === "string")
      .map((r) => normalizeLogin(r.github_login)),
  );
}

/**
 * A notice's details as its first sentence and the rest, for a list that shows
 * one line each and the whole text on request. The first sentence is read from
 * the first paragraph with its line breaks joined: notify.mjs wraps its prose,
 * so a first LINE stops mid-sentence. Later paragraphs keep their breaks, since
 * they are often lists.
 *
 * @param {string} details
 * @returns {{first: string, rest: string}}
 */
export function noticeLines(details) {
  const paras = plainDetails(details).split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  if (!paras.length) return { first: "", rest: "" };
  const lead = paras[0].replace(/\s*\n\s*/g, " ");
  const sentence = /^(.+?[.!?])(?:\s|$)/.exec(lead);
  const first = sentence ? sentence[1] : lead;
  const rest = [lead.slice(first.length).trim(), ...paras.slice(1)].filter(Boolean).join("\n\n");
  return { first, rest };
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
