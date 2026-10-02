// Which copy of the app is running, and where the real one lives.
//
// deploy-frontend.yml publishes the production app at the site root and, when a
// `beta` branch exists, a second build of that branch under `beta/` on the SAME
// origin - so a lecturer testing it stays signed in, and writes to the same
// organizations. That is the point of it, and it is also why anything the beta
// HANDS OUT must not carry `beta/`: an invitation link copied from the beta
// would put a whole cohort on an unreleased app, and keep them there after the
// branch is gone.
//
// Functions, not constants: invite.js is imported by node:test, where
// `import.meta.env` does not exist, and a read at module scope would throw on
// import. Nothing here is evaluated until a browser asks.

/** `beta` in the beta build, '' in production and in development. */
export function buildChannel() {
  return import.meta.env.VITE_BUILD_CHANNEL || ''
}

/**
 * The production app's base path, for every link a person is given to keep or
 * pass on. The beta build sets VITE_PUBLIC_BASE_URL to the production base;
 * production has no need to, because there the two are the same.
 */
export function publicBaseUrl() {
  return import.meta.env.VITE_PUBLIC_BASE_URL || import.meta.env.BASE_URL
}
