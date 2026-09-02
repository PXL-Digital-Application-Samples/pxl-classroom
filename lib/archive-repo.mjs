// Where a preserved submission lives.
//
// The archive used to be ONE repository per organization,
// `<org>/pxl-classroom-archive`, holding every branch of every assignment for
// ever. Measured on real PXL cohorts before this changed: student repos on the
// automation/systems courses run 400 KB - 58 MB each (people commit build
// artifacts), and git dedups the shared template but not what students add. At
// four assignments a year and forty students that is roughly 800 MB per org per
// year, in a single repository, against GitHub's ~1 GB soft warning. It only
// ever grew, because the one thing that would shrink it - retiring a cohort -
// could not be done without deleting other cohorts too.
//
// So the archive is now per assignment: `pxl-classroom-archive-<assignment-id>`.
// It is created by preserve.mjs on the first preservation, and it dies with the
// cohort - retiring a three-year-old assignment is its student repos and its
// archive, one gesture, with nothing else in the blast radius.
//
// THE RECORD IS AUTHORITATIVE, NOT THIS FUNCTION. Every preservation.json ever
// written carries `archive_repo` (preserve.mjs has always recorded it), so an
// existing preservation is resolved from what was written down, never from what
// today's naming rule would produce. That is what keeps links to submissions
// archived before this change alive - see `resolveArchiveRepo`.
//
// Dependency-free and isomorphic on purpose: the SPA imports it through
// `frontend/src/lib/archive-repo.js`, the CLI and the workflows import it
// directly. `tests/archive-repo.test.mjs` fails if any of them builds an
// archive repo name or a `preserved/...` URL of its own.

// `#deployment`, never "./deployment.mjs". This module is ISOMORPHIC - the SPA
// re-exports it through frontend/src/lib/archive-repo.js - and the Node reader
// uses node:fs and node:url. Importing it directly bundled `fileURLToPath` into
// the browser, where it is not a function: every route that loaded this chunk
// rendered a blank page. The subpath import resolves to lib/deployment.mjs in
// Node (package.json "imports") and to frontend/src/lib/deployment.js in the
// browser (vite.config.js "resolve.alias"). Same values, same names, one
// deployment.yml behind both.
import { LEGACY_ARCHIVE_REPO, ARCHIVE_REPO_PREFIX } from "#deployment";

// The single per-org archive, used by every preservation written before this
// change. Never a fallback for a NEW preservation - only for reading an old one.
export { LEGACY_ARCHIVE_REPO, ARCHIVE_REPO_PREFIX };



// GitHub refuses a repository name longer than 100 characters. An assignment id
// is schema-constrained to 100 (`^[a-z0-9][a-z0-9-]{0,99}$`), so the prefix
// alone can push a legitimate id past the limit. Without a rule for it the
// failure lands as `fail:create-archive` for the whole cohort, at the deadline,
// which is the worst moment this system has.
export const MAX_REPO_NAME_LENGTH = 100;

const HASH_LENGTH = 8;

// FNV-1a, 32-bit. A disambiguator for a truncated name, not a security
// boundary - which is why it does not need (and must not pull in) crypto: this
// module is bundled into the browser.
function shortHash(input) {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(HASH_LENGTH, "0").slice(-HASH_LENGTH);
}

// An assignment id that reaches here should already have been validated by the
// schema or by preserve.mjs. Normalising rather than trusting keeps a
// hand-edited YAML from producing a name GitHub rejects.
function normalizeId(assignmentId) {
  if (typeof assignmentId !== "string") return "";
  return assignmentId.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+/, "");
}

/**
 * The repository a NEW preservation for this assignment is pushed to.
 *
 * Returns null for an unusable id rather than throwing: this runs inside Vue
 * computeds, and a throw there takes the whole pane down with the control that
 * would fix it (the `localToUtc` bug, CLAUDE.md). Callers that must have a name
 * - preserve.mjs - check for null and fail loudly.
 *
 * @param {string} assignmentId
 * @returns {string|null}
 */
export function archiveRepoName(assignmentId) {
  const id = normalizeId(assignmentId);
  if (!id) return null;

  const full = ARCHIVE_REPO_PREFIX + id;
  if (full.length <= MAX_REPO_NAME_LENGTH) return full;

  // Deterministic, so a later lookup lands on the same repository: truncate the
  // id and append a digest of the WHOLE id, not of the truncated part - two ids
  // sharing a long prefix must not collide.
  const room = MAX_REPO_NAME_LENGTH - ARCHIVE_REPO_PREFIX.length - HASH_LENGTH - 1;
  const head = id.slice(0, room).replace(/-+$/, "");
  return `${ARCHIVE_REPO_PREFIX}${head}-${shortHash(id)}`;
}

