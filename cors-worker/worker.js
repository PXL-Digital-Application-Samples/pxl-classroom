// PXL Classroom - device-flow CORS proxy (Cloudflare Worker).
//
// WHY THIS EXISTS
//
// github.com/login/device/code and github.com/login/oauth/access_token send no
// CORS headers at all. Measured 2026-08-28: a 200 response carries zero
// `access-control-*` headers, and GitHub's own OAuth documentation states that
// "CORS pre-flight requests (OPTIONS) are not supported at this time". Since the
// SPA sends `Content-Type: application/json`, a preflight is mandatory and there
// is none - so a browser can never call those two endpoints directly. A proxy is
// structural, not a workaround, and it is not going away.
//
// The SPA's primary proxy is corsproxy.io. On 2026-08-28 it withdrew its free
// tier and began answering `401 {"error":"A valid API key is required"}` to
// everything, which took sign-in down for every lecturer and every student. The
// obvious recovery - point VITE_CORS_PROXY_URL at a different public proxy - was
// then measured and DOES NOT EXIST: allorigins, thingproxy and codetabs all
// silently issue a GET and hand back GitHub's HTML sign-in page. HTTP 200, wrong
// method, unparseable body. There is no third-party substitute to fail over to.
//
// So the fallback has to be one we own, and this is it. It is deployed by hand
// once (RUNBOOK §1.6) and is deliberately NOT wired into CI - automating the
// deploy would mean putting a Cloudflare API token in the hub, which is more
// standing credential than the thing it protects.
//
// WHAT PROTECTS IT FROM BECOMING AN OPEN RELAY
//
// ALLOWED_TARGETS is the load-bearing control, and it is an allowlist of two
// exact URLs rather than a pattern. Without it this is a general-purpose proxy
// on a PXL account that anyone could route arbitrary traffic through.
//
// ALLOWED_ORIGINS is defence in depth and nothing more. An Origin header is set
// by the caller, so anything that is not a browser can claim any origin it
// likes; the check stops OTHER WEB PAGES from using this Worker, which is real
// but narrow. Do not weaken the target allowlist on the strength of it.

/** The only two URLs this Worker will ever fetch. Exact match, no patterns. */
const ALLOWED_TARGETS = new Set([
  'https://github.com/login/device/code',
  'https://github.com/login/oauth/access_token',
])

/**
 * Browser origins allowed to use this Worker. The Pages deployment, plus the
 * Vite dev server so a lecturer can test a proxy change locally before it ships.
 */
const ALLOWED_ORIGINS = new Set([
  'https://pxl-digital-application-samples.github.io',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
])

export default {
  async fetch(request) {
    const origin = request.headers.get('Origin') || ''
    if (!ALLOWED_ORIGINS.has(origin)) {
      return new Response('Origin not allowed', { status: 403 })
    }

    const cors = {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Accept',
      'Access-Control-Max-Age': '86400',
      // The allowed origin varies by caller, so any cache in front of this must
      // key on it rather than serving one origin's header to another.
      Vary: 'Origin',
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors })
    }
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: cors })
    }

    // Same `?url=` interface as corsproxy.io, so this is a drop-in for
    // VITE_CORS_PROXY_URL and the SPA needs no special case for it.
    const target = new URL(request.url).searchParams.get('url')
    if (!ALLOWED_TARGETS.has(target)) {
      return new Response('Target not allowed', { status: 403, headers: cors })
    }

    let upstream
    try {
      upstream = await fetch(target, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: await request.text(),
      })
    } catch (err) {
      // Say which leg failed. "Sign-in is broken" is not a diagnosis, and this
      // Worker is the last thing standing when the primary proxy is already
      // down - whoever reads this is having a bad day already.
      return new Response(
        JSON.stringify({ error: 'upstream_unreachable', detail: String(err && err.message) }),
        { status: 502, headers: { ...cors, 'Content-Type': 'application/json' } },
      )
    }

    // GitHub's status is passed through unchanged: the SPA distinguishes "the
    // proxy is broken" from "GitHub answered and said no", and rewriting the
    // status here would destroy exactly that signal.
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        ...cors,
        'Content-Type': upstream.headers.get('Content-Type') || 'application/json',
      },
    })
  },
}
