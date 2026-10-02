// The control repository's "Instructor Notifications" issue, read whole.
//
// Every workflow that needs a lecturer posts a comment there (notify/notify.mjs).
// The assignment page reads it for the students turned away; the Organization
// page reads it for what needs the lecturer (lib/org-notices.mjs). One walk, so
// the two cannot read different parts of it.
//
// ONE PAGE IS NOT THE LIST, and GitHub returns issue comments OLDEST first, so
// the first page of a long-lived tracking issue is the oldest hundred - exactly
// the ones least likely to matter now. It is walked, and a capped walk is
// reported as unreadable rather than complete.

import { ghApi } from './api.js'
import { TRACKING_LABEL } from '../../../lib/rejection-notice.mjs'

const MAX_PAGES = 10

/**
 * @param {string} token
 * @param {{org: string, controlRepo: string}} where
 * @returns {Promise<{state: 'ok', issueUrl: string|null, comments: object[]}
 *                  |{state: 'none'}|{state: 'no-repo'}
 *                  |{state: 'unreadable', status?: number, issueUrl?: string|null}>}
 *   `none` is a real answer: nothing has ever been notified in this
 *   organization. `no-repo` is a 404 on the issues endpoint - no control
 *   repository this account can read, which the page reports elsewhere.
 *   `unreadable` keeps the issue's link when it got that far, so the page can
 *   still send a lecturer to read it on GitHub.
 */
export async function readTrackingIssue(token, { org, controlRepo }) {
  const found = await ghApi(token, 'GET', `/repos/${org}/${controlRepo}/issues?labels=${TRACKING_LABEL}&state=open&per_page=1`)
  if (!found.ok) return found.status === 404 ? { state: 'no-repo' } : { state: 'unreadable', status: found.status }
  const issue = Array.isArray(found.data) ? found.data[0] : null
  if (!issue) return { state: 'none' }
  const issueUrl = issue.html_url || null
  const comments = []
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await ghApi(token, 'GET', `/repos/${org}/${controlRepo}/issues/${issue.number}/comments?per_page=100&page=${page}`)
    if (!res.ok) return { state: 'unreadable', status: res.status, issueUrl }
    const batch = Array.isArray(res.data) ? res.data : []
    comments.push(...batch)
    if (batch.length < 100) return { state: 'ok', issueUrl, comments }
  }
  return { state: 'unreadable', issueUrl }
}
