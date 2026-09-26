// The GitHub REST API version this system's own request helpers ask for.
//
// SPELLED ONCE. It was written eight times (the hub's request helper, the Git
// Data API writer, two preflight scripts, three places in the SPA's api.js,
// the live kit), and the CLI sent none at all - so the CLI got whatever
// GitHub's default was, and printed a deprecation warning for every issue it
// created. tests/github-api-version.test.mjs fails on any other copy.
//
// NOT EVERY REQUEST (third review, 2026-09-26): the sign-in's own reads in
// frontend/src/lib/auth.js, a few one-off fetches, every `gh api` call and
// every `actions/github-script` step send no version and get GitHub's default
// (2022-11-28, supported until 2028-03-10). What this covers is the helpers
// the system's own reads and writes go through.
//
// 2026-03-10 replaced 2022-11-28 for those. Compared before the move
// (2026-09-26, by hand, the routes this project calls, under both versions -
// no probe in tests/live/ repeats it): the same statuses; the fields that
// disappear - `assignee`, `merge_commit_sha`, `has_downloads`,
// `use_squash_pr_title_as_default`, `rate` on /rate_limit - are read nowhere;
// and a workflow dispatch answers 200 with the run's details instead of 204,
// which every caller accepts as success.
//
// ISOMORPHIC and dependency-free: the SPA imports it, and so can an entry point
// that runs with no `npm ci`.

export const GITHUB_API_VERSION = "2026-03-10";
