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

/** Record the title the assignment page read. An empty title records nothing. */
export function rememberAssignmentTitle(org, id, title) {
  const t = typeof title === 'string' ? title.trim() : ''
  if (!org || !id || !t) return
  titles.set(key(org, id), t)
}

/** The title read for this assignment, or '' when none has been read yet. */
export function assignmentTitle(org, id) {
  return titles.get(key(org, id)) || ''
}
