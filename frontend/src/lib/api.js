// PXL Classroom - GitHub API client.
//
// Thin wrapper around fetch() for GitHub API calls. Uses the authenticated
// user's own token - never a privileged credential.

import { clearAuth } from './auth.js'
import { READ_TIMEOUT_MS, fetchWithTimeout } from './http.js'
import { toast } from './toast.js'
import { commitWithRebase } from '../../../lib/gittree.mjs'

const API_BASE = 'https://api.github.com'

// A 401 from api.github.com with a token attached means the token is dead
// (the device-flow tokens live 8h). Handle it once, centrally: clear the
// stale auth, tell the user plainly, and reload into the signed-out state of
// the current route - instead of every view rendering a misleading empty
// state while errors pile up in the console.
let sessionExpiredNotified = false
function handleSessionExpiry() {
  if (sessionExpiredNotified) return
  sessionExpiredNotified = true
  clearAuth()
  toast.error('Your session expired. Sign in again.')
  if (window.pxlHasUnsavedState && window.pxlHasUnsavedState()) {
    return
  }
  setTimeout(() => window.location.reload(), 1800)
}

export { READ_TIMEOUT_MS }

/**
 * Make an authenticated GitHub API call.
 *
 * TIMEOUTS APPLY TO READS ONLY.
 *
 * Aborting a fetch stops us waiting; it does NOT cancel the request at GitHub.
 * A timed-out write therefore leaves us unable to say whether it took effect,
 * and reporting failure for a call that actually succeeded is worse than
 * waiting: retrying can create a second commit, a second PR, or - via
 * triggerWorkflow - a second Actions run, which the minimal-minutes design
 * exists to avoid. Reads have no such hazard; repeating one is free.
 *
 * A write may opt in with `options.timeoutMs`, but only where the endpoint is
 * genuinely idempotent, and the caller has to say so deliberately.
 *
 * @param {object} [options]
 * @param {number} [options.timeoutMs] override; 0 waits indefinitely
 * @param {AbortSignal} [options.signal] caller cancellation
 */
export async function ghApi(token, method, path, body = null, options = {}) {
  const timeoutMs = options.timeoutMs ?? (method === 'GET' ? READ_TIMEOUT_MS : 0)

  const res = await fetchWithTimeout(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    ...(method === 'GET' ? { cache: 'no-store' } : {}),
  }, { timeoutMs, signal: options.signal })

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
 * Add a collaborator to a repository with specific permission (e.g. admin, pull, push).
 */
export async function addCollaborator(token, owner, repo, username, permission = 'admin') {
  return ghApi(token, 'PUT', `/repos/${owner}/${repo}/collaborators/${username}`, { permission })
}

/**
 * Remove a collaborator from a repository and cancel any pending invitations.
 */
export async function removeCollaborator(token, owner, repo, username) {
  const res = await ghApi(token, 'DELETE', `/repos/${owner}/${repo}/collaborators/${username}`)
  try {
    const invRes = await ghApi(token, 'GET', `/repos/${owner}/${repo}/invitations`)
    if (invRes.ok && Array.isArray(invRes.data)) {
      const pending = invRes.data.find((inv) => inv.invitee?.login?.toLowerCase() === username.toLowerCase())
      if (pending) {
        await ghApi(token, 'DELETE', `/repos/${owner}/${repo}/invitations/${pending.id}`)
      }
    }
  } catch {
    // non-critical
  }
  return res
}

/**
 * Check if a repo exists and is accessible to the user.
 */
export async function getRepo(token, owner, repo) {
  return ghApi(token, 'GET', `/repos/${owner}/${repo}`)
}

/**
 * Get pending repository invitations for the user.
 *
 * Paginated, and that is not theoretical. The default page size is **30**, and
 * a student who has accepted assignments across several courses without ever
 * accepting the repository invitations accumulates them - so theirs could sit
 * on page two and the acceptance page would poll for three minutes without
 * finding it.
 *
 * It matters more since the waiting screen started trusting this call: an
 * answer that omits the student's invitation reads as "there is no invitation"
 * and the timeout state then tells them setup failed, which is the opposite of
 * what happened. A truncated success is worse here than an error would be.
 */
