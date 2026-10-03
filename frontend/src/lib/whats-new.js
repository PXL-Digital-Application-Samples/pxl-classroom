// The one-time "New look" card on the Assignments page (WhatsNewCard.vue).
//
// Remembered in the browser, per browser - not per account, because per account
// would mean a file per lecturer in every course's control repository for a
// notice read once. Beta and the live app share an origin, so they share this
// memory, and nobody sees it twice when beta becomes the live app.
//
// On beta it is remembered for the browser session only (decided 2026-10-03):
// there it is fine to show it on every visit, and it must not use up the one
// showing a lecturer gets on the live app.
//
// A storage that cannot be read or written (private mode, blocked site data)
// shows the card again rather than throwing: a notice seen twice costs nothing.

const KEY = 'pxl_seen_new_look'
// Bumped for a later notice, so it is shown once too.
export const WHATS_NEW_VERSION = '2026-10-new-look'

/** Which storage remembers it: the session on beta, the browser elsewhere. */
export function whatsNewStorage(channel, win = globalThis.window) {
  try {
    return channel === 'beta' ? win?.sessionStorage : win?.localStorage
  } catch {
    return null
  }
}

/** Has this browser already dismissed this notice? */
export function whatsNewSeen(storage) {
  try {
    return storage?.getItem(KEY) === WHATS_NEW_VERSION
  } catch {
    return false
  }
}

/** Remember that it was dismissed. Best effort. */
export function markWhatsNewSeen(storage) {
  try {
    storage?.setItem(KEY, WHATS_NEW_VERSION)
  } catch {
    // Not remembered: it shows again next time, which is the safe direction.
  }
}
