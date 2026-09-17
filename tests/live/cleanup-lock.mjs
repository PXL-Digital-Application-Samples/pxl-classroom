// PXL Classroom - one drill cleanup at a time per organization. Not part of `npm test`.
//
// Two sessions ran `drill.mjs cleanup --all` against pxl-classroom-testbed nine
// seconds apart on 2026-09-17. Both listed the same drills, split the deletes
// between them, and one assignment was retired twice: the second run, finding
// nothing left to remove, rewrote `retired/<id>/manifest.json` to say the broker
// was not deleted and no paths were removed. That record is written once and
// nothing regenerates it.
//
// THE LOCK LIVES WHERE BOTH RUNS WRITE: a git ref in the organization's control
// repository. A file on this machine would not stop a run in another worktree's
// temp directory, on another machine, or anywhere else holding the credentials.
//
// Measured against the testbed's control repository on 2026-09-17, because
// GitHub documents none of it for a ref outside heads/ and tags/:
//
//   * creating `refs/pxl-drill/cleanup-lock` answers 201, and is not a branch
//   * creating it again answers 422 "Reference already exists"
//   * two creates sent at the same instant, five rounds: exactly one 201 each
//     round, and the second request won one of them, so they really raced
//   * the commit it points at is readable, message and committer date intact
//   * DELETE answers 204; deleting one that is gone answers 422
//     "Reference does not exist", NOT 404
//
// So acquiring is ONE create, never a read followed by a create: the create is
// the atomic step and anything in front of it is a window. The ref points at a
// parentless commit whose message names the holder and whose committer date
// GitHub sets, so a refusal can say who holds it and since when.
//
// A run that dies without releasing leaves the lock behind. Nothing takes it
// over automatically: two runs that both judge it stale could each delete the
// other's fresh lock, because GitHub has no compare-and-delete for a ref. Clearing
// it is a person's decision (`cleanup --break-lock`).

export const CLEANUP_LOCK_REF = "pxl-drill/cleanup-lock";

const REF_PATH = (org, repo) => `/repos/${org}/${repo}/git/refs/${CLEANUP_LOCK_REF}`;
const REF_READ_PATH = (org, repo) => `/repos/${org}/${repo}/git/ref/${CLEANUP_LOCK_REF}`;

const message = (res) => res?.data?.message ?? "";

/** Who holds the lock and since when, or null fields where that is unreadable. */
async function readHolder(request, { org, repo }) {
  const ref = await request("GET", REF_READ_PATH(org, repo));
  if (!ref.ok) return { sha: null, holder: null, since: null, status: ref.status };
  const sha = ref.data?.object?.sha ?? null;
  const commit = sha ? await request("GET", `/repos/${org}/${repo}/git/commits/${sha}`) : null;
  const holder = commit?.ok ? (String(commit.data?.message ?? "").match(/^holder: (.*)$/m)?.[1] ?? null) : null;
  const since = commit?.ok ? (commit.data?.committer?.date ?? null) : null;
  return { sha, holder, since, status: ref.status };
}

/**
 * Take the cleanup lock for this control repository.
 *
 * @param {Function} request `(method, path, body) => {ok, status, data}`
 * @param {{org: string, repo: string, holder: string}} args
 * @returns {Promise<{ok: true, sha: string} |
 *   {ok: false, held: boolean, holder: string|null, since: string|null, reason: string}>}
 */
export async function acquireCleanupLock(request, { org, repo, holder }) {
  const refused = (reason) => ({ ok: false, held: false, holder: null, since: null, reason });

  // The lock commit needs a tree. main's is one GET away and certainly exists.
  const head = await request("GET", `/repos/${org}/${repo}/git/ref/heads/main`);
  if (!head.ok) return refused(`cannot read ${repo} main (HTTP ${head.status})`);
  const main = await request("GET", `/repos/${org}/${repo}/git/commits/${head.data?.object?.sha}`);
  if (!main.ok) return refused(`cannot read ${repo} main's commit (HTTP ${main.status})`);

  const lockCommit = await request("POST", `/repos/${org}/${repo}/git/commits`, {
    message: `pxl drill cleanup lock\n\nholder: ${holder}\n`,
    tree: main.data?.tree?.sha,
    parents: [],
  });
  if (!lockCommit.ok) return refused(`cannot write the lock commit (HTTP ${lockCommit.status})`);

  const created = await request("POST", `/repos/${org}/${repo}/git/refs`, {
    ref: `refs/${CLEANUP_LOCK_REF}`,
    sha: lockCommit.data.sha,
  });
  if (created.ok) return { ok: true, sha: lockCommit.data.sha };

  // Only this answer means somebody else has it. Any other failure is a lock we
  // could not take, and running without one is the thing this exists to stop.
  if (created.status === 422 && /already exists/i.test(message(created))) {
    const who = await readHolder(request, { org, repo });
    return {
      ok: false,
      held: true,
      holder: who.holder,
      since: who.since,
      reason: `another cleanup holds refs/${CLEANUP_LOCK_REF}`,
    };
  }
  return refused(`cannot create refs/${CLEANUP_LOCK_REF} (HTTP ${created.status} ${message(created)})`.trim());
}

/**
 * Give the lock back - only if it is still ours.
 *
 * A lock broken and re-taken by somebody else while this run was going is
 * theirs now, and deleting it would let a third run in beside them. The read
 * and the delete are two calls, so that protection has a window; it is there
 * for the ordinary case of a lock that was broken minutes ago, not for a race.
 */
export async function releaseCleanupLock(request, { org, repo, sha }) {
  const now = await readHolder(request, { org, repo });
  if (now.status === 404) return { ok: true, action: "absent" };
  if (!now.sha) return { ok: false, action: "unreadable", reason: `cannot read the lock (HTTP ${now.status})` };
  if (now.sha !== sha) {
    return { ok: false, action: "not-ours", reason: `the lock is held by ${now.holder ?? "an unreadable holder"} now - left in place` };
  }
  return deleteLock(request, { org, repo });
}

/** Remove the lock whoever holds it. A person's decision, never automatic. */
export async function breakCleanupLock(request, { org, repo }) {
  const was = await readHolder(request, { org, repo });
  const res = await deleteLock(request, { org, repo });
  return { ...res, holder: was.holder, since: was.since };
}

async function deleteLock(request, { org, repo }) {
  const res = await request("DELETE", REF_PATH(org, repo));
  if (res.ok) return { ok: true, action: "released" };
  // Measured: a ref that is already gone is 422 "Reference does not exist".
  if (res.status === 404 || (res.status === 422 && /does not exist/i.test(message(res)))) {
    return { ok: true, action: "absent" };
  }
  return { ok: false, action: "failed", reason: `cannot delete refs/${CLEANUP_LOCK_REF} (HTTP ${res.status})` };
}
