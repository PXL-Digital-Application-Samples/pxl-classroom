// PXL Classroom - planning a starter code sync.
//
// Pure: no fetch, no fs, no Node builtins, so the SPA's pre-flight, the
// workflow script and the CLI all decide the same thing. Only the I/O differs.
//
// WHY THIS REPLACED A MERGE. The old implementation asked each student's
// repository about a commit SHA from the template:
//
//     GET  /repos/{org}/{student}/compare/{templateSha}...main
//     POST /repos/{org}/{student}/merges  { base: "main", head: templateSha }
//
// Measured against live GitHub on 2026-08-25, on repositories created the way
// provisioning creates them (`POST /repos/{tpl}/generate`), same-owner and
// cross-owner alike:
//
//   * the MERGE succeeds - 201, and the resulting commit carries the
//     template's own root commit as a second parent. Generated repositories
//     stay in the template's object network, so the SHA resolves. (An earlier
//     version of this comment claimed a 404 here. It was wrong.)
//   * the COMPARE is a 404: `No common ancestor between <sha> and main`.
//
// That asymmetry is the bug. The compare fed the `status === "identical"`
// check, so the "already up to date" skip could never fire and every re-run
// re-merged; and in the modal's pre-flight a non-ok compare fell to the
// catch-all, so every student was previewed as a conflict. Meanwhile the merge
// that did work carried the WHOLE template tree - making the lecturer's file
// selection decorative - and grafted the template's entire history into each
// student repository.
//
// tests/sync-starter.test.mjs missed all of it by building its students with
// `git clone` of the template, which is not what provisioning produces either.
//
// Neither executor could reach any of this in practice: the workflow could not
// mint an App token (`client-id` on an action version that takes `app-id`) and
// the script passed `loadYaml` file text instead of a path without awaiting it.
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
 * Which template commit to sync, when the lecturer names one: the value
 * lower-cased, or null for "the newest" (blank), or `{ error }`.
 *
 * WHY A LECTURER NAMES ONE. A sync copies what ONE commit changed, and without
 * this it is always the newest commit. A sync that stopped part-way therefore
 * left its commit unreachable the moment a later one was pushed: on 2026-09-25
 * lab 3 reached 31 of 111 students before the job timed out, lab 4 was synced
 * over it, and nothing could send lab 3 to the other 43 again.
 *
 * Only a hex sha, 7 to 40 characters. It arrives from a workflow form, and
 * GitHub would also resolve a branch or tag name here - which is a moving
 * target, and exactly what this field exists to not be.
 */
export function readTemplateCommit(value) {
  const v = String(value ?? "").trim();
  if (!v) return null;
  if (!/^[0-9a-f]{7,40}$/i.test(v)) {
    return { error: `"${v}" is not a commit sha - give 7 to 40 hexadecimal characters, e.g. 1e7f714` };
  }
  return v.toLowerCase();
}

/**
 * Narrow a selection to what the lecturer ticked. `["*"]` (or an empty/absent
 * list) means everything the commit touched.
 */
export function resolveSelection(changed, selected) {
  const list = Array.isArray(selected) ? selected.filter(Boolean) : [];
  // `!path` EXCLUDES. A selection is `["*", "!a", "!b"]` when the lecturer
  // unticked two files: "everything this student is behind on, except these".
  // An inclusion list could not say that once a student's range reaches past
  // the files the dialog showed - unticking one file would silently drop every
  // earlier change they had missed.
  const excluded = new Set(list.filter((p) => p.startsWith("!")).map((p) => p.slice(1)));
  const included = list.filter((p) => !p.startsWith("!"));
  let out;
  if (included.length === 0 || included.includes("*")) {
    out = [...changed];
  } else {
    const wanted = new Set(included);
    // Intersected rather than trusted: a path the lecturer's browser sent that
    // the commit did not touch has no content to copy and no base to compare to.
    out = changed.filter((p) => wanted.has(p));
  }
  return excluded.size ? out.filter((p) => !excluded.has(p)) : out;
}

/**
 * Did the lecturer send EVERYTHING? Only then does a student who got this
 * sync count as being at its commit - a student who was not sent a file is not
 * at the commit that changed it, and treating them as if they were is how that
 * file would never reach them.
 */
export function selectionIsAll(selected) {
  const list = Array.isArray(selected) ? selected.filter(Boolean) : [];
  if (list.length === 0) return true;
  return list.includes("*") && !list.some((p) => p.startsWith("!"));
}

/**
 * Every path whose content differs between two trees, including a path in
 * only one of them. `Map<path, blobSha>` both.
 *
 * This is what a student starting at `from` is behind on at `head` - computed
 * from the two trees, so it has no cap. The commit's own `files` list stops at
 * 300 entries, and a range of commits has no such list at all.
 */