export async function getInvitations(token) {
  const merged = []
  let path = '/user/repository_invitations?per_page=100'
  let last = null
  const seen = new Set()
  // A student is not in 2,000 pending invitations; the cap only stops a
  // malformed or self-referential Link header spinning forever.
  const MAX_PAGES = 20

  for (let page = 0; path && page < MAX_PAGES; page++) {
    if (seen.has(path)) break
    seen.add(path)
    const res = await ghApi(token, 'GET', path)
    if (!res.ok) return res
    last = res
    merged.push(...(Array.isArray(res.data) ? res.data : []))

    const link = res.headers?.get?.('link') || ''
    const next = link.split(',').find((p) => /rel="next"/.test(p))
    const m = next && next.match(/<([^>]+)>/)
    path = m ? m[1].replace('https://api.github.com', '') : null
  }

  return { ...last, data: merged }
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
 *
 * Paginated, and it must be: the default per_page is 30, and this endpoint
 * silently returns only the first page. An org past the cut-off simply stops
 * appearing in the org switcher - no error, no empty state, it is just gone.
 * PXL onboards course orgs per academic year, so 30 is a matter of time.
 *
 * The response is an OBJECT ({ total_count, installations }), not a bare array,
 * so pages are merged on the inner list rather than concatenated wholesale.
 */
export async function getInstallations(token) {
  const merged = []
  let path = '/user/installations?per_page=100'
  let last = null
  const seen = new Set()
  // 100 per page; nobody is in 5000 installations. The cap exists so a
  // malformed or self-referential Link header cannot spin forever.
  const MAX_PAGES = 50

  for (let page = 0; path && page < MAX_PAGES; page++) {
    if (seen.has(path)) break
    seen.add(path)
    const res = await ghApi(token, 'GET', path)
    if (!res.ok) return res
    last = res
    merged.push(...(res.data?.installations || []))

    const link = res.headers?.get?.('link') || ''
    const next = link.split(',').find((p) => /rel="next"/.test(p))
    const m = next && next.match(/<([^>]+)>/)
    path = m ? m[1].replace('https://api.github.com', '') : null
  }

  return { ...last, data: { total_count: merged.length, installations: merged } }
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

  // Above 1 MB the Contents API answers 200 with `content: ""` and
  // `encoding: "none"` rather than an error, so this returned null and every
  // caller read that as "file not found" - a large reports/dashboard.json or a
  // roster for a big cohort would have looked absent instead of failing. The
  // raw media type has no such limit below 100 MB.
  if (res.data && res.data.encoding === 'none') {
    const raw = await fetchWithTimeout(
      `${API_BASE}/repos/${owner}/${repo}/contents/${path}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github.raw',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        cache: 'no-store',
      },
      { timeoutMs: READ_TIMEOUT_MS },
    )
    if (raw.ok) return raw.text()
    const e = new Error(`${path} is too large for the contents API, and the raw read failed (HTTP ${raw.status})`)
    e.status = raw.status
    throw e
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
 * Commit several files in a SINGLE commit via the Git Data API.
 *
 * Seeding 33 teams through commitFile() would be 33 commits and 66 writes
 * against a ~80/min secondary rate limit; this is one commit and one history
 * entry the lecturer can revert in one click.
 */
export async function commitFiles(token, owner, repo, changes, message, { branch = 'main', signal } = {}) {
  try {
    const res = await commitWithRebase({ token, owner, repo, branch, message, changes, signal })
    return { ok: true, commitSha: res.commitSha, attempts: res.attempts }
  } catch (e) {
    if (e?.status === 401) handleSessionExpiry()
    return { ok: false, status: e?.status ?? 0, error: e?.message || 'commit failed' }
  }
}

/**
 * Read every team manifest of an assignment from the control repo.
 * The manifests are authoritative; reports/<id>.json is a derived snapshot.
 */
export async function listTeams(token, org, controlRepo, assignmentId, { concurrency = 6 } = {}) {
  let files = []
  try {
    files = await listRepoDir(token, org, controlRepo, `teams/${assignmentId}`)
  } catch (e) {
    if (e.status === 404) return []
    throw e
  }
  const jsons = files.filter((f) => f.type === 'file' && f.name.endsWith('.json'))
  const out = []
  let cursor = 0
  async function worker() {
    while (cursor < jsons.length) {
      const f = jsons[cursor++]
      try {
        const text = await getRepoContent(token, org, controlRepo, f.path)
        if (text) out.push(JSON.parse(text))
      } catch {
        // A single unreadable manifest must not sink the whole read - the
        // caller surfaces the count so a short list is visible, not silent.
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, jsons.length || 1) }, worker))
  return out.sort((a, b) => String(a.team_slug).localeCompare(String(b.team_slug)))
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
 * Accepts inputs and ref flexibly (e.g. triggerWorkflow(token, owner, repo, id, inputs) or triggerWorkflow(token, owner, repo, id, 'main', inputs)).
 */
export async function triggerWorkflow(token, owner, repo, workflowId, inputsOrRef = null, possibleInputs = null) {
  let ref = 'main'
  let inputs = null

  if (typeof inputsOrRef === 'string') {
    ref = inputsOrRef
    inputs = possibleInputs && typeof possibleInputs === 'object' ? possibleInputs : null
  } else if (inputsOrRef && typeof inputsOrRef === 'object') {
    inputs = inputsOrRef
    ref = typeof possibleInputs === 'string' ? possibleInputs : 'main'
  }

  const body = { ref }
  if (inputs && Object.keys(inputs).length > 0) body.inputs = inputs
  return ghApi(token, 'POST', `/repos/${owner}/${repo}/actions/workflows/${workflowId}/dispatches`, body)
}

/**
 * List workflow runs for a specific workflow file.
 */
export async function getWorkflowRuns(token, owner, repo, workflowId) {
  return ghApi(token, 'GET', `/repos/${owner}/${repo}/actions/workflows/${workflowId}/runs`)
}

export function createWorkflowRequestId(prefix = 'request') {
  const unique = typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `${prefix}-${unique}`
}

/**
 * Locate the workflow_dispatch run whose run-name contains a request ID.
 * workflow_dispatch returns 204 without a run ID, so callers add the ID as a
 * workflow input and the workflow exposes it in `run-name` for correlation.
 */
export async function getWorkflowRunByRequestId(token, owner, repo, workflowId, requestId) {
  const res = await ghApi(
    token,
    'GET',
    `/repos/${owner}/${repo}/actions/workflows/${workflowId}/runs?event=workflow_dispatch&per_page=20`
  )
  if (!res.ok) return res
  const runs = Array.isArray(res.data?.workflow_runs) ? res.data.workflow_runs : []
  return {
    ...res,
    run: runs.find((run) => String(run.display_title || '').includes(`[${requestId}]`)) || null,
  }
}

/**
 * Format a workflow_dispatch failure for the toast. Prefers GitHub's own
 * message because 403/404 almost never means "user has no access" - for a
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
 * query - works regardless of org size). Without one, paginates the org repos
 * endpoint via Link rel="next".
 */
// `failFast` turns a failed page into an error instead of a short list. The
// default stays lenient because a partial list is fine for most callers - but
// a caller that renders "this organization has none" from an empty result has
// to be able to tell an empty org from an unanswered request.
export async function listOrgRepos(token, org, prefix = '', { failFast = false } = {}) {
  const fail = (status) => {
    const e = new Error(`Failed to list repositories for ${org} (HTTP ${status})`)
    e.status = status
    return e
  }

  if (prefix) {
    const q = encodeURIComponent(`org:${org} ${prefix} in:name`)
    const res = await ghApi(token, 'GET', `/search/repositories?q=${q}&per_page=100`)
    if (!res.ok) {
      if (failFast) throw fail(res.status)
      return []
    }
    return (res.data?.items || []).filter((r) => r.name.startsWith(prefix))
  }

  const out = []
  let url = `/orgs/${org}/repos?per_page=100&sort=full_name`
  while (url) {
    const res = await fetchWithTimeout(`${API_BASE}${url}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    }, { timeoutMs: READ_TIMEOUT_MS })
    if (!res.ok) {
      if (failFast) throw fail(res.status)
      break
    }
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
    // `fork:true` means "forks AS WELL AS non-forks". GitHub's repository
    // search hides forks by default, and a fork can perfectly well be a
    // template - so a lecturer who forked a template into their org watched it
    // never appear in the picker, with no error anywhere, while
    // `is_template: true` sat on the repository. Reported live for
    // PXL-2TIN-NetAdv-26-27/Guts-DotNetAdvanced-2627 on 2026-08-24.
    //
    // The REST fallback below would have found it (GET /orgs/{org}/repos
    // includes forks), but that leg only runs when the search FAILS - and this
    // search succeeded. It just answered a question nobody meant to ask.
    const q = encodeURIComponent(`org:${org} is:template fork:true`)
    const res = await ghApi(token, 'GET', `/search/repositories?q=${q}&per_page=100`)
    if (res.ok) {
      const items = res.data?.items || []
      return items.filter((r) => r.is_template)
    }
  } catch (e) {
    console.error('Search templates failed, falling back to listOrgRepos', e)
  }

  // Fallback: list all org repos and filter client-side. This leg runs ONLY
  // because the search already failed, so it is not allowed to fail quietly:
  // `listOrgRepos` used to `break` out of its pagination loop on a bad
  // response and return an empty array, and the Admin Panel rendered that as
  // "This organization has no template repositories yet" - telling a lecturer
  // to go and create a template they may well already have. An empty org and
  // an unanswered request are different facts (the same rule the roster count
  // follows), and only one of them is safe to state.
  const repos = await listOrgRepos(token, org, '', { failFast: true })
  return repos.filter((r) => r.is_template)
}

/**
 * Validates whether a given owner/repo exists, is accessible, and is marked as a GitHub template.
 */
export async function validateTemplateRepository(token, owner, repo) {
  if (!owner || !repo) return { ok: false, reason: 'missing_params' }
  const res = await ghApi(token, 'GET', `/repos/${owner}/${repo}`)
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      reason: res.status === 404 ? 'not_found' : 'forbidden_or_error',
      message: res.data?.message || `HTTP ${res.status}`,
    }
  }
  const repoData = res.data || {}
  return {
    ok: true,
    isTemplate: !!repoData.is_template,
    defaultBranch: repoData.default_branch || 'main',
    isPrivate: !!repoData.private,
    fullName: repoData.full_name || `${owner}/${repo}`,
    htmlUrl: repoData.html_url,
  }
}
