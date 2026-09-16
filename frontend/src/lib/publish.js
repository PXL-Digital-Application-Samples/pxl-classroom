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

/**
 * Which workflow saving a published assignment must dispatch. Never neither.
 *
 * "Nothing to do" when the broker was found was only true of the broker. The
 * student's page reads the card `pages/generate.mjs` writes, not the stored
 * document the hub enforces, so an edit saved with no dispatch reached the hub
 * at once and the page never. PXL-2TIN-NetAdv-26-27/net-advanced-guts-2627,
 * 2026-09-16: `require_claim` was ticked on a live assignment, the page kept
 * the old card and never showed the address field, and the hub refused the
 * lecturer's own acceptance six times as `rejected:no-claim`. Retrying could
 * not fix it: a rejection regenerates nothing.
 *
 * The publish workflow ends by dispatching the regeneration itself, so only one
 * is ever needed.
 *
 * @param {boolean|null|undefined} brokerExists
 * @returns {'publish-assignment.yml'|'regenerate-dashboard.yml'}
 */
export function publishedSaveWorkflow(brokerExists) {
  return needsBrokerDispatch(brokerExists) ? 'publish-assignment.yml' : 'regenerate-dashboard.yml'
}

/** The states `pages/generate.mjs` writes a student card for. */
const CARD_STATES = new Set(['published', 'closed'])

/**
 * Does a write that takes an assignment from `before` to `after` change a page
 * a student reads?
 *
 * Either side is enough. Into a card state, the card has to appear or change;
 * out of one, it has to go - a card left saying `published` offers an Accept
 * button the hub answers with `rejected:not-published`, and one left saying
 * `closed` tells a reopened cohort they are too late.
 */
export function writeReachesStudentPage(before, after) {
  return CARD_STATES.has(before) || CARD_STATES.has(after)
}
