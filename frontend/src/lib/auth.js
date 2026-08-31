// PXL Classroom - GitHub Device Flow authentication module.
//
// Implements the GitHub device authorization flow for static frontends.
// Based on spikes/02-auth/device-flow.mjs (Spike 2 - PASS).
//
// Flow:
//   1. POST /login/device/code -> get device_code, user_code, verification_uri
//   2. User opens verification_uri and enters user_code
//   3. Poll POST /login/oauth/access_token until authorized
//   4. Use access_token to call GitHub API
//
// Token storage: sessionStorage only (cleared on tab close).
// Never localStorage. Never embedded in Pages output.

// github.com/login/* does NOT send CORS headers - direct browser fetch fails.
// Route the two device-flow endpoints through a CORS proxy. api.github.com
// does support CORS and is called directly.
//
// TWO proxies, tried in order, and the FIRST one is OURS. That ordering is the
// whole security property here, and it used to be the other way round.
//
// On 2026-08-28 corsproxy.io withdrew its free tier and began answering
// `401 {"error":"A valid API key is required"}` to everything, which took
// sign-in down for every lecturer and every student. The obvious recovery -
// point the setting at a different public proxy - was then measured and DOES NOT
// EXIST: allorigins, thingproxy and codetabs each silently issue a GET and hand
// back GitHub's HTML sign-in page. So a proxy nobody can withdraw had to be
// built, and it is `cors-worker/worker.js`, a PXL-owned Cloudflare Worker.
//
// It was added as the FALLBACK, and that turned out to protect nobody. Measured
// live 2026-08-31 by loading the deployed SPA and reading its own resource
// timing: the device-code request and all three access_token polls went to
// corsproxy.io and the Worker was never contacted, because a fallback is only
// reached when the primary FAILS - and the primary had started working again on
// a paid key. So the third party was back on the path of every sign-in, which is
// exactly the state the Worker was built to end.
//
// THREAT MODEL, and why the order matters rather than just the existence of two:
// whichever proxy answers sees the device_code and the ACCESS TOKEN in transit.
// A student token can only open an issue on a public broker (8h lifetime,
// instant revoke at github.com/settings/applications). A LECTURER token reads
// the org's private control repo - the roster: names, student numbers,
// institutional email addresses. Ours first means that is a PXL-operated hop in
// the ordinary case, and a third party only when ours is unreachable.
// See ARCHITECTURE.md §10.2.
import { DEVICE_FLOW_PROXY } from './deployment.js'
import { HttpTimeoutError, READ_TIMEOUT_MS, fetchWithTimeout } from './http.js'

// The target URL is appended, so a proxy must end at the parameter that takes
// it. Three spellings are accepted, and the second is why this is not a single
// `endsWith('?url=')`:
//
//   https://proxy.example/?url=            the original form
//   https://proxy.example/?key=abc&url=    a proxy that also wants an API key
//   https://proxy.example/?                shorthand; `url=` is appended
//
// A keyed URL ends `&url=`, so the check that predated the outage rejected
// exactly the value needed to recover from it.
function normalizeProxy(value) {
  let url = (value || '').trim()
  if (!url) return null // absent is "not configured", which is not an error
  if (url.endsWith('?')) url += 'url='
  return { url, usable: /[?&]url=$/.test(url) }
}

// AND NONE OF THIS MAY THROW. This is module scope in a file the whole SPA
// imports, so a throw is a blank page with nothing on it - the `localToUtc`
// mistake in the worst possible place. A misconfigured proxy is recorded and
// reported when sign-in is attempted, where there is somewhere to show it.
// ORDERED, ours first. The PXL Worker comes from deployment.yml rather than a
// secret because it is not one - it is baked into a public bundle and readable
// by anyone who opens the page - and because the ORDER then lives in the file
// people actually read, instead of depending on which of two similarly-named
// secrets happened to hold which value. That ambiguity is how the third party
// stayed primary for as long as it did.
//
// The third-party entry keeps its `VITE_CORS_PROXY_URL` name and its secret, and
// there is deliberately no hardcoded default for it any more: a default meant
// that deleting the secret silently reinstated corsproxy.io.
const PROXIES = [DEVICE_FLOW_PROXY, import.meta.env.VITE_CORS_PROXY_URL || '']
  .map(normalizeProxy)
  .filter(Boolean)

