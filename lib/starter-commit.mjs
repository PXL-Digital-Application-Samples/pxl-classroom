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
 * What this repository was given: `{ sha, count }`, both null for GitHub's copy.
 *
 * Asked of every record naming the repository, not only the student's own: the
 * run that copied it wrote the first member's record, and a teammate who joined
 * later - or a lecturer moving someone in - wrote one without it.
 *
 * @param {{ repo_id?: number, starter_sha?: string, starter_commit_count?: number } | null | undefined} record
 * @param {Array<{ repo_id?: number, starter_sha?: string, starter_commit_count?: number }>} records  every record of the assignment
 */
export function starterFor(record, records = []) {
  const read = (r) => ({ sha: r.starter_sha, count: Number.isInteger(r.starter_commit_count) ? r.starter_commit_count : null });
  if (!record) return { sha: null, count: null };
  if (typeof record.starter_sha === "string" && SHA.test(record.starter_sha)) return read(record);
  if (!Number.isInteger(record.repo_id)) return { sha: null, count: null };
  const other = records.find((r) => r?.repo_id === record.repo_id && typeof r.starter_sha === "string" && SHA.test(r.starter_sha));
  return other ? read(other) : { sha: null, count: null };
}

/**
 * True when nothing the student did is on the branch yet; false when it is or
 * when it cannot be told.
 *
 * @param {object} a
 * @param {string|null} a.starterSha  from starterFor, null for GitHub's copy
 * @param {string|null} a.latestSha   the branch head the latest observation saw
 * @param {number|null} a.commitCount the latest observation's count
 */
export function unstartedRepo({ starterSha, latestSha, commitCount }) {
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
