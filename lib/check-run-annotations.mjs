// PXL Classroom - reading a check run's annotations.
//
// Transport-agnostic, the way `lib/gittree.mjs` is: callers hand in a
// `request(path)` returning `{ status, data }`, so the CLI (Octokit), the SPA
// (`ghApi`) and the workflow scripts (`lib/gh.mjs`) share one walk.
//
// It is a walk and not a single call because of the rule in CLAUDE.md: one
// page is not the list. This endpoint's default page size is 30 and it answers
// with a bare array - no Link header shape `ghAll` can key on - so a grader
// emitting a per-test annotation for every exercise plus the runner's own
// deprecation warnings scrolls the `Points X/Y` line off page one, and the
// score silently reads as "no score". `complete: false` is returned rather
// than a short answer dressed up as a whole one.

const PER_PAGE = 100;

// 500 annotations is far past any real autograding run; the cap exists so a
// malformed pager cannot loop forever, not as a budget anybody should hit.
const MAX_PAGES = 5;

/**
 * @param {(path: string) => Promise<{ status: number, data: any }>} request
 * @param {{ repoFullName: string, checkRunId: number|string }} opts
 * @returns {Promise<{ annotations: any[], complete: boolean, status: number }>}
 */
export async function fetchCheckRunAnnotations(request, { repoFullName, checkRunId }) {
  const annotations = [];

  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await request(
      `/repos/${repoFullName}/check-runs/${checkRunId}/annotations?per_page=${PER_PAGE}&page=${page}`,
    );

    if (!res || res.status < 200 || res.status >= 300) {
      // A failed page is not an empty page. Whatever was already read is still
      // returned - a partial answer is worth having - but never as a complete one.
      return { annotations, complete: false, status: res?.status ?? 0 };
    }

    const batch = Array.isArray(res.data) ? res.data : [];
    annotations.push(...batch);

    // A short page is the end of the list.
    if (batch.length < PER_PAGE) {
      return { annotations, complete: true, status: res.status };
    }
  }

  return { annotations, complete: false, status: 200 };
}
