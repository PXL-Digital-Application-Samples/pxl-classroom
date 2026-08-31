# PXL Classroom - Installation

**Audience: the central system administrator. Performed once, for the whole institution.**

> [!CAUTION]
> If the central hub (`PXL-Digital-Application-Samples/pxl-classroom`) and its GitHub Apps already exist, **you do not need this file at all**.
> - Adding a course or academic-year organization → [ADMIN.md §1](ADMIN.md#1-onboarding-a-new-organization-per-org). PXL Classroom is multi-tenant: one hub and one App set serve every organization, and a new org needs no frontend and no new App.
> - Running assignments as a lecturer → [RUNBOOK.md](RUNBOOK.md).

The hub is `PXL-Digital-Application-Samples/pxl-classroom`. These steps initialize it. Run in order; §3 depends on §2, and §10 blocks publishing until it is done.

Why any of it is shaped this way → [ARCHITECTURE.md](ARCHITECTURE.md). What broke to make a rule exist → [LESSONS.md](LESSONS.md).

---


## 1. Enable Pages

1. `pxl-classroom` → Settings → Pages → Build and deployment → Source: **GitHub Actions**.
   > [!NOTE]
   > GitHub shows "Suggested workflows" under this setting. Do **not** click Configure — the repository already has `.github/workflows/deploy-frontend.yml`.
2. Actions → **Deploy frontend to Pages** → **Run workflow** (branch `main`).
   > [!NOTE]
   > Running this before the secrets in §3 exist is safe and expected. `scripts/fetch-pages-data.mjs` detects that credentials are not configured, logs a notice, and exits cleanly with an empty index — which deploys the frontend shell and makes `/setup` reachable.

## 2. Create the central GitHub App

1. Open the Pages site at `https://<pages-host>/pxl-classroom/setup`.
2. Enter the owning **organization** — leaving it empty registers the App under your personal account — and click **Create GitHub App**.

   The permission set comes from `MANIFEST_APP_PERMISSIONS` in `lib/audit.mjs` and is deliberately not restated here; a second copy is a copy that goes stale. [ARCHITECTURE §3.2.1](ARCHITECTURE.md) says what each permission is for, and this answers what the live App actually holds:

   ```bash
   gh api apps/<slug> --jq .permissions
   ```

3. Confirm on GitHub's page.
   > [!NOTE]
   > **App names are globally unique across GitHub.com and capped at 34 characters.** The manifest generates a scoped name (`PXL Classroom (<org>)`). On "Name already taken", type any unique name up to 34 characters and create it.

   GitHub redirects back to `/setup`, which exchanges the one-time manifest code and shows the **App ID**, **Client ID** (`Iv…`) and a **Download .pem** button. These appear **once** — store them per §3 immediately. If the exchange fails (the code is single-use and expires after an hour) the App still exists: take the IDs from the App settings page under "About" and use **Generate a private key** there.

4. **Account permissions are not in the manifest** and must be set by hand on the App settings page before installing anywhere:
   - Account → **Email addresses: Read**. The only account permission this App needs, and **required by the claim flow**. A student confirms one of their own GitHub-*verified* addresses, which is a user-to-server read of `/user/emails`; an installation token cannot do it at all, and without the declaration the SPA's user token is not scoped for it either. No organization owner approves account permissions — you set it alone.
   - `GET /apps/{slug}` reports this as `emails`, not `email_addresses`. The settings toggle and the API disagree, and only the API spelling matters to the checks.

## 3. Set hub secrets

**Where a secret lives is part of its protection, so the two tables are separate.** Every private key is an **environment** secret on `provisioning` with **no repository-level copy**: a job that does not declare `environment: provisioning` cannot read one at all, which is half of what closes the branch-ref path (§3.4, [ARCHITECTURE §4.3.4](ARCHITECTURE.md)). Putting one at repository level hands it to every job that does not name the environment, and `tests/workflow-hardening.test.mjs` fails CI when such a job appears.

**Environment secrets** — Settings → Environments → `provisioning` → Add secret. Create the environment first (§3.4):

| Secret | Value |
|---|---|
| `PXL_APP_PRIVATE_KEY` | Full PEM body from §2, BEGIN/END lines included. |
| `PXL_INVITE_SIGNING_KEY` | Ed25519 private key that signs invitation tokens (§3.1). `publish-assignment.yml` fails closed without it. |
| `PXL_CLAIM_PRIVATE_KEY` | ECDH P-256 private key that decrypts a student's claimed email address (§3.2). This decrypts every student's institutional address, so it is the most sensitive value in the system after the App key. |
| `PXL_BROKER_CLIENT_ID` / `PXL_BROKER_PRIVATE_KEY` | The **broker** App's credential. Written by `scripts/create-broker-app.mjs`, not by hand — §10. |

**Repository secrets** — Settings → Secrets and variables → Actions. Neither is a private key:

| Secret | Value |
|---|---|
| `PXL_APP_CLIENT_ID` | Client ID from §2 (the `Iv…` string). Required by `actions/create-github-app-token`; the older `app-id` input is deprecated. Deliberately repository-level: a client id is not secret and already ships in the SPA bundle. |
| `VITE_CORS_PROXY_URL` | Optional. The **secondary** device-flow proxy, reached only when the PXL Worker is unreachable. The **primary** is `device_flow_proxy` in `deployment.yml` and is deliberately not a secret (§9). There is deliberately **no default**, so leaving it unset means one proxy rather than silently reinstating a third party. MUST end in `?url=`, `&url=` (a keyed proxy) or `?` (auto-rewritten). An unusable value is skipped rather than fatal and is reported in the sign-in card. |
| `VITE_GITHUB_CLIENT_ID` | Optional. Same Client ID as `PXL_APP_CLIENT_ID`, baked in at SPA build time. `frontend/src/lib/config.js` falls back to the built-in id, so the PXL deployment does not set it; **a fork running its own App does need it.** |

### 3.1 Invitation signing keypair

Acceptance is triggered by a public event on a public repository, so anyone can fire a broker. The signed invitation token is what makes an unauthorized trigger cost nothing: the broker verifies it before minting an App token ([ARCHITECTURE §4.3.2](ARCHITECTURE.md)).

```bash
node scripts/generate-invite-keypair.mjs 1
```

1. Pipe the **private** half into the environment secret. Do not paste it into a shared terminal, and do not commit it:

   ```bash
   gh secret set PXL_INVITE_SIGNING_KEY --env provisioning --repo PXL-Digital-Application-Samples/pxl-classroom < key.pem
   ```

2. Put the **public** half in `acceptance/invite-keys.json` under its key id and commit it. It belongs in a public repository: every broker reads it from a hub checkout, and a public key lets a broker reject a forged token without holding anything worth stealing.

3. Delete the local `key.pem`.

**Rotation.** Generate with the next key id, keep the previous entry in `invite-keys.json` so links already in circulation keep verifying, and set the `INVITE_KID` repository *variable* to the new id so new links use it. Drop the old entry once every assignment signed with it is closed.

**Switching acceptance off** without deleting anything: set the broker's `INVITE_ENABLED` variable to `false`. It is read in the workflow's job-level `if`, so GitHub skips the run without allocating a runner.

Retiring one assignment's links is a lecturer action and does not need the key — [RUNBOOK.md](RUNBOOK.md).

### 3.2 Claim keypair

The claim binds a GitHub account to an institutional email address ([ARCHITECTURE §15.1](ARCHITECTURE.md)). The student's browser seals the address to the hub's **public** key, so only ciphertext travels over the public acceptance event; the hub decrypts it with the **private** half.

```bash
node scripts/generate-claim-keypair.mjs 1
```

1. Set the **private** half as an **environment** secret on `provisioning`, never at repository level. This key decrypts every student's institutional email address.

2. Put the **public** half in `acceptance/claim-keys.json` under its key id, set `current` to that id, and commit. A public key belongs in a public repository: it lets anyone encrypt, which is the point, and decrypt nothing. `tests/claim-keys.test.mjs` fails if anything private-key-shaped lands there — both halves are P-256 base64url and look alike, but a private key is **184** characters where a public key is **122**.

3. The script prints the private half **once** and writes it nowhere, so it cannot linger in the working tree. If you lose it before setting the secret, run the script again — nothing has been committed yet.

**Rotation.** The hub holds several private keys and tries each, which is what makes rotation possible. Order matters:

1. Generate the next keypair: `node scripts/generate-claim-keypair.mjs 2`.
2. **Before changing anything else**, add the **current** private key to the `provisioning` environment secret `PXL_CLAIM_PRIVATE_KEYS_RETIRED` (newline- or comma-separated; it may already hold others). This is the step that keeps in-flight claims working — do it first and the rest is safe in any order.
3. Set `PXL_CLAIM_PRIVATE_KEY` to the **new** private half.
4. Put the new **public** half in `acceptance/claim-keys.json`, point `current` at it, and commit. Keep the old public entry only for the record; it is the retired **private** key that does the work.
5. Deploy — `deploy-frontend.yml`'s path filter names `acceptance/claim-keys.json`, so the commit in step 4 triggers it. Until it lands, browsers keep sealing to the old key, which is why step 2 comes first.
6. Drop the old key from `PXL_CLAIM_PRIVATE_KEYS_RETIRED` once no cached bundle can still be sealing to it. A week is generous.

`tests/claim-key-rotation.test.mjs` runs the whole thing through the real crypto, including the case where the retired key is *absent* and the pre-rotation claim is lost.

**What rotation does and does not buy.** Sealed claims sit in public GitHub issue bodies, which GH Archive mirrors permanently. There is no forward secrecy and there cannot be: a static page sealing to a long-lived recipient key has nothing to derive one from. Whoever holds a private key can decrypt every claim ever sealed to it, retroactively, for ever. Rotation bounds the *window* one leaked key exposes; it does not undo it. Treat every retired key as still sensitive, and delete it from the secret when you no longer need it rather than when it stops being used.

### 3.3 Migrating an assignment to signed acceptance

Only applies to a deployment carrying assignments published **before** signed acceptance shipped. There is one republish per such assignment that **cannot** keep its links alive, and it is not optional.

An acceptance issue's title lands in GitHub's public event feed, which GH Archive mirrors permanently — redaction, deletion and the Tier 4 sweep all act after that, so none can take it back. That is why the title carries a **signature** rather than the invitation ([ARCHITECTURE §4.3.2](ARCHITECTURE.md)).

An assignment moves across when it is next published. Nothing is automatic and nothing is scheduled: until you republish, it keeps working exactly as before.

**Per published assignment:**

1. Open it in the Admin Panel. If it still uses the old format, *Republish broker* carries a warning saying so — that warning is the migration flag.
2. Republish. This mints the keypair, sets `INVITE_PUBKEY` on the broker, and rewrites the broker's workflow.
3. **Copy the new link and send it to anyone who has not accepted yet.** This is the part nothing can do for you.

**What students holding the old link see.** Not a 404: the old digest keeps resolving, to a page saying *"This invitation link is out of date - ask your lecturer for the current one."* Repositories of students who already accepted are untouched.

**Verify with *Troubleshoot*.** Tier 4 checks the assignment's `invite_key` and that the broker's `INVITE_PUBKEY` matches it. A missing or mismatched public key fails **every** acceptance in silence, which is exactly what a half-completed republish leaves behind.

It also catches the more dangerous inverse: a broker holding `INVITE_PUBKEY` for an assignment whose keypair was never committed. Publish sets the variable and pushes the broker workflow in one step and commits the assignment afterwards, so a failure in between — an org ruleset rejecting the push — leaves the broker verifying signatures while every student's link is still the older kind. Every acceptance is then refused as out of date while the token, key id and nonce all still check out. Republishing fixes it.

**Do not** hand-edit `invite_key` or `invite_pubkey` in a control repo. They are one pair; changing either half alone locks the cohort out.

### 3.4 The `provisioning` environment

Every hub job holding a private key declares `environment: provisioning`. That environment allows deployments from `main` only, and a job naming an environment does not start when the run's ref falls outside the policy — which is what stops a `workflow_dispatch --ref <other-branch>` from running hub code with a credential in scope ([ARCHITECTURE §4.3.4](ARCHITECTURE.md)).

Create it once:

```bash
gh api --method PUT repos/PXL-Digital-Application-Samples/pxl-classroom/environments/provisioning -f 'deployment_branch_policy[protected_branches]=false' -f 'deployment_branch_policy[custom_branch_policies]=true'
```

Then add `main` as the only allowed branch:

```bash
gh api --method POST repos/PXL-Digital-Application-Samples/pxl-classroom/environments/provisioning/deployment-branch-policies -f name=main -f type=branch
```

Do **not** add required reviewers or a wait timer: acceptance runs synchronously and would stall behind an approval.

If a private key is ever re-added at repository level it shadows nothing — environment secrets win for jobs that name the environment — but it does hand the value to any job that does not. `tests/workflow-hardening.test.mjs` fails CI if such a job appears.

**Blocking ad-hoc branch creation** closes the other half of the branch-ref path: the environment stops a credential being *read* at another ref, and this stops the ref being created. A ruleset named `Block ad-hoc branch creation` does it, with target `branch`, enforcement `active`, rule `creation`, `conditions.ref_name.include` of `~ALL` excluding `refs/heads/participating-orgs` (which `setup-org.yml` creates on a fresh hub), and bypass actors for OrganizationAdmin and the repository admin role:

```bash
gh api --method POST repos/PXL-Digital-Application-Samples/pxl-classroom/rulesets --input ruleset.json
```

Confirm it:

```bash
gh api repos/PXL-Digital-Application-Samples/pxl-classroom/rulesets --jq '.[] | "\(.name) \(.enforcement)"'
```

## 4. Install the App on the hub's owning org, scoped narrowly

This installation is what lets the **SPA** dispatch hub workflows on a lecturer's behalf — Publish, Retry acceptance and the six others the Admin Panel triggers with the lecturer's own user-to-server token. It is **not** what brokers mint against: they use the separate Broker App (§10). Scope it tightly.

1. App settings page → **Install App** → choose `PXL-Digital-Application-Samples`.
2. **Only select repositories** → tick `pxl-classroom` only.
3. Confirm.

Verify with an App-level JWT: `gh api /app/installations` should show `repository_selection: selected` and `repositories: [pxl-classroom]`.

## 5. Branch protection on `main`

`pxl-classroom` is public and its workflows are the highest-value target. The repository is maintained by **direct pushes to `main`** (no pull requests), so PR-review and required-status-check rules are deliberately **not** used — a required status check rejects any direct push, because the pushed commit cannot have a passing check yet. CI still runs on every push and fails loudly.

- Branch rule for `main`: block force-pushes and deletions, **including for administrators**. No PR requirement, no required checks, no signed-commits requirement.
- Settings → Code security: enable secret scanning **and** push protection.

```bash
printf '{"required_status_checks":null,"enforce_admins":true,"required_pull_request_reviews":null,"restrictions":null,"allow_force_pushes":false,"allow_deletions":false}' | \
  gh api -X PUT repos/PXL-Digital-Application-Samples/pxl-classroom/branches/main/protection --input -
```

## 6. Protection on the `participating-orgs` branch

This branch is the registry of participating orgs, and `setup-org.yml` commits to it directly from automation, so it must accept plain pushes. Apply the same rule as `main` — force-push and deletion blocking only, same API call with `participating-orgs` in place of `main`.

## 7. Verify

```bash
# Hub is public, Pages is live
curl -I https://pxl-digital-application-samples.github.io/pxl-classroom/

# App exists and is correctly scoped
gh api /app
gh api /app/installations
```

## 8. SPA directory structure

Do not move `frontend/` to a subdirectory without updating `frontend/vite.config.js`'s `server.fs.allow` — `lib/dashboard-aggregate.mjs` is imported from outside the SPA root.

## 9. Device-flow CORS proxy

`github.com/login/device/code` and `github.com/login/oauth/access_token` send **no CORS headers at all**, and GitHub's OAuth documentation states that "CORS pre-flight requests (OPTIONS) are not supported at this time". A browser therefore cannot call them directly. The proxy is **structural and permanent**, not a workaround. `api.github.com` is CORS-friendly and is called directly, so **only sign-in depends on this**.

> [!WARNING]
> **There is no substitute proxy to switch to in an emergency.** The obvious recovery — point `VITE_CORS_PROXY_URL` at another public proxy — was measured and does not work: allorigins, thingproxy and codetabs each silently issue a **GET** and return GitHub's HTML sign-in page (HTTP 200, wrong method, unparseable body). Do not plan on finding one under pressure.

The SPA tries **two** proxies in order, and **ours is first**: the PXL-owned Cloudflare Worker (`device_flow_proxy` in `deployment.yml`), which nobody outside PXL can withdraw, then a third-party proxy (`VITE_CORS_PROXY_URL`). Failover is automatic and needs no redeploy.

> [!IMPORTANT]
> **The order is a security property, not a preference.** Whichever proxy answers **sees the access token**, and a lecturer token reads the private control repo: roster names, student numbers, institutional email addresses. A fallback is only reached when the primary fails, so a Worker in second place protects nobody. Do not put a third party in front of it.
>
> The Worker URL lives in `deployment.yml` rather than a secret because it was never secret — it is baked into a public bundle and readable by anyone who opens the page. Keeping it there also puts the *order* in a file people read. `VITE_CORS_PROXY_FALLBACK_URL` is retired.

**Deploy the Worker:** `cd cors-worker && npx wrangler@latest login && npx wrangler@latest deploy`. Free plan, no credit card, no domain. Deploy from the repository rather than pasting into the dashboard editor — the Worker carries a security allowlist, and a pasted copy drifts from the reviewed one the moment either is touched. [`cors-worker/README.md`](cors-worker/README.md) has the dashboard alternative and the verification probes; Cloudflare renames that screen regularly, so trust what is in front of you over any written click-path. Both proxy values are **baked into the bundle at build time**, so a change does not exist until `deploy-frontend.yml` has run.

**Who owns the Worker matters**, because if that account is lost sign-in silently falls back to a third party and nobody is told:

| | |
|---|---|
| Cloudflare account | `tom-cool-38e` (Tom Cool) — **single-owner, see [OPEN-ITEMS.md](OPEN-ITEMS.md)** |
| Worker URL | `https://pxl-cors.tom-cool-38e.workers.dev/` |
| Configured as | `device_flow_proxy` in [`deployment.yml`](deployment.yml) — that URL with `?url=` appended. **Primary.** Not a secret: it ships in the public bundle either way. |

**The Worker's allowlists refuse by exact match**, which is the control doing its job: `example.com`, `api.github.com/user`, the correct target with `?x=1` appended, `evil.example.com` and `pxl-digital-application-samples.github.io.evil.com` are all 403 — that last is a domain anyone can register, which a suffix check would have admitted (the same trap as `claim_domains` in [ARCHITECTURE §15.1](ARCHITECTURE.md)). A request with no `Origin` is refused and `GET` is 405.

**Diagnosing it.** `curl` alone gets a 403 from **both** proxies — corsproxy.io sits behind Cloudflare bot protection and the Worker enforces its `Origin` allowlist. That is them working, not an outage, and it will look exactly like an outage. Send a browser-shaped request before concluding anything:

```bash
curl -s -X POST "https://corsproxy.io/?key=<key>&url=https%3A%2F%2Fgithub.com%2Flogin%2Fdevice%2Fcode" -H "Origin: https://pxl-digital-application-samples.github.io" -H "Referer: https://pxl-digital-application-samples.github.io/" -H "User-Agent: Mozilla/5.0" -H "Content-Type: application/json" -d '{"client_id":"Iv23li0H0Je93H2FkMPW","scope":"user:email"}'
```

A `device_code` comes back, unused, expiring in 15 minutes; nothing needs cleaning up.

Two more things that only show up when you actually run it. **In a browser a proxy's 401 never arrives as a 401** — an error response carrying no CORS headers is blocked from being read, so the SPA sees a network error and fails over through the catch path rather than through its response check. And **a cached bundle keeps the old proxy list**, so a tab still holding the previous `index-*.js` goes on using the old primary, which reads exactly like a failed rollback. Confirm any proxy change against a **cache-busted** load (`/?cb=<something>`) and check which `index-*.js` the page actually fetched.

## 10. The broker dispatch App

> [!CAUTION]
> **Publishing is blocked until this exists.** That is deliberate. The only alternative is putting the provisioning App's own private key on a public repository — see [ARCHITECTURE §4.3.0](ARCHITECTURE.md) for why that is not an option.

A broker repository is public, there is one per assignment, and it needs a credential because its whole job is one `POST` to the hub's `/dispatches` endpoint. It therefore gets its **own** App, holding `contents: write` and nothing else.

**Create it (once).** Use the script — it sets the permission set exactly, so nobody ticks a box by hand:

```bash
node scripts/create-broker-app.mjs
```

It opens a page that submits a prepared App Manifest, you press GitHub's **Create GitHub App** button, and it does the rest: exchanges the one-hour code, stores `PXL_BROKER_CLIENT_ID` and `PXL_BROKER_PRIVATE_KEY` on the hub's **`provisioning` environment**, and reads the App back to confirm it declares `Contents: write` **and nothing else**. The private key goes from GitHub straight into `gh secret set` over a pipe — never written to disk, never printed, never placed in a command line where `ps` would show it. `--dry-run` prints the manifest without creating anything.

**Two steps are browser-only, and that is GitHub's limit rather than a shortcut here.** Creating an App has no REST endpoint — the App Manifest flow is the only programmatic route and it requires a human to confirm. Installing one has no REST endpoint either: *"an organization owner or application manager must make this change within the UI"*. Adding further repositories to an **existing** installation is an API; the first install is not.

So after the script finishes, install it by hand at the URL it prints:

```
https://github.com/apps/<slug>/installations/new
```

Choose **Only select repositories** and select **`pxl-classroom`** — only that one. Not the course orgs; it has no business there, and every org it is not installed on is an org a leaked broker key cannot reach. Then confirm:

```bash
gh api /repos/PXL-Digital-Application-Samples/pxl-classroom/installation --jq '.app_slug + " -> " + (.permissions|tostring)'
```

<details>
<summary>Doing it by hand instead</summary>

1. New GitHub App owned by `PXL-Digital-Application-Samples`, named e.g. **PXL Classroom Broker**.
2. Permissions: **Repository → Contents: Read and write**. Nothing else — that is exactly what `POST /repos/{owner}/{repo}/dispatches` requires. In particular do **not** grant **Actions**, or a leaked broker key could dispatch hub workflows.
3. Subscribe to no events. Where install is offered, choose **Only on this account**.
4. Generate a private key.
5. Set `PXL_BROKER_CLIENT_ID` (the `Iv…` Client ID) and `PXL_BROKER_PRIVATE_KEY` (the whole PEM, header and footer included) on the **`provisioning` environment** — not repository-level.
6. Install on `pxl-classroom` only, as above.

`node scripts/create-broker-app.mjs --verify --slug <slug>` checks the result either way.

</details>

Publishing verifies the credential *before* it writes anything: `publish-assignment.yml` mints a token with it and fails the run if the App is missing, uninstalled or under-permissioned. A broker App that does not work is a red publish run for the lecturer, not a silent failure at the first student's acceptance.

**A broker must never hold the provisioning App's key.** Republishing an assignment is what removes one that does: publish pushes the new broker workflow, then deletes `PXL_APP_PRIVATE_KEY` and `PXL_APP_CLIENT_ID` from that broker — in that order, because the old workflow still reads the old secret until it is replaced. Confirm any broker with:

```bash
gh secret list --repo <org>/broker-<assignment-id>
```

Only `PXL_BROKER_CLIENT_ID` and `PXL_BROKER_PRIVATE_KEY` should appear. A broker in an org you do not administer answers 403; ask an owner of that org.

---

The system is now ready to onboard its first organization → [ADMIN.md §1](ADMIN.md#1-onboarding-a-new-organization-per-org).
