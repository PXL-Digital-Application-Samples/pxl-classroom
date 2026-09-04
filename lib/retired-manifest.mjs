// The record a deleted assignment leaves behind.
//
// `retired/<id>/manifest.json` is written in the same atomic commit that removes
// the working data, and then nothing ever touches it again. Nothing iterates
// `retired/` either, so no surface will ever re-render this document and no
// later run will correct it: whatever it says on the day of the delete is what
// a grade dispute reads years afterwards. That is the whole reason it is built
// here rather than inline in the panel - one place to get it right, one place
// for `schemas/retired-manifest.schema.json` and `tests/retired-manifest.test.mjs`
// to point at.
//
// It is deliberately NOT validated at write time. The manifest is assembled
// after the broker has already been deleted, which is the one step of a delete
// that cannot be undone; aborting there on a schema error would leave the
// assignment standing with no broker and no record of why. The e2e fixture
// validates every control-repo write against this schema instead, so the shape
// is enforced where a failure costs nothing.
//
// Isomorphic: the Admin Panel imports it directly from `frontend/src/views/`.
// No `node:` builtins, here or anywhere it imports.
import { archiveRepoName, resolveArchiveRepo } from "./archive-repo.mjs";

/**
 * @param {object} args
 * @param {string} args.org                    Organization owning the control repo.
 * @param {string} args.assignmentId           The assignment being deleted.
 * @param {string|null} [args.title]           Its title, for a reader who has only this file.
 * @param {string|null} [args.deletedBy]       GitHub login of whoever confirmed it.
 * @param {string|null} [args.brokerRepo]      Bare name of the broker, or null if there was none.
 * @param {boolean} [args.brokerDeleted]       Whether that broker was actually deleted by this run.
 * @param {string[]} [args.removedPaths]       Control-repo paths the delete removed.
 * @param {string} [args.deletedAt]            Override for the timestamp; tests pin it.
 * @returns {object} a document matching schemas/retired-manifest.schema.json
 */
export function buildRetiredManifest({
  org,
  assignmentId,
  title = null,
  deletedBy = null,
  brokerRepo = null,
  brokerDeleted = false,
  removedPaths = [],
  deletedAt = null,
} = {}) {
  // EVERY REPOSITORY IN THIS FILE IS `owner/name`, and both are composed here so
  // there is one answer to what that means. `broker_repo_deleted` was already
  // qualified and `archive_repo` was not, which is exactly the drift that a
  // manifest read without its surrounding context cannot survive.
  const broker = brokerDeleted && brokerRepo ? `${org}/${brokerRepo}` : null;

  // WHERE A NEW ARCHIVE WOULD GO IS THE RIGHT QUESTION HERE, unusually: this
  // manifest names the archive belonging to the assignment by today's rule,
  // because a preserved submission's own `archive_repo` (the authoritative one)
  // is on the report rows, which are copied into `retired/` beside this file.
  //
  // The null guard is not defensive noise. `resolveArchiveRepo` treats an absent
  // `recorded` as "preserved before per-assignment archives existed" and falls
  // back to the org's legacy `pxl-classroom-archive` - correct for reading an
  // old row, and a straight lie here, where it would name a repository that
  // holds nothing of this cohort's.
  const archiveName = archiveRepoName(assignmentId);
  const archive = archiveName ? resolveArchiveRepo({ org, recorded: archiveName }) : null;

  return {
    schema_version: 1,
    assignment_id: assignmentId,
    title: title || null,
    deleted_at: deletedAt || new Date().toISOString(),
    deleted_by: deletedBy || null,
    broker_repo_deleted: broker,
    archive_repo: archive,
    removed_paths: Array.isArray(removedPaths) ? removedPaths.filter((p) => typeof p === "string" && p) : [],
  };
}
