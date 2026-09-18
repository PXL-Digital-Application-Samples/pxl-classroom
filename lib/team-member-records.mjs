// WHAT A LECTURER'S TEAM CHANGE MUST REWRITE BESIDE THE MANIFESTS.
//
// A team manifest says who is in a team. Three other readers never look at it:
//
//   * the collector reads `repositories/<id>/<login>.json` to find a student's
//     repository, so a moved student's commits kept coming from the OLD team's;
//   * lockdown builds its targets from those same records and demotes the
//     record's login on the record's repository, so a moved or lecturer-added
//     student kept admin on their real team repository after the deadline - and
//     on a free-plan organization, where the lock IS the demotion, could still
//     push - while the demotion re-invited them, with read access, to the
//     repository they had been moved out of;
//   * accept.mjs treats an acceptance record as "already accepted into THIS
//     team" and skips the existing-repository check.
//
// A student's own switch (accept.mjs + the acceptance handler) already rewrites
// both records. The Teams tab rewrote only the manifests. This module plans the
// records for the lecturer's paths so one commit carries everything.
//
// Merge, never replace: an existing record is spread and only the repository
// fields change. A NEW record is built only for a student joining a team that
// already has a repository, and it carries what write-repository-record.mjs
// writes, so the two writers cannot disagree about the shape.
//
// Pure and isomorphic: the Teams tab imports this, so no fs, no fetch.

import { acceptancePath, repositoryPath } from "./control-layout.mjs";

/**
 * The repository a team manifest points at, or null when it has none yet.
 *
 * `repo_name` is `owner/name` (scripts/write-repository-record.mjs). A bare
 * name, which the schema also allows, is completed with `org`.
 *
 * @param {import("./types.mjs").Team | null | undefined} team
 * @param {string} org
 * @returns {{repo_name: string, repo_id: number, repo_url: string}|null}
 */
export function teamRepository(team, org) {
  const raw = typeof team?.repo_name === "string" ? team.repo_name.trim() : "";
  if (!raw || !Number.isInteger(team?.repo_id)) return null;
  const repoName = raw.includes("/") ? raw : `${org}/${raw}`;
  const url = typeof team?.repo_url === "string" && team.repo_url
    ? team.repo_url
    : `https://github.com/${repoName}`;
  return { repo_name: repoName, repo_id: team.repo_id, repo_url: url };
}

/**
 * A NEW repository record. The one builder, shared with
 * scripts/write-repository-record.mjs, so the provisioning path and the Teams
 * tab cannot write two shapes of the same document.
 *
 * @param {object} args
 * @param {string} args.assignmentId
 * @param {string} args.login
 * @param {{repo_name: string, repo_id: number, repo_url: string}} args.repo
 * @param {string} [args.teamSlug]
 * @param {string} [args.studentPermission]
 * @param {string} [args.runUrl]
 * @param {string} [args.baselineSha]
 * @param {Date} [args.now]
 */
export function buildRepositoryRecord({
  assignmentId,
  login,
  repo,
  teamSlug,
  studentPermission = "admin",
  runUrl,
  baselineSha,
  now = new Date(),
}) {
  return {
    schema_version: 1,
    assignment_id: assignmentId,
    github_login: login,
    repo_id: repo.repo_id,
    repo_name: repo.repo_name,
    repo_url: repo.repo_url,
    created_at: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
    ...(runUrl ? { provisioned_by_run: runUrl } : {}),
    student_permission: studentPermission,
    access_state: "invited",
    last_checked_at: null,
    feedback_pr_number: null,
    feedback_pr_url: null,
    feedback_pr_baseline_sha: baselineSha || null,
    ...(teamSlug ? { team_slug: teamSlug } : {}),
  };
}

/**
 * The file changes that make one student's records agree with where the
 * lecturer just put them.
 *
 * @param {object} args
 * @param {string} args.assignmentId
 * @param {string} args.org
 * @param {string} args.login
 * @param {import("./types.mjs").Team | null} args.toTeam   the manifest they now
 *   belong to, or null when they were removed from their team and belong to none
 * @param {import("./types.mjs").RepositoryRecord | null} args.repoRecord  their
 *   stored repository record, if any
 * @param {import("./types.mjs").Acceptance | null} args.acceptance  their stored
 *   acceptance record, if any
 * @param {string} [args.studentPermission]  what the grant gave them
 * @param {Date} [args.now]
 * @returns {Array<{path: string, content: string|null}>} `null` content deletes
 */
export function planMemberRecordChanges({
  assignmentId,
  org,
  login,
  toTeam,
  repoRecord,
  acceptance,
  studentPermission = "admin",
  now = new Date(),
}) {
  const changes = [];
  const repo = teamRepository(toTeam, org);
  const recPath = repositoryPath(assignmentId, login);

  if (repo) {
    const sameRepo = repoRecord && repoRecord.repo_id === repo.repo_id;
    const next = repoRecord
      ? {
          ...repoRecord,
          ...repo,
          team_slug: toTeam.team_slug,
          // A feedback PR belongs to a repository. On a DIFFERENT one the old
          // numbers name somebody else's pull request.
          ...(sameRepo
            ? {}
            : { feedback_pr_number: null, feedback_pr_url: null, feedback_pr_baseline_sha: null }),
        }
      : buildRepositoryRecord({
          assignmentId,
          login,
          repo,
          teamSlug: toTeam.team_slug,
          studentPermission,
          now,
        });
    changes.push({ path: recPath, content: JSON.stringify(next, null, 2) + "\n" });
  } else if (repoRecord) {
    // No repository on the team they are in now (or no team at all): the record
    // would name one they no longer have, and lockdown would demote - which is
    // to say re-invite - them on it at the deadline.
    changes.push({ path: recPath, content: null });
  }

  if (acceptance) {
    const next = { ...acceptance };
    if (toTeam) {
      next.team_slug = toTeam.team_slug;
      next.team_name = toTeam.team_name || toTeam.team_slug;
    } else {
      delete next.team_slug;
      delete next.team_name;
    }
    if (next.team_slug !== acceptance.team_slug || next.team_name !== acceptance.team_name) {
      changes.push({
        path: acceptancePath(assignmentId, login),
        content: JSON.stringify(next, null, 2) + "\n",
      });
    }
  }

  return changes;
}
