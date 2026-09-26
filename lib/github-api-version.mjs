// The GitHub REST API version every request from this system asks for.
//
// SPELLED ONCE. It was written eight times (the hub's request helper, the Git
// Data API writer, two preflight scripts, three places in the SPA's api.js,
// the live kit), and the CLI sent none at all - so the CLI got whatever
// GitHub's default was, and printed a deprecation warning for every issue it
// created. tests/github-api-version.test.mjs fails on any other copy.
//
// 2026-03-10 replaced 2022-11-28, which GitHub supports until 2028-03-10.
// Measured before the move (2026-09-26, 43 routes this project calls, under
// both versions): the same statuses everywhere; the fields that disappear -
// `assignee`, `merge_commit_sha`, `has_downloads`,
// `use_squash_pr_title_as_default`, `rate` on /rate_limit - are read nowhere;
// and a workflow dispatch answers 200 with the run's details instead of 204,
// which every caller accepts as success.
//
// ISOMORPHIC and dependency-free: the SPA imports it, and so can an entry point
// that runs with no `npm ci`.

export const GITHUB_API_VERSION = "2026-03-10";
