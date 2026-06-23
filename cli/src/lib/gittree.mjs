// PXL Classroom CLI — gittree adapter.
//
// Wraps the root lib/gittree.mjs so commands pass an Octokit instance instead
// of { fetch, token }. The root module is HTTP-stack-agnostic (it accepts a
// request fn shaped like Octokit.request), so this wrapper is one line per
// export plus a userAgent default.

import * as root from "../../../lib/gittree.mjs";

function adapt(octokit) {
  return async (route, params) => {
    const r = await octokit.request(route, params);
    return { status: r.status, headers: r.headers, data: r.data };
  };
}

export function commitWithRebase(octokit, opts) {
  return root.commitWithRebase({ request: adapt(octokit), ...opts });
}

export function commitWithFreshRepoRetry(octokit, opts) {
  return root.commitWithFreshRepoRetry({ request: adapt(octokit), ...opts });
}

export { GittreeError } from "../../../lib/gittree.mjs";
