// PXL Classroom — GitHub API client.
//
// Thin wrapper around fetch() for GitHub API calls. Uses the authenticated
// user's own token — never a privileged credential.

import { clearAuth } from './auth.js'
import { toast } from './toast.js'

const API_BASE = 'https://api.github.com'

// A 401 from api.github.com with a token attached means the token is dead
// (the device-flow tokens live 8h). Handle it once, centrally: clear the
// stale auth, tell the user plainly, and reload into the signed-out state of
// the current route — instead of every view rendering a misleading empty
// state while errors pile up in the console.
let sessionExpiredNotified = false
function handleSessionExpiry() {
  if (sessionExpiredNotified) return
  sessionExpiredNotified = true
  clearAuth()
  toast.error('Your session expired. Sign in again.')
  setTimeout(() => window.location.reload(), 1800)
}

/**
 * Make an authenticated GitHub API call.
 */
export async function ghApi(token, method, path, body = null) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })

  if (res.status === 401 && token) handleSessionExpiry()

  const text = await res.text()
  let data = null
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = { raw: text }
    }
  }

  return { status: res.status, ok: res.ok, data, headers: res.headers }
}

/**
 * Read the total page count from a GitHub Link header. Used together with
 * per_page=1 to derive a total without a second API call.
 *
 * GitHub omits the Link header when the response fits on one page, so this
 * falls back to the item count from the body for 0/1-item cases.
 */
export function totalFromLinkHeader(headers, fallbackArray) {
  const link = headers?.get?.('link')
  if (link) {
    const m = link.match(/<[^>]*[?&]page=(\d+)[^>]*>;\s*rel="last"/)
    if (m) return parseInt(m[1], 10)
  }
  return Array.isArray(fallbackArray) ? fallbackArray.length : 0
}

// --- Student-facing API calls -----------------------------------------------

/**
 * Star a repository (acceptance trigger).
 */
export async function starRepo(token, owner, repo) {
  return ghApi(token, 'PUT', `/user/starred/${owner}/${repo}`)
}

/**
 * Unstar a repository. Used by the retry path so that a subsequent star
 * re-fires the broker's watch:started event.
 */
export async function unstarRepo(token, owner, repo) {
  return ghApi(token, 'DELETE', `/user/starred/${owner}/${repo}`)
}

/**
 * Check if the user has starred a repo.
 */
export async function isStarred(token, owner, repo) {
  const res = await ghApi(token, 'GET', `/user/starred/${owner}/${repo}`)
  return res.status === 204
}

/**
 * Check if a repo exists and is accessible to the user.
 */
export async function getRepo(token, owner, repo) {
  return ghApi(token, 'GET', `/repos/${owner}/${repo}`)
}

/**
 * Get pending repository invitations for the user.
 */
export async function getInvitations(token) {
  return ghApi(token, 'GET', '/user/repository_invitations')
}

/**
 * Accept a repository invitation.
 */
export async function acceptInvitation(token, invitationId) {
  return ghApi(token, 'PATCH', `/user/repository_invitations/${invitationId}`)
}

// --- Lecturer-facing API calls ----------------------------------------------

/**
 * Get the user's App installations (to find orgs where the App is installed).
 */
export async function getInstallations(token) {
  return ghApi(token, 'GET', '/user/installations')
}

/**
 * Get the repos accessible to an installation.
 */
export async function getInstallationRepos(token, installationId) {
  return ghApi(token, 'GET', `/user/installations/${installationId}/repositories`)
}

/**
 * Read a file from a repo (for fetching control repo data at runtime).
 * Throws on 401 (caller can prompt re-auth); returns null for 404 and other
 * non-success statuses (caller treats as "no file").
 */
export async function getRepoContent(token, owner, repo, path) {
  const res = await ghApi(token, 'GET', `/repos/${owner}/${repo}/contents/${path}`)
  if (res.status === 401) {
    const e = new Error('Unauthorized')
    e.status = 401
    throw e
  }
  if (res.status === 404) return null
  if (!res.ok) {
    const e = new Error(res.data?.message || `Failed to read file (HTTP ${res.status})`)
    e.status = res.status
    throw e
  }

  if (res.data?.content) {
    try {
      const bin = atob(res.data.content.replace(/\n/g, ''))
      return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)))
    } catch {
      return null
    }
  }
  return null
}

/**
 * List files in a directory of a repo.
 */
export async function listRepoDir(token, owner, repo, path) {
  const res = await ghApi(token, 'GET', `/repos/${owner}/${repo}/contents/${path}`)
  if (!res.ok) {
    const err = new Error(res.data?.message || `Failed to list repo directory (HTTP ${res.status})`)
    err.status = res.status
    throw err
  }
  if (!Array.isArray(res.data)) {
    throw new Error('Expected directory contents array')
  }
  return res.data.map((f) => ({ name: f.name, path: f.path, type: f.type }))
}

