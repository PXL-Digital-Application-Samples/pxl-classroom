// The GitHub REST API version this system's own request helpers ask for.
//
// SPELLED ONCE. It was written eight times (the hub's request helper, the Git
// Data API writer, two preflight scripts, three places in the SPA's api.js,
// the live kit), and the CLI sent none at all - so the CLI got whatever
// GitHub's default was, and printed a deprecation warning for every issue it
// created. tests/github-api-version.test.mjs fails on any other copy.
//
// THE WORKFLOWS (2026-09-27): YAML cannot import this, so every step running
// `gh api` or `actions/github-script` spells it in its `env:` as
// GITHUB_API_VERSION - `gh api -H`, and a one-line hook as the script's first
// line - and tests/github-api-version.test.mjs holds each one equal to this.
// Changing the version is this file plus what that test then names.
//
// A workflow talks to GitHub through `gh api` and nothing else, because no
// other gh subcommand can send a header (the test refuses them). The one
// exception is `gh secret set`: REST takes a value already sealed to the
// repository's public key with libsodium, and that is not worth a crypto
// dependency around the broker App's private key.
//
// NOT EVERY REQUEST: the sign-in's own reads in frontend/src/lib/auth.js, a
// few one-off fetches, and `gh secret set` send no version and get GitHub's
// default (2022-11-28, supported until 2028-03-10).
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
