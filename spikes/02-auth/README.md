# Spike 2 — Student authentication

**Goal:** identify the GitHub user from a static frontend with the minimum permission, no pasted PAT, no exposed secret, surviving refresh; document token lifetime/storage. Compare **device flow** vs **OAuth/GitHub App PKCE**. (See `REQUIREMENTS.md` → *Browser authentication* and *Student authentication spike*.)

Status: **scaffolded** — device-flow harness ready; needs the App Client ID + Device Flow enabled.

## Why device flow first

No redirect URL, no client secret in the browser → most static-Pages-friendly. The trade-off (an extra "enter this code" step) is exactly what this spike measures, against OAuth/GitHub App user-to-server PKCE.

## Run it

1. On the GitHub App (`pxl-classroom-provisioner`) settings → **enable "Device Flow"**.
2. Copy the App's **Client ID** (App settings page; it is *not* a secret — format `Iv…`/`Iv23…`).
3. Request a code:
   ```bash
   CLIENT_ID=<client-id> node spikes/02-auth/device-flow.mjs request
   ```
4. Open the printed URL, enter the code, authorize (do this as **tomccargo** to mirror a real student).
5. Exchange + identify:
   ```bash
   CLIENT_ID=<client-id> node spikes/02-auth/device-flow.mjs poll
   ```
   Expect `authenticated_as=tomccargo`, plus token type / expiry / refresh-token info.

## Success criteria

- [ ] identifies the user (login + id)
- [ ] minimum permission (GitHub App user token is governed by app perms, not broad scopes)
- [ ] no PAT pasted, no secret exposed in the browser
- [ ] token lifetime + storage documented (expiring user-to-server token + refresh, vs non-expiring)
- [ ] device-flow vs OAuth/PKCE comparison written up here

## Results

_(fill in after the run)_
