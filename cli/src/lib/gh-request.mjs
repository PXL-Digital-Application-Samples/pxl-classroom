// PXL Classroom CLI - one Octokit -> `request(path)` adapter.
//
// The shared walks in `lib/` are transport-agnostic: they take a function that
// answers `{ status, data }` and never throws, because a failed page has to be
// distinguishable from an empty one. Octokit does the opposite - it throws on
// any non-2xx - so something has to translate, and this is the one place that
// does it.

/**
 * @param {{ request: (route: string) => Promise<{status: number, data: any}> }} octokit
 * @returns {(path: string) => Promise<{ status: number, data: any }>}
 */
export function toRequest(octokit) {
  return async (path) => {
    try {
      const r = await octokit.request(`GET ${path}`);
      // Headers too: a walk that finds the LAST page reads the `link` header,
      // and without it "the first commit" silently becomes the newest one.
      return { status: r.status, data: r.data, headers: r.headers ?? {} };
    } catch (err) {
      // The status, not a throw: the caller reports "could not read", never
      // "there was nothing there". With GitHub's answer and its headers: a
      // rate limit is a 403 too, told apart only by its message or
      // `x-ratelimit-remaining` (lib/grade-dispatch.mjs `isRateLimited`), and
      // dropping both made every one read as a missing permission (P2-5).
      return { status: err?.status ?? 0, data: err?.response?.data ?? null, headers: err?.response?.headers ?? {} };
    }
  };
}
