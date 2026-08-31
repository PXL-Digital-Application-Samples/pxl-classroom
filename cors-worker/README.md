# Device-flow CORS proxy (Cloudflare Worker)

The SPA's **fallback** proxy for GitHub's device-flow endpoints. `corsproxy.io`
stays primary; this takes over automatically when it fails.

Read the header comment in [`worker.js`](worker.js) for why a proxy is
structurally required and why the fallback has to be one we own. The short
version: GitHub sends no CORS headers on `login/device/code` or
`login/oauth/access_token`, and **there is no other public proxy that works** —
measured, not assumed.

## Deploy

Once, by hand. Not wired into CI on purpose: automating it would mean storing a
Cloudflare API token in the hub, which is more standing credential than the thing
it protects.

### Preferred: from this directory

`wrangler.jsonc` is here so that **the deployed Worker is this file**. The
dashboard's paste-into-the-editor flow works too, but then the running code and
the reviewed code are two separate things that drift the moment either is
touched — and this one carries a security allowlist, so drift is the failure that
matters.

```bash
cd cors-worker && npx wrangler@latest login && npx wrangler@latest deploy
```

`login` opens a browser once. `deploy` prints the URL. Validate without
deploying — no account needed — with `npx wrangler@latest deploy --dry-run`.

### Alternative: the dashboard

Cloudflare renames and rearranges this screen regularly, so trust what is in
front of you over anything written here. As of 2026-08-28, from **Compute
(Workers)**, the "Ship something new" panel lists five options and the one you
want is the third, **"Start with Hello World!"** — it is *not* inside "Select a
template".

1. **Start with Hello World!** → name it `pxl-cors` → **Deploy**. This deploys
   Cloudflare's placeholder script; that is expected, the point is to create the
   Worker.
2. **Edit code** → select all → replace with [`worker.js`](worker.js) → **Deploy**.

### Then, either way

3. Copy the URL — `https://pxl-cors.<your-subdomain>.workers.dev`.
4. Add the hub repo secret so the SPA picks it up at build time:

```bash
gh secret set VITE_CORS_PROXY_FALLBACK_URL --repo PXL-Digital-Application-Samples/pxl-classroom --body "https://pxl-cors.<your-subdomain>.workers.dev/?url="
```

5. Re-run `deploy-frontend.yml`. The value is baked into the bundle at build
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
INSTALL.md §9.

## Cost

Free plan: 100,000 requests/day, 10 ms CPU per invocation (waiting on GitHub is
not CPU). One sign-in is about seven requests — a device code plus polls — so
the daily allowance is roughly 14,000 sign-ins. Nowhere near it.
