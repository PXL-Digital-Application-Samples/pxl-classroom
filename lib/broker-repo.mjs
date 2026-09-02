// Where an assignment's acceptance broker lives.
//
// One rule, in one place, for the same reason lib/archive-repo.mjs exists: the
// name was being rebuilt by hand at eight call sites, and one of them had
// already drifted. `AdminView.vue` rendered `broker-${id}` with no `||
// broker_repo` at all, so an assignment carrying a custom broker name displayed
// somebody else's.
//
// The fallback is not cosmetic. `broker_repo` is what the assignment document
// says its broker IS; `broker-<id>` is only where a new one GOES. Reading the
// recorded value first is what keeps an existing assignment resolvable after
// the default naming changes - the same distinction archive-repo.mjs draws
// between resolving one that exists and naming one that does not yet.

/**
 * The broker repository name for an assignment.
 *
 * Returns null rather than a guess when there is nothing to build one from: a
 * caller with no id has no business rendering `broker-undefined`, and a link to
 * it is a 404 the user discovers by clicking.
 *
 * @param {{assignment?: {broker_repo?: string, id?: string}|null, assignmentId?: string|null}} args
 * @returns {string|null}
 */
export function brokerRepoName({ assignment = null, assignmentId = null } = {}) {
  const recorded = typeof assignment?.broker_repo === "string" ? assignment.broker_repo.trim() : "";
  if (recorded) return recorded;

  const id = String(assignmentId ?? assignment?.id ?? "").trim();
  return id ? `broker-${id}` : null;
}