export function diffTreePaths(fromTree, headTree) {
  const out = new Set();
  for (const [path, sha] of headTree) if (fromTree.get(path) !== sha) out.add(path);
  for (const path of fromTree.keys()) if (!headTree.has(path)) out.add(path);
  return [...out].sort();
}

/** Outcomes after which a student holds the sync's commit. `failed` and the
 *  skips for a missing repository are not. */
export const REACHED_OUTCOMES = Object.freeze(["auto-merged", "merged-and-pr", "pr-opened", "skipped-up-to-date"]);

/**
 * The template commit this student is known to be at - where their range
 * starts - and how that is known.
 *
 * A SYNC SENDS EACH STUDENT WHAT THEY ARE MISSING, not what one commit
 * changed. The single-commit version could never send a commit again: lab 3
 * of .NET Advanced reached 31 of 111 students before its run was stopped, lab
 * 4 was synced over it, and nothing afterwards would ever have carried lab 3
 * to the other 43.
 *
 * In order, the first that answers:
 *
 *   synced     the newest sync record that sent this student EVERYTHING in
 *              their range (`per_student_range` and `all_files`) and reached
 *              them. Older, single-commit records are not evidence of where
 *              a student is: they say one commit's files arrived, not that the
 *              student holds that commit.
 *   generated  their repository's FIRST commit carries exactly a template
 *              commit's tree - `POST /generate` copies the tree, and this was
 *              measured on all 111 repositories of .NET Advanced (2026-09-25):
 *              every one matched. Several template commits can share a tree (a
 *              revert); the newest of those is taken, because the files are
 *              identical and a later start means a shorter range.
 *   unknown    the head commit's parent: exactly what a sync did before this,
 *              so an unanswerable student is never treated worse than they
 *              were.
 *
 * A wrong answer here cannot overwrite a student's work - `planStarterSync`
 * only writes a file whose content equals a template version of it. What a
 * start that is too LATE costs is a change never sent, which is why nothing is
 * guessed from timestamps: a commit made at 11:30 and pushed at 11:36 would
 * date a repository generated at 11:33 one lab ahead of what it holds.
 *
 * @param {object} p
 * @param {string} p.login
 * @param {Array<import("./types.mjs").SyncRecord>} [p.records]  sync records for this assignment
 * @param {string|null} [p.rootTreeSha]       the tree of the repository's first commit
 * @param {Array<{sha: string, treeSha: string, date: string}>} [p.templateCommits]
 * @param {string|null} [p.fallbackSha]       the head commit's parent
 * @returns {{sha: string|null, source: "synced"|"generated"|"unknown"}}
 */
export function startingPointFor({ login, records = [], rootTreeSha = null, templateCommits = [], fallbackSha = null }) {
  const me = String(login || "").toLowerCase();
  const synced = records
    .filter((r) => r?.per_student_range === true && r?.all_files === true && /^[0-9a-f]{40}$/.test(r?.template_sha || ""))
    .filter((r) =>
      (r.results || []).some(
        (x) =>
          String(x?.github_login || "").toLowerCase() === me &&
          REACHED_OUTCOMES.includes(x?.outcome) &&
          // A student whose start was UNKNOWN was sent only the newest
          // commit's changes, so reaching this sync does not put them at its
          // commit - counting it would bury whatever they had missed before.
          // "first-commit" too: a range from their own first commit is the
          // whole of what they were missing - but ONLY where it left nothing
          // behind. A first-commit sync written before 2026-09-26 filed files
          // an earlier sync had delivered as "theirs" (`files_kept`) and never
          // updated them, so it does not put the student at its commit:
          // counting it would start the next sync after changes they never got.
          (x?.from_source === "synced" || x?.from_source === "generated" ||
            (x?.from_source === "first-commit" && !x?.files_kept)),
      ),
    )
    .sort((a, b) => String(b.synced_at).localeCompare(String(a.synced_at)))[0];
  if (synced) return { sha: synced.template_sha, source: "synced" };

  if (rootTreeSha) {
    const hits = templateCommits
      .filter((c) => c?.treeSha === rootTreeSha)
      .sort((a, b) => String(b.date).localeCompare(String(a.date)));
    if (hits.length) return { sha: hits[0].sha, source: "generated" };
  }
  return { sha: fallbackSha, source: "unknown" };
}

