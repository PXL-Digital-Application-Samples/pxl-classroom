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
 * kept, and a semester-long assignment would read as untouched. `null` when
 * nothing established either: the caller keeps its old answer.
 *
 * @param {{ok?: boolean, status: number, data: any}|null|undefined} res  the push log
 * @param {object|null} [head]  the newest commit, a `GET /commits` row
 * @returns {boolean|null}
 */
export function personPushed(res, head = null) {
  const log = okStatus(res) && Array.isArray(res.data) ? res.data : null;
  if (log?.some((a) => typeof a?.actor?.login === "string" && a.actor.login && !/\[bot\]$/i.test(a.actor.login))) return true;
  if (log && log.length > 0 && log.length < 100) return false;
  if (head && generatedFromTemplate(head)) return false;
  return null;
}

/**
 * @param {(path: string) => Promise<{ok?: boolean, status: number, data: any}>} get
 * @param {string} repoFullName  `owner/name`
 * @returns {Promise<"absent"|"untouched"|"touched"|"unknown">}
 *   `absent`: no such repository; `untouched`: only what GitHub generated and
 *   bots added since; `touched`: anything else; `unknown`: a read failed, which
 *   is never read as either of the others.
 */
export async function repoTouched(get, repoFullName) {
  const branches = await get(`/repos/${repoFullName}/branches?per_page=2`);
  if (branches?.status === 404) return "absent";
  if (!okStatus(branches) || !Array.isArray(branches.data)) return "unknown";
  // A second branch is somebody's work; none at all is a repository GitHub
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
