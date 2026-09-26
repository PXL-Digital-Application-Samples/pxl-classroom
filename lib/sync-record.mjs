// The starter sync record - `syncs/<assignment-id>/<sync-id>.json` - built in
// ONE place for both writers: the workflow (scripts/sync-starter.mjs) and the
// CLI (`pxl-classroom sync-starter`).
//
// The CLI wrote no record at all until 2026-09-27, so nothing could say what a
// CLI sync delivered: the next sync started those students earlier, and a file
// the CLI had delivered and the student had since edited came back as a pull
// request offering the version they already had. A second hand-built copy of
// this document is how the two writers would come to disagree, so neither
// builds it.
//
// ISOMORPHIC and dependency-free apart from lib/starter-sync.mjs.

import { summarize } from "./starter-sync.mjs";

/** `sync-<UTC timestamp>-<6 random>`, the pattern the schema requires. */
export function generateSyncId(now = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const ts = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;
  const rand = Math.random().toString(36).slice(2, 8).padEnd(6, "0");
  return `sync-${ts}-${rand}`;
}

/**
 * One student's row, from their plan (lib/starter-sync-cohort.mjs `planStudent`).
 * The caller adds what happened after: `commit_sha`, `pr_number`, `pr_url`,
 * the issue fields, or `outcome: "failed"` with `error`.
 *
 * @param {{ login: string, repoName: string, teamSlug?: string|null, outcome: string,
 *           from?: string|null, source?: string, at?: string|null,
 *           plan: { clean: unknown[], conflicts: unknown[], kept: unknown[] } }} p
 */
export function syncRow({ login, repoName, teamSlug = null, outcome, from = null, source, at = null, plan }) {
  return {
    github_login: login,
    repo_name: repoName,
    ...(teamSlug ? { team_slug: teamSlug } : {}),
    outcome,
    from_sha: from || null,
    from_source: source,
    ...(at ? { at_sha: at } : {}),
    files_merged: plan.clean.length,
    files_conflicted: plan.conflicts.length,
    ...(plan.kept.length ? { files_kept: plan.kept.length } : {}),
  };
}

/**
 * The whole record. `status` is `running` while it goes (no `finished_at`, no
 * `remaining`), then `completed` or `stopped`.
 *
 * `via: "cli"` marks a sync with no workflow run behind it: a `running` CLI
 * record cannot be checked against a run, so the status line says so rather
 * than "Syncing" for ever after a terminal was closed (lib/sync-status.mjs).
 */
export function buildSyncRecord({
  syncId, assignmentId, startedAt, syncedBy, status, runId = null, runUrl = null, via = null,
  totalStudents, remaining = 0, templateRepo, templateSha, templateBaseSha = null,
  appliedPaths = [], allFiles, prTitle, prBody, createdIssues, results,
}) {
  return {
    schema_version: 1,
    sync_id: syncId,
    assignment_id: assignmentId,
    synced_at: startedAt,
    synced_by: syncedBy,
    status,
    ...(runId ? { run_id: runId } : {}),
    ...(runUrl ? { run_url: runUrl } : {}),
    ...(via ? { via } : {}),
    started_at: startedAt,
    ...(status === "running" ? {} : { finished_at: new Date().toISOString() }),
    total_students: totalStudents,
    ...(status === "running" ? {} : { remaining }),
    template_repo: templateRepo,
    template_sha: templateSha,
    ...(templateBaseSha ? { template_base_sha: templateBaseSha } : {}),
    // The paths actually applied to anyone, not the raw request.
    selected_files: [...appliedPaths].sort(),
    // What makes this record evidence of where each student now is
    // (lib/starter-sync.mjs `startingPointFor`).
    per_student_range: true,
    all_files: allFiles,
    pr_title: prTitle,
    pr_body: prBody,
    created_issues: createdIssues,
    summary: summarize(results),
    results,
  };
}