/**
 * Decide, per path, what happens in one student repository.
 *
 * Trees are `Map<path, blobSha>` or plain objects. An absent path means the
 * file does not exist in that tree, which is a meaningful value here: absent in
 * `head` is a deletion, absent in `base` and in `student` is a clean add.
 *
 * `kept` is a file this commit ADDS that the student already has, with other
 * content. They received it before - a sync that got that far, or a
 * repository generated after the commit - and have since worked in it, so it
 * is theirs. Offering it as a pull request would offer to reset their work to
 * the starter version, which is never what a re-sync is for. It is counted
 * rather than hidden (`files_kept` on the sync record).
 *
 * @param {object} p
 * @param {Map<string,string>|object} p.headTree
 * @param {Map<string,string>|object} p.baseTree
 * @param {Map<string,string>|object} p.studentTree
 * @param {string[]} p.paths
 * @param {Map<string, Set<string>>|null} [p.knownVersions]  every blob the template ever had per path
 * @param {boolean} [p.keepAdded]  false after a template switch: nothing is "theirs" by being added
 * @param {boolean} [p.trustBase]  false when the base is not known to be starter code (a first commit GitHub did not generate)
 * @returns {{
 *   upToDate: string[],
 *   kept: string[],
 *   clean: Array<{path: string, action: "write"|"delete"}>,
 *   conflicts: Array<{path: string, action: "write"|"delete"}>,
 * }}
 */
export function planStarterSync({ headTree, baseTree, studentTree, paths, knownVersions = null, keepAdded = true, trustBase = true }) {
  const at = (tree, path) =>
    tree instanceof Map ? tree.get(path) : tree?.[path];
  // A copy byte-identical to ANY version the template ever had of this path is
  // starter code nobody edited, so replacing it loses nothing (`knownVersions`:
  // path -> Set of blob shas). Passed after a template SWITCH, where the
  // student's base is their own first commit and a file they received from
  // the new template later is otherwise indistinguishable from their work.
  const untouched = (path, student) =>
    student !== undefined && knownVersions?.get(path)?.has(student) === true;

  /** @type {string[]} */
  const upToDate = [];
  /** @type {string[]} */
  const kept = [];
  /** @type {Array<{path: string, action: "write"|"delete"}>} */
  const clean = [];
  /** @type {Array<{path: string, action: "write"|"delete"}>} */
  const conflicts = [];

  for (const path of paths || []) {
    const head = at(headTree, path);
    const base = at(baseTree, path);
    const student = at(studentTree, path);
    const action = /** @type {"write"|"delete"} */ (head === undefined ? "delete" : "write");

    if (student === head) {
      // Includes the both-absent case: a file the commit deleted that this
      // student never had.
      upToDate.push(path);
    } else if (!trustBase) {
      // THE BASE IS NOT KNOWN TO BE STARTER CODE (`trustBase: false` - a
      // student's own first commit, which after a force-pushed history or a
      // reused repository is THEIR work, not a template's). "Unchanged since
      // the base" then proves nothing, so only what can be proved is done
      // straight on main: a file they do not have is added, and a copy this
      // template actually had is replaced or deleted. Anything else they hold
      // is theirs until they say otherwise - a changed file is a pull request,
      // and a deletion of a file no template version matches is not proposed
      // at all. Not `kept` either: kept files mark a record as not having
      // reached the student (a template file left un-updated), and a file of
      // theirs left in place withholds nothing the template sends.
      if (student === undefined || untouched(path, student)) clean.push({ path, action });
      else if (action !== "delete") conflicts.push({ path, action });
    } else if (student === base || untouched(path, student)) {
      // Byte-identical to what the template said before this commit, so
      // nothing of the student's is at stake.
      clean.push({ path, action });
    } else if (keepAdded && base === undefined && head !== undefined && student !== undefined) {
      // NOT after a template switch (`keepAdded: false`): there every file of
      // the new template is "added" relative to the student's first commit,
      // so a file an earlier sync delivered would be "theirs" for ever and
      // never updated again - and the record would still say they hold this
      // commit. It goes to a pull request instead, like any other edit.
      // The commit adds it and they already have one: theirs (see `kept`).
      kept.push(path);
    } else {
      conflicts.push({ path, action });
    }
  }

  return { upToDate, kept, clean, conflicts };
}

/**
 * Marker written into a sync pull request's body, so a second run of the same
 * sync adopts the pull request it already opened instead of opening another.
 *
 * Without it, re-running a sync - which a lecturer does the moment the first
 * one looks like it did nothing - piles up one pull request per run in every
 * student repository that has an edit. Observed on the second run of a live
 * rehearsal: the same one-file correction opened #1 and then #3.
 *
 * Keyed on the template commit, so syncing a DIFFERENT correction still opens
 * its own pull request.
 */
export function syncMarker(templateSha) {
  return `<!-- pxl-starter-sync: ${templateSha} -->`;
}

/**
 * The open pull request a previous run of this same sync already opened, if any.
 *
 * `openPulls` must be the WHOLE list - one page of it is not the list, and a
 * missed marker is a duplicate pull request rather than a visible error.
 */
export function findExistingSyncPr(openPulls, templateSha) {
  const marker = syncMarker(templateSha);
  return (openPulls || []).find((pr) => (pr?.body || "").includes(marker)) || null;
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
