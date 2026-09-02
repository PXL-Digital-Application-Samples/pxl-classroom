// Which help topic is open, if any.
//
// One module-level ref rather than a prop chain: a help button can sit anywhere
// - inside a form, a table row, a modal - and the drawer it opens is rendered
// once at the top of App.vue. That placement is deliberate and load-bearing. The
// drawer is `position: fixed`, and ANY ancestor carrying `transform`, `filter`,
// `perspective`, `will-change` or `contain` becomes its containing block, which
// puts a fixed overlay wherever that ancestor happens to be rather than over the
// viewport. Rendering it beside `<router-view>` keeps it out from under every
// animated wrapper in the app.
//
// Nothing here throws at module scope, and nothing imports a `node:` builtin -
// this file is in the SPA's graph.

import { ref, readonly } from 'vue'
import manual from '../generated/manual.json'
import { MANUAL_TOPICS } from '../../../lib/manual-topics.mjs'

const current = ref(null)

/** The manual, as parsed at build time by scripts/build-manual.mjs. */
export const MANUAL = manual

/** Topic id -> topic, for the drawer's lookup. */
const BY_ID = new Map(manual.topics.map((t) => [t.id, t]))

/** The open topic id, or null. */
export const openTopic = readonly(current)

/**
 * Open the drawer on a topic.
 *
 * An unknown id opens nothing rather than an empty drawer: a drawer with no
 * content reads as "there is no help for this", which is a worse answer than
 * the button appearing not to work, and the guard in
 * tests/manual-topics.test.mjs is what stops it happening at all.
 *
 * @param {string} id
 */
export function openHelp(id) {
  if (!BY_ID.has(id)) return false
  current.value = id
  return true
}

export function closeHelp() {
  current.value = null
}

/** @param {string} id */
export function topicById(id) {
  return BY_ID.get(id) ?? null
}

/** Every topic id the manual actually shipped with. */
export const SHIPPED_TOPICS = manual.topics.map((t) => t.id)

/** Re-exported so a component can assert against the registry without a deep path. */
export { MANUAL_TOPICS }
