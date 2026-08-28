# Device-flow CORS proxy (Cloudflare Worker)

The SPA's **fallback** proxy for GitHub's device-flow endpoints. `corsproxy.io`
stays primary; this takes over automatically when it fails.

Read the header comment in [`worker.js`](worker.js) for why a proxy is
structurally required and why the fallback has to be one we own. The short
version: GitHub sends no CORS headers on `login/device/code` or
`login/oauth/access_token`, and **there is no other public proxy that works** —
measured, not assumed.

## Deploy

Once, by hand. Ten minutes. Not wired into CI on purpose: automating it would
mean storing a Cloudflare API token in the hub, which is more standing
credential than the thing it protects.

1. Sign in at [dash.cloudflare.com](https://dash.cloudflare.com) — the free plan
   needs no credit card, and no domain or DNS zone.
2. **Compute (Workers) → Create → Start from Hello World → Deploy.**
   Name it `pxl-cors`.
3. **Edit code**, replace the whole file with [`worker.js`](worker.js), **Deploy**.
4. Copy the URL — `https://pxl-cors.<your-subdomain>.workers.dev`.
5. Add the hub repo secret so the SPA picks it up at build time:

```bash
gh secret set VITE_CORS_PROXY_FALLBACK_URL --repo PXL-Digital-Application-Samples/pxl-classroom --body "https://pxl-cors.<your-subdomain>.workers.dev/?url="
```

6. Re-run `deploy-frontend.yml`. The value is baked into the bundle at build
   time, so **the fallback does not exist until a deploy has run.**

The trailing `?url=` is required — the SPA appends the target to it. Same
interface as corsproxy.io.

## Verify

`curl` alone gets a 403: the Origin check rejects it, which is the Worker
working. Send a real browser origin:

```bash
curl -s -X POST "https://pxl-cors.<your-subdomain>.workers.dev/?url=https%3A%2F%2Fgithub.com%2Flogin%2Fdevice%2Fcode" -H "Origin: https://pxl-digital-application-samples.github.io" -H "Content-Type: application/json" -d '{"client_id":"Iv23li0H0Je93H2FkMPW","scope":"user:email"}'
```

A `device_code` and a `user_code` come back. That code is unused and expires in
15 minutes; nothing needs cleaning up.

Confirm the allowlist refuses anything else — this must be `403 Target not allowed`:

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST "https://pxl-cors.<your-subdomain>.workers.dev/?url=https%3A%2F%2Fexample.com" -H "Origin: https://pxl-digital-application-samples.github.io" -d '{}'
```

## Account ownership

The Worker lives in whoever's Cloudflare account deployed it. If that account is
lost, **the fallback silently stops existing** and nobody finds out until the
primary fails and the fallback is not there either. Put it in an account tied to
a PXL address that more than one person can reach, and record who owns it in
RUNBOOK §1.9.

## Cost

Free plan: 100,000 requests/day, 10 ms CPU per invocation (waiting on GitHub is
not CPU). One sign-in is about seven requests — a device code plus polls — so
the daily allowance is roughly 14,000 sign-ins. Nowhere near it.
