// A snapshot observation: one look at the tip of one student's submission
// branch, as `observations/<id>/<login>/<timestamp>.json` stores it.
//
// ONE BUILDER, TWO WRITERS. The nightly collector wrote these, and the
// assignment page's Refresh wrote its findings into the REPORT only - so the
// next rebuild of that report, which reads observations and nothing else,
// threw them away. PXL-Automation-II / 2627-pe-1-test-1, 2026-09-26: a
// lecturer's row read "On time, d5bcbae" after Refresh and "No submission, no
// commits" half an hour later, because an unrelated save rebuilt the report
// before any nightly had collected. Refresh now writes observations too, built
// here, so a rebuild keeps what it saw and the report's own rules classify it.
//
// ISOMORPHIC: no `node:` imports, no network. The callers read GitHub.

import { isGitHubNoreplyAddress } from "./github-noreply.mjs";

/** A commit author name that is a machine, not the student. */
export function isBotAuthorName(name) {
  if (!name) return false;
  const s = String(name).toLowerCase();
  return s.includes("[bot]") || s.includes("provisioner") || s === "github" || s === "web-flow";
}

/**
 * The author a commit names, with the machines and the noreply addresses
 * removed - null where nothing usable is left.
 *
 * @param {any} commit a row of `GET /repos/{o}/{r}/commits`
 * @returns {{ name: string|null, email: string|null }}
 */
export function commitAuthor(commit) {
  const name = commit?.commit?.author?.name || null;
  const email = commit?.commit?.author?.email || null;
  return {
    name: isBotAuthorName(name) ? null : name,
    email: isGitHubNoreplyAddress(email) ? null : email,
  };
}

/**
 * The observation document for the newest commit on the submission branch.
 *
 * @param {object} a
 * @param {string} a.assignmentId
 * @param {string} a.login
 * @param {number} a.repoId
 * @param {string} a.ref            the assignment's submission_ref
 * @param {any}    a.commit         the newest commit, a `/commits` row
 * @param {number|null} a.commitCount
 * @param {number|null} [a.lateCommitCount]  null is "not counted", never "none"
 * @param {{name: string|null, email: string|null}} [a.author]  defaults to commitAuthor(commit)
 * @param {string} a.observedAt     ISO time of THIS look - never when the student acted
 * @param {string|null} [a.observerRun]  the Actions run that looked, when one did
 * @param {"scheduled"|"manual"|"deadline"|"lockdown"|"preservation"} a.collectionType
 */
export function snapshotObservation({
  assignmentId, login, repoId, ref, commit, commitCount,
  lateCommitCount = null, author = null, observedAt, observerRun = null, collectionType,
}) {
  const who = author || commitAuthor(commit);
  const doc = {
    schema_version: 1,
    type: "snapshot",
    assignment_id: assignmentId,
    github_login: login,
    repo_id: repoId,
    observed_at: observedAt,
    ref,
    sha: commit.sha,
    commit_count: commitCount,
    commit_date: commit?.commit?.committer?.date || commit?.commit?.author?.date || null,
    late_commit_count: lateCommitCount,
    commit_message: commit?.commit?.message || null,
    author_name: who.name ?? null,
    author_email: who.email ?? null,
    collection_type: collectionType,
  };
  // Optional in the schema, and a `uri`: absent rather than null when no run looked.
  if (observerRun) doc.observer_run = observerRun;
  return doc;
}
