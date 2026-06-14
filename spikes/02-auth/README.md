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

## Results (2026-06-14) — device flow PASS for identity

Client ID `Iv23li0H0Je93H2FkMPW`, Device Flow enabled, authorized as **tomccargo**:

```
authenticated_as=tomccargo (id=1250098)
token_type=user-to-server (expiring)
token_expires_in=28800        # 8h
has_refresh_token=true
scope=                        # GitHub App: governed by app permissions, not OAuth scopes
```

- ✅ identifies the user (login + immutable id)
- ✅ no PAT pasted, no client secret in the browser, no redirect URL needed
- ✅ minimal permission — user-to-server token, no broad scopes
- ✅ token lifetime documented: 8h expiring + refresh token (good for "avoid long-lived browser tokens"; store in-memory/session only, not localStorage)

### Recommendation

**Device flow is the working prototype** and the simplest fit for a static Pages frontend (no redirect, no secret). Cost: one extra "enter this code" step. OAuth / GitHub App user-to-server **PKCE** would remove that step but requires handling a redirect + PKCE on the static page; keep it as the alternative if the extra step proves unacceptable.

### Linchpin result (2026-06-14): star BLOCKED → App needs the Starring permission

`PUT /user/starred/<broker>` with the device-flow token returned **HTTP 403 "Resource not accessible by integration."** The GitHub App's user token cannot star because the App was created **without the Account → Starring permission**.

**Fix to try:** on the App, add **Account permissions → Starring → Read and write**, save, then re-authorize (a new account permission requires re-consent) and re-test with `STAR_TARGET` set. Expect `star_...=HTTP 204`. This keeps least privilege — one user-level Starring permission, far narrower than an OAuth App's `public_repo` scope.

**If even that fails** (GitHub may not expose starring to GitHub App user tokens at all): fall back to an **OAuth App** device flow with `public_repo`, or choose a non-star acceptance action the App token *can* perform.
