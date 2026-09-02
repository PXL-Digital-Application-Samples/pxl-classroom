// When saving a published assignment must also dispatch the publish workflow.
//
// Extracted from AdminView because a decision written inline inside a click
// handler is a decision no test can run - it can only be grepped for, and a
// guard that greps for a branch cannot tell whether the branch is reachable or
// what it returns.
//
// The subject is `brokerExists`, which has THREE states, and the whole bug was
// reading it as two:
//
//   true   the broker was found. Nothing to do.
//   false  it was looked for and is not there. Dispatch.
//   null   NOBODY HAS LOOKED YET. Dispatch.
//
// `null` is the state the panel is in from the moment it opens until
// verifyLiveInfrastructure() resolves, and the old test - `=== false` - read it
// as "fine". Saving inside that window dispatched nothing, and said nothing.
//
// Fails toward doing the work: the only state that skips the dispatch is a
// positive sighting of the broker. Publishing again where one already exists is
// supported (it is what Republish broker does) and costs one redundant workflow
// run. Skipping wrongly costs an assignment that claims to be published and
// that no student can accept - and nothing surfaces it until somebody reopens
// the panel and reads the banner.

/**
 * @param {boolean|null|undefined} brokerExists
 * @returns {boolean} whether Save must also dispatch publish-assignment.yml
 */
export function needsBrokerDispatch(brokerExists) {
  return brokerExists !== true
}
