// What is actually running, so a bug report can name it.
//
// Nothing identified the deployed build before this. Answering "which version
// were you on when that happened" meant listing deploy-frontend runs, reading
// headSha off each one and matching deploy times against a commit - three API
// calls, available only to somebody with the repository open. A lecturer
// reporting a problem could not answer it at all.
//
// BOTH halves are here on purpose. The version is what you say out loud; the
// SHA is what settles it, because a version can be ambiguous in ways a commit
// hash cannot - an unreleased commit, a tag that moved, a browser holding a
// stale bundle that still reports a plausible number.
//
// Injected at build time by deploy-frontend.yml. In development neither exists,
// and that is reported as `dev` rather than guessed at: a made-up version is
// worse than an obviously absent one.

import { HUB_REPO } from './deployment.js'

const rawSha = import.meta.env.VITE_BUILD_SHA || ''
const rawVersion = import.meta.env.VITE_BUILD_VERSION || ''

/** Full commit SHA of the deployed build, or '' outside a real build. */
export const BUILD_SHA = rawSha

/** Seven characters, which is what a human compares and what git accepts. */
export const BUILD_SHORT_SHA = rawSha ? rawSha.slice(0, 7) : ''

/** The release tag this was built from, or 'dev'. */
export const BUILD_VERSION = rawVersion || 'dev'

/**
 * What to show: `v1.4.0 (9fb7639)`, or as much of it as exists.
 *
 * Degrades rather than lying. A build with a SHA and no tag says `(9fb7639)`,
 * which is still enough to find the code; a local dev build says `dev`.
 */
export const BUILD_LABEL = [
  rawVersion || (rawSha ? '' : 'dev'),
  BUILD_SHORT_SHA ? `(${BUILD_SHORT_SHA})` : '',
]
  .filter(Boolean)
  .join(' ');

/** Where that commit lives, or null when there is nothing to link to. */
export const BUILD_COMMIT_URL = rawSha
  ? `https://github.com/${HUB_REPO}/commit/${rawSha}`
  : null

/**
 * The release this was built from, or null before the first one.
 *
 * `rawVersion` is whatever `git describe --tags --abbrev=0` returned, which is
 * the tag verbatim - `v1.0.0` - and `tagFormat` in .releaserc.json is what
 * makes that also the release's own name. Nothing reformats it here: a tag and
 * the release page named after it are one string, and rebuilding it from parts
 * is how a link comes to 404 on a tag somebody spelled differently.
 */
export const BUILD_RELEASE_URL = rawVersion
  ? `https://github.com/${HUB_REPO}/releases/tag/${rawVersion}`
  : null

/**
 * What the header actually links to: the release when there is one, the commit
 * when there is not.
 *
 * The release is what a person asking "what changed" wants - notes, a date, a
 * name. The commit is what SETTLES it, and it is still on screen beside the
 * version and still where this points before the first release, or on any build
 * made between a tag and the deploy that picks it up.
 */
export const BUILD_LINK_URL = BUILD_RELEASE_URL || BUILD_COMMIT_URL
