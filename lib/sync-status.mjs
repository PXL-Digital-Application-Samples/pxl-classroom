// PXL Classroom - what the assignment page says about its starter syncs.
//
// PURE and isomorphic: the component reads the newest sync record, the run it
// names when that record says `running`, and the template's newest commit, and
// hands them here. Every sentence below is computed from those reads; where a
// read failed the sentence says so rather than guessing (CLAUDE.md: a message
// no branch computed is a guess).
//
// Why it exists: on 2026-09-25 two syncs of .NET Advanced were cut off by a
// timeout and nothing on screen said so. The dialog had reported "dispatched
// successfully", a later sync reported success, and 43 students were missing a
// lab until somebody counted.

/** The newest sync record's file, from a `syncs/<id>/` listing, or null. */
export function newestSyncFile(listing) {
  const files = (Array.isArray(listing) ? listing : []).filter(
    (f) => f?.type === "file" && /^sync-\d{8}T\d{6}Z-[a-z0-9]{6}\.json$/.test(f?.name || ""),
  );
  // The id starts with a UTC timestamp, so the names sort in time order.
  return files.sort((a, b) => a.name.localeCompare(b.name)).at(-1) || null;
}

const RUNNING_RUN_STATES = new Set(["queued", "in_progress", "waiting", "pending", "requested"]);

// A run's conclusion is GitHub's word, not ours (DESIGN.md §1.7): `timed_out`
// on screen is machine output. An unknown one falls back to itself rather than
// to a blank.
const ENDED = {
  cancelled: "was cancelled before it finished",
  timed_out: "timed out before it finished",
  failure: "failed before it finished",
  // The run went green and its record still says running: the final write
  // landed after this page read it, or did not land at all.
  success: "finished, but its record was not closed",
};
const ended = (conclusion) => ENDED[conclusion] || `ended (${conclusion || "unknown"}) before it finished`;

/**
 * @param {object} [p]
 * @param {import("./types.mjs").SyncRecord|null} [p.record]  the newest sync record
 * @param {{status?: string, conclusion?: string|null, html_url?: string}|null} [p.run]
 *   the run a `running` record names: undefined = not asked, null = the read failed
 * @param {string|null} [p.templateHeadSha]  undefined = not asked, null = the read failed
 * `commit` is the short sha the title names, so a surface can set it in
 * monospace (DESIGN.md §2) without re-deriving it.
 *
 * @returns {null | {state: string, tone: "success"|"warning"|"danger"|"neutral",
 *           title: string, commit: string, detail: string|null, runUrl: string|null,
 *           action: "sync-again"|"refresh"|null, failed: Array<{login: string, error: string}>}}
 */
export function describeSyncStatus({ record, run, templateHeadSha } = {}) {
  if (!record) return null;
  const status = record.status || "completed"; // absent: written only at the end, before 2026-09-25
  const results = Array.isArray(record.results) ? record.results : [];
  const total = Number.isInteger(record.total_students) ? record.total_students : results.length;
  const reached = results.length;
  const failed = results
    .filter((r) => r?.outcome === "failed")
    .map((r) => ({ login: r.github_login, error: r.error || "failed" }));
  const runUrl = record.run_url || run?.html_url || null;
  const by = record.synced_by ? ` by @${record.synced_by}` : "";
  const commit = String(record.template_sha || "").slice(0, 7);
  const of = `${reached} of ${total} student${total === 1 ? "" : "s"}`;
  const base = { runUrl, failed, commit };

  // `reached` is as of the record's last write, which is every 20 students or
  // 2 minutes - "at the last count", never "so far" as if it were live.
  if (status === "running") {
    if (run === null) {
      return {
        ...base, state: "running-unknown", tone: "neutral", action: "refresh",
        title: `A sync of ${commit} started${by} and has not recorded an end`,
        detail: `Could not read its run, so whether it is still going is unknown. ${of} reached at the last count.`,
      };
    }
    if (run && !RUNNING_RUN_STATES.has(run.status)) {
      // The run is over and the record never said so: it was cut off, or its
      // final write failed. Either way the students past `reached` were not.
      return {
        ...base, state: "died", tone: "warning", action: "sync-again",
        title: `The sync of ${commit}${by} ${ended(run.conclusion || run.status)}`,
        detail: `${of} reached. Run the sync again: students it did not reach get everything they are missing, and the others are skipped.`,
      };
    }
    return {
      ...base, state: "running", tone: "neutral", action: "refresh",
      title: `Syncing ${commit}${by}`,
      detail: `${of} done at the last count.`,
    };
  }

  if (status === "stopped") {
    const left = Number.isInteger(record.remaining) ? record.remaining : Math.max(0, total - reached);
    return {
      ...base, state: "stopped", tone: "warning", action: "sync-again",
      title: `The sync of ${commit} stopped with ${left} student${left === 1 ? "" : "s"} not reached`,
      detail: "It stopped at its time limit. Run it again: it continues where it stopped.",
    };
  }

  // completed
  const newer = templateHeadSha && templateHeadSha !== record.template_sha;
  const tail =
    templateHeadSha === null
      ? " Could not read the template, so whether it has changed since is unknown."
      : newer
        ? " The template has changed since - sync again to send it."
        : "";
  if (failed.length) {
    return {
      ...base, state: "completed-with-failures", tone: "danger", action: "sync-again",
      title: `The last sync of ${commit}${by} could not update ${failed.length} student${failed.length === 1 ? "" : "s"}`,
      // The others, not all of them: "111 of 111 handled" under "could not
      // update 2" read as a contradiction.
      detail: `The other ${reached - failed.length} of ${total} were handled. Sync again to retry these:${tail}`,
    };
  }
  const updated = results.filter((r) => ["auto-merged", "merged-and-pr", "pr-opened"].includes(r?.outcome)).length;
  return {
    ...base,
    state: newer ? "template-changed" : "completed",
    tone: newer ? "warning" : "success",
    action: newer ? "sync-again" : null,
    title: `Last sync${by}: ${commit}, all ${total} student${total === 1 ? "" : "s"} handled`,
    detail: `${updated} updated, ${reached - updated} already had it.${tail}`,
  };
}
