// PXL Classroom - fetch with a bounded wait.
//
// Dependency-free on purpose: lib/api.js imports clearAuth from lib/auth.js,
// so anything both of them need has to live outside that pair or it forms an
// import cycle.

// Bounded wait for reads. GitHub REST reads are sub-second in normal
// operation, so 10s is roughly 10x the realistic worst case - enough that a
// slow-but-working call still lands, short enough that a stalled connection
// surfaces while the user is still looking at the screen.
export const READ_TIMEOUT_MS = 10000

export class HttpTimeoutError extends Error {
  constructor(timeoutMs, url) {
    super(`Request timed out after ${Math.round(timeoutMs / 1000)}s`)
    this.name = 'HttpTimeoutError'
    this.timeoutMs = timeoutMs
    this.url = url
  }
}

/**
 * fetch() that gives up after `timeoutMs`.
 *
 * Aborting only stops US waiting - the request may still be in flight at the
 * server and may still take effect. That is why callers decide per request
 * whether a timeout is safe (see the rule in lib/api.js's ghApi), and why
 * `timeoutMs: 0` (the default) means "wait indefinitely" rather than picking
 * a number for them.
 *
 * Uses a plain AbortController rather than AbortSignal.timeout/any so it does
 * not depend on newer signal APIs - students open this on whatever browser
 * the lab machine has.
 */
export async function fetchWithTimeout(url, init = {}, { timeoutMs = 0, signal = null } = {}) {
  if (!timeoutMs) {
    return fetch(url, signal ? { ...init, signal } : init)
  }

  const controller = new AbortController()
  const forwardAbort = () => controller.abort()
  if (signal) {
    if (signal.aborted) return fetch(url, { ...init, signal })
    signal.addEventListener('abort', forwardAbort, { once: true })
  }

  // Distinguishes our own timeout from a caller-initiated cancel, so a
  // cancelled sign-in is not reported to the user as a network timeout.
  let timedOut = false
  const deadline = Date.now() + timeoutMs
  let timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)

  // THE BODY TOO, NOT ONLY THE HEADERS. fetch() resolves when the headers
  // arrive, and clearing the timer there left the reply's body unbounded: a
  // response that stalled half way hung its reader for ever (2026-10-06). So on
  // success the timer and the forwarded abort stay armed until the deadline,
  // and an abort then ends a body still being read - aborting one that was
  // already read does nothing. Read the body straight away; ghApi does.
  const disarm = () => {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', forwardAbort)
  }
  try {
    const res = await fetch(url, { ...init, signal: controller.signal })
    clearTimeout(timer)
    timer = setTimeout(() => {
      timedOut = true
      controller.abort()
      disarm()
    }, Math.max(0, deadline - Date.now()))
    return res
  } catch (err) {
    disarm()
    if (timedOut) throw new HttpTimeoutError(timeoutMs, url)
    throw err
  }
}
