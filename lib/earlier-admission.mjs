// PXL Classroom - did the hub admit this account to this assignment before?
//
// WHY IT EXISTS (2026-11-13). An acceptance creates the repository first and
// writes its records last, and that last write can be lost. On 2026-09-25 a
// student's was: every gate passed, his email address was confirmed, his
// repository was created and he was invited - and the push of his acceptance
// record, his repository record AND his claim binding was refused five times
// while fifty classmates' pushes landed, and dropped. He worked in the
// repository for seven weeks on no list. The remedy the nightly's notice
// offers, Retry, could not work: the assignment asks for a confirmed address,
// the confirmation was lost in the same push, and a lecturer's Retry carries
// none, so the hub answered `rejected:no-claim`.
//
// The hub does not have to ask again what it can show it already decided. What
// survives a lost push is on GitHub, not in the control repository:
//
//   1. the student's own acceptance issue on the broker, by THIS account id,
//      carrying the `outcome:invited` label - and that label put there by the
//      provisioning App. A student cannot label a broker issue (a label needs
//      write access, which is why the outcome is a label at all:
//      lib/acceptance-labels.mjs), so the App's own labelling event is the
//      hub saying "I admitted this request";
//   2. the repository that admission made: the assignment's name for this
//      account, generated from the assignment's template, created within
//      minutes BEFORE that label (provisioning labels after it creates), with
//      this account still holding access to it.
//
// All of it, or nothing: this replaces a gate, so anything unread or
// unmatched is "no" and the Retry is refused exactly as before. It answers for
// an INDIVIDUAL acceptance only - a team's repository is one object many
// accounts hold, and which of them the hub admitted is not in it.
//
// Pure: the reads are made by scripts/prove-earlier-admission.mjs.

import { INVITED_LABEL } from "./acceptance-labels.mjs";
import { sameLogin } from "./github-login.mjs";

// Provisioning labels the issue seconds after it creates the repository
// (create, grant, label: three seconds on 2026-09-25). Ten minutes covers a
// slow full-history copy and still ties the repository to THAT admission.
export const ADMISSION_WINDOW_MS = 10 * 60_000;

const ACCESS = new Set(["admin", "maintain", "write", "triage", "read"]);

/**
 * @typedef {{number?: number, user?: {id?: number}|null, labels?: Array<{name?: string}|string>}} BrokerIssue
 * @typedef {{event?: string, created_at?: string, label?: {name?: string}|null, actor?: {login?: string, type?: string}|null}} IssueEvent
 */

/**
 * When the App labelled this issue `outcome:invited`, or null. The NEWEST such
 * event: a label taken off and put back is still the App's word.
 *
 * @param {IssueEvent[]|null|undefined} events
 * @param {string} appBotLogin `<app-slug>[bot]`
 * @returns {string|null} ISO time
 */
export function invitedByApp(events, appBotLogin) {
  const times = (Array.isArray(events) ? events : [])
    .filter((e) =>
      e?.event === "labeled" &&
      e?.label?.name === INVITED_LABEL &&
      e?.actor?.type === "Bot" &&
      sameLogin(e?.actor?.login || "", appBotLogin) &&
      !Number.isNaN(Date.parse(e?.created_at || "")))
    .map((e) => /** @type {string} */ (e.created_at))
    .sort();
  return times.at(-1) || null;
}

/**
 * The verdict. `admitted` only when every part was read and matches.
 *
 * @param {object} p
 * @param {string} [p.assignmentType]            absent is individual
 * @param {number} p.githubId                    the account the Retry is for
 * @param {Array<{issue: BrokerIssue, events: IssueEvent[]|null}>} p.requests
 *        this account's broker issues carrying the label, each with its events
 *        (null: the events could not be read)
 * @param {string} p.appBotLogin
 * @param {{id?: number, created_at?: string, template_repository?: {id?: number, full_name?: string}|null}|null} p.repo
 *        the repository the assignment names for this account, or null (absent or unread)
 * @param {number|null} [p.templateId]           the assignment's pinned template id
 * @param {string|null} [p.templateFullName]     `owner/name`, used only where nothing is pinned
 * @param {string|null} p.permission             this account's permission on `repo`, or null (none or unread)
 * @returns {{admitted: boolean, at: string|null, issue: number|null, why: string}}
 */
export function judgeEarlierAdmission({
  assignmentType, githubId, requests, appBotLogin, repo, templateId = null, templateFullName = null, permission,
}) {
  const no = (why) => ({ admitted: false, at: null, issue: null, why });
  if (assignmentType === "team") return no("a team assignment: one repository, many accounts");
  if (!Number.isInteger(githubId) || githubId <= 0) return no("no account id");
  if (!repo || !Number.isInteger(repo.id)) return no("the repository the assignment names for this account does not exist, or could not be read");
  const made = Date.parse(repo.created_at || "");
  if (Number.isNaN(made)) return no("the repository does not say when it was created");

  const from = repo.template_repository;
  const fromTemplate = Number.isInteger(templateId)
    ? from?.id === templateId
    : Boolean(templateFullName) && String(from?.full_name || "").toLowerCase() === String(templateFullName).toLowerCase();
  if (!fromTemplate) return no("the repository was not created from this assignment's template");
  if (!ACCESS.has(String(permission || ""))) return no("this account does not hold access to the repository");

  // The request this repository answers: by this account, labelled by the App,
  // within the window after the repository was made. Newest first.
  const matches = [];
  for (const { issue, events } of Array.isArray(requests) ? requests : []) {
    if (issue?.user?.id !== githubId) continue;
    const at = invitedByApp(events, appBotLogin);
    if (!at) continue;
    const gap = Date.parse(at) - made;
    if (gap < 0 || gap > ADMISSION_WINDOW_MS) continue;
    matches.push({ at, issue: Number.isInteger(issue.number) ? issue.number : null });
  }
  if (matches.length === 0) {
    return no("no acceptance request of this account that the hub marked as invited when this repository was created");
  }
  matches.sort((a, b) => b.at.localeCompare(a.at));
  return { admitted: true, at: matches[0].at, issue: matches[0].issue, why: "the hub admitted this account and created this repository for it" };
}
