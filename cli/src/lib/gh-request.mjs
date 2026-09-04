// PXL Classroom CLI - one Octokit -> `request(path)` adapter.
//
// The shared walks in `lib/` are transport-agnostic: they take a function that
// answers `{ status, data }` and never throws, because a failed page has to be
// distinguishable from an empty one. Octokit does the opposite - it throws on
// any non-2xx - so something has to translate, and this is the one place that
// does it. `check-run-annotations.mjs` held the only copy until a second walk
// needed the same three lines.

/**
 * @param {{ request: (route: string) => Promise<{status: number, data: any}> }} octokit
 * @returns {(path: string) => Promise<{ status: number, data: any }>}
 */
export function toRequest(octokit) {
  return async (path) => {
    try {
      const r = await octokit.request(`GET ${path}`);
      return { status: r.status, data: r.data };
    } catch (err) {
      // The status, not a throw: the caller reports "could not read", never
      // "there was nothing there".
      return { status: err?.status ?? 0, data: null };
    }
  };
}
