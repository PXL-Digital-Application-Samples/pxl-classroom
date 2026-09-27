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
// COMMITS, NOT CLOCKS. The first version compared `generated_at` with the
// source commit's date, and the review of v1.5.0 found the race it missed: a
// regeneration that checks out BEFORE a finalize pushes and finishes AFTER it
// stamps a later time over pre-deadline data - the normal case at a deadline,
// where a drill saw six regenerations during one finalize. So report.mjs
// records the commit it read (`derived_from`), and the answer is whether the
// newest commit to each source directory is that commit or one of its
// ancestors. A report with no `derived_from` - Refresh builds one in the
// browser from data loaded when the page opened - is not known to be current.
//
// Only the directories finalize writes: every other source (acceptances,
// teams, overrides) is followed by a regeneration within seconds of its own
// write, and a refusal costs a lecturer a retry, not data.
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

/** The directories a report is derived from that finalize writes, for one assignment. */
export const REPORT_SOURCE_DIRS = (assignmentId) => [observationsDir(assignmentId), lockdownsDir(assignmentId)];

const SHA = /^[0-9a-f]{40}$/;

/**
 * The verdict, from what was read.
 *
 * @param {string|null|undefined} derivedFrom the report's `derived_from`; absent when unknown
 * @param {Array<{sha: string|null|undefined, contained?: boolean|undefined}>} sources
 *        per source directory: `sha` is its newest commit (null = no commit ever,
 *        undefined = the read failed); `contained` is whether that commit is
 *        `derivedFrom` or an ancestor of it (undefined = not asked or not answered)
 * @returns {"current"|"stale"|"unknown"}
 */
export function reportFreshness(derivedFrom, sources) {
  if (!Array.isArray(sources) || sources.some((s) => s?.sha === undefined)) return "unknown";
  const changed = sources.filter((s) => s.sha !== null);
  if (changed.length === 0) return "current";
  if (typeof derivedFrom !== "string" || !SHA.test(derivedFrom)) return "stale";
  if (changed.some((s) => s.contained === false)) return "stale";
  if (changed.some((s) => s.contained !== true)) return "unknown";
  return "current";
}

/**
 * Read everything reportFreshness needs, and answer.
 *
 * @param {(method: string, path: string) => Promise<{ok: boolean, status?: number, data?: any}>} request
 * @param {{owner: string, repo: string, assignmentId: string, derivedFrom?: string|null}} where
 * @returns {Promise<"current"|"stale"|"unknown">}
 */
export async function readReportFreshness(request, { owner, repo, assignmentId, derivedFrom }) {
  const sources = await Promise.all(
    REPORT_SOURCE_DIRS(assignmentId).map(async (path) => {
      const q = new URLSearchParams({ path, per_page: "1" });
      const res = await request("GET", `/repos/${owner}/${repo}/commits?${q}`);
      if (!res?.ok || !Array.isArray(res.data)) return { sha: undefined };
      if (res.data.length === 0) return { sha: null };
      const sha = res.data[0]?.sha;
      if (typeof sha !== "string" || !SHA.test(sha)) return { sha: undefined };
      if (sha === derivedFrom) return { sha, contained: true };
      if (typeof derivedFrom !== "string" || !SHA.test(derivedFrom)) return { sha };
      // base...head: `ahead` or `identical` means base is an ancestor of head.
      const cmp = await request("GET", `/repos/${owner}/${repo}/compare/${sha}...${derivedFrom}`);
      if (!cmp?.ok) return { sha, contained: undefined };
      const status = cmp.data?.status;
      if (status === "ahead" || status === "identical") return { sha, contained: true };
      if (status === "behind" || status === "diverged") return { sha, contained: false };
      return { sha, contained: undefined };
    }),
  );
  return reportFreshness(derivedFrom, sources);
}

/** What a refused delete tells the person, for each reason it refuses. */
export const STALE_REPORT_REFUSAL =
  "The report is older than the lock and preservation recorded after it, so it would be kept as out-of-date evidence. " +
  "It is being regenerated now - try again in a minute or two. Nothing was deleted.";
export const UNKNOWN_REPORT_REFUSAL =
  "Could not check whether the report is up to date, so nothing was deleted. Try again in a moment.";
export const UNREADABLE_REPORT_REFUSAL =
  "Could not read the report, so nothing was deleted. Try again in a moment.";