// One unusable entry is SKIPPED, not fatal: surviving a proxy going wrong is the
// entire point, and a typo in the fallback must not take working sign-in down
// with it. It is only a configuration error when nothing usable is left.
const USABLE_PROXIES = PROXIES.filter((p) => p.usable)
const corsProxyError =
  USABLE_PROXIES.length > 0
    ? null
    : // A STUDENT reaches this. AuthCard is the one sign-in surface, so the
      // same sentence greets someone trying to accept an assignment - naming a
      // build secret and a document section tells them nothing they can act on
      // and reads as their fault. Say what is true and who can fix it.
      `Sign-in is not set up correctly for this deployment, so nobody can sign in right now. ` +
      `This needs a PXL Classroom administrator - please let your lecturer know.`

// Targets, not proxied URLs - proxiedPost() appends them to whichever proxy it
// is trying.
const DEVICE_CODE_TARGET = 'https://github.com/login/device/code'
const TOKEN_TARGET = 'https://github.com/login/oauth/access_token'
const GITHUB_API_BASE = 'https://api.github.com' // API supports CORS directly

// GitHub's documented device-flow error codes. This is an ALLOWLIST and has to
// be, because a proxy failure and a GitHub refusal can both be JSON carrying an
// `error` field - corsproxy.io's withdrawal reply was `{"error":"A valid API key
// is required"}`, which is well-formed JSON that GitHub would never send. An
// unrecognised code fails over rather than being reported as GitHub's answer:
// trying the other proxy and then quoting the reply is recoverable, whereas
// showing a student a proxy's billing error as an authorization failure is not.
const OAUTH_ERRORS = new Set([
  'authorization_pending',
  'slow_down',
  'expired_token',
  'access_denied',
  'unsupported_grant_type',
  'incorrect_client_credentials',
  'incorrect_device_code',
  'device_flow_disabled',
])

const isDeviceCodeReply = (d) => typeof d?.device_code === 'string'
const isTokenReply = (d) => typeof d?.access_token === 'string' || OAUTH_ERRORS.has(d?.error)

// Whichever proxy answered last. A dead primary is then paid for once per
// sign-in rather than on every poll tick.
let preferredProxy = 0

/**
 * POST to a device-flow endpoint through the first proxy that actually works.
 *
 * `accept` decides whether a reply came from GitHub or from a broken proxy.
 * Anything it rejects - a 401 billing notice, an HTML page served with HTTP 200
 * (the failure mode of every GET-only proxy) - counts as this proxy being
 * broken, and the next one is tried.
 */
async function proxiedPost(target, body, accept, { timeoutMs, signal } = {}) {
  // Reported here rather than thrown at import, so a misconfigured deployment
  // shows a sentence in the sign-in card instead of a blank page.
  if (corsProxyError) throw new Error(corsProxyError)

  let last = null
  for (let i = 0; i < USABLE_PROXIES.length; i++) {
    const idx = (preferredProxy + i) % USABLE_PROXIES.length
    let res
    try {
      res = await fetchWithTimeout(
        `${USABLE_PROXIES[idx].url}${encodeURIComponent(target)}`,
        {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
        { timeoutMs, signal },
      )
    } catch (err) {
      if (signal?.aborted) throw err
      last = err
      continue
    }

    let text = ''
    try {
      text = await res.text()
    } catch {
      text = ''
    }
    let data = null
    try {
      data = JSON.parse(text)
    } catch {
      data = null
    }

    if (accept(data)) {
      preferredProxy = idx
      return data
    }
    // Keep what it actually said. "Sign-in is broken" is not a diagnosis, and a
    // bad client_id reaches here as GitHub's own 404 rather than a proxy fault.
    last = new Error(`HTTP ${res.status} ${text.slice(0, 120).replace(/\s+/g, ' ').trim()}`)
  }

  // Every proxy timed out. Polling is itself the retry, so hand the timeout back
  // intact and let the caller decide rather than ending sign-in over a slow tick.
  if (last instanceof HttpTimeoutError) throw last
  throw new Error(
    `Sign-in could not reach GitHub through any CORS proxy (${USABLE_PROXIES.length} tried). ` +
      `Last reply: ${last?.message || 'none'}`,
  )
}

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
      // Expired - clear
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
  if (!_token) {
    initAuth()
  }
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
  if (!_user) {
    initAuth()
  }
  return _user
}

