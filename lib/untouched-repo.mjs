// Whether a team's repository holds anything a person pushed.
//
// Asked when a student switches out of a team and leaves it empty (asked
// 2026-10-08). A student who made a typo in a team name, or joined the wrong
// one, switched to the right team and left the wrong one behind: listed, its
// name taken, its repository kept, until a lecturer deleted it by hand - one
// lecturer, one evening, one student at a time. A team nobody is in, whose
// repository holds nothing anybody wrote, is nothing to keep; one where work
// was pushed IS that work, and a former member can still get back into it.
//
// "Nothing anybody wrote" is decided by what GitHub can vouch for, never by a
// name: the first commit is the one GitHub generated from the template
// (`generatedFromTemplate`, measured 2026-09-26), and every later one is a
// VERIFIED commit authored by a bot - PXL Classroom adding the grading
// workflow, or a starter sync. A commit's author is resolved from an email
// anyone can type, so a student's commit claiming a bot's address is
// unverified; and a person's signed commit carries their own identity.
//
// Isomorphic, read through the caller's `get(path)` resolving
// `{ ok?, status, data }`, as lib/starter-sync-cohort.mjs is.

import { generatedFromTemplate } from "./starter-sync-cohort.mjs";

const okStatus = (res) => res && res.status >= 200 && res.status < 300;

/** More than this many commits is work, whoever made them. */
const MAX_COMMITS = 20;

/** A commit PXL Classroom (or another bot) made, as GitHub vouches for it. */
function botCommit(row) {
  return row?.commit?.verification?.verified === true && /\[bot\]$/.test(String(row?.author?.login ?? ""));
}

/**
 * Has a person pushed to this repository, by its push log
 * (`GET /repos/{o}/{r}/activity`)?
 *
 * The student pages said "Submitted on time" from the newest commit's date,
 * and on a repository nobody had touched that commit is GitHub's generated one,
 * PXL Classroom's grading workflow, or - for a full-history copy - the
 * template's own head, by the lecturer, months old (review 2026-10-14, PG7).
 * The log's actor is who PUSHED, which a commit's author is not; every push
 * PXL Classroom makes is its App's (`[bot]`). So: a person in the log is
 * `true`; a log of bots alone, or - where the log says nothing - a head that
 * is still the commit GitHub generated (`generatedFromTemplate`), is `false`.
 * An EMPTY log is not "nobody": GitHub does not document how long the log is
 * kept, and a semester-long assignment would read as untouched. Nor is a log
 * of bots that does not reach back to the creation (`createdAt`, review
 * 2026-10-15): a student's pushes months old can have fallen off it under a
 * later starter sync's. An entry with no actor is a person - a deploy key
 * pushes with none. `null` when nothing established either: the caller keeps
 * its old answer.
 *
 * @param {{ok?: boolean, status: number, data: any}|null|undefined} res  the push log
 * @param {object|null} [head]  the newest commit, a `GET /commits` row
 * @param {{createdAt?: string}} [opts]  the repository's `created_at`
 * @returns {boolean|null}
 */
export function personPushed(res, head = null, { createdAt } = {}) {
  const log = okStatus(res) && Array.isArray(res.data) ? res.data : null;
  if (log?.some((a) => !a?.actor?.login || !/\[bot\]$/i.test(String(a.actor.login)))) return true;
  if (log && log.length > 0 && log.length < 100 && logReachesCreation(log, createdAt)) return false;
  if (head && generatedFromTemplate(head)) return false;
  return null;
}

/**
 * Every entry of a push log is THIS App's - not "a bot": `github-actions[bot]`
 * pushing from a workflow in the student's repository, a coding agent's
 * branch, or an entry with no actor at all (a deploy key) is somebody's work
 * (review 2026-10-15). `appLogin` is `<APP_SLUG>[bot]`, passed in, because
 * this module is the SPA's too and takes no configuration of its own.
 */
export function onlyAppPushedLog(entries, appLogin) {
  if (!appLogin || !Array.isArray(entries) || entries.length === 0) return false;
  const want = String(appLogin).toLowerCase();
  return entries.every((a) => typeof a?.actor?.login === "string" && a.actor.login.toLowerCase() === want);
}

/** How long after `created_at` the filling push may land: a full-history copy is cloned and pushed in up to eight minutes. */
const CREATION_WINDOW_MS = 15 * 60_000;

