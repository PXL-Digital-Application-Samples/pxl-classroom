// PXL Classroom — GitHub Device Flow authentication module.
//
// Implements the GitHub device authorization flow for static frontends.
// Based on spikes/02-auth/device-flow.mjs (Spike 2 — PASS).
//
// Flow:
//   1. POST /login/device/code → get device_code, user_code, verification_uri
//   2. User opens verification_uri and enters user_code
//   3. Poll POST /login/oauth/access_token until authorized
//   4. Use access_token to call GitHub API
//
// Token storage: sessionStorage only (cleared on tab close).
// Never localStorage. Never embedded in Pages output.

const GITHUB_DEVICE_CODE_URL = 'https://github.com/login/device/code'
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token'
const GITHUB_API_BASE = 'https://api.github.com' // API supports CORS directly

// State
let _token = null
let _user = null
let _tokenExpiresAt = null

/**
 * Initialize auth from sessionStorage (tab persistence).
 */
export function initAuth() {
  const stored = sessionStorage.getItem('pxl_auth')
  if (stored) {
    try {
      const data = JSON.parse(stored)
      if (data.expires_at && new Date(data.expires_at) > new Date()) {
        _token = data.access_token
        _user = data.user
        _tokenExpiresAt = new Date(data.expires_at)
        return true
      }
      // Expired — clear
      sessionStorage.removeItem('pxl_auth')
    } catch {
      sessionStorage.removeItem('pxl_auth')
    }
  }
  return false
}

/**
 * Get the current access token (or null if not authenticated).
 */
export function getToken() {
  if (_tokenExpiresAt && new Date() > _tokenExpiresAt) {
    clearAuth()
    return null
  }
  return _token
}

/**
 * Get the current authenticated user (or null).
 */
export function getUser() {
  return _user
}

/**
 * Check if the user is authenticated.
 */
export function isAuthenticated() {
  return !!getToken()
}

/**
 * Clear authentication state.
 */
export function clearAuth() {
  _token = null
  _user = null
  _tokenExpiresAt = null
  sessionStorage.removeItem('pxl_auth')
}

/**
 * Start the device flow. Returns { device_code, user_code, verification_uri, interval }.
 * @param {string} clientId - GitHub App client ID
 */
export async function startDeviceFlow(clientId) {
  const res = await fetch(GITHUB_DEVICE_CODE_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_id: clientId,
      // No scopes — the GitHub App's permissions govern what the token can do
    }),
  })

  if (!res.ok) {
    throw new Error(`Device code request failed: HTTP ${res.status}`)
  }

  return await res.json()
}

/**
 * Poll for the device flow token. Returns { access_token, token_type, scope }.
 * Resolves when the user completes authorization.
 * @param {string} clientId - GitHub App client ID
 * @param {string} deviceCode - From startDeviceFlow
 * @param {number} interval - Polling interval in seconds
 * @param {AbortSignal} signal - Optional abort signal
 */
export async function pollDeviceFlow(clientId, deviceCode, interval = 5, signal = null) {
  let pollInterval = interval

  while (true) {
    if (signal?.aborted) throw new Error('Cancelled')

    await new Promise((resolve) => setTimeout(resolve, pollInterval * 1000))

    const res = await fetch(GITHUB_TOKEN_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_id: clientId,
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    })

    const data = await res.json()

    if (data.access_token) {
      // Success — fetch user info
      const user = await fetchUser(data.access_token)

      // Calculate expiry
      const expiresAt = data.expires_in
        ? new Date(Date.now() + data.expires_in * 1000)
        : new Date(Date.now() + 8 * 60 * 60 * 1000) // default 8h

      // Store in memory + sessionStorage
      _token = data.access_token
      _user = user
      _tokenExpiresAt = expiresAt

      sessionStorage.setItem(
        'pxl_auth',
        JSON.stringify({
          access_token: data.access_token,
          user,
          expires_at: expiresAt.toISOString(),
        })
      )

      return { user, token: data.access_token, expiresAt }
    }

    if (data.error === 'authorization_pending') {
      continue
    }

    if (data.error === 'slow_down') {
      pollInterval += 5
      continue
    }

    if (data.error === 'expired_token') {
      throw new Error('Device code expired. Please restart the login flow.')
    }

    if (data.error === 'access_denied') {
      throw new Error('Authorization was denied.')
    }

    throw new Error(`Unexpected error: ${data.error || 'unknown'}`)
  }
}

/**
 * Fetch the authenticated user's profile.
 */
async function fetchUser(token) {
  const res = await fetch(`${GITHUB_API_BASE}/user`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
    },
  })
  if (!res.ok) throw new Error(`Failed to fetch user: HTTP ${res.status}`)
  const data = await res.json()
  return {
    login: data.login,
    id: data.id,
    avatar_url: data.avatar_url,
    name: data.name,
  }
}
