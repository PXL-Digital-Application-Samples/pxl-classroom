// PXL Classroom CLI - check-run annotations adapter.
//
// Wraps the root lib/check-run-annotations.mjs so commands pass an Octokit
// instance instead of a request fn, exactly as `cli/src/lib/gittree.mjs` does.
// Octokit throws on a non-2xx response where the shared walk expects a status,
// so the catch translates rather than swallowing: a 403 or 404 comes back as
// `complete: false` and the caller reports "score unread", never "no score".

import { fetchCheckRunAnnotations as root } from "../../../lib/check-run-annotations.mjs";

export function fetchCheckRunAnnotations(octokit, opts) {
  const request = async (path) => {
    try {
      const r = await octokit.request(`GET ${path}`);
      return { status: r.status, data: r.data };
    } catch (err) {
      return { status: err?.status ?? 0, data: null };
    }
  };
  return root(request, opts);
}