/**
 * Whether a push log reaches back to the repository's creation: its oldest
 * entry is the App creating a branch as it filled the repository, within
 * minutes of `created_at`. Measured live 2026-10-15: GitHub's copy and a
 * full-history copy both start with the App's `branch_creation`, four seconds
 * after creation. Only then has nothing dropped off the start of the log.
 *
 * @param {Array<{timestamp?: string, actor?: {login?: string}, activity_type?: string}>} entries
 * @param {string|undefined} createdAt
 */
export function logReachesCreation(entries, createdAt) {
  const created = Date.parse(createdAt ?? "");
  if (!Array.isArray(entries) || entries.length === 0 || !Number.isFinite(created)) return false;
  const oldest = entries.reduce((a, b) => (Date.parse(b?.timestamp ?? "") < Date.parse(a?.timestamp ?? "") ? b : a));
  const at = Date.parse(oldest?.timestamp ?? "");
  return Number.isFinite(at) && at >= created && at - created <= CREATION_WINDOW_MS
    && oldest.activity_type === "branch_creation" && /\[bot\]$/i.test(String(oldest.actor?.login ?? ""));
}

/**
 * @param {(path: string) => Promise<{ok?: boolean, status: number, data: any}>} get
 * @param {string} repoFullName  `owner/name`
 * @param {{appLogin?: string}} [opts]  `<APP_SLUG>[bot]`, PXL Classroom's own pusher
 * @returns {Promise<"absent"|"untouched"|"touched"|"unknown">}
 *   `absent`: no such repository; `untouched`: only what GitHub generated and
 *   bots added since; `touched`: anything else; `unknown`: a read failed, which
 *   is never read as either of the others.
 */
export async function repoTouched(get, repoFullName, { appLogin } = {}) {
  const branches = await get(`/repos/${repoFullName}/branches?per_page=2`);
  if (branches?.status === 404) return "absent";
  if (!okStatus(branches) || !Array.isArray(branches.data)) return "unknown";
  // WHO PUSHED, where the push log says: its actor is who pushed, and every
  // push PXL Classroom makes is its App's. Anybody else in it - a person, an
  // entry with no actor (a deploy key), another bot - is work.
  const log = await get(`/repos/${repoFullName}/activity?per_page=100`);
  const entries = okStatus(log) && Array.isArray(log.data) ? log.data : null;
  if (entries && entries.length > 0 && !onlyAppPushedLog(entries, appLogin)) {
    if (personPushed(log) === true || appLogin) return "touched";
  }
  // THE LOG CALLS IT UNTOUCHED FOR A FULL-HISTORY COPY ONLY, whose prepared
  // branches and template commits by the lecturer the commits below read as
  // somebody's work for ever, so a team left empty by a switch kept a copy
  // nobody had pushed to (TV-5, 2026-10-15). GitHub's own copy names its
  // template (`template_repository`) and is decided by its commits, which vouch
  // for it - the log only adds who else pushed (review 2026-10-15: trusting it
  // alone there deleted on less evidence than before). And only a log of this
  // App alone that reaches back to the creation, since GitHub does not say how
  // long it keeps one (`logReachesCreation`).
  if (entries && entries.length > 0 && entries.length < 100 && onlyAppPushedLog(entries, appLogin)) {
    const repo = await get(`/repos/${repoFullName}`);
    if (okStatus(repo) && !repo.data?.template_repository && logReachesCreation(entries, repo.data?.created_at)) return "untouched";
  }
  // A second branch is kept as if it were somebody's work (it can be
  // provisioning's own feedback baseline: safe, not certain); none at all is a repository GitHub
  // never filled, which a person cannot have written to either.
  if (branches.data.length > 1) return "touched";
  if (branches.data.length === 0) return "untouched";

  const commits = await get(`/repos/${repoFullName}/commits?per_page=${MAX_COMMITS + 1}`);
  if (commits?.status === 409) return "untouched"; // "Git Repository is empty"
  if (!okStatus(commits) || !Array.isArray(commits.data) || commits.data.length === 0) return "unknown";
  if (commits.data.length > MAX_COMMITS) return "touched";
  // Newest first: the last row is the root.
  const root = commits.data[commits.data.length - 1];
  if (!generatedFromTemplate(root)) return "touched";
  return commits.data.slice(0, -1).every(botCommit) ? "untouched" : "touched";
}
