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

import { REACHED_OUTCOMES, summarize } from "./starter-sync.mjs";

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
 *           plan: { clean: Array<{ path: string }>, conflicts: Array<{ path: string }>, kept: unknown[] } }} p
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
    // What THIS student was sent: written to their branch or offered in their
    // pull request. `selected_files` is the union over everyone, and read as
    // one student's it called files "delivered" that never reached them
    // (lib/starter-sync-cohort.mjs `withoutDelivered`). `buildSyncRecord`
    // leaves it out where it equals that union - see `compactRow`.
    applied_files: [...new Set([...plan.clean, ...plan.conflicts].map((e) => e.path))].sort(),
  };
}

/** The same row, failed. Nothing is known to have been applied, so it says nothing about files. */
export function failedRow(row, error) {
  const { applied_files: _dropped, ...rest } = row;
  return { ...rest, outcome: "failed", error };
}

const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * A row as it is written: `applied_files` omitted where it is exactly the
 * record's `selected_files`. Absent then reads as the union, which is what a
 * row written before the field meant too - so omitting it changes no answer,
 * and a cohort sent the same lab does not repeat its file list once per
 * student. That repetition is not cosmetic: every surface reads records
 * through the contents API, which serves no content past 1 MB, and a
 * first-commit sync of a large template to a hundred students passes it.
 * A failed row never carries it (`failedRow`).
 */
function compactRow(row, selected) {
  if (!Array.isArray(row?.applied_files)) return row;
  if (row.outcome === "failed" || sameList(row.applied_files, selected)) {
    const { applied_files: _dropped, ...rest } = row;
    return rest;
  }
  return row;
}

/**
 * The paths a sync applied to ONE student: their reached row's
 * `applied_files`, or - where the row predates the field, or it was left out
 * as equal (`compactRow`) - the record's `selected_files`. Empty when the
 * record did not reach them.
 *
 * @param {import("./types.mjs").SyncRecord} record
 * @param {string} login
 * @returns {string[]}
 */
export function appliedFilesFor(record, login) {
  const me = String(login || "").toLowerCase();
  const row = (record?.results || []).find(
    (x) => String(x?.github_login || "").toLowerCase() === me && REACHED_OUTCOMES.includes(x?.outcome),
  );
  if (!row) return [];
  return Array.isArray(row.applied_files) ? row.applied_files : (record.selected_files || []);
}

/** Progress is recorded every FLUSH_EVERY finished students or FLUSH_MS, whichever comes first. */
export const FLUSH_EVERY = 20;
export const FLUSH_MS = 2 * 60_000;

/**
 * The progress-write policy both writers use: `maybeFlush(done)` writes a
 * `running` record when `done` finished students is FLUSH_EVERY past the last
 * write, or FLUSH_MS has passed since it - never twice for the same count, and
 * never two at once (the CLI finishes students concurrently; a caller that
 * finds a write in flight goes on, and the caller that started it waits for
 * it, so no write outlives the students it describes).
 *
 * BEST EFFORT: a failed progress write goes to `onError` and the sync goes on.
 * The students matter more than the tally, and the final write is not
 * optional. A record written only at the end records nothing about a run that
 * did not reach the end - the CLI wrote its rows only there, so a closed
 * terminal left `results: []` over students it had changed.
 *
 * @param {{ write: () => Promise<unknown>, onError?: (e: Error) => void,
 *           every?: number, ms?: number, now?: () => number }} p
 * @returns {(done: number) => Promise<void>}
 */
export function progressFlusher({ write, onError = () => {}, every = FLUSH_EVERY, ms = FLUSH_MS, now = Date.now }) {
  let last = now();
  let flushedAt = 0;
  let inFlight = false;
  return async (done) => {
    if (inFlight || done === flushedAt) return;
    if (done - flushedAt < every && now() - last < ms) return;
    inFlight = true;
    try {
      await write();
    } catch (err) {
      onError(err);
    } finally {
      last = now();
      flushedAt = done;
      inFlight = false;
    }
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
  const selected = [...appliedPaths].sort();
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
    selected_files: selected,
    // What makes this record evidence of where each student now is
    // (lib/starter-sync.mjs `startingPointFor`).
    per_student_range: true,
    all_files: allFiles,
    pr_title: prTitle,
    pr_body: prBody,
    created_issues: createdIssues,
    summary: summarize(results),
    results: results.map((r) => compactRow(r, selected)),
  };
}
