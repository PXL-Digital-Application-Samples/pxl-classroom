// PXL Classroom - is the committed report derived from what the control repo
// holds now?
//
// `reports/<id>.json` is DERIVED. The finalize job commits its sources -
// observations (with each student's preservation) and the lockdown record -
// and regenerate-dashboard.yml, dispatched after it, rebuilds the report from
// them. Between the two, for about a minute, the committed report is the one
// from before the deadline: preservation `not-required`, statuses from before
// the lock.
//
// Almost nothing minds: the next regeneration replaces it. The one reader that
// does is a DELETE, which copies the report into `retired/<id>/report.json`,
// counts preserved submissions into the manifest from its rows, and removes
// the sources in the same commit - so nothing can ever correct it afterwards.
// Measured 2026-09-27: a drill deleted a minute after its finalize recorded
// `preserved_submissions: 0` over an archive holding both students' branches,
// and left that archive behind.
//
// So a delete asks this first, and refuses while the answer is not `current`.
// Two reads, one per source directory, newest commit only. Only the directories
// finalize writes: every other source (acceptances, teams, overrides) is
// followed by a regeneration within seconds of its own write, and a refusal
// costs a lecturer a retry, not data.
//
// Isomorphic: the Admin Panel and tests/live/drill.mjs both import it. The
// request function is passed in, as findOrgSubmissionLock takes it.

import { lockdownsDir, observationsDir } from "./control-layout.mjs";

/**
 * The states whose report regenerate-dashboard.yml rebuilds
 * (scripts/generate-interim-reports.mjs reads this). A refusal is only honest
 * where a regeneration will end it: an archived or draft assignment's report is
 * never rebuilt, so refusing its delete as stale would refuse it for ever.
 */
export const REGENERATED_STATES = Object.freeze(["published", "closed"]);

/** Whether a delete of an assignment in this state has to wait for a current report. */
export const deleteWaitsForReport = (state) => REGENERATED_STATES.includes(state);

/**
 * @param {{generated_at?: string, live_refreshed_at?: string}|null|undefined} report the committed report, parsed; absent when there is none
 * @param {Array<string|null|undefined>} sourceChangedAt the newest commit to each source directory; null = no commit ever; undefined = the read failed
 * @returns {"current"|"stale"|"unknown"}
 */
export function reportFreshness(report, sourceChangedAt) {
  if (!Array.isArray(sourceChangedAt) || sourceChangedAt.some((t) => t === undefined)) return "unknown";
  const changes = sourceChangedAt.filter((t) => t !== null).map((t) => Date.parse(String(t)));
  if (changes.some((t) => Number.isNaN(t))) return "unknown";
  if (changes.length === 0) return "current";
  const latest = Math.max(...changes);
  // Refresh in the detail view writes the report together with the
  // observations it read, and stamps `live_refreshed_at`, not `generated_at`.
  const derivedAt = Math.max(
    ...[report?.generated_at, report?.live_refreshed_at].map((t) => (t ? Date.parse(t) : NaN)).filter((t) => !Number.isNaN(t)),
    -Infinity,
  );
  return derivedAt >= latest ? "current" : "stale";
}

/**
 * The newest commit date touching each of this assignment's report sources.
 *
 * @param {(method: string, path: string) => Promise<{ok: boolean, status?: number, data?: any}>} request
 * @param {{owner: string, repo: string, assignmentId: string}} where
 * @returns {Promise<Array<string|null|undefined>>} one entry per source; see reportFreshness
 */
export async function readReportSourceChanges(request, { owner, repo, assignmentId }) {
  return Promise.all(
    [observationsDir(assignmentId), lockdownsDir(assignmentId)].map(async (path) => {
      const q = new URLSearchParams({ path, per_page: "1" });
      const res = await request("GET", `/repos/${owner}/${repo}/commits?${q}`);
      if (!res?.ok || !Array.isArray(res.data)) return undefined;
      if (res.data.length === 0) return null;
      return res.data[0]?.commit?.committer?.date ?? undefined;
    }),
  );
}

/** What a refused delete tells the person, for each verdict that refuses. */
export const STALE_REPORT_REFUSAL =
  "The report is older than the lock and preservation recorded after it, so it would be kept as out-of-date evidence. " +
  "It is being regenerated now - try again in a minute or two. Nothing was deleted.";
export const UNKNOWN_REPORT_REFUSAL =
  "Could not check whether the report is up to date, so nothing was deleted. Try again in a moment.";
