// PXL Classroom - the control repo directory layout (ARCHITECTURE.md §5.1).
//
// One source of truth, consumed by:
//   - lib/audit.mjs             (re-exported; drives the scaffold-intact check)
//   - scripts/scaffold-control-repo.mjs  (used by setup-org.yml)
//   - control-repo-template/    (asserted equal by tests/scaffold.test.mjs)
//
// Deliberately dependency-free: setup-org.yml runs the scaffold script without
// `npm ci`, so anything imported here must not pull in node_modules.

export const CONTROL_SCAFFOLD_DIRS = Object.freeze([
  "assignments",
  "students",
  "teams",
  "acceptances",
  "repositories",
  "observations",
  "lockdowns",
  "reports",
  "overrides",
  "public",
]);

// ---------------------------------------------------------------------------
// Where a given document lives inside that layout.
//
// The directory names above were owned here from the start; the FILE paths were
// not, and were spelled by hand across the CLI, the SPA and the hub - roughly
// seventeen sites over five families. `students/roster.yml` is the one that
// already had an owner (`ROSTER_PATH` in lib/roster-entries.mjs) and a guard,
// because it had been re-spelled once and the re-spelling was found the hard
// way. Its siblings had neither.
//
// A path spelled twice is a rename that half-lands: the writer moves and the
// reader does not, and the failure is a 404 that reads as "no data yet" rather
// than as a bug. `acceptances/<id>` returning empty looks exactly like a cohort
// where nobody has accepted.
//
// These take the SEGMENT names from the array above rather than repeating them,
// so renaming a directory moves its files with it. tests/control-paths.test.mjs
// checks that every builder's first segment is a declared scaffold directory,
// which is the assertion that keeps the two halves honest.

const DIR = Object.fromEntries(CONTROL_SCAFFOLD_DIRS.map((d) => [d, d]));

/** `assignments/<id>.yml` - the assignment document. */
export const assignmentPath = (id) => `${DIR.assignments}/${id}.yml`;

/** `reports/<id>.json` - one assignment's report. */
export const reportPath = (id) => `${DIR.reports}/${id}.json`;

/** `reports/dashboard.json` - the aggregate every dashboard reads. */
export const DASHBOARD_PATH = `${DIR.reports}/dashboard.json`;

/** `acceptances/<id>` - the directory; one file per accepted login. */
export const acceptancesDir = (id) => `${DIR.acceptances}/${id}`;

/** `acceptances/<id>/<login>.json` - one student's acceptance record. */
export const acceptancePath = (id, login) => `${acceptancesDir(id)}/${login}.json`;

/** `repositories/<id>` - the directory; one file per provisioned repo. */
export const repositoriesDir = (id) => `${DIR.repositories}/${id}`;

/** `repositories/<id>/<login>.json` - one provisioned repository record. */
export const repositoryPath = (id, login) => `${repositoriesDir(id)}/${login}.json`;

/** `teams/<id>` - the directory; one file per team. */
export const teamsDir = (id) => `${DIR.teams}/${id}`;

/** `teams/<id>/<slug>.json` - one team. */
export const teamPath = (id, slug) => `${teamsDir(id)}/${slug}.json`;

/** `overrides/<id>` - the directory; one file per student with an override. */
export const overridesDir = (id) => `${DIR.overrides}/${id}`;

/** `overrides/<id>/<login>.json` - one student's deadline override. */
export const overridePath = (id, login) => `${overridesDir(id)}/${login}.json`;

/** `lockdowns/<id>/lockdown-record.json` - what the deadline froze. */
export const lockdownRecordPath = (id) => `${DIR.lockdowns}/${id}/lockdown-record.json`;

// The two `students/` paths are NOT here. `lib/claim.mjs` already exports
// claimPath() and claimAttemptsPath(), and `students/roster.yml` is ROSTER_PATH
// in lib/roster-entries.mjs - both owned by the module that owns the documents
// themselves, which is the same placement rule and predates this file's
// builders. Restating them here would be a second owner, which is the fork this
// module exists to prevent. tests/control-paths.test.mjs imports them from
// their real homes and checks all three agree on the `students` segment.
