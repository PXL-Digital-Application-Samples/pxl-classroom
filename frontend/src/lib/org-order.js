// The order of the organization switcher.
//
// It was the order GitHub returned the App's installations in, which is
// install order: a lecturer's live course could sit below last year's empty
// ones. Asked for 2026-09-17: lit lamps first - green (an assignment open now),
// then amber (assignments, none open) - then everything unlit, and A-Z inside
// each group.
//
// "Unlit" is every other state on purpose: an empty org, one this account is
// not staff on, and one whose status has not loaded yet all draw a hollow or
// faint lamp, and the order follows what the reader can see.

const LIT_RANK = Object.freeze({ active: 0, inactive: 1 })
const UNLIT_RANK = 2

/** The group a lamp status sorts into. */
export function lampRank(status) {
  return LIT_RANK[status] ?? UNLIT_RANK
}

/**
 * Organizations in switcher order. Returns a new array; the input is untouched.
 *
 * @param {{ login: string }[]} orgs
 * @param {(login: string) => number} rankOf usually `(login) => lampRank(statusOf(login))`
 */
export function orderOrgsForSwitcher(orgs, rankOf) {
  return [...(orgs || [])].sort(
    (a, b) =>
      rankOf(a.login) - rankOf(b.login) ||
      String(a.login).localeCompare(String(b.login), 'en', { sensitivity: 'base' }),
  )
}