/**
 * When the current token expires (Date), or null when not authenticated.
 * Surfaced in the UserBadge so the 8-hour cliff is visible before it hits.
 */
export function getTokenExpiry() {
  return _tokenExpiresAt
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
// Minting a device code is a single quick round trip.
const DEVICE_CODE_TIMEOUT_MS = 10000

export async function startDeviceFlow(clientId, scope = 'user:email') {
  const body = { client_id: clientId }
  if (scope) body.scope = scope
  // A POST, but a safe one to bound: it only mints a device code, and a code
  // we never showed the user simply expires unused. Left unbounded, a stalled
  // request means a spinner and no code to type - nothing the user can act on.
  return await proxiedPost(DEVICE_CODE_TARGET, body, isDeviceCodeReply, {
    timeoutMs: DEVICE_CODE_TIMEOUT_MS,
  })
}

/**
 * Poll for the device flow token. Returns { access_token, token_type, scope }.
 * Resolves when the user completes authorization.
 * @param {string} clientId - GitHub App client ID
 * @param {string} deviceCode - From startDeviceFlow
 * @param {number} interval - Polling interval in seconds
 * @param {AbortSignal} signal - Optional abort signal
 */
// One poll tick. Shorter than a read because the loop retries anyway, and a
// tick that outlives its own interval is already stalled.
const POLL_TIMEOUT_MS = 8000

export async function pollDeviceFlow(clientId, deviceCode, interval = 5, signal = null) {
  let pollInterval = interval

  while (true) {
    if (signal?.aborted) throw new Error('Cancelled')

    await new Promise((resolve) => setTimeout(resolve, pollInterval * 1000))

    // The one POST it is safe to time out: polling IS the retry, so a stalled
    // tick costs nothing and the next one asks the same question. Before this,
    // a hung request stranded sign-in forever - `signal` was only checked at
    // the top of the loop and was never attached to the request, so Cancel did
    // nothing until the fetch resolved on its own.
    let data
    try {
      data = await proxiedPost(
        TOKEN_TARGET,
        {
          client_id: clientId,
          device_code: deviceCode,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        },
        isTokenReply,
        { timeoutMs: POLL_TIMEOUT_MS, signal },
      )
    } catch (err) {
      if (signal?.aborted) throw new Error('Cancelled')
      // A slow tick is not a failed sign-in - the user may still be on the
      // GitHub authorization page. Try again on the next interval.
      if (err instanceof HttpTimeoutError) continue
      throw err
    }

    if (data.access_token) {
      // Success - fetch user info
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
 * Fetch the authenticated user's profile and verified email.
 */
async function fetchUser(token) {
  const res = await fetchWithTimeout(`${GITHUB_API_BASE}/user`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
    },
  }, { timeoutMs: READ_TIMEOUT_MS })
  if (!res.ok) throw new Error(`Failed to fetch user: HTTP ${res.status}`)
  const data = await res.json()

  let email = data.email || null
  try {
    const emailsRes = await fetchWithTimeout(`${GITHUB_API_BASE}/user/emails`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
      },
    }, { timeoutMs: READ_TIMEOUT_MS })
    if (emailsRes.ok) {
      const emails = await emailsRes.json()
      if (Array.isArray(emails)) {
        const primary = emails.find((e) => e.primary && e.verified) || emails.find((e) => e.verified) || emails[0]
        if (primary?.email) email = primary.email
      }
    }
  } catch {
    // ignore if /user/emails permission is not granted
  }

  return {
    login: data.login,
    id: data.id,
    avatar_url: data.avatar_url,
    name: data.name,
    email,
  }
}