/**
 * The repository an EXISTING preservation lives in, as `owner/name`.
 *
 * `recorded` is the `archive_repo` field carried by preservation.json and
 * propagated onto every report row. It wins outright.
 *
 * Its absence is not ambiguity: a preserved row without the field predates
 * per-assignment archives, and everything preserved before that went to the
 * single per-org `pxl-classroom-archive`. Falling back to today's naming rule
 * instead would hand a lecturer a 404 for every submission archived before the
 * change.
 *
 * It takes no assignment id, deliberately: resolving an existing preservation
 * from today's naming rule is the one thing this function must not be able to
 * do by accident.
 *
 * @param {{org?: string, recorded?: string|null}} args
 * @returns {string|null} `owner/name`, or null when neither is resolvable.
 */
export function resolveArchiveRepo({ org, recorded } = {}) {
  if (typeof recorded === "string" && recorded.trim()) {
    const value = recorded.trim();
    if (value.includes("/")) return value;
    return org ? `${org}/${value}` : null;
  }
  return org ? `${org}/${LEGACY_ARCHIVE_REPO}` : null;
}

/**
 * The branch a submission is preserved on.
 *
 * `recordedRef` is preservation.json's `preserved_ref`, propagated onto the
 * report row as `archive_ref`. It wins, for the same reason `recorded` wins in
 * resolveArchiveRepo: it is what the push actually targeted.
 *
 * Reconstruction is the fallback for rows written before the field was
 * propagated. A group shares one repository, so the team slug is the ref key
 * when there is one - the SPA used to reconstruct with the login unconditionally
 * and linked every group submission to a branch that does not exist.
 *
 * @param {{assignmentId?: string, login?: string|null, teamSlug?: string|null, recordedRef?: string|null}} args
 * @returns {string|null}
 */
export function archiveBranchName({ assignmentId, login, teamSlug, recordedRef } = {}) {
  if (typeof recordedRef === "string" && recordedRef.trim()) {
    return recordedRef.trim().replace(/^refs\/heads\//, "");
  }
  const key = teamSlug || login;
  if (!assignmentId || !key) return null;
  return `preserved/${assignmentId}/${key}`;
}

/**
 * Browse URL for an archive repository.
 *
 * @param {{org?: string, recorded?: string|null, serverUrl?: string}} args
 * @returns {string|null}
 */
export function archiveRepoUrl({ org, recorded, serverUrl = "https://github.com" } = {}) {
  const slug = resolveArchiveRepo({ org, recorded });
  return slug ? `${serverUrl}/${slug}` : null;
}

/**
 * Browse URL for an archive's BRANCH LIST, which is where the work actually is.
 *
 * A preservation is a branch, `preserved/<assignment>/<login>`; the default
 * branch holds only a README. So the repository root - which is what
 * `archiveRepoUrl` returns and what the UI linked to - shows one small file and
 * reads as an EMPTY REPOSITORY. A lecturer opening the archive for a finished
 * exam concluded exactly that (2026-09-02), which is the worst possible wrong
 * conclusion to invite: that the evidence was lost.
 *
 * @param {{org?: string, recorded?: string|null, serverUrl?: string}} args
 * @returns {string|null}
 */
export function archiveBranchesUrl({ org, recorded, serverUrl = "https://github.com" } = {}) {
  const slug = resolveArchiveRepo({ org, recorded });
  return slug ? `${serverUrl}/${slug}/branches` : null;
}

/**
 * Browse URL for one preserved submission.
 *
 * Returns null when there is nothing to link to, so a caller renders no link
 * rather than a dead one.
 *
 * @param {{org?: string, assignmentId?: string, login?: string|null, teamSlug?: string|null, recorded?: string|null, recordedRef?: string|null, serverUrl?: string}} args
 * @returns {string|null}
 */
export function archiveBranchUrl({ org, assignmentId, login, teamSlug, recorded, recordedRef, serverUrl = "https://github.com" } = {}) {
  const slug = resolveArchiveRepo({ org, recorded });
  const branch = archiveBranchName({ assignmentId, login, teamSlug, recordedRef });
  if (!slug || !branch) return null;
  return `${serverUrl}/${slug}/tree/${encodeURIComponent(branch)}`;
}

/**
 * The archive repository a report as a whole points at, for surfaces that need
 * one link rather than one per student (the preservation banner's "Archive
 * Repo" button, the CLI's clone target).
 *
 * Reads it off the first preserved row instead of deriving it, so a cohort
 * archived before this change still resolves to the repository that actually
 * holds it. Returns null when nothing is preserved yet - at which point no
 * archive repository exists, and offering a link to one is the page guessing.
 *
 * @param {{org?: string, students?: Array<object>}} args
 * @returns {string|null}
 */
export function reportArchiveRepo({ org, students } = {}) {
  const preserved = (Array.isArray(students) ? students : []).filter(
    (s) => s && s.preservation_status === "preserved",
  );
  if (preserved.length === 0) return null;
  const recorded = preserved.find((s) => typeof s.archive_repo === "string" && s.archive_repo.trim());
  return resolveArchiveRepo({ org, recorded: recorded?.archive_repo });
}
