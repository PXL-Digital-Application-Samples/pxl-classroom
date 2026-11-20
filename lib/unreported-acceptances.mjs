// PXL Classroom - the students an assignment page shows before the report knows them.
//
// `reports/<id>.json` is DERIVED: regenerate-dashboard.yml rebuilds it after
// an acceptance, so it trails one by a minute. On 2026-11-20 it trailed by
// eight: fifty students of PXL-2TIN-DevOps-2627 accepted in three minutes,
// each acceptance's rebuild cancelled the one before it, and the lecturer's
// page showed one student of fifty - Refresh did nothing, because it re-reads
// only the rows the report already has. The acceptance record and the
// repository record are written by the acceptance itself, before any rebuild,
// so a screen that says who accepted reads THEM. CLAUDE.md: write the source,
// then derive; a screen that shows the source does not wait for the
// derivation. lib/team-rows.js is the same rule for the Teams tab.
//
// Only who accepted and which repository they got come from here. Everything
// about the work - commits, on time or late, the lock, the score - is the
// report's, and nothing has read this repository yet, so a row this adds is
// exactly the row the report writes for a student it has not observed: the
// status from the same judge (`classifySubmission`), which the page shows as
// "Not read yet" (frontend/src/lib/last-commit.js `statusNotRead`) until a
// rebuild or a Refresh has looked. No field of its own, so the row stores as
// it is when Refresh saves the report.
//
// One request per student the report is missing, and none for the rest: the
// two directory listings say who that is. So on an ordinary load, with the
// report current, this costs two requests (api.js `listAcceptances` is the
// read-everything version, kept behind an explicit action).
//
// Isomorphic and dependency-light: the SPA imports it and the tests run it.

import { normalizeLogin } from "./github-login.mjs";
import { starterFor } from "./starter-commit.mjs";
import { classifySubmission } from "./submission-status.mjs";

const fileLogin = (name) => (typeof name === "string" && name.endsWith(".json") ? name.slice(0, -".json".length) : null);

/**
 * The logins, as their files spell them, whose records the page has to read:
 * an acceptance record exists and the report has no row for them, still lists
 * them as not accepted (a roster row), or has no repository for them while a
 * repository record exists.
 *
 * @param {Array<Partial<import("./types.mjs").ReportStudent>>} rows the report's students
 * @param {{acceptanceFiles?: string[], repositoryFiles?: string[]}} [listing] file names in acceptances/<id>/ and repositories/<id>/
 * @returns {string[]}
 */
export function loginsToRead(rows, { acceptanceFiles = [], repositoryFiles = [] } = {}) {
  const byLogin = new Map();
  for (const r of rows || []) {
    const key = normalizeLogin(r?.github_login);
    if (key) byLogin.set(key, r);
  }
  const withRepository = new Set(repositoryFiles.map(fileLogin).filter(Boolean).map(normalizeLogin));
  const out = [];
  for (const name of acceptanceFiles) {
    const login = fileLogin(name);
    if (!login) continue;
    const key = normalizeLogin(login);
    const row = byLogin.get(key);
    if (!row || row.acceptance_state === "not-accepted" || (!row.repo_name && withRepository.has(key))) out.push(login);
  }
  return out;
}

/**
 * The report's rows with what the records say added: a new row for a student
 * the report does not list, and acceptance and repository filled in on a row
 * it lists without them. A record that could not be read is `null` and
 * changes nothing (unreadable is not evidence).
 *
 * @param {Array<Partial<import("./types.mjs").ReportStudent>>} rows the report's students
 * @param {Array<{acceptance: Partial<import("./types.mjs").Acceptance>|null, repository: Partial<import("./types.mjs").RepositoryRecord>|null}>} records read for `loginsToRead`
 * @param {{rosterEntry?: (login: string) => ({student_number?: string|null, full_name?: string|null, email?: string|null, class_group?: string|null}|null)}} [opts] the roster row for a login, for the name columns
 * @returns {Array<Partial<import("./types.mjs").ReportStudent>>} a new array; rows not named in `records` are the same objects
 */
export function withUnreportedAcceptances(rows, records, { rosterEntry = () => null } = {}) {
  const out = [...(rows || [])];
  for (const { acceptance, repository } of records || []) {
    const login = acceptance?.github_login;
    const key = normalizeLogin(login);
    if (!key) continue;
    const idx = out.findIndex((r) => normalizeLogin(r?.github_login) === key);
    const prev = idx === -1 ? null : out[idx];
    // The repository record's, as report.mjs reads it - and the starting point
    // through the same function, so Refresh judges these rows as the report would.
    const repo = repository && normalizeLogin(repository.github_login ?? login) === key ? repository : null;
    const given = starterFor(repo);
    const fromRecords = {
      acceptance_state: acceptance.status ?? "accepted",
      team_slug: prev?.team_slug ?? acceptance.team_slug ?? null,
      team_name: prev?.team_name ?? acceptance.team_name ?? null,
      repo_id: repo?.repo_id ?? prev?.repo_id ?? null,
      repo_name: repo?.repo_name ?? prev?.repo_name ?? null,
      repo_url: repo?.repo_url ?? prev?.repo_url ?? null,
      ...(given.sha ? { starter_sha: given.sha } : {}),
      ...(given.sha && given.count != null ? { starter_commit_count: given.count } : {}),
      ...(given.sha && given.fullHistory ? { full_history: true } : {}),
      // Nothing observed: what report.mjs says of a row with no reading. What
      // the report said before was said of a student with no acceptance or no
      // repository, so it is asked again rather than kept.
      submission_status: classifySubmission({
        hadRepository: Boolean(repo?.repo_name ?? prev?.repo_name),
        unstarted: false,
        lastOnTimeSha: null,
        hasLateActivity: false,
        latestObservedSha: null,
        hasDeadline: false,
      }),
    };
    if (prev) {
      out[idx] = { ...prev, ...fromRecords };
      continue;
    }
    const roster = rosterEntry(login) || null;
    out.push({
      github_login: login,
      student_number: roster?.student_number ?? null,
      full_name: roster?.full_name ?? null,
      email: roster?.email ?? null,
      class_group: roster?.class_group ?? null,
      ...fromRecords,
    });
  }
  return out;
}
