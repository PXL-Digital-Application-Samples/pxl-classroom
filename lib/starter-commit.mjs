// What a student added to a repository, against what it was given.
//
// GitHub's template copy gives a repository ONE commit, so "not started" was
// "one commit or none", and every commit counted was the student's
// (report/report.mjs). A repository copied with the template's full history
// (`template_full_history`, provisioning's `createWithFullHistory`) has the
// template's commits from the first second: counted, every student read as
// handed in the moment they accepted, with the template's commits as theirs.
// Such a repository records the commit it was given and how many commits that
// was (`starter_sha`, `starter_commit_count` on its repository record).
//
// Not started is the COMMIT, not a count: a fast-forward merge of a prepared
// branch moves main to another of the template's own commits, which is work;
// resetting back to the start is not.

const SHA = /^[0-9a-f]{40}$/;

/**
 * What this repository was given: `{ sha, count, fullHistory }` - the sha and
 * count null where GitHub's one-commit copy is the start.
 *
 * Asked of every record naming the repository, not only the student's own: the
 * run that copied it wrote the first member's record, and a teammate who joined
 * later - or a lecturer moving someone in - wrote one without it.
 *
 * `fullHistory`: whether any of those records says the start is a copy of the
 * template's whole history (`full_history`). A start is also recorded for
 * GitHub's copy that provisioning committed a grading workflow to (two commits
 * from the first second, which "one commit is the start" read as handed in,
 * review 2026-10-14) - and that copy's branches are not the students' own, so
 * only the flag says which.
 *
 * @param {{ repo_id?: number, starter_sha?: string, starter_commit_count?: number, full_history?: boolean } | null | undefined} record
 * @param {Array<{ repo_id?: number, starter_sha?: string, starter_commit_count?: number, full_history?: boolean }>} records  every record of the assignment
 * @returns {{ sha: string|null, count: number|null, fullHistory: boolean }}
 */
export function starterFor(record, records = []) {
  const has = (r) => typeof r?.starter_sha === "string" && SHA.test(r.starter_sha);
  if (!record) return { sha: null, count: null, fullHistory: false };
  // Every record naming this repository, its own first. They can disagree on
  // a team's repository: a later member's run recovers the head the App left,
  // grading workflow included, while the first member's record holds the
  // copy's. Each is a state only the App made, and later is further along, so
  // the most commits is the one every member is read against - one answer
  // for one repository (review 2026-10-14).
  const same = Number.isInteger(record.repo_id)
    ? records.filter((r) => r !== record && r?.repo_id === record.repo_id && has(r))
    : [];
  const all = [...(has(record) ? [record] : []), ...same];
  if (all.length === 0) return { sha: null, count: null, fullHistory: false };
  const read = (r) => ({
    sha: r.starter_sha,
    count: Number.isInteger(r.starter_commit_count) ? r.starter_commit_count : null,
    fullHistory: all.some((x) => x.full_history === true),
  });
  const counted = all.filter((r) => Number.isInteger(r.starter_commit_count));
  if (counted.length === 0) return read(all[0]);
  return read(counted.reduce((best, r) => (r.starter_commit_count > best.starter_commit_count ? r : best)));
}

/**
 * True when nothing the student did is on the branch yet; false when it is or
 * when it cannot be told.
 *
 * WHAT THE LOOK ESTABLISHED FIRST (`headProvided`, the observation's
 * `head_provided`, lib/untouched-repo.mjs `headIsProvided`): the head is what
 * GitHub generated or the recorded start, with only PXL Classroom's own
 * commits on top. Without it, the recorded start, then "one commit or none" -
 * which read a student's squashed one-commit history as nothing handed in, and
 * GitHub's copy plus provisioning's grading workflow, before starts were
 * recorded, as handed in (review 2026-10-15, R6-9).
 *
 * @param {object} a
 * @param {string|null} a.starterSha  from starterFor, null for GitHub's copy
 * @param {string|null} a.latestSha   the branch head the latest observation saw
 * @param {number|null} a.commitCount the latest observation's count
 * @param {boolean|null} [a.headProvided]  judged at `latestSha`; null where not
 */
export function unstartedRepo({ starterSha, latestSha, commitCount, headProvided = null }) {
  if (headProvided === true || headProvided === false) return headProvided;
  if (starterSha) return Boolean(latestSha) && latestSha === starterSha;
  return commitCount != null ? commitCount <= 1 : false;
}

/**
 * The commits on the branch that it was not given: the observed count less the
 * count it started with. The observed count as it is where nothing was
 * recorded (GitHub's copy, or a start that could not be read), and never below
 * zero - a student who reset to an older template commit added nothing.
 *
 * @param {object} a
 * @param {number|null} a.starterCount  from starterFor
 * @param {number|null} a.commitCount   the latest observation's count
 */
export function addedCommits({ starterCount, commitCount }) {
  if (commitCount == null) return null;
  if (!Number.isInteger(starterCount)) return commitCount;
  return Math.max(0, commitCount - starterCount);
}

/**
 * Whether a report row is shown as "No submission" before anything is read
 * for it (the Grading tab's breakdown). No repository, the report's own
 * `no-submission`, or an empty repository - and `commit_count: 0` is empty
 * only for GitHub's copy (no `starter_sha`): on a full-history copy it is
 * "added nothing", which an amend or a reset inside the template's history,
 * the work of a git exercise, also gives, and the report's status already
 * says whether that is a submission (review 2026-10-14, R1-5, TA-10).
 *
 * @param {{ repo_name?: string|null, submission_status?: string|null, commit_count?: number|null, starter_sha?: string|null }} row
 * @returns {boolean}
 */
export function noSubmissionRow(row) {
  return !row?.repo_name || row.submission_status === "no-submission" || (row.commit_count === 0 && !row.starter_sha);
}