/**
 * Get the user's organizations.
 */
export async function getUserOrgs(token) {
  return ghApi(token, 'GET', '/user/orgs')
}

/**
 * Check if the user is an owner of an org.
 */
export async function getOrgMembership(token, org) {
  return ghApi(token, 'GET', `/user/memberships/orgs/${org}`)
}

/**
 * Create or update a file in a repository.
 */
export async function commitFile(token, owner, repo, path, contentStr, message) {
  const getRes = await ghApi(token, 'GET', `/repos/${owner}/${repo}/contents/${path}`)
  let sha = undefined
  if (getRes.ok && getRes.data?.sha) {
    sha = getRes.data.sha
  }

  // Base64 encode unicode properly
  const base64Content = btoa(unescape(encodeURIComponent(contentStr)))

  const body = { message, content: base64Content }
  if (sha) body.sha = sha

  return ghApi(token, 'PUT', `/repos/${owner}/${repo}/contents/${path}`, body)
}

/**
 * Delete a file from a repository. Returns { ok: false } when the file
 * doesn't exist (nothing to delete).
 */
export async function deleteFile(token, owner, repo, path, message) {
  const getRes = await ghApi(token, 'GET', `/repos/${owner}/${repo}/contents/${path}`)
  if (!getRes.ok || !getRes.data?.sha) return { ok: false, status: getRes.status, data: getRes.data }
  return ghApi(token, 'DELETE', `/repos/${owner}/${repo}/contents/${path}`, {
    message,
    sha: getRes.data.sha,
  })
}

/**
 * Trigger a GitHub Action workflow via workflow_dispatch.
 */
export async function triggerWorkflow(token, owner, repo, workflowId, inputs = null, ref = 'main') {
  const body = { ref }
  if (inputs) body.inputs = inputs
  return ghApi(token, 'POST', `/repos/${owner}/${repo}/actions/workflows/${workflowId}/dispatches`, body)
}

/**
 * Format a workflow_dispatch failure for the toast. Prefers GitHub's own
 * message because 403/404 almost never means "user has no access" — for a
 * hub collaborator it usually means the App's user-to-server token lacks
 * actions:write, or the workflow file isn't on the dispatched ref. The
 * old canned "ask a hub admin to add you as a collaborator" hid this.
 */
export function explainDispatchFailure(res, fallback) {
  const msg = res.data?.message
  if (msg === 'Resource not accessible by integration') {
    return `${fallback}: the GitHub App's user-to-server token doesn't have actions:write. A hub admin needs to add that permission to the App and have each participating org re-approve it.`
  }
  if (res.status === 404) {
    return `${fallback}: workflow not found. Check that the workflow file exists on the default branch of the hub repo, and that you can see the repo.`
  }
  if (res.status === 403) {
    return `${fallback} (403): ${msg || 'forbidden'}. Most often: the App needs actions:write, or you're not a collaborator on the hub repo with write access.`
  }
  return `${fallback}: ${msg || `HTTP ${res.status}`}`
}

/**
 * List repos in an org. With a prefix, uses the Search API (single bounded
 * query — works regardless of org size). Without one, paginates the org repos
 * endpoint via Link rel="next".
 */
export async function listOrgRepos(token, org, prefix = '') {
  if (prefix) {
    const q = encodeURIComponent(`org:${org} ${prefix} in:name`)
    const res = await ghApi(token, 'GET', `/search/repositories?q=${q}&per_page=100`)
    if (!res.ok) return []
    return (res.data?.items || []).filter((r) => r.name.startsWith(prefix))
  }

  const out = []
  let url = `/orgs/${org}/repos?per_page=100&sort=full_name`
  while (url) {
    const res = await fetch(`${API_BASE}${url}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    })
    if (!res.ok) break
    const data = await res.json()
    if (Array.isArray(data)) out.push(...data)
    const link = res.headers.get('link') || ''
    const next = link.split(',').find((p) => /rel="next"/.test(p))
    const m = next && next.match(/<([^>]+)>/)
    url = m ? m[1].replace(API_BASE, '') : null
  }
  return out
}

/**
 * List all template repositories in an org using search with rest fallback.
 */
export async function listOrgTemplates(token, org) {
  try {
    const q = encodeURIComponent(`org:${org} is:template`)
    const res = await ghApi(token, 'GET', `/search/repositories?q=${q}&per_page=100`)
    if (res.ok) {
      return res.data?.items || []
    }
  } catch (e) {
    console.error('Search templates failed, falling back to listOrgRepos', e)
  }

  // Fallback: list all org repos and filter client-side
  const repos = await listOrgRepos(token, org)
  return repos.filter((r) => r.is_template)
}
