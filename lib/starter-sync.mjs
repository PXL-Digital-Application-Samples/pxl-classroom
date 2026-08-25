// PXL Classroom - planning a starter code sync.
//
// Pure: no fetch, no fs, no Node builtins, so the SPA's pre-flight, the
// workflow script and the CLI all decide the same thing. Only the I/O differs.
//
// WHY THIS REPLACED A MERGE. The old implementation asked each student's
// repository to merge a commit SHA from the template:
//
//     GET  /repos/{org}/{student}/compare/{templateSha}...main
//     POST /repos/{org}/{student}/merges  { base: "main", head: templateSha }
//
// Student repositories are created with `POST /repos/{tpl}/generate`
// (provisioning/provision.mjs), which produces a repository holding a single
// squashed commit and NO objects in common with the template. So that SHA does
// not exist in the repository being asked about, and GitHub answers 404 -
// verified live on 2026-08-25. The compare 404 put every student in the
// "conflict" bucket, the merge 404 fell through to the `else` branch and was
// recorded as `failed`, and because the fallback keyed on 409 the PR path could
// never run either. The feature could not work for any repository this system
// provisions. tests/sync-starter.test.mjs missed it by building its students
// with `git clone` of the template - shared history, which real provisioning
// never produces.
//
// The replacement copies CONTENT and never touches history. Three git trees
// answer everything:
//
//   head    - the template at the commit being synced
//   base    - the template at that commit's parent
//   student - the student repository's default branch
//
// Blob SHAs are content addresses (sha1 of "blob <len>\0<bytes>"), identical in
// every repository for identical bytes, so comparing them compares content
// exactly - without fetching a single file. A student whose blob still matches
// `base` has not touched that file and can be updated in place; one whose blob
// differs has, and gets a pull request instead. Per FILE, not per student: a
// correction to `bmi_calculator.py` still lands directly for the 40 students
// who never opened it.

/**
 * Paths a template commit touched, as the default selection.
 *
 * A rename is an add plus a delete here - `previous_filename` has to be in the
 * selection or the old path survives in every student repository beside the new
 * one.
 *
 * @param {Array<{filename: string, previous_filename?: string}>} files
 * @returns {string[]}
 */
export function changedPaths(files) {
  const out = [];
  for (const f of files || []) {
    if (f?.filename) out.push(f.filename);
    if (f?.previous_filename) out.push(f.previous_filename);
  }
  return [...new Set(out)];
}

/**
 * Narrow a selection to what the lecturer ticked. `["*"]` (or an empty/absent
 * list) means everything the commit touched.
 */
export function resolveSelection(changed, selected) {
  const list = Array.isArray(selected) ? selected.filter(Boolean) : [];
  if (list.length === 0 || list.includes("*")) return [...changed];
  const wanted = new Set(list);
  // Intersected rather than trusted: a path the lecturer's browser sent that
  // the commit did not touch has no content to copy and no base to compare to.
  return changed.filter((p) => wanted.has(p));
}

/**
 * Decide, per path, what happens in one student repository.
 *
 * Trees are `Map<path, blobSha>` or plain objects. An absent path means the
 * file does not exist in that tree, which is a meaningful value here: absent in
 * `head` is a deletion, absent in `base` and in `student` is a clean add.
 *
 * @returns {{
 *   upToDate: string[],
 *   clean: Array<{path: string, action: "write"|"delete"}>,
 *   conflicts: Array<{path: string, action: "write"|"delete"}>,
 * }}
 */
export function planStarterSync({ headTree, baseTree, studentTree, paths }) {
  const at = (tree, path) =>
    tree instanceof Map ? tree.get(path) : tree?.[path];

  const upToDate = [];
  const clean = [];
  const conflicts = [];

  for (const path of paths || []) {
    const head = at(headTree, path);
    const base = at(baseTree, path);
    const student = at(studentTree, path);
    const action = head === undefined ? "delete" : "write";

    if (student === head) {
      // Includes the both-absent case: a file the commit deleted that this
      // student never had.
      upToDate.push(path);
    } else if (student === base) {
      // Byte-identical to what the template said before this commit, so
      // nothing of the student's is at stake.
      clean.push({ path, action });
    } else {
      conflicts.push({ path, action });
    }
  }

  return { upToDate, clean, conflicts };
}

/**
 * The outcome string for one student, from their plan.
 *
 * `merged-and-pr` exists because the split is per file: the same sync can put
 * three corrections straight onto a student's main and raise a pull request for
 * the fourth. Collapsing that into one label would misreport half of it.
 */
export function outcomeFor({ clean, conflicts }) {
  const hasClean = (clean?.length || 0) > 0;
  const hasConflicts = (conflicts?.length || 0) > 0;
  if (hasClean && hasConflicts) return "merged-and-pr";
  if (hasConflicts) return "pr-opened";
  if (hasClean) return "auto-merged";
  return "skipped-up-to-date";
}

/**
 * Roll results up into the sync record's `summary` block.
 *
 * A `merged-and-pr` student counts in BOTH `auto_merged` and `pr_opened`,
 * which is why the counters do not sum to `total` and are not asserted to.
 */
export function summarize(results) {
  const summary = { total: results.length, auto_merged: 0, pr_opened: 0, skipped: 0, failed: 0 };
  for (const r of results) {
    if (r.outcome === "auto-merged" || r.outcome === "merged-and-pr") summary.auto_merged++;
    if (r.outcome === "pr-opened" || r.outcome === "merged-and-pr") summary.pr_opened++;
    if (r.outcome === "skipped-up-to-date" || r.outcome === "skipped-no-repo") summary.skipped++;
    if (r.outcome === "failed") summary.failed++;
  }
  return summary;
}
