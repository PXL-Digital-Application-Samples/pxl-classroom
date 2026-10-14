// A student's submit tag: `refs/tags/submit/<declared time>-<short sha>`.
//
// THE TIME IS WRITTEN WITH DASHES (2026-10-14). Git refuses a colon in a ref
// name, so the documented `date -u +%Y-%m-%dT%H:%M:%SZ` made `git tag` fail
// with "not a valid tag name" for every student who ever tried, and no submit
// tag could have existed. `T14-05-00Z` is what a student can create;
// `declared_at` is still given as the ISO time. A colon is still accepted, for
// a ref some other tool wrote. The name sorts by time, so the latest tag is the
// greatest name.
//
// Lived in collect/collect.mjs, which runs on import, so nothing could test it.

const SUBMIT_TAG_RE = /^refs\/tags\/(submit\/(\d{4}-\d{2}-\d{2})T(\d{2})[-:](\d{2})[-:](\d{2})Z-[0-9a-f]{7,40})$/;

/**
 * @param {string} ref  a full ref name, `refs/tags/submit/...`
 * @returns {{ tag: string, declared_at: string } | null}
 */
export function parseSubmitTagRef(ref) {
  const m = SUBMIT_TAG_RE.exec(String(ref || ""));
  if (!m) return null;
  return { tag: m[1], declared_at: `${m[2]}T${m[3]}:${m[4]}:${m[5]}Z` };
}
