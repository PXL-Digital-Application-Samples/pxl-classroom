// PXL Classroom - is a planned drill delete still true? Not part of `npm test`.
//
// A cleanup reads the assignment document, then reads the control tree, then
// commits. Between the first two reads somebody else can delete the same
// assignment - the other cleanup did, on 2026-09-17 - and `commitWithRebase`
// rebases onto whatever head it finds, so the commit lands anyway and rewrites
// `retired/<id>/manifest.json` with a manifest saying nothing was removed. That
// record is written once and nothing regenerates it.
//
// tests/live/cleanup-lock.mjs stops two cleanups; this stops the commit whose
// plan stopped being true, whoever invalidated it - the Admin Panel deleting
// the same assignment in a browser tab, or a Contents read served from before
// the delete.
//
// NOT "a retired record exists". `retired/<id>/` is written by EVERY delete, and
// a lecturer may delete an assignment nobody joined and start again under the
// same id - CLAUDE.md makes that the standing rule about the deletion record,
// and the Admin Panel's own collision check reads the manifest for exactly that
// case. So the question is whether the document THIS plan was read from is
// still in the tree the commit will be built on. The retired manifest only says
// which of the two things happened, which is the difference between "somebody
// else deleted it" and "it vanished".

import { assignmentPath, retiredManifestPath } from "../../lib/control-layout.mjs";

/**
 * @param {object} args
 * @param {string[]} args.paths        every blob path in the tree the commit will be built on
 * @param {string} args.assignmentId
 * @returns {{reason: "retired"|"gone", message: string}|null} null when the plan still holds
 */
export function deletePlanStale({ paths, assignmentId }) {
  const all = Array.isArray(paths) ? paths : [];
  if (all.includes(assignmentPath(assignmentId))) return null;
  if (all.includes(retiredManifestPath(assignmentId))) {
    return {
      reason: "retired",
      message: `${assignmentId} was retired by another delete while this run was planning`,
    };
  }
  return {
    reason: "gone",
    message: `${assignmentId} is no longer in the control repository - it was deleted while this run was planning`,
  };
}
