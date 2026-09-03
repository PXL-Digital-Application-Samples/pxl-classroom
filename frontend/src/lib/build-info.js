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
