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
import { archiveRepoName, reportArchiveRepo, resolveArchiveRepo } from "./archive-repo.mjs";

/**
 * @param {object} args
 * @param {string} args.org                    Organization owning the control repo.
 * @param {string} args.assignmentId           The assignment being deleted.
 * @param {string|null} [args.title]           Its title, for a reader who has only this file.
 * @param {string|null} [args.deletedBy]       GitHub login of whoever confirmed it.
 * @param {string|null} [args.brokerRepo]      Bare name of the broker, or null if there was none.
 * @param {boolean} [args.brokerDeleted]       Whether that broker was actually deleted by this run.
 * @param {string[]} [args.removedPaths]       Control-repo paths the delete removed.
 * @param {object[]} [args.students]           The report's rows, for where the submissions
 *                                             actually went and how many there were.
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
  students = [],
  deletedAt = null,
} = {}) {
  // EVERY REPOSITORY IN THIS FILE IS `owner/name`, and both are composed here so
  // there is one answer to what that means. `broker_repo_deleted` was already
  // qualified and `archive_repo` was not, which is exactly the drift that a
  // manifest read without its surrounding context cannot survive.
  const broker = brokerDeleted && brokerRepo ? `${org}/${brokerRepo}` : null;

  // WHERE THE SUBMISSIONS ACTUALLY WENT, read off the report rows, not composed.
  //
  // The first version of this called `archiveRepoName(id)` with a comment
  // arguing that "where a NEW archive would go" was the right question here. It
  // is not, and CLAUDE.md already says so: `lib/archive-repo.mjs` decides where
  // a preservation IS versus where a new one GOES. A cohort preserved before
  // per-assignment archives existed is in the org's legacy `pxl-classroom-archive`,
  // and today's naming rule would have named `pxl-classroom-archive-<id>` - a
  // repository that never held a line of their work - in the one document
  // written to be read years later without context.
  //
  // `reportArchiveRepo` takes it from the first preserved row's own
  // `archive_repo`, which is what preserve.mjs recorded when it pushed. The
  // delete has the report in hand already: it reads it as evidence before
  // removing anything.
  const rows = Array.isArray(students) ? students : [];
  const observed = reportArchiveRepo({ org, students: rows });

  // Nothing preserved means no row can answer, so fall back to the name this
  // assignment's archive would carry - paired with the count below, which tells
  // a reader not to expect anything in it.
  const byRule = archiveRepoName(assignmentId);
  const archive = observed || (byRule ? resolveArchiveRepo({ org, recorded: byRule }) : null);

  return {
    schema_version: 1,
    assignment_id: assignmentId,
    title: title || null,
    deleted_at: deletedAt || new Date().toISOString(),
    deleted_by: deletedBy || null,
    broker_repo_deleted: broker,
    archive_repo: archive,
    // HOW MUCH WAS IN IT ON THE DAY, so a 404 later is interpretable.
    //
    // The archive outlives the delete on purpose and the lecturer removes it by
    // hand when they retire the year - nothing tells this record when that
    // happens, and nothing can. What it CAN do is say what was there when the
    // assignment was deleted: 0 means the archive never held a submission and
    // losing it costs nothing, N means N are gone. Without it, a reader finding
    // no repository cannot tell a deliberate cleanup from a name recorded wrong.
    preserved_submissions: rows.filter((s) => s?.preservation_status === "preserved").length,
    removed_paths: Array.isArray(removedPaths) ? removedPaths.filter((p) => typeof p === "string" && p) : [],
  };
}
