// The title of the assignment the page below the org bar has read, for the
// bar's breadcrumb (OrgShell.vue).
//
// The bar is drawn once for every page of an organization and knows only the
// route, so the crumb said the slug - `teams-ux-demo` - where a lecturer
// named the assignment "Teams UX demo" (DESIGN.md §1.6). The assignment page
// reads the document anyway; it tells this module what it read, and the bar
// shows that. Until it has, the bar shows the slug: the one name it does know.

import { reactive } from 'vue'

const titles = reactive(new Map())
const key = (org, id) => `${String(org).toLowerCase()}/${id}`

export const APP_NAME = 'PXL Classroom'

/**
 * What the browser tab says on an assignment: its title once read, its slug
 * until then. The router sets it on every navigation (router/index.js), before
 * the page has read anything - so the first visit says the slug, and
 * rememberAssignmentTitle puts the title in its place once it is known.
 */
export function assignmentDocumentTitle(org, id) {
  return `${assignmentTitle(org, id) || id} - ${org} · ${APP_NAME}`
}

/** Record the title the assignment page read. An empty title records nothing. */
export function rememberAssignmentTitle(org, id, title) {
  const t = typeof title === 'string' ? title.trim() : ''
  if (!org || !id || !t) return
  const before = assignmentDocumentTitle(org, id)
  titles.set(key(org, id), t)
  // Only the tab that still names THIS assignment by its slug: a title read
  // late must not rename a tab that has moved on to another page.
  if (typeof document !== 'undefined' && document.title === before) {
    document.title = assignmentDocumentTitle(org, id)
  }
}

/** The title read for this assignment, or '' when none has been read yet. */
export function assignmentTitle(org, id) {
  return titles.get(key(org, id)) || ''
}
