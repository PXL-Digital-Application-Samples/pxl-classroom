// Where a sign-in is kept between page loads, and how the tabs agree about it.
//
// It was sessionStorage, which is per TAB: every new tab, every link opened in a
// new tab and every browser restart asked for a fresh device code, and a
// lecturer reported copying the code "every time" (2026-09-17). It is now
// localStorage, for everyone, chosen over an opt-in checkbox. What that costs:
//
//   * The token stays on the computer until it expires (GitHub's 8 hours) or
//     somebody signs out. On a shared or lab computer the next person opening
//     the site is still signed in as you, until then.
//   * Sign out removes it from this browser and cannot revoke it at GitHub:
//     revoking a user token needs the App's client secret, which the SPA does
//     not have. github.com/settings/applications revokes it.
//   * Every page on this origin can read it. The origin is
//     <hub_owner>.github.io, shared by every Pages site in the hub org; checked
//     2026-09-17, the only other one redirects to its own domain.
//
// What it does NOT change: the token is never refreshed and never kept past
// its expiry. GitHub's refresh token is still discarded.
//
// Pure: the caller hands in the storages, so a Node test can run every branch.
// A storage that is missing or throws (blocked site data, some private modes)
// behaves as an empty one - signed out, never a blank page.

export const AUTH_KEY = 'pxl_auth'

function read(store) {
  try {
    return store ? store.getItem(AUTH_KEY) : null
  } catch {
    return null
  }
}

function remove(store) {
  try {
    store?.removeItem(AUTH_KEY)
  } catch {
    // Nothing to remove from a storage that cannot be used.
  }
}

function parse(raw) {
  if (typeof raw !== 'string' || !raw) return null
  try {
    const data = JSON.parse(raw)
    return typeof data?.access_token === 'string' && data.access_token ? data : null
  } catch {
    return null
  }
}

/**
 * The stored sign-in, if there is a live one.
 *
 * A tab signed in before the move to localStorage has its record in
 * sessionStorage; it is moved across once so the deploy signs nobody out. An
 * expired or unreadable record is removed rather than kept.
 *
 * @param {{ local: Storage|null, session: Storage|null }} stores
 * @returns {{ access_token: string, user: object, expires_at: string } | null}
 */
export function loadStoredAuth({ local, session }, now = new Date()) {
  let raw = read(local)
  if (raw === null) {
    const legacy = read(session)
    if (legacy !== null) {
      remove(session)
      if (parse(legacy)) {
        try {
          local?.setItem(AUTH_KEY, legacy)
        } catch {
          // Still usable for this page load, just not kept.
        }
      }
      raw = legacy
    }
  }
  if (raw === null) return null

  const data = parse(raw)
  const expires = data?.expires_at ? new Date(data.expires_at) : null
  if (!data || !expires || Number.isNaN(expires.getTime()) || expires <= now) {
    remove(local)
    return null
  }
  return data
}

/** Keep a sign-in. A storage that refuses leaves it in memory for this page only. */
export function saveStoredAuth({ local }, record) {
  try {
    local?.setItem(AUTH_KEY, JSON.stringify(record))
    return true
  } catch {
    return false
  }
}

/** Forget the sign-in in both places it has ever been kept. */
export function clearStoredAuth({ local, session }) {
  remove(local)
  remove(session)
}

/**
 * Did another tab sign in, sign out or switch account?
 *
 * A `storage` event only ever reaches the OTHER tabs, never the one that wrote.
 * `key: null` is `localStorage.clear()`. Rewriting the same token is not a
 * change, so a tab does not reload over its own sign-in.
 *
 * @returns {null | { signedIn: boolean, login: string|null }}
 */
export function authChangeFromOtherTab(event, tokenInThisTab) {
  if (!event || (event.key !== AUTH_KEY && event.key !== null)) return null
  const next = event.key === null ? null : parse(event.newValue)
  const nextToken = next?.access_token ?? null
  if (nextToken === (tokenInThisTab || null)) return null
  return { signedIn: nextToken !== null, login: typeof next?.user?.login === 'string' ? next.user.login : null }
}
