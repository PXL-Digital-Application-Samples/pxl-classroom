// PXL Classroom — GitHub API client.
//
// Thin wrapper around fetch() for GitHub API calls. Uses the authenticated
// user's own token — never a privileged credential.

const API_BASE = 'https://api.github.com'

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

  const text = await res.text()
  let data = null
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = { raw: text }
    }
  }

  return { status: res.status, ok: res.ok, data }
}

// --- Student-facing API calls -----------------------------------------------

/**
 * Star a repository (acceptance trigger).
 */
export async function starRepo(token, owner, repo) {
  return ghApi(token, 'PUT', `/user/starred/${owner}/${repo}`)
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
 */
export async function getRepoContent(token, owner, repo, path) {
  const res = await ghApi(token, 'GET', `/repos/${owner}/${repo}/contents/${path}`)
  if (!res.ok) return null

  // GitHub returns base64-encoded content
  if (res.data?.content) {
    try {
      const decoded = atob(res.data.content.replace(/\n/g, ''))
      return decoded
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
  if (!res.ok || !Array.isArray(res.data)) return []
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
 * Trigger a GitHub Action workflow via workflow_dispatch.
 */
export async function triggerWorkflow(token, owner, repo, workflowId, ref = 'main') {
  return ghApi(token, 'POST', `/repos/${owner}/${repo}/actions/workflows/${workflowId}/dispatches`, { ref })
}
